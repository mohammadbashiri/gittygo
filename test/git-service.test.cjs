const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../src/git-service.cjs');

function command(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-review-test-'));
  command(repo, ['init', '-q']);
  command(repo, ['config', 'user.name', 'Test User']);
  command(repo, ['config', 'user.email', 'test@example.com']);
  const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'sample.txt'), original);
  command(repo, ['add', 'sample.txt']);
  command(repo, ['commit', '-qm', 'Initial']);
  return repo;
}

test('parseStatus handles staged, unstaged, and untracked entries', () => {
  const parsed = git.parseStatus(' M src/a.js\0A  src/b.js\0?? notes.txt\0');
  assert.deepEqual(parsed.map((file) => [file.path, file.staged, file.unstaged, file.untracked]), [
    ['src/a.js', false, true, false],
    ['src/b.js', true, false, false],
    ['notes.txt', false, true, true],
  ]);
});

test('repository state separates staged and unstaged files', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.appendFileSync(path.join(repo, 'sample.txt'), 'new line\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new file\n');
  command(repo, ['add', 'new.txt']);

  const state = await git.getState(repo);
  assert.equal(state.changes[0].path, 'sample.txt');
  assert.equal(state.staged[0].path, 'new.txt');
});

test('a single hunk can be staged and unstaged', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, 'sample.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = 'changed near top';
  lines[20] = 'changed near bottom';
  fs.writeFileSync(file, lines.join('\n'));

  const { patch } = await git.getDiff(repo, 'sample.txt', 'unstaged');
  const hunks = git.extractHunks(patch);
  assert.equal(hunks.length, 2);

  await git.stageHunk(repo, hunks[0].patch);
  let state = await git.getState(repo);
  assert.equal(state.staged.length, 1);
  assert.equal(state.changes.length, 1);

  const stagedDiff = await git.getDiff(repo, 'sample.txt', 'staged');
  const stagedHunk = git.extractHunks(stagedDiff.patch)[0];
  await git.unstageHunk(repo, stagedHunk.patch);
  state = await git.getState(repo);
  assert.equal(state.staged.length, 0);
  assert.equal(state.changes.length, 1);
});

test('commit returns the new short hash', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.appendFileSync(path.join(repo, 'sample.txt'), 'committed line\n');
  await git.stageFile(repo, 'sample.txt');
  const hash = await git.commit(repo, 'Add committed line');
  assert.match(hash, /^[0-9a-f]+$/);
  assert.equal(command(repo, ['log', '-1', '--pretty=%s']).trim(), 'Add committed line');
});
