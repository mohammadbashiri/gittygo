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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-test-'));
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

test('mutation fingerprints detect content and index changes', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, 'sample.txt');
  fs.appendFileSync(file, 'first change\n');
  const repositoryBefore = await git.getRepositoryMutationFingerprint(repo);
  const fileBefore = await git.getFileChangeFingerprint(repo, 'sample.txt');

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('first change', 'other change'));
  assert.notEqual(await git.getRepositoryMutationFingerprint(repo), repositoryBefore);
  assert.notEqual(await git.getFileChangeFingerprint(repo, 'sample.txt'), fileBefore);

  const beforeStage = await git.getRepositoryMutationFingerprint(repo);
  await git.stageFile(repo, 'sample.txt');
  assert.notEqual(await git.getRepositoryMutationFingerprint(repo), beforeStage);

  const beforeRemote = await git.getRepositoryMutationFingerprint(repo);
  command(repo, ['remote', 'add', 'origin', 'https://example.test/one.git']);
  assert.notEqual(await git.getRepositoryMutationFingerprint(repo), beforeRemote);
});

test('all changes can be staged and unstaged together', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.appendFileSync(path.join(repo, 'sample.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new file\n');

  await git.stageAll(repo);
  let state = await git.getState(repo);
  assert.equal(state.staged.length, 2);
  assert.equal(state.changes.length, 0);

  await git.unstageAll(repo);
  state = await git.getState(repo);
  assert.equal(state.staged.length, 0);
  assert.equal(state.changes.length, 2);
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

test('selected changed lines can be staged independently', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, 'sample.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = 'changed line 2';
  lines[2] = 'changed line 3';
  fs.writeFileSync(file, lines.join('\n'));

  const { patch } = await git.getDiff(repo, 'sample.txt', 'unstaged');
  const hunk = git.extractHunks(patch)[0];
  const selected = hunk.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line === '-line 2' || line === '+changed line 2')
    .map(({ index }) => index);
  await git.stageSelectedLines(repo, hunk.patch, selected, 'unstaged');

  const staged = command(repo, ['diff', '--cached']);
  const unstaged = command(repo, ['diff']);
  assert.match(staged, /changed line 2/);
  assert.doesNotMatch(staged, /changed line 3/);
  assert.match(unstaged, /changed line 3/);
});

test('history and undo preserve committed changes', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.appendFileSync(path.join(repo, 'sample.txt'), 'second commit\n');
  command(repo, ['add', 'sample.txt']);
  command(repo, ['commit', '-qm', 'Second']);

  const history = await git.getHistory(repo);
  assert.equal(history[0].subject, 'Second');
  assert.equal(history.length, 2);
  await git.undoLastCommit(repo, true);
  assert.equal(command(repo, ['log', '-1', '--pretty=%s']).trim(), 'Initial');
  assert.match(command(repo, ['diff', '--cached']), /second commit/);
});

test('commit details provide a structured file inventory and lazy diffs', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const rootHash = command(repo, ['rev-parse', 'HEAD']).trim();
  const root = await git.getCommitDetails(repo, rootHash);
  assert.equal(root.comparison.kind, 'root');
  assert.equal(root.files.length, 1);
  assert.equal(root.files[0].status, 'A');

  command(repo, ['mv', 'sample.txt', 'renamed.txt']);
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'new notes\n');
  fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  command(repo, ['add', '.']);
  command(repo, ['commit', '-qm', 'Rename and add files']);
  const hash = command(repo, ['rev-parse', 'HEAD']).trim();
  const details = await git.getCommitDetails(repo, hash);
  assert.equal(details.comparison.kind, 'parent');
  assert.equal(details.totals.files, 3);
  const renamed = details.files.find((file) => file.status === 'R');
  assert.equal(renamed.oldPath, 'sample.txt');
  assert.equal(renamed.path, 'renamed.txt');
  assert.equal(details.files.find((file) => file.path === 'image.bin').binary, true);

  const textFile = details.files.find((file) => file.path === 'notes.txt');
  const diff = await git.getCommitFileDiff(repo, hash, textFile.oldPath, textFile.path);
  assert.equal(diff.binary, false);
  assert.match(diff.patch, /\+new notes/);
  assert.equal(diff.hunks.length, 1);
});

