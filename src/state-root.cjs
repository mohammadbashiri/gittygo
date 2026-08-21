const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let cachedRoot;

function stateRoot() {
  const configured = process.env.GITTYGO_STATE_DIR || process.env.GIT_REVIEW_STATE_DIR;
  if (configured) return path.resolve(configured);
  if (cachedRoot) return cachedRoot;

  const preferred = path.join(os.homedir(), '.gittygo');
  const legacy = path.join(os.homedir(), '.git-review');
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, preferred); }
    catch (error) { if (!fs.existsSync(preferred)) throw error; }
  }
  cachedRoot = preferred;
  return cachedRoot;
}

module.exports = { stateRoot };
