const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../src/git-service.cjs');
const sessions = require('../src/session-store.cjs');
const reviews = require('../src/review-store.cjs');

function command(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-session-repo-'));
  command(repo, ['init', '-q']);
  command(repo, ['config', 'user.name', 'Test User']);
  command(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'original\n');
  command(repo, ['add', '.']);
  command(repo, ['commit', '-qm', 'Initial']);
  return repo;
}

test('session is repository-bound and context uses ordered cursors', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-state-'));
  const repo = createRepo();
  process.env.GITTYGO_STATE_DIR = stateDirectory;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const created = await sessions.createSession(repo);
  assert.match(created.session.sessionId, /^gg-[a-f0-9]{32}$/);
  assert.equal(created.cursor, 0);
  assert.equal(created.snapshot.head.length > 0, true);

  fs.writeFileSync(path.join(repo, 'file.txt'), 'changed\n');
  await git.stageFile(repo, 'file.txt');
  let state = await git.getState(repo);
  await sessions.appendEvent(created.session.sessionId, { type: 'fileStaged', payload: { path: 'file.txt' } }, state);
  await sessions.appendEvent(created.session.sessionId, { type: 'hunkUnstaged', payload: { path: 'file.txt' } }, state);
  await sessions.appendEvent(created.session.sessionId, { type: 'branchCreated', payload: { name: 'feature' } }, state);

  const first = await sessions.getContext(created.session.sessionId, 0);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].type, 'stagingChanged');
  assert.equal(first.events[0].payload.operationCount, 2);
  assert.equal(first.events[1].type, 'branchCreated');
  assert.equal(first.nextCursor, 3);
  assert.equal(first.hasMore, false);
  assert.equal(first.repo.root, await fs.promises.realpath(repo));

  const repeated = await sessions.getContext(created.session.sessionId, 0);
  assert.deepEqual(repeated.events.map((event) => event.eventId), first.events.map((event) => event.eventId));
  const empty = await sessions.getContext(created.session.sessionId, first.nextCursor);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.nextCursor, 3);
});

test('concurrent event writers allocate unique ordered sequences', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-state-'));
  const repo = createRepo();
  process.env.GITTYGO_STATE_DIR = stateDirectory;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const created = await sessions.createSession(repo);
  await Promise.all(Array.from({ length: 20 }, (_, index) => sessions.appendEvent(created.session.sessionId, { type: 'testEvent', payload: { index } })));
  const context = await sessions.getContext(created.session.sessionId, 0);
  assert.deepEqual(context.events.map((event) => event.seq), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(new Set(context.events.map((event) => event.eventId)).size, 20);
});

test('open comments are immediately authoritative context alongside their event', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-state-'));
  const repo = createRepo();
  process.env.GITTYGO_STATE_DIR = stateDirectory;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const created = await sessions.createSession(repo);
  const added = await reviews.addComment(created.session.repoIdentity, { path: 'file.txt', section: 'unstaged', side: 'new', startLine: 1, endLine: 1 }, 'Please rename this.');
  await sessions.appendEvent(created.session.sessionId, { type: 'reviewCommentCreated', payload: { comment: added.comment } });
  const context = await sessions.getContext(created.session.sessionId, 0);
  assert.equal(context.events[0].type, 'reviewCommentCreated');
  assert.equal(context.review.comments[0].id, added.comment.id);
  assert.equal(context.review.openCommentCount, 1);
  await sessions.requestCommentFocus(created.session.sessionId, added.comment.id);
  assert.equal((await sessions.consumeCommentFocus(created.session.sessionId)).commentId, added.comment.id);
  assert.equal(await sessions.consumeCommentFocus(created.session.sessionId), null);
  await sessions.requestCommitMessage(created.session.sessionId, 'Address review feedback');
  assert.equal((await sessions.consumeCommitMessage(created.session.sessionId)).message, 'Address review feedback');
  assert.equal(await sessions.consumeCommitMessage(created.session.sessionId), null);
});

test('context detects repository state changed outside recorded UI events', async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-state-'));
  const repo = createRepo();
  process.env.GITTYGO_STATE_DIR = stateDirectory;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const created = await sessions.createSession(repo);
  fs.appendFileSync(path.join(repo, 'file.txt'), 'external\n');
  const context = await sessions.getContext(created.session.sessionId, 0);
  assert.equal(context.events.length, 0);
  assert.equal(context.externalStateChanged, true);
  assert.equal(context.snapshot.unstaged.length, 1);
});
