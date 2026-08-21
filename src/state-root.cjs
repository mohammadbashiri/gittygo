const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let cachedRoot;

function secureStateRoot(root) {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`GittyGo state directory must not be a symbolic link: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return root;
}

function stateRoot() {
  const configured = process.env.GITTYGO_STATE_DIR || process.env.GIT_REVIEW_STATE_DIR;
  if (configured) return secureStateRoot(path.resolve(configured));
  if (cachedRoot) return cachedRoot;

  const preferred = path.join(os.homedir(), '.gittygo');
  const legacy = path.join(os.homedir(), '.git-review');
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    if (fs.lstatSync(legacy).isSymbolicLink()) throw new Error(`Legacy GittyGo state directory must not be a symbolic link: ${legacy}`);
    try { fs.renameSync(legacy, preferred); }
    catch (error) { if (!fs.existsSync(preferred)) throw error; }
  }
  cachedRoot = secureStateRoot(preferred);
  return cachedRoot;
}

module.exports = { stateRoot };