test('local branches and remotes can be managed', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  await git.addRemote(repo, 'origin', 'https://example.com/project.git');
  let remotes = await git.getRemotes(repo);
  assert.equal(remotes[0].name, 'origin');
  assert.equal(remotes[0].fetchUrl, 'https://example.com/project.git');
  await git.removeRemote(repo, 'origin');
  remotes = await git.getRemotes(repo);
  assert.equal(remotes.length, 0);

  const initialBranch = command(repo, ['branch', '--show-current']).trim();
  await git.createBranch(repo, 'feature/test');
  let branches = await git.getBranches(repo);
  assert.equal(branches.find((branch) => branch.name === 'feature/test').current, true);
  await git.switchBranch(repo, initialBranch);
  branches = await git.getBranches(repo);
  assert.equal(branches.find((branch) => branch.name === initialBranch).current, true);
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

test('an unborn repository can stage, unstage, and create its initial commit', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-unborn-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  command(repo, ['init', '-q']);
  command(repo, ['config', 'user.name', 'Test User']);
  command(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'first.txt'), 'first\n');

  assert.equal((await git.getState(repo)).head, '');
  await git.stageFile(repo, 'first.txt');
  assert.equal((await git.getState(repo)).staged.length, 1);
  await git.unstageFile(repo, 'first.txt');
  assert.equal((await git.getState(repo)).changes[0].path, 'first.txt');
  await git.stageAll(repo);
  await git.commit(repo, 'Initial commit');
  assert.notEqual((await git.getState(repo)).head, '');
});

test('spaces, Unicode, and leading dashes remain safe repository paths', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const names = ['space name.txt', 'überblick.txt', '--leading.txt'];
  names.forEach((name) => fs.writeFileSync(path.join(repo, name), `${name}\n`));
  assert.deepEqual((await git.getState(repo)).changes.map((file) => file.path).sort(), names.sort());
  for (const name of names) await git.stageFile(repo, name);
  assert.equal((await git.getState(repo)).staged.length, names.length);
});

test('merge conflicts are surfaced with operation state', async (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const initialBranch = command(repo, ['branch', '--show-current']).trim();
  command(repo, ['switch', '-qc', 'conflicting']);
  fs.writeFileSync(path.join(repo, 'sample.txt'), 'feature\n');
  command(repo, ['commit', '-qam', 'Feature change']);
  command(repo, ['switch', '-q', initialBranch]);
  fs.writeFileSync(path.join(repo, 'sample.txt'), 'main\n');
  command(repo, ['commit', '-qam', 'Main change']);
  assert.throws(() => command(repo, ['merge', 'conflicting']));

  const state = await git.getState(repo);
  assert.equal(state.operation, 'merge');
  assert.equal(state.conflicted, true);
  assert.equal(state.changes[0].path, 'sample.txt');
});

test('linked worktrees receive distinct identities over one common repository', async (t) => {
  const repo = createRepo();
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-worktree-parent-'));
  fs.rmSync(worktree, { recursive: true, force: true });
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  command(repo, ['worktree', 'add', '-qb', 'worktree-test', worktree]);
  const primary = await git.getRepositoryIdentity(repo);
  const linked = await git.getRepositoryIdentity(worktree);
  assert.equal(primary.gitCommonDirectory, linked.gitCommonDirectory);
  assert.notEqual(primary.worktreeRoot, linked.worktreeRoot);
  assert.notEqual(primary.repoIdentity, linked.repoIdentity);
  assert.equal((await git.getState(worktree)).branch, 'worktree-test');
});

test('fetch, fast-forward pull, and push work against a local remote', async (t) => {
  const repo = createRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-remote-'));
  const cloneParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-clone-parent-'));
  const clone = path.join(cloneParent, 'clone');
  t.after(() => {
    fs.rmSync(cloneParent, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  command(bare, ['init', '--bare', '-q']);
  await git.addRemote(repo, 'origin', bare);
  await git.push(repo);
  const branch = command(repo, ['branch', '--show-current']).trim();
  command(bare, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  execFileSync('git', ['clone', '-q', bare, clone]);
  command(clone, ['config', 'user.name', 'Test User']);
  command(clone, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(clone, 'remote.txt'), 'remote\n');
  command(clone, ['add', '.']);
  command(clone, ['commit', '-qm', 'Remote change']);
  command(clone, ['push', '-q']);

  await git.fetchRemote(repo);
  assert.equal((await git.getState(repo)).behind, 1);
  await git.pull(repo);
  assert.equal(fs.readFileSync(path.join(repo, 'remote.txt'), 'utf8'), 'remote\n');
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local\n');
  await git.stageFile(repo, 'local.txt');
  await git.commit(repo, 'Local change');
  await git.push(repo);
  assert.equal(command(bare, ['log', '-1', '--pretty=%s']).trim(), 'Local change');
});
