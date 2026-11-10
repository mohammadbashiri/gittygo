const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const git = require('./git-service.cjs');
const { createWorkspaceController, serializeError } = require('./workspace-controller.cjs');
const { createRpcLedger } = require('./rpc-idempotency.cjs');
const VERSION = 1;
const MAX_BODY = 4 * 1024 * 1024;
const ASSETS = Object.freeze({
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'renderer.js': ['renderer.js', 'text/javascript; charset=utf-8'],
  'browser-adapter.js': ['browser-adapter.js', 'text/javascript; charset=utf-8'],
  'styles.css': ['styles.css', 'text/css; charset=utf-8'],
});
function failure(message) { return { ok: false, error: { message, details: '' } }; }
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function countHeader(req, name) { return req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length; }
async function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw new Error('Expected uncompressed JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('Malformed JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}
function exactKeys(value, keys) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }

/** Start a private loopback-only multi-workspace service. Never pass token to a renderer. */
async function startWorkspaceService({ port = 0, token, allowedOrigins = [], confirmationTtlMs } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (typeof token !== 'string' || token.length < 32 || token.length > 1024 || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error('Supply a private token of at least 32 URL-safe characters.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; } catch { return true; }
  })) throw new Error('Invalid allowed origins.');
  const secret = Buffer.from(`Bearer ${token}`);
  const workspaces = new Map();
  const canonical = new Map();
  const rpcLedger = createRpcLedger();
  let listeningPort;
  let closing = false;
  let closePromise;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const hosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
      if (countHeader(req, 'host') !== 1 || !hosts.includes(req.headers.host)) return json(res, 403, failure('Unexpected Host.'));
      const received = Buffer.from(req.headers.authorization || '');
      if (countHeader(req, 'authorization') !== 1 || received.length !== secret.length || !crypto.timingSafeEqual(received, secret)) return json(res, 401, failure('Unauthorized.'));
      if (countHeader(req, 'origin') > 1 || (req.headers.origin !== undefined && ![...hosts.map((host) => `http://${host}`), ...allowedOrigins].includes(req.headers.origin))) return json(res, 403, failure('Unexpected Origin.'));
      if (closing) return json(res, 503, failure('Service is closing.'));
      // Raw path matching: no URL normalizing traversal, encoded separators, queries, or absolute-form targets.
      if (typeof req.url !== 'string' || !/^\/[A-Za-z0-9_./-]*$/.test(req.url) || req.url.split('/').some((part) => part === '.' || part === '..')) return json(res, 400, failure('Invalid path.'));
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, result: { service: 'gittygo-workspace', version: VERSION, ready: true } });
      if (req.method === 'POST' && req.url === '/api/workspaces') {
        const body = await readJson(req);
        if (!exactKeys(body, ['directory']) || typeof body.directory !== 'string' || !body.directory || body.directory.length > 4096 || body.directory.includes('\0') || !path.isAbsolute(body.directory)) throw new Error('Expected an absolute workspace directory.');
        const stat = await fs.stat(body.directory);
        if (!stat.isDirectory()) throw new Error('Workspace must be a directory.');
        const identity = await git.getRepositoryIdentity(body.directory).catch(async (error) => {
          if (!/not a git repository/i.test(error.message)) throw error;
          const root = await fs.realpath(body.directory);
          return { worktreeRoot: root, repoIdentity: `nonrepo-${crypto.createHash('sha256').update(root).digest('hex')}` };
        });
        let creation = canonical.get(identity.repoIdentity);
        if (!creation) {
          if (canonical.size >= 128) throw new Error('Workspace limit reached.');
          creation = (async () => {
            const controller = await createWorkspaceController(identity.worktreeRoot, { confirmationTtlMs });
            const workspaceId = crypto.randomBytes(16).toString('hex');
            const result = { workspaceId, worktreeRoot: identity.worktreeRoot, repoIdentity: identity.repoIdentity, sessionId: controller.sessionId };
            workspaces.set(workspaceId, { controller, result });
            return result;
          })();
          canonical.set(identity.repoIdentity, creation);
          creation.catch(() => canonical.delete(identity.repoIdentity));
        }
        return json(res, 200, { ok: true, result: await creation });
      }
      const match = req.url.match(/^\/w\/([a-f0-9]{32})\/(.*)$/);
      if (!match || !workspaces.has(match[1])) return json(res, 404, failure('Unknown route or workspace.'));
      const { controller } = workspaces.get(match[1]);
      if (req.method === 'POST' && match[2] === 'rpc') {
        const body = await readJson(req);
        if (!exactKeys(body, ['method', 'args']) && !exactKeys(body, ['method', 'args', 'requestId'])) throw new Error('Expected method, args and optional requestId.');
        const encoded = await rpcLedger.execute(match[1], body, () => controller.dispatch(body.method, body.args));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(encoded); return;
      }
      if (req.method === 'GET' && Object.hasOwn(ASSETS, match[2])) {
        const [file, type] = ASSETS[match[2]];
        const content = await fs.readFile(path.join(__dirname, 'renderer', file)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!content) return json(res, 404, failure('Asset unavailable.'));
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      return json(res, 404, failure('Unknown route.'));
    } catch (error) { if (!res.headersSent) json(res, 400, { ok: false, error: serializeError(error) }); else res.destroy(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  listeningPort = server.address().port;
  return {
    server, port: listeningPort, url: `http://127.0.0.1:${listeningPort}`,
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true;
        await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
        await Promise.allSettled(canonical.values());
        await Promise.all([...workspaces.values()].map(({ controller }) => controller.close()));
      })();
      return closePromise;
    },
  };
}
module.exports = { startWorkspaceService, VERSION };
