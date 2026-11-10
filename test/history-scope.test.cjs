const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const service = require('../src/git-service.cjs');

// Private disposable graph: common -> main; common -> feature. Other refs must
// never leak into the history of the selected worktree's HEAD.
test('history follows HEAD through switches, detached HEAD, merges and unborn branches', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-history-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), linked = path.join(root, 'linked');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = (subject) => { git('commit', '--allow-empty', '-qm', subject); return git('rev-parse', 'HEAD'); };
  const common = commit('Common ancestor');
  const main = commit('Main only');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('switch', '-qc', 'feat/execution-ui', common);
  const feature = commit('Park distributed execution prototype for later review');
  git('tag', 'feature-only-tag');
  git('update-ref', 'refs/remotes/origin/feature', feature);
  git('switch', '-q', 'main');
  const hashes = async (where = repo, limit) => (await service.getHistory(where, limit)).map(c => c.hash);
  assert.deepEqual(await hashes(), [main, common]);
  assert.deepEqual(await hashes(repo, 1), [main]);
  git('switch', '-q', 'feat/execution-ui');
  assert.deepEqual(await hashes(), [feature, common]);
  git('switch', '-q', 'main');
  git('worktree', 'add', '-q', linked, 'feat/execution-ui');
  assert.deepEqual(await hashes(linked), [feature, common]);
  assert.deepEqual(await hashes(), [main, common]);
  git('switch', '--detach', '-q', common);
  assert.deepEqual(await hashes(), [common]);
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'Merge feature', 'feat/execution-ui');
  assert.deepEqual(new Set(await hashes()), new Set([git('rev-parse', 'HEAD'), main, feature, common]));
  git('switch', '--orphan', 'unborn');
  assert.deepEqual(await hashes(), []);
});
