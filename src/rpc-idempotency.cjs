const crypto = require('node:crypto');
const { serializeError } = require('./workspace-controller.cjs');
const READ_ONLY = new Set(['state', 'reviewState', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'remotes', 'branches', 'worktrees', 'readTarget']);
const fail = (message) => ({ ok: false, error: { message, details: '' } });
const OVERFLOW = JSON.stringify(fail('RPC result retention limit reached. The operation may have completed. Refresh state/context; do not repeat it with a new requestId.'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// No TTL, LRU or deletion: an uncertain old UUID can never become executable again.
// Whole ledgers disappear only with the runtime's unpredictable workspace identities.
function createRpcLedger({ maxEntries = 65536, maxWorkspaceEntries = 32768, maxBytes = 64 * 1024 * 1024 } = {}) {
  const workspaces = new Map();
  let entries = 0;
  let bytes = 0;
  let saturated = false;
  function execute(workspaceId, { method, args, requestId }, action) {
    if (typeof method !== 'string' || !Array.isArray(args)) throw new Error('Expected method and args.');
    if (requestId === undefined) {
      if (!READ_ONLY.has(method)) throw new Error('A UUID requestId is required for mutation and consuming RPC.');
      return Promise.resolve().then(action).then(JSON.stringify);
    }
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new Error('Invalid UUID requestId.');
    requestId = requestId.toLowerCase();
    // Object key ordering is irrelevant; positional array/argument order remains significant.
    const payload = JSON.stringify({ method, args }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    let workspace = workspaces.get(workspaceId);
    const existing = workspace?.get(requestId);
    if (existing) {
      if (existing.digest !== digest) throw new Error('requestId was already used with a different method or arguments.');
      return existing.promise;
    }
    // Charge the input plus overhead and a guaranteed small fallback response up front.
    // This bounds even in-flight requests; completed entries keep the conservative input charge.
    const fallbackBytes = Buffer.byteLength(OVERFLOW);
    const reservation = Buffer.byteLength(payload) + 256 + fallbackBytes;
    if (saturated || entries >= maxEntries || (workspace?.size || 0) >= maxWorkspaceEntries || bytes + reservation > maxBytes) throw new Error('RPC request ledger is full. No operation was started. Existing requestIds remain replayable; restart/re-establish the service to continue.');
    if (!workspace) { workspace = new Map(); workspaces.set(workspaceId, workspace); }
    bytes += reservation; entries++;
    const record = { digest, promise: null };
    // Reservation is visible synchronously BEFORE scheduling any controller execution.
    workspace.set(requestId, record);
    function retain(result) {
      let encoded;
      try { encoded = JSON.stringify(result); } catch (error) { encoded = JSON.stringify({ ok: false, error: serializeError(error) }); }
      const extraBytes = Buffer.byteLength(encoded) - fallbackBytes;
      if (bytes + extraBytes > maxBytes) { saturated = true; return OVERFLOW; }
      bytes += extraBytes;
      return encoded;
    }
    record.promise = Promise.resolve().then(action).then(retain, (error) => retain({ ok: false, error: serializeError(error) }));
    return record.promise;
  }
  return { execute };
}
module.exports = { createRpcLedger };
