const { contextBridge, ipcRenderer } = require('electron');
// Keep the native facade authoritative; capture mutation target before IPC.
const channels = { state: 'repo:state', reviewState: 'review:state', addReviewComment: 'review:add-comment', editReviewComment: 'review:edit-comment', resolveReviewComment: 'review:resolve-comment', diff: 'repo:diff', stageFile: 'repo:stage-file', unstageFile: 'repo:unstage-file', stageAll: 'repo:stage-all', unstageAll: 'repo:unstage-all', discardFile: 'repo:discard-file', stageHunk: 'repo:stage-hunk', unstageHunk: 'repo:unstage-hunk', discardHunk: 'repo:discard-hunk', stageSelected: 'repo:stage-selected', commit: 'repo:commit', history: 'repo:history', commitDetails: 'repo:commit-details', commitFileDiff: 'repo:commit-file-diff', remotes: 'repo:remotes', branches: 'repo:branches', fetch: 'repo:fetch', pull: 'repo:pull', push: 'repo:push', undoCommit: 'repo:undo-commit', addRemote: 'repo:add-remote', removeRemote: 'repo:remove-remote', switchBranch: 'repo:switch-branch', createBranch: 'repo:create-branch', worktrees: 'repo:worktrees', selectWorktree: 'repo:select-worktree', createWorktree: 'repo:create-worktree', removeWorktree: 'repo:remove-worktree', initializeRepository: 'repo:initialize' };
const reads = new Set(['state', 'reviewState', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'remotes', 'branches', 'worktrees']);
let target;
const api = {};
for (const [method, channel] of Object.entries(channels)) {
  api[method] = async (...args) => {
    const scoped = target && !['state', 'reviewState', 'worktrees', 'selectWorktree', 'initializeRepository'].includes(method);
    const reply = await (scoped ? ipcRenderer.invoke(reads.has(method) ? 'repo:read-target' : 'repo:target', target, method, args) : ipcRenderer.invoke(channel, ...args));
    if (reply.ok && ['state', 'selectWorktree'].includes(method)) target = reply.result.repo;
    return reply;
  };
}
for (const [name, channel] of Object.entries({ Changed: 'repo:changed', ReviewChanged: 'review:changed', FocusComment: 'review:focus-comment', SetCommitMessage: 'ui:set-commit-message', Error: 'repo:error' })) {
  api[`on${name}`] = (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));
}
contextBridge.exposeInMainWorld('gittyGo', api);
