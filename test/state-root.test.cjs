const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stateRoot } = require('../src/state-root.cjs');

function permissions(filePath) { return fs.statSync(filePath).mode & 0o777; }

test('configured state roots are private and symbolic links are rejected', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-root-'));
  const root = path.join(parent, 'state');
  fs.mkdirSync(root, { mode: 0o755 });
  process.env.GITTYGO_STATE_DIR = root;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  assert.equal(stateRoot(), root);
  assert.equal(permissions(root), 0o700);

  const target = path.join(parent, 'target');
  const link = path.join(parent, 'linked-state');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  process.env.GITTYGO_STATE_DIR = link;
  assert.throws(() => stateRoot(), /must not be a symbolic link/);
});

test('legacy default state is migrated and secured', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(home, '.git-review');
  fs.mkdirSync(legacy, { mode: 0o755 });
  fs.writeFileSync(path.join(legacy, 'marker'), 'legacy');
  const modulePath = path.resolve(__dirname, '../src/state-root.cjs');
  const script = `const fs=require('node:fs'); const root=require(process.argv[1]).stateRoot(); console.log(JSON.stringify({root, mode:fs.statSync(root).mode & 0o777}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script, modulePath], {
    encoding: 'utf8', env: { ...process.env, HOME: home, GITTYGO_STATE_DIR: '', GIT_REVIEW_STATE_DIR: '' },
  }));
  assert.equal(result.root, path.join(home, '.gittygo'));
  assert.equal(result.mode, 0o700);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(path.join(result.root, 'marker'), 'utf8'), 'legacy');
});
