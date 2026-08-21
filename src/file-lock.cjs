const lockfile = require('proper-lockfile');

const DEFAULT_TIMEOUT_MS = 3000;
const STALE_LOCK_MS = 5 * 60 * 1000;

async function withFileLock(lockTarget, action, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let release;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: STALE_LOCK_MS,
      update: STALE_LOCK_MS / 4,
      retries: {
        retries: Math.ceil(timeoutMs / 15),
        factor: 1,
        minTimeout: 15,
        maxTimeout: 15,
        randomize: true,
      },
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error(options.timeoutMessage || 'Timed out waiting for a file lock.');
    throw error;
  }

  try { return await action(); }
  finally { await release(); }
}

module.exports = { withFileLock };
