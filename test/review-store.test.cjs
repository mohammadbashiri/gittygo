const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reviews = require('../src/review-store.cjs');

const identity = 'a'.repeat(64);

function setup(t) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittygo-comments-'));
  process.env.GITTYGO_STATE_DIR = stateDirectory;
  t.after(() => {
    delete process.env.GITTYGO_STATE_DIR;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  });
}

test('comments are immediately active, editable, and removed on resolution', async (t) => {
  setup(t);
  const anchor = { path: 'src/app.js', section: 'unstaged', side: 'new', startLine: 4, endLine: 6, selectedText: ['one', 'two'] };
  const first = await reviews.addComment(identity, anchor, 'Please simplify this.');
  const second = await reviews.addComment(identity, { ...anchor, startLine: 10, endLine: 10 }, 'Can this be null?');
  assert.equal(second.comments.length, 2);

  const edited = await reviews.editComment(identity, first.comment.id, 'Please simplify this branch.');
  assert.equal(edited.comment.body, 'Please simplify this branch.');

  const resolved = await reviews.resolveComment(identity, first.comment.id, undefined, 'agent-cli');
  assert.equal(resolved.resolution.note, undefined);
  assert.equal(resolved.comments.length, 1);
  assert.equal(resolved.comments[0].id, second.comment.id);
  const finalResolution = await reviews.resolveComment(identity, second.comment.id, 'No longer actionable.', 'user-ui');
  assert.equal(finalResolution.resolution.note, 'No longer actionable.');
  assert.equal(finalResolution.comments.length, 0);
  assert.equal(finalResolution.openCommentCount, 0);
});

