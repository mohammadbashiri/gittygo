const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('externally removed selection exposes read-only recovery without retargeting mutations', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-unavailable-')));
  const old = process.env.GITTYGO_STATE_DIR; process.env.GITTYGO_STATE_DIR = path.join(root, 'state');
  const repo = path.join(root, 'repo'), linked = path.join(root, 'linked'); await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(repo, 'file'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed');
  git('worktree', 'add', '-qb', 'linked', linked);
  const c = await require('../src/workspace-controller.cjs').createWorkspaceController(repo);
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); if (old === undefined) delete process.env.GITTYGO_STATE_DIR; else process.env.GITTYGO_STATE_DIR = old; });
  const session = c.sessionId;
  assert.equal((await c.dispatch('selectWorktree', [linked])).ok, true);
  git('worktree', 'remove', linked); // External Git does not observe GittyGo leases.
  const state = await c.dispatch('state'); assert.equal(state.ok, true); assert.equal(state.result.unavailable, true); assert.equal(state.result.repo, linked);
  assert.equal((await c.dispatch('reviewState')).ok, true);
  const folders = await c.dispatch('worktrees'); assert.equal(folders.ok, true); assert.equal(folders.result.find(e => e.path === repo).valid, true);
  assert.equal((await c.dispatch('stageAll')).ok, false);
  assert.equal((await c.dispatch('target', [linked, 'stageAll', []])).ok, false);
  assert.equal((await c.dispatch('readTarget', [linked, 'diff', ['file', 'unstaged']])).ok, false);
  assert.equal(git('diff', '--cached'), '');
  assert.equal(c.sessionId, session);
  assert.equal((await c.dispatch('selectWorktree', [repo])).ok, true);
  assert.equal((await c.dispatch('state')).result.repo, repo);
  assert.equal((await c.dispatch('state')).result.unavailable, undefined);
  assert.equal(c.sessionId, session);
});
