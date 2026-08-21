const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFileLock } = require('../src/file-lock.cjs');

const execFileAsync = promisify(execFile);

test('independent processes retain mutual exclusion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'state');
  const counterPath = path.join(directory, 'counter');
  fs.writeFileSync(counterPath, '0');

  const modulePath = path.resolve(__dirname, '../src/file-lock.cjs');
  const script = `
    const fs = require('node:fs/promises');
    const { withFileLock } = require(process.argv[1]);
    withFileLock(process.argv[2], async () => {
      const value = Number(await fs.readFile(process.argv[3], 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(process.argv[3], String(value + 1));
    }).catch((error) => { console.error(error); process.exit(1); });
  `;
  await Promise.all(Array.from({ length: 10 }, () => execFileAsync(
    process.execPath,
    ['-e', script, modulePath, lockPath, counterPath],
  )));
  assert.equal(fs.readFileSync(counterPath, 'utf8'), '10');
  assert.equal(fs.existsSync(lockPath), false);
});

test('an active lock times out rather than allowing a second owner', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'state');
  let secondEntered = false;
  await withFileLock(lockPath, async () => {
    await assert.rejects(
      withFileLock(lockPath, async () => { secondEntered = true; }, { timeoutMs: 30, timeoutMessage: 'busy' }),
      /busy/,
    );
  });
  assert.equal(secondEntered, false);
});
