const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { stateRoot } = require('./state-root.cjs');

function reviewDirectory(repoIdentity) {
  if (!/^[a-f0-9]{64}$/.test(repoIdentity)) throw new Error('Invalid repository identity.');
  return path.join(stateRoot(), 'repositories', repoIdentity);
}

function reviewFile(repoIdentity) { return path.join(reviewDirectory(repoIdentity), 'review.json'); }
function emptyState(repoIdentity) { return { version: 2, repoIdentity, comments: [] }; }

function normalizeState(value, repoIdentity) {
  if (value?.version === 2 && Array.isArray(value.comments)) return value;
  const comments = [];
  if (value?.draft?.comments) comments.push(...value.draft.comments);
  if (Array.isArray(value?.reviews)) {
    value.reviews.forEach((review) => comments.push(...review.comments.filter((comment) => comment.status !== 'resolved')));
  }
  return { version: 2, repoIdentity, comments: comments.map((comment) => ({ ...comment, status: 'open' })) };
}

async function writeJsonSecure(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function loadState(repoIdentity) {
  const value = await fs.readFile(reviewFile(repoIdentity), 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return emptyState(repoIdentity);
    throw error;
  });
  return normalizeState(value, repoIdentity);
}

let updateQueue = Promise.resolve();
function updateState(repoIdentity, mutate) {
  const operation = updateQueue.then(async () => {
    const directory = reviewDirectory(repoIdentity);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const state = await loadState(repoIdentity);
    const result = await mutate(state);
    await writeJsonSecure(reviewFile(repoIdentity), state);
    return { state, result };
  });
  updateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function normalizeBody(body) {
  const value = String(body || '').trim();
  if (!value) throw new Error('Comment text is required.');
  if (value.length > 20000) throw new Error('Comment text is too long.');
  return value;
}

function publicState(state) {
  return { comments: state.comments, openCommentCount: state.comments.length };
}

async function getReviewState(repoIdentity) { return publicState(await loadState(repoIdentity)); }
async function getAgentReviewState(repoIdentity) { return getReviewState(repoIdentity); }

async function addComment(repoIdentity, anchor, body, actor = 'user-ui') {
  return updateState(repoIdentity, (state) => {
    const comment = {
      id: `rc-${crypto.randomUUID()}`,
      status: 'open',
      body: normalizeBody(body),
      anchor: { ...anchor },
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    state.comments.push(comment);
    return comment;
  }).then(({ state, result }) => ({ comment: result, ...publicState(state) }));
}

async function editComment(repoIdentity, commentId, body) {
  return updateState(repoIdentity, (state) => {
    const comment = state.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error('Open review comment was not found.');
    comment.body = normalizeBody(body);
    comment.editedAt = new Date().toISOString();
    return comment;
  }).then(({ state, result }) => ({ comment: result, ...publicState(state) }));
}

async function resolveComment(repoIdentity, commentId, note, actor = 'user-ui') {
  return updateState(repoIdentity, (state) => {
    const index = state.comments.findIndex((item) => item.id === commentId);
    if (index < 0) throw new Error('Open review comment was not found.');
    const [comment] = state.comments.splice(index, 1);
    const cleanNote = note == null ? '' : String(note).trim();
    return {
      comment,
      resolution: { actor, time: new Date().toISOString(), ...(cleanNote ? { note: cleanNote } : {}) },
    };
  }).then(({ state, result }) => ({ ...result, ...publicState(state) }));
}

module.exports = {
  getReviewState,
  getAgentReviewState,
  addComment,
  editComment,
  resolveComment,
};
