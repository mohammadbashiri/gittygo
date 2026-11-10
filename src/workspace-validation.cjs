const path = require('node:path');
const fs = require('node:fs/promises');
const git = require('./git-service.cjs');
const text = (v, max = 4096) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const nonempty = (v) => text(v) && v.length > 0;
const file = (v) => nonempty(v) && !path.isAbsolute(v) && !v.startsWith(':') && !v.split(/[\\/]/).some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git');
const name = (v) => nonempty(v) && !v.startsWith('-') && !/[\r\n]/.test(v);
const section = (v) => v === 'staged' || v === 'unstaged';
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{7,40}$/i.test(v);
const patch = (v) => text(v, 2 * 1024 * 1024) && v.length > 0;
const schemas = {
  target: [nonempty, nonempty, Array.isArray], readTarget: [nonempty, nonempty, Array.isArray],
  worktrees: [], selectWorktree: [nonempty], createWorktree: [(v) => nonempty(v) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v), name, (v) => typeof v === 'boolean'], removeWorktree: [nonempty], initializeRepository: [],
  state: [], reviewState: [], uiRequests: [], stageAll: [], unstageAll: [], remotes: [], branches: [], fetch: [], pull: [], push: [], undoCommit: [],
  addReviewComment: [(v) => v && typeof v === 'object' && !Array.isArray(v) && file(v.path) && section(v.section), (v) => text(v, 50000)],
  editReviewComment: [nonempty, (v) => text(v, 50000)], resolveReviewComment: [nonempty],
  diff: [file, section], stageFile: [file], unstageFile: [file], discardFile: [file],
  stageHunk: [patch, file], unstageHunk: [patch, file], discardHunk: [patch, file],
  stageSelected: [patch, (v) => Array.isArray(v) && v.length > 0 && v.length <= 100000 && v.every((i) => Number.isSafeInteger(i) && i >= 0), section, file],
  commit: [(v) => text(v, 100000), (v) => v === undefined || typeof v === 'boolean'],
  history: [(v) => v === undefined || (Number.isSafeInteger(v) && v >= 1 && v <= 500)],
  commitDetails: [hash], commitFileDiff: [hash, (v) => v === null || file(v), file],
  addRemote: [(v) => name(v) && /^[A-Za-z0-9._-]+$/.test(v), (v) => name(v) && !/^[a-zA-Z][\w+.-]*::/.test(v)],
  removeRemote: [name], switchBranch: [name], createBranch: [name],
  confirm: [(v) => typeof v === 'string' && /^[a-f0-9]{48}$/.test(v), (v) => Number.isSafeInteger(v) && v >= 0 && v <= 2],
};
function validateCall(method, args) {
  if (typeof method !== 'string' || !Object.hasOwn(schemas, method) || !Array.isArray(args)) throw new Error('Unknown method or invalid arguments.');
  const schema = schemas[method];
  const min = method === 'history' ? 0 : method === 'commit' ? 1 : schema.length;
  if (args.length < min || args.length > schema.length || !schema.every((check, i) => check(args[i]))) throw new Error('Invalid arguments.');
}
async function confined(repo, value) {
  let target = path.resolve(repo, value);
  while (true) {
    try {
      const resolved = await fs.realpath(target);
      if (resolved !== repo && !resolved.startsWith(repo + path.sep)) throw new Error('Path escapes the worktree.');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      target = parent;
    }
  }
}
async function validateReviewedPatch(repo, method, args) {
  const positions = { diff: [0], stageFile: [0], unstageFile: [0], discardFile: [0], stageHunk: [1], unstageHunk: [1], discardHunk: [1], stageSelected: [3], commitFileDiff: [1, 2] };
  for (const index of positions[method] || []) if (args[index] !== null) await confined(repo, args[index]);
  if (method === 'addReviewComment') await confined(repo, args[0].path);
  if (['stageFile', 'unstageFile', 'discardFile'].includes(method)) {
    const state = await git.getState(repo);
    const files = method === 'unstageFile' ? state.staged : state.changes;
    if (!files.some((item) => item.path === args[0])) throw new Error('The selected file is no longer present in this change section.');
  }
  if (!['stageHunk', 'unstageHunk', 'discardHunk', 'stageSelected'].includes(method)) return;
  const filePath = args[method === 'stageSelected' ? 3 : 1];
  const selectedSection = method === 'stageSelected' ? args[2] : method === 'unstageHunk' ? 'staged' : 'unstaged';
  const diff = await git.getDiff(repo, filePath, selectedSection);
  const hunks = git.extractHunks(diff.patch);
  const hunk = hunks.find((item) => item.patch === args[0]);
  if (!hunk) throw new Error('The supplied hunk is not part of the current file diff. Refresh and select it again.');
  if (method === 'stageSelected') {
    // Renderer range selection includes context. Only real hunk body lines are
    // selectable (not EOF/newline metadata), and at least one change is required.
    const validBody = args[1].every((i) => i < hunk.lines.length && /^[ +\-]/.test(hunk.lines[i]));
    const includesChange = args[1].some((i) => /^[+\-]/.test(hunk.lines[i] || ''));
    if (!validBody || !includesChange) throw new Error('Invalid selected line indexes.');
  }
}
module.exports = { validateCall, validateReviewedPatch };
