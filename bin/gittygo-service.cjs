#!/usr/bin/env node
const { startWorkspaceService } = require('../src/workspace-service.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Usage: GITTYGO_SERVICE_TOKEN=<private-token> node bin/gittygo-service.cjs [--port 0]');
  const port = args.length ? Number(args[1]) : 0;
  const token = process.env.GITTYGO_SERVICE_TOKEN;
  delete process.env.GITTYGO_SERVICE_TOKEN; // Do not pass the service credential to Git/hooks.
  const service = await startWorkspaceService({ port, token });
  // No token, directories, credential-bearing URLs, or request logging.
  process.stdout.write(`${JSON.stringify({ service: 'gittygo-workspace', version: 1, url: service.url, port: service.port })}\n`);
  const stop = async () => { try { await service.close(); } catch { process.exitCode = 1; } };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
