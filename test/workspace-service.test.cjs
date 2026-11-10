const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRpcLedger } = require('../src/rpc-idempotency.cjs');
const { execFileSync, spawn } = require('node:child_process');
const { startWorkspaceService } = require('../src/workspace-service.cjs');
const { createWorkspaceController, channels } = require('../src/workspace-controller.cjs');
const { invokeNative } = require('../src/native-workspace-adapter.cjs');
const { withFileLock } = require('../src/file-lock.cjs');
const git = require('../src/git-service.cjs');
const sessions = require('../src/session-store.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One isolated process-local HOME/state for this entire test file; no installed/native app is launched.
test('private workspace service and shared desktop orchestration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-workspace-test-'));
  const previous = { HOME: process.env.HOME, GITTYGO_STATE_DIR: process.env.GITTYGO_STATE_DIR, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = path.join(root, 'home');
  process.env.GITTYGO_STATE_DIR = path.join(root, 'state');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  await fs.mkdir(process.env.HOME);
  const token = 'test-private-token-0123456789abcdef';
  const service = await startWorkspaceService({ token });
  t.after(async () => {
    await service.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  });
  function command(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }
  let counter = 0;
  async function repo() {
    const directory = path.join(root, `repo-${++counter}`);
    await fs.mkdir(directory);
    command(directory, ['init', '-q', '-b', 'main']);
    command(directory, ['config', 'user.name', 'Fixture']);
    command(directory, ['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(directory, 'file.txt'), 'one\ntwo\nthree\n');
    command(directory, ['add', '.']); command(directory, ['commit', '-qm', 'Initial']);
    return directory;
  }
  function request(url, body, { method = body === undefined ? 'GET' : 'POST', headers = {}, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: service.port, path: url, method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
        let data = ''; res.on('data', (part) => { data += part; });
        res.on('end', () => { let value; try { value = JSON.parse(data); } catch { value = data; } resolve({ status: res.statusCode, body: value, headers: res.headers }); });
      });
      req.on('error', reject); req.end(body === undefined ? undefined : raw ? body : JSON.stringify(body));
    });
  }
  async function workspace(directory) {
    const response = await request('/api/workspaces', { directory });
    assert.equal(response.body.ok, true, JSON.stringify(response.body));
    return response.body.result;
  }
  const rpc = async (id, method, args = [], requestId = randomUUID()) => (await request(`/w/${id}/rpc`, { method, args, requestId })).body;

  await t.test('auth, Host, Origin, payload and raw path checks fail closed', async () => {
    assert.equal((await request('/health')).body.result.service, 'gittygo-workspace');
    assert.equal((await request('/health', undefined, { headers: { Authorization: '' } })).status, 401);
    assert.equal((await request('/health', undefined, { headers: { Authorization: `bearer ${token}` } })).status, 401);
    assert.equal((await request('/health', undefined, { headers: { Host: 'evil.invalid' } })).status, 403);
    for (const Origin of ['null', 'https://evil.invalid', `${service.url}/`, 'http://localhost:1']) assert.equal((await request('/health', undefined, { headers: { Origin } })).status, 403);
    assert.equal((await request('/health', undefined, { headers: { Origin: service.url } })).status, 200);
    for (const url of ['/../health', '/%2e%2e/health', '/health?token=x', 'http://localhost/health', '/health%00']) assert.equal((await request(url)).status, 400);
    assert.equal((await request('/api/workspaces', '{', { raw: true })).status, 400);
    assert.equal((await request('/api/workspaces', { directory: root }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
    assert.equal((await request('/api/workspaces', 'x'.repeat(4 * 1024 * 1024 + 1), { raw: true })).status, 400);
    assert.equal((await request('/api/workspaces', { directory: root, extra: true })).body.ok, false);
    assert.equal((await request('/api/workspaces', { directory: '.' })).body.ok, false);
    const nonrepo = (await request('/api/workspaces', { directory: root })).body;
    assert.equal(nonrepo.ok, true);
    assert.equal((await rpc(nonrepo.result.workspaceId, 'state')).result.nonRepository, true);
    assert.equal(await fs.stat(path.join(root, '.git')).catch(() => null), null);
  });

  await t.test('same canonical worktree is deduplicated, linked worktrees stay distinct, assets are fixed', async () => {
    const directory = await repo();
    const sub = path.join(directory, 'sub'); await fs.mkdir(sub);
    const alias = path.join(root, 'alias'); await fs.symlink(directory, alias);
    const results = await Promise.all([directory, sub, alias].map(workspace));
    assert.equal(new Set(results.map((item) => item.workspaceId)).size, 1);
    const first = results[0];
    const linked = path.join(root, 'linked'); command(directory, ['worktree', 'add', '-qb', 'linked', linked]);
    const second = await workspace(linked);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.notEqual(first.repoIdentity, second.repoIdentity);
    assert.equal((await sessions.loadSession(first.sessionId)).worktreeRoot, first.worktreeRoot);
    const html = await request(`/w/${first.workspaceId}/`);
    assert.equal(html.status, 200); assert.match(html.body, /GittyGo/); assert.ok(!html.body.includes(token));
    assert.equal((await request(`/w/${first.workspaceId}/renderer.js`)).status, 200);
    for (const asset of ['package.json', '../main.cjs', '%2e%2e/main.cjs', '.git/config']) assert.notEqual((await request(`/w/${first.workspaceId}/${asset}`)).status, 200);
    assert.equal((await request(`/w/${'0'.repeat(32)}/rpc`, { method: 'state', args: [] })).status, 404);
    assert.equal((await rpc(second.workspaceId, 'state')).result.repo, await fs.realpath(linked));
  });

  await t.test('scoped facade rejects malformed args, pathspecs, symlink escapes and forged patches', async () => {
    const directory = await repo(); const { workspaceId } = await workspace(directory);
    await fs.writeFile(path.join(root, 'secret'), 'private fixture');
    await fs.symlink(path.join(root, 'secret'), path.join(directory, 'escape'));
    for (const [method, args] of [['__proto__', []], ['git', ['status']], ['state', [directory]], ['stageAll', [true]], ['commit', ['msg', 'true']], ['diff', ['../secret', 'unstaged']], ['diff', ['escape', 'unstaged']], ['stageFile', [':(top)**']], ['stageFile', ['.git/config']], ['history', [-1]], ['addRemote', ['-x', '/tmp/repo']], ['addRemote', ['origin', 'ext::sh -c anything']], ['confirm', ['bad', 1]], ['stageHunk', ['diff --git a/file.txt b/elsewhere\n', 'file.txt']], ['stageSelected', ['patch', [0.5], 'unstaged', 'file.txt']]]) {
      assert.equal((await rpc(workspaceId, method, args)).ok, false, `${method} ${JSON.stringify(args)}`);
    }
    assert.equal((await request(`/w/${workspaceId}/rpc`, { method: 'state', args: [], directory })).body.ok, false);
    assert.equal((await request(`/w/${workspaceId}/rpc`, { method: 'state' })).body.ok, false);
    assert.equal(command(directory, ['diff', '--cached', '--name-only']), '');
    await fs.mkdir(path.join(directory, 'nested'));
    await fs.writeFile(path.join(directory, 'nested/other.txt'), 'not the reviewed file\n');
    assert.equal((await rpc(workspaceId, 'stageFile', ['nested'])).ok, false);
    assert.equal((await rpc(workspaceId, 'stageFile', ['file.txt'])).ok, false);
    assert.equal(command(directory, ['diff', '--cached', '--name-only']), '');
    await fs.writeFile(path.join(directory, 'file.txt'), 'changed\ntwo\nthree\n');
    const diff = (await rpc(workspaceId, 'diff', ['file.txt', 'unstaged'])).result;
    assert.equal((await rpc(workspaceId, 'stageHunk', [diff.hunks[0].patch, 'file.txt'])).ok, true);
    assert.equal(command(directory, ['diff', '--cached', '--name-only']), 'file.txt');
    assert.equal((await rpc(workspaceId, 'unstageHunk', [(await rpc(workspaceId, 'diff', ['file.txt', 'staged'])).result.hunks[0].patch, 'file.txt'])).ok, true);
  });

  for (const transport of ['native', 'http']) await t.test(`mixed context/changed ranges stage and unstage only selected changes through ${transport}`, async () => {
    const directory = await repo();
    const prefix = Array.from({ length: 12 }, (_, i) => `prefix ${i}`).join('\n') + '\n';
    const base = prefix + 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n';
    const changed = 'earlier insertion\n' + prefix + 'alpha\nfirst replacement\ngamma\nsecond replacement\nepsilon\nzeta\n';
    const firstOnly = prefix + 'alpha\nfirst replacement\ngamma\ndelta\nepsilon\nzeta\n';
    const secondOnly = 'earlier insertion\n' + prefix + 'alpha\nbeta\ngamma\nsecond replacement\nepsilon\nzeta\n';
    await fs.writeFile(path.join(directory, 'file.txt'), base);
    await fs.writeFile(path.join(directory, 'no-newline.txt'), 'before');
    command(directory, ['add', '.']); command(directory, ['commit', '-qm', 'Range fixture']);
    await fs.writeFile(path.join(directory, 'file.txt'), changed);
    const controller = transport === 'native' ? await createWorkspaceController(directory) : null;
    const scope = controller ? null : await workspace(directory);
    const invoke = controller
      ? (method, args = []) => invokeNative(controller, method, args, async () => { throw new Error('Range staging must not show a dialog.'); })
      : (method, args = []) => rpc(scope.workspaceId, method, args);
    const indexContent = (file = 'file.txt') => execFileSync('git', ['-C', directory, 'show', `:${file}`], { encoding: 'utf8' });
    const range = (hunk) => {
      const start = hunk.lines.indexOf(' alpha');
      const end = hunk.lines.indexOf(' gamma');
      assert.ok(start >= 0 && end > start);
      const indexes = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      assert.ok(indexes.some((i) => hunk.lines[i].startsWith(' ')));
      assert.ok(indexes.some((i) => hunk.lines[i].startsWith('+')));
      assert.ok(indexes.some((i) => hunk.lines[i].startsWith('-')));
      return indexes;
    };
    try {
      let hunk = (await invoke('diff', ['file.txt', 'unstaged'])).result.hunks.find((item) => item.lines.includes(' alpha'));
      const selected = range(hunk);
      const changedIndex = selected.find((i) => hunk.lines[i].startsWith('+'));
      for (const indexes of [[selected[0]], [changedIndex, hunk.lines.length], [changedIndex, -1], [changedIndex, 0.5], [changedIndex, hunk.lines.length - 1]]) {
        const invalid = await invoke('stageSelected', [hunk.patch, indexes, 'unstaged', 'file.txt']);
        assert.equal(invalid.ok, false, JSON.stringify(indexes));
        assert.equal(indexContent(), base);
      }
      const staged = await invoke('stageSelected', [hunk.patch, selected, 'unstaged', 'file.txt']);
      assert.equal(staged.ok, true, JSON.stringify(staged));
      assert.equal(indexContent(), firstOnly);
      assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), changed);
      assert.equal(execFileSync('git', ['-C', directory, 'show', 'HEAD:file.txt'], { encoding: 'utf8' }), base);
      assert.equal((await invoke('stageAll')).ok, true);
      assert.equal(indexContent(), changed);
      hunk = (await invoke('diff', ['file.txt', 'staged'])).result.hunks.find((item) => item.lines.includes(' alpha'));
      const starts = hunk.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      assert.notEqual(starts[1], starts[2]); // prior staged insertion shifts the reverse source
      const unstaged = await invoke('stageSelected', [hunk.patch, range(hunk), 'staged', 'file.txt']);
      assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
      assert.equal(indexContent(), secondOnly);
      assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), changed);
      // EOF metadata is part of the exact server hunk, but is not a selectable body line.
      await fs.writeFile(path.join(directory, 'no-newline.txt'), 'after');
      const eof = (await invoke('diff', ['no-newline.txt', 'unstaged'])).result.hunks[0];
      const metadata = eof.lines.findIndex((line) => line.startsWith('\\'));
      const addition = eof.lines.findIndex((line) => line.startsWith('+'));
      assert.ok(metadata >= 0 && addition >= 0);
      assert.equal((await invoke('stageSelected', [eof.patch, [addition, metadata], 'unstaged', 'no-newline.txt'])).ok, false);
      assert.equal(indexContent('no-newline.txt'), 'before');
    } finally { await controller?.close(); }
  });

  await t.test('browser facade keeps selected-line, hunk, branch, history and review capabilities with existing event context', async () => {
    const directory = await repo(); const { workspaceId, sessionId } = await workspace(directory);
    await fs.writeFile(path.join(directory, 'file.txt'), 'one\nchanged\nthree\n');
    let hunk = (await rpc(workspaceId, 'diff', ['file.txt', 'unstaged'])).result.hunks[0];
    const indexes = hunk.lines.flatMap((line, i) => /^[+-]/.test(line) ? [i] : []);
    assert.equal((await rpc(workspaceId, 'stageSelected', [hunk.patch, indexes, 'unstaged', 'file.txt'])).ok, true);
    assert.equal((await rpc(workspaceId, 'unstageAll')).ok, true);
    hunk = (await rpc(workspaceId, 'diff', ['file.txt', 'unstaged'])).result.hunks[0];
    let reply = await rpc(workspaceId, 'discardHunk', [hunk.patch, 'file.txt']);
    assert.ok(reply.confirmation);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, true);
    await fs.writeFile(path.join(directory, 'file.txt'), 'browser change\n');
    const comment = (await rpc(workspaceId, 'addReviewComment', [{ path: 'file.txt', section: 'unstaged' }, 'Review fixture'])).result.comment;
    assert.equal((await rpc(workspaceId, 'editReviewComment', [comment.id, 'Edited fixture'])).ok, true);
    assert.equal((await rpc(workspaceId, 'reviewState')).result.comments[0].body, 'Edited fixture');
    assert.equal((await rpc(workspaceId, 'resolveReviewComment', [comment.id])).ok, true);
    assert.equal((await rpc(workspaceId, 'stageAll')).ok, true);
    assert.equal((await rpc(workspaceId, 'commit', ['Browser commit', false])).ok, true);
    const history = (await rpc(workspaceId, 'history')).result;
    const details = (await rpc(workspaceId, 'commitDetails', [history[0].hash])).result;
    assert.equal(details.files[0].path, 'file.txt');
    assert.equal((await rpc(workspaceId, 'commitFileDiff', [history[0].hash, null, 'file.txt'])).ok, true);
    assert.equal((await rpc(workspaceId, 'createBranch', ['fixture-branch'])).ok, true);
    assert.equal((await rpc(workspaceId, 'switchBranch', ['main'])).ok, true);
    assert.equal((await rpc(workspaceId, 'branches')).result.length, 2);
    const context = await sessions.getContext(sessionId);
    for (const type of ['stagingChanged', 'hunkDiscarded', 'reviewCommentCreated', 'reviewCommentEdited', 'reviewCommentResolved', 'commitCreated', 'branchCreated', 'branchSwitched']) assert.ok(context.events.some((event) => event.type === type), type);
    assert.equal(context.externalStateChanged, false);
  });

  await t.test('confirmation is one-use, workspace-bound, argument-bound, and stale content is rejected under lock', async () => {
    const directory = await repo(); const first = await workspace(directory); const other = await workspace(await repo());
    const target = path.join(directory, 'file.txt'); await fs.writeFile(target, 'discard me\n');
    let reply = await rpc(first.workspaceId, 'discardFile', ['file.txt']);
    assert.deepEqual(reply.confirmation.choices, ['Cancel', 'Discard file changes']);
    assert.equal(await fs.readFile(target, 'utf8'), 'discard me\n');
    assert.equal((await rpc(other.workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, false);
    assert.equal((await rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 1, 'other.txt'])).ok, false);
    assert.equal((await rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 0])).result.cancelled, true);
    assert.equal((await rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, false);
    reply = await rpc(first.workspaceId, 'discardFile', ['file.txt']);
    const identity = await git.getRepositoryIdentity(directory);
    await withFileLock(path.join(identity.gitCommonDirectory, 'gittygo-mutation'), async () => {
      let settled = false;
      const confirmation = rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 1]).then((result) => { settled = true; return result; });
      await delay(70); assert.equal(settled, false);
      await fs.writeFile(target, 'new external content\n');
      // Do not await while holding lock; continuation waits for release.
      reply = { confirmationPromise: confirmation };
    });
    const stale = await reply.confirmationPromise;
    assert.equal(stale.ok, false); assert.match(stale.error.message, /changed/);
    assert.equal(await fs.readFile(target, 'utf8'), 'new external content\n');
    reply = await rpc(first.workspaceId, 'discardFile', ['file.txt']);
    assert.equal((await rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'one\ntwo\nthree\n');
    assert.equal((await rpc(first.workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, false);
  });

  await t.test('expired and invalid-choice challenges cannot mutate', async () => {
    const directory = await repo(); const controller = await createWorkspaceController(directory, { confirmationTtlMs: 25 });
    try {
      await fs.writeFile(path.join(directory, 'file.txt'), 'keep\n');
      let reply = await controller.dispatch('discardFile', ['file.txt']);
      await delay(50);
      assert.equal((await controller.dispatch('confirm', [reply.confirmation.id, 1])).ok, false);
      reply = await controller.dispatch('discardFile', ['file.txt']);
      assert.equal((await controller.dispatch('confirm', [reply.confirmation.id, 2])).ok, false);
      assert.equal((await controller.dispatch('confirm', [reply.confirmation.id, 1])).ok, false);
      assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'keep\n');
    } finally { await controller.close(); }
  });

  await t.test('confirmation expires even after approval while waiting for the shared mutation lock', async () => {
    const directory = await repo();
    const controller = await createWorkspaceController(directory, { confirmationTtlMs: 150 });
    try {
      await fs.writeFile(path.join(directory, 'file.txt'), 'retain after expiry\n');
      const reply = await controller.dispatch('discardFile', ['file.txt']);
      const identity = await git.getRepositoryIdentity(directory);
      let completion;
      await withFileLock(path.join(identity.gitCommonDirectory, 'gittygo-mutation'), async () => {
        completion = controller.dispatch('confirm', [reply.confirmation.id, 1]);
        await delay(200);
      });
      const result = await completion;
      assert.equal(result.ok, false); assert.match(result.error.message, /expired/);
      assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'retain after expiry\n');
    } finally { await controller.close(); }
  });

  await t.test('native adapter preserves confirmation, semantic CLI cursor events and UI requests', async () => {
    const directory = await repo();
    const created = await sessions.createSession(directory);
    const controller = await createWorkspaceController(directory, { sessionId: created.session.sessionId });
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../bin/gittygo.cjs'), ...args], { encoding: 'utf8' }));
    try {
      const preload = await fs.readFile(path.join(__dirname, '../src/preload.cjs'), 'utf8');
      for (const method of Object.keys(channels).filter((method) => !['target', 'readTarget'].includes(method))) assert.match(preload, new RegExp(`\\b${method}:`));
      assert.match(preload, /ipcRenderer\.invoke\(reads\.has\(method\) \? 'repo:read-target' : 'repo:target', target, method, args\)/);
      await fs.writeFile(path.join(directory, 'file.txt'), 'native change\n');
      let dialogs = 0;
      const native = (method, args, choice = 1) => invokeNative(controller, method, args, async (spec) => { dialogs++; assert.equal(spec.defaultId, 0); return { response: choice }; });
      assert.equal((await native('stageFile', ['file.txt'])).ok, true);
      assert.equal(dialogs, 0);
      assert.equal((await native('commit', ['Second'])).ok, true);
      const amend = await native('commit', ['Amended', true]); assert.equal(amend.ok, true);
      assert.equal(dialogs, 1);
      let context = cli('context', '--session', controller.sessionId, '--after', '0', '--json');
      assert.deepEqual(context.events.map((event) => event.type), ['stagingChanged', 'commitCreated', 'commitAmended']);
      assert.deepEqual(context.events[0].payload.paths, ['file.txt']);
      const journal = await fs.readFile(path.join(process.env.GITTYGO_STATE_DIR, 'sessions', controller.sessionId, 'events.jsonl'), 'utf8');
      assert.equal(JSON.parse(journal.split('\n')[0]).type, 'fileStaged');
      assert.equal(context.events[1].payload.currentHead.length > 0, true);
      const cursor = context.nextCursor;
      assert.equal((await native('undoCommit', [], 2)).ok, true);
      context = cli('context', '--session', controller.sessionId, '--after', String(cursor), '--json');
      assert.equal(context.events[0].type, 'commitUndone'); assert.equal(context.events[0].payload.changesPreservedAs, 'unstaged');
      const comment = await controller.dispatch('addReviewComment', [{ path: 'file.txt', section: 'unstaged', startLine: 1, endLine: 1 }, 'Fixture comment']);
      assert.equal(comment.ok, true);
      cli('review', 'focus', '--session', controller.sessionId, '--comment', comment.result.comment.id, '--json');
      cli('commit-message', 'set', '--session', controller.sessionId, '--message', 'Draft fixture', '--json');
      const requests = (await controller.dispatch('uiRequests')).result;
      assert.equal(requests.focusRequest.commentId, comment.result.comment.id);
      assert.equal(requests.commitMessageRequest.message, 'Draft fixture');
      assert.deepEqual((await controller.dispatch('uiRequests')).result, { focusRequest: null, commitMessageRequest: requests.commitMessageRequest });
      assert.equal((await native('discardFile', ['file.txt'], 0)).result.cancelled, true);
      const staleNative = await invokeNative(controller, 'discardFile', ['file.txt'], async () => {
        await fs.writeFile(path.join(directory, 'file.txt'), 'new while native dialog open\n');
        return { response: 1 };
      });
      assert.equal(staleNative.ok, false); assert.match(staleNative.error.message, /changed/);
      assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'new while native dialog open\n');
    } finally { await controller.close(); }
  });

  await t.test('guarded remotes, pull, push, amendment and configuration/ref freshness use local bare remotes only', async () => {
    const directory = await repo(); const { workspaceId } = await workspace(directory);
    const bare = path.join(root, 'remote.git'); await fs.mkdir(bare); command(bare, ['init', '--bare', '-q']);
    assert.equal((await rpc(workspaceId, 'addRemote', ['origin', bare])).ok, true);
    let reply = await rpc(workspaceId, 'push'); assert.ok(reply.confirmation);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, true);
    assert.equal((await rpc(workspaceId, 'fetch')).ok, true);
    reply = await rpc(workspaceId, 'pull'); assert.ok(reply.confirmation);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, true);
    reply = await rpc(workspaceId, 'commit', ['Amend fixture', true]);
    command(directory, ['config', 'fixture.changed', 'yes']);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, false);
    reply = await rpc(workspaceId, 'push');
    command(directory, ['update-ref', 'refs/remotes/origin/fixture', 'HEAD']);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, false);
    reply = await rpc(workspaceId, 'removeRemote', ['origin']);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 0])).result.cancelled, true);
    assert.equal((await rpc(workspaceId, 'remotes')).result.length, 1);
    reply = await rpc(workspaceId, 'removeRemote', ['origin']);
    assert.equal((await rpc(workspaceId, 'confirm', [reply.confirmation.id, 1])).ok, true);
    assert.deepEqual((await rpc(workspaceId, 'remotes')).result, []);
  });

  await t.test('HTTP request IDs execute concurrent commit/comment/confirmation/consuming calls at most once per runtime', async () => {
    const directory = await repo(); const { workspaceId, sessionId } = await workspace(directory);
    const endpoint = `/w/${workspaceId}/rpc`;
    for (const method of ['stageAll', 'commit', 'addReviewComment', 'confirm', 'uiRequests']) {
      const missing = await request(endpoint, { method, args: [] });
      assert.equal(missing.body.ok, false); assert.match(missing.body.error.message, /requestId/);
    }
    assert.equal((await request(endpoint, { method: 'state', args: [] })).body.ok, true);
    assert.equal((await rpc(workspaceId, 'state', [], 'not-a-uuid')).ok, false);
    await fs.writeFile(path.join(directory, 'file.txt'), 'idempotent commit\n');
    command(directory, ['add', 'file.txt']);
    const commitId = randomUUID(); const identity = await git.getRepositoryIdentity(directory);
    let duplicates;
    await withFileLock(path.join(identity.gitCommonDirectory, 'gittygo-mutation'), async () => {
      duplicates = Promise.all(Array.from({ length: 8 }, () => rpc(workspaceId, 'commit', ['Only once', false], commitId)));
      await delay(60);
      assert.equal(command(directory, ['rev-list', '--count', 'HEAD']), '1');
      const conflict = await rpc(workspaceId, 'commit', ['Different payload', false], commitId);
      assert.equal(conflict.ok, false); assert.match(conflict.error.message, /different/);
    });
    const commits = await duplicates;
    assert.equal(commits[0].ok, true); commits.forEach((reply) => assert.deepEqual(reply, commits[0]));
    assert.equal(command(directory, ['rev-list', '--count', 'HEAD']), '2');
    assert.deepEqual(await rpc(workspaceId, 'commit', ['Only once', false], commitId), commits[0]);
    assert.equal((await rpc(workspaceId, 'state', [], commitId)).ok, false);
    await fs.writeFile(path.join(directory, 'file.txt'), 'review before discard\n');
    const commentId = randomUUID();
    const args = [{ path: 'file.txt', section: 'unstaged' }, 'One comment'];
    const comments = await Promise.all(Array.from({ length: 8 }, () => rpc(workspaceId, 'addReviewComment', args, commentId)));
    comments.forEach((reply) => assert.deepEqual(reply, comments[0])); assert.equal(comments[0].ok, true);
    assert.equal((await rpc(workspaceId, 'reviewState')).result.comments.length, 1);
    // Property order changes do not change the payload's identity.
    assert.deepEqual(await rpc(workspaceId, 'addReviewComment', [{ section: 'unstaged', path: 'file.txt' }, 'One comment'], commentId), comments[0]);
    const prepareId = randomUUID();
    const prepared = await Promise.all(Array.from({ length: 4 }, () => rpc(workspaceId, 'discardFile', ['file.txt'], prepareId)));
    prepared.forEach((reply) => assert.deepEqual(reply, prepared[0])); assert.ok(prepared[0].confirmation);
    const confirmId = randomUUID();
    const confirmed = await Promise.all(Array.from({ length: 8 }, () => rpc(workspaceId, 'confirm', [prepared[0].confirmation.id, 1], confirmId)));
    confirmed.forEach((reply) => assert.deepEqual(reply, confirmed[0])); assert.equal(confirmed[0].ok, true);
    assert.deepEqual(await rpc(workspaceId, 'discardFile', ['file.txt'], prepareId), prepared[0]);
    assert.equal((await rpc(workspaceId, 'confirm', [prepared[0].confirmation.id, 1])).ok, false);
    await sessions.requestCommitMessage(sessionId, 'Consume once, replay same response');
    const consumingId = randomUUID();
    const consumed = await Promise.all(Array.from({ length: 4 }, () => rpc(workspaceId, 'uiRequests', [], consumingId)));
    consumed.forEach((reply) => assert.deepEqual(reply, consumed[0]));
    assert.equal(consumed[0].result.commitMessageRequest.message, 'Consume once, replay same response');
    assert.deepEqual((await rpc(workspaceId, 'uiRequests')).result.commitMessageRequest, consumed[0].result.commitMessageRequest,'a different view can read the same proposal');
    const journal = (await fs.readFile(path.join(process.env.GITTYGO_STATE_DIR, 'sessions', sessionId, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    for (const type of ['commitCreated', 'reviewCommentCreated', 'fileChangesDiscarded']) assert.equal(journal.filter((event) => event.type === type).length, 1);
  });

  await t.test('a response socket dropped before bytes is safely replayed with its original requestId', async () => {
    const directory = await repo(); const { workspaceId, sessionId } = await workspace(directory);
    const endpoint = `/w/${workspaceId}/rpc`;
    await fs.writeFile(path.join(directory, 'file.txt'), 'lost response fixture\n'); command(directory, ['add', 'file.txt']);
    const body = { method: 'commit', args: ['Commit despite dropped response', false], requestId: randomUUID() };
    let drops = 0;
    const drop = (req, res) => {
      if (req.url === endpoint && req.headers['x-test-drop-response'] === 'yes') {
        res.end = () => { drops++; req.socket.destroy(); return res; };
      }
    };
    async function loseResponse(payload) {
      service.server.on('request', drop);
      try { await assert.rejects(request(endpoint, payload, { headers: { 'X-Test-Drop-Response': 'yes' } }), /socket hang up|ECONNRESET/); }
      finally { service.server.removeListener('request', drop); }
    }
    await loseResponse(body);
    assert.equal(drops, 1); assert.equal(command(directory, ['rev-list', '--count', 'HEAD']), '2');
    const replay = await request(endpoint, body); assert.equal(replay.body.ok, true);
    assert.deepEqual((await request(endpoint, body)).body, replay.body);
    assert.equal(command(directory, ['rev-list', '--count', 'HEAD']), '2');
    await fs.writeFile(path.join(directory, 'file.txt'), 'comment and confirm dropped responses\n');
    const comment = { method: 'addReviewComment', args: [{ path: 'file.txt', section: 'unstaged' }, 'Lost comment response'], requestId: randomUUID() };
    await loseResponse(comment);
    const commentReplay = (await request(endpoint, comment)).body;
    assert.equal(commentReplay.ok, true);
    assert.deepEqual((await request(endpoint, comment)).body, commentReplay);
    assert.equal((await rpc(workspaceId, 'reviewState')).result.comments.length, 1);
    const prepared = await rpc(workspaceId, 'discardFile', ['file.txt']);
    const confirmation = { method: 'confirm', args: [prepared.confirmation.id, 1], requestId: randomUUID() };
    await loseResponse(confirmation);
    const confirmed = (await request(endpoint, confirmation)).body;
    assert.equal(confirmed.ok, true);
    assert.deepEqual((await request(endpoint, confirmation)).body, confirmed);
    assert.equal(drops, 3);
    const context = await sessions.getContext(sessionId);
    for (const type of ['commitCreated', 'reviewCommentCreated', 'fileChangesDiscarded']) assert.equal(context.events.filter((event) => event.type === type).length, 1);
  });

  await t.test('bounded request ledgers never evict/re-execute old IDs; result overflow fails closed', async () => {
    let calls = 0;
    const ledger = createRpcLedger({ maxEntries: 2, maxWorkspaceEntries: 2 });
    const first = { method: 'commit', args: ['one'], requestId: randomUUID() };
    const second = { method: 'commit', args: ['two'], requestId: randomUUID() };
    const action = () => ({ ok: true, result: ++calls });
    const response = await ledger.execute('workspace', first, action);
    await ledger.execute('workspace', second, action);
    assert.throws(() => ledger.execute('workspace', { ...first, requestId: randomUUID() }, action), /full/);
    assert.equal(await ledger.execute('workspace', first, action), response); assert.equal(calls, 2);
    assert.throws(() => ledger.execute('new-workspace', first, action), /full/);
    const scoped = createRpcLedger({ maxWorkspaceEntries: 1 });
    await scoped.execute('same-workspace', first, () => ({ ok: true, result: 'scoped' }));
    assert.throws(() => scoped.execute('same-workspace', second, action), /full/);
    assert.equal(JSON.parse(await scoped.execute('same-workspace', first, action)).result, 'scoped');
    assert.equal(calls, 2);
    assert.throws(() => ledger.execute('workspace', { ...first, args: ['changed'] }, action), /different/);
    const small = createRpcLedger({ maxBytes: 1024 });
    const overflow = await small.execute('workspace', first, () => { calls++; return { ok: true, result: 'x'.repeat(4096) }; });
    assert.match(JSON.parse(overflow).error.message, /may have completed/);
    assert.equal(await small.execute('workspace', first, action), overflow); assert.equal(calls, 3);
    assert.throws(() => small.execute('workspace', second, action), /full/);
    assert.equal(JSON.parse(await small.execute('workspace', { method: 'state', args: [] }, () => ({ ok: true, result: 'refresh allowed' }))).result, 'refresh allowed');
    const otherWorkspace = createRpcLedger();
    assert.equal(JSON.parse(await otherWorkspace.execute('second', first, action)).ok, true);
    const inFlight = createRpcLedger({ maxEntries: 1 });
    let finish; let executions = 0;
    const reserved = inFlight.execute('workspace', first, () => { executions++; return new Promise((resolve) => { finish = resolve; }); });
    assert.equal(executions, 0); // reservation precedes scheduling dispatch
    const joined = inFlight.execute('workspace', first, action);
    assert.equal(joined, reserved);
    assert.throws(() => inFlight.execute('workspace', second, action), /full/);
    await Promise.resolve(); finish({ ok: true, result: 'reserved before exhaustion' });
    assert.equal(await reserved, await joined); assert.equal(executions, 1);
    const concurrentOverflow = createRpcLedger({ maxBytes: 1600 });
    const oversized = concurrentOverflow.execute('workspace', first, () => ({ ok: true, result: 'x'.repeat(4096) }));
    const alreadyReserved = concurrentOverflow.execute('workspace', second, () => ({ ok: true, result: 'still resolves' }));
    assert.match(JSON.parse(await oversized).error.message, /may have completed/);
    assert.equal(JSON.parse(await alreadyReserved).result, 'still resolves');
    assert.equal(await concurrentOverflow.execute('workspace', second, action), await alreadyReserved);
  });

  await t.test('a fresh runtime never accepts a previous runtime workspace URL', async () => {
    const directory = await repo(); const oldWorkspace = await workspace(directory);
    const fresh = await startWorkspaceService({ token });
    try {
      const old = await fetch(`${fresh.url}/w/${oldWorkspace.workspaceId}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'stageAll', args: [], requestId: randomUUID() }) });
      assert.equal(old.status, 404);
      const created = await fetch(`${fresh.url}/api/workspaces`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) });
      const current = (await created.json()).result;
      assert.notEqual(current.workspaceId, oldWorkspace.workspaceId);
    } finally { await fresh.close(); }
  });

  await t.test('standalone service CLI starts without Electron, accepts supplied token/port and shuts down cleanly', async () => {
    await assert.rejects(startWorkspaceService({ token: 'short' }), /token/);
    await assert.rejects(startWorkspaceService({ token, allowedOrigins: ['https://bad.invalid/path'] }), /origins/);
    const child = spawn(process.execPath, [path.join(__dirname, '../bin/gittygo-service.cjs'), '--port', '0'], { env: { ...process.env, GITTYGO_SERVICE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = '';
    child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { stderr += part; });
    const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
    try {
      for (let i = 0; i < 100 && !output.includes('\n'); i++) await delay(10);
      const ready = JSON.parse(output.trim());
      assert.equal(ready.service, 'gittygo-workspace'); assert.ok(ready.port > 0); assert.ok(!output.includes(token));
      const health = await fetch(`${ready.url}/health`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(health.status, 200);
      await health.text();
    } finally { child.kill('SIGTERM'); await finished; }
    assert.equal(stderr, '');
  });

  await t.test('a separate desktop/controller process and linked worktree share the common Git lock', async () => {
    const directory = await repo(); const linked = path.join(root, 'lock-linked');
    command(directory, ['worktree', 'add', '-qb', 'lock-linked', linked]);
    await fs.writeFile(path.join(linked, 'file.txt'), 'from child\n');
    const identity = await git.getRepositoryIdentity(directory);
    let child; let output = ''; let done;
    await withFileLock(path.join(identity.gitCommonDirectory, 'gittygo-mutation'), async () => {
      const code = `const {createWorkspaceController}=require(${JSON.stringify(path.join(__dirname, '../src/workspace-controller.cjs'))}); (async()=>{console.log('ready'); const c=await createWorkspaceController(process.argv[1]); console.log(JSON.stringify(await c.dispatch('stageFile',['file.txt']))); await c.close();})().catch(e=>{console.error(e);process.exitCode=1});`;
      child = spawn(process.execPath, ['-e', code, linked], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
      child.stdout.on('data', (data) => { output += data; });
      done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
      for (let i = 0; i < 100 && !output.includes('ready'); i++) await delay(10);
      assert.match(output, /ready/); await delay(70);
      assert.equal(command(linked, ['diff', '--cached', '--name-only']), '');
      assert.ok(!output.includes('"ok"'));
    });
    await done; assert.match(output, /"ok":true/);
    assert.equal(command(linked, ['diff', '--cached', '--name-only']), 'file.txt');
  });
});
