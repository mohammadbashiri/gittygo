// Shared desktop/browser orchestration. No Electron dependency.
const crypto = require('node:crypto');
const path = require('node:path');
const gitService = require('./git-service.cjs');
const sessionStore = require('./session-store.cjs');
const reviewStore = require('./review-store.cjs');
const { withFileLock } = require('./file-lock.cjs');
const { validateCall, validateReviewedPatch } = require('./workspace-validation.cjs');
const channels = {"state": "repo:state", "reviewState": "review:state", "addReviewComment": "review:add-comment", "editReviewComment": "review:edit-comment", "resolveReviewComment": "review:resolve-comment", "diff": "repo:diff", "stageFile": "repo:stage-file", "unstageFile": "repo:unstage-file", "stageAll": "repo:stage-all", "unstageAll": "repo:unstage-all", "discardFile": "repo:discard-file", "stageHunk": "repo:stage-hunk", "unstageHunk": "repo:unstage-hunk", "discardHunk": "repo:discard-hunk", "stageSelected": "repo:stage-selected", "commit": "repo:commit", "history": "repo:history", "commitDetails": "repo:commit-details", "commitFileDiff": "repo:commit-file-diff", "remotes": "repo:remotes", "branches": "repo:branches", "fetch": "repo:fetch", "pull": "repo:pull", "push": "repo:push", "undoCommit": "repo:undo-commit", "addRemote": "repo:add-remote", "removeRemote": "repo:remove-remote", "switchBranch": "repo:switch-branch", "createBranch": "repo:create-branch"};
function serializeError(error) { return { message: error.message || String(error), details: error.details || '' }; }

const worktrees = require('./worktrees.cjs');
Object.assign(channels, { readTarget: 'repo:read-target', target: 'repo:target', worktrees: 'repo:worktrees', selectWorktree: 'repo:select-worktree', createWorktree: 'repo:create-worktree', removeWorktree: 'repo:remove-worktree', initializeRepository: 'repo:initialize' });
async function createBoundController(directory, options = {}) {
  const identity = await gitService.getRepositoryIdentity(directory);
  const repository = identity.worktreeRoot;
  let session;
  if (options.sessionId) {
    session = await sessionStore.loadSession(options.sessionId);
    if (session.repoIdentity !== identity.repoIdentity) throw new Error('The supplied GittyGo session belongs to a different worktree.');
  } else if (options.eventSessionId) session = await sessionStore.loadSession(options.eventSessionId);
  else session = (await sessionStore.createSession(repository)).session;
  const sessionId = options.eventSessionId || session.sessionId;
  async function appendEvent(_id, event, state) {
    return sessionStore.appendEvent(sessionId, { ...event, payload: { ...event.payload, targetWorktree: repository, targetRepoIdentity: identity.repoIdentity } }, state || await gitService.getState(repository));
  }
  const repositoryIdentity = identity.repoIdentity;
  // Same target across desktop/service processes AND linked worktrees.
  const lockTarget = path.join(identity.gitCommonDirectory, 'gittygo-mutation');
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const sendState = async () => { await options.onState?.(await gitService.getState(repository)); };
  const sendReview = async () => { await options.onReview?.(await reviewStore.getReviewState(repositoryIdentity)); };
  let mutationQueue = Promise.resolve();
  const pending = new Map();
  const ttl = options.confirmationTtlMs ?? 120000;
  let closed = false;
  // Each invocation gets its own dialog closure (no ambient/current-request slot).
  const { AsyncLocalStorage } = require('node:async_hooks');
  const invocation = new AsyncLocalStorage();
  const mainWindow = null;
  const dialog = { showMessageBox: async (_window, spec) => {
    const call = invocation.getStore();
    if (closed || pending.size >= 64) throw new Error('Workspace closed or confirmation limit reached.');
    const id = crypto.randomBytes(24).toString('hex');
    return new Promise((resolve) => {
      const record = { resolve, call, choices: spec.buttons, expires: Date.now() + ttl };
      record.timer = setTimeout(() => { pending.delete(id); resolve({ response: 0 }); }, ttl);
      record.timer.unref();
      pending.set(id, record);
      call.present({ ok: true, confirmation: { id, title: spec.title, message: spec.message, detail: `Target worktree: ${repository}\n\n${spec.detail || ''}`, choices: spec.buttons } });
    });
  } };
async function inspect(action) {
  try {
    return { ok: true, result: await action() };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function perform(action, eventDescriptor = null) {
  try {
    const call = invocation.getStore();
    if (closed) throw new Error('Workspace is closed.');
    if (call?.confirmationExpires && Date.now() >= call.confirmationExpires) throw new Error('Confirmation expired while waiting for the repository lock.');
    const current = await gitService.getRepositoryIdentity(repository);
    if (current.repoIdentity !== repositoryIdentity) throw new Error('Workspace identity changed.');
    if (call) await validateReviewedPatch(repository, call.method, call.args);
    const before = eventDescriptor ? await gitService.getState(repository) : null;
    const result = await action();
    const after = await gitService.getState(repository);
    if (eventDescriptor && sessionId) {
      const event = typeof eventDescriptor === 'function'
        ? eventDescriptor(result, before, after)
        : eventDescriptor;
      await appendEvent(sessionId, event, after);
    }
    await sendState(true);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function mutate(action, eventDescriptor = null) {
  const result = mutationQueue.then(() => withFileLock(lockTarget, () => perform(action, eventDescriptor), { timeoutMs: 30000 }));
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function mutateIfUnchanged(expectedFingerprint, readFingerprint, action, eventDescriptor = null) {
  return mutate(async () => {
    const currentFingerprint = await readFingerprint();
    if (currentFingerprint !== expectedFingerprint) {
      throw new Error('The repository changed while confirmation was open. Review the latest state and try again.');
    }
    return action();
  }, eventDescriptor);
}

async function confirmationSnapshot() {
  return withFileLock(lockTarget, () => Promise.all([
    gitService.getState(repository), gitService.getRepositoryMutationFingerprint(repository),
  ]), { timeoutMs: 30000 });
}

function registerIpc() {
  ipcMain.handle('repo:worktrees', () => inspect(() => worktrees.list(repository)));
  ipcMain.handle('repo:create-worktree', async (_event, folder, branch, newBranch) => {
    const expected = await worktrees.fingerprint(repository);
    const answer = await dialog.showMessageBox(null, { title: 'Create worktree?', message: `Create ${newBranch ? 'new' : 'existing'} branch “${branch}” in a sibling folder?`, detail: `Destination: ${path.join(path.dirname(repository), folder)}`, buttons: ['Cancel', 'Create worktree'] });
    if (answer.response !== 1) return { ok: true, result: { cancelled: true } };
    return mutateIfUnchanged(expected, () => worktrees.fingerprint(repository), () => worktrees.create(repository, folder, branch, newBranch), (result) => ({ type: 'worktreeCreated', payload: result }));
  });
  ipcMain.handle('repo:remove-worktree', async (_event, target) => {
    const entry = await worktrees.member(repository, target);
    const protectedRoots = () => [options.invokingRoot || repository, ...(options.protectedRoots?.() || []), repository];
    if (entry.main || protectedRoots().includes(target) || entry.dirty || entry.locked || entry.prunable) throw new Error('Only clean, unlocked, non-main worktrees that are not invoking or selected can be removed.');
    if (await worktrees.activeViews(repository, target)) throw new Error('This worktree is retained by an open GittyGo view. Close that window or browser workspace before removing it.');
    const expected = await worktrees.fingerprint(repository);
    const answer = await dialog.showMessageBox(null, { title: 'Remove worktree?', message: `Remove worktree folder ${target}?`, detail: 'The clean folder will be deleted. Its branch is preserved.', buttons: ['Cancel', 'Remove worktree'] });
    if (answer.response !== 1) return { ok: true, result: { cancelled: true } };
    return mutateIfUnchanged(expected, () => worktrees.fingerprint(repository), () => worktrees.remove(repository, target, protectedRoots()), (result) => ({ type: 'worktreeRemoved', payload: result }));
  });
  ipcMain.handle('repo:state', () => inspect(() => gitService.getState(repository)));
  ipcMain.handle('review:state', () => inspect(() => reviewStore.getReviewState(repositoryIdentity)));
  ipcMain.handle('review:add-comment', (_event, anchor, body) => mutate(async () => {
    const state = await gitService.getState(repository);
    const files = [...state.staged, ...state.changes];
    if (!files.some((file) => file.path === anchor.path && file.section === anchor.section)) throw new Error('The commented file is no longer present in this change section.');
    const result = await reviewStore.addComment(repositoryIdentity, anchor, body);
    if (sessionId) await appendEvent(sessionId, { type: 'reviewCommentCreated', payload: { comment: result.comment } }, state);
    await sendReview(true);
    return result;
  }));
  ipcMain.handle('review:edit-comment', (_event, commentId, body) => mutate(async () => {
    const result = await reviewStore.editComment(repositoryIdentity, commentId, body);
    if (sessionId) await appendEvent(sessionId, { type: 'reviewCommentEdited', payload: { comment: result.comment } });
    await sendReview(true); return result;
  }));
  ipcMain.handle('review:resolve-comment', (_event, commentId) => mutate(async () => {
    const result = await reviewStore.resolveComment(repositoryIdentity, commentId, undefined, 'user-ui');
    if (sessionId) {
      const state = await gitService.getState(repository);
      await appendEvent(sessionId, {
        type: 'reviewCommentResolved',
        payload: { commentId },
      }, state);
    }
    await sendReview(true);
    return result;
  }));
  ipcMain.handle('repo:diff', (_event, filePath, section) =>
    inspect(async () => {
      const result = await gitService.getDiff(repository, filePath, section);
      return { ...result, hunks: gitService.extractHunks(result.patch) };
    }),
  );
  ipcMain.handle('repo:stage-file', (_event, filePath) =>
    mutate(() => gitService.stageFile(repository, filePath), { type: 'fileStaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:unstage-file', (_event, filePath) =>
    mutate(() => gitService.unstageFile(repository, filePath), { type: 'fileUnstaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:stage-all', () => mutate(
    () => gitService.stageAll(repository),
    (_result, before) => ({ type: 'allChangesStaged', payload: { fileCount: before.changes.length } }),
  ));
  ipcMain.handle('repo:unstage-all', () => mutate(
    () => gitService.unstageAll(repository),
    (_result, before) => ({ type: 'allChangesUnstaged', payload: { fileCount: before.staged.length } }),
  ));
  ipcMain.handle('repo:stage-hunk', (_event, patch, filePath) =>
    mutate(() => gitService.stageHunk(repository, patch), { type: 'hunkStaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:unstage-hunk', (_event, patch, filePath) =>
    mutate(() => gitService.unstageHunk(repository, patch), { type: 'hunkUnstaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:discard-hunk', async (_event, patch, filePath) => {
    const expectedFingerprint = await gitService.getFileChangeFingerprint(repository, filePath);
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Discard hunk'],
      defaultId: 0,
      cancelId: 0,
      title: 'Discard changes?',
      message: 'Discard this hunk permanently?',
      detail: 'This cannot be undone by Git.',
    });
    if (result.response !== 1) return { ok: true, result: { cancelled: true } };
    return mutateIfUnchanged(
      expectedFingerprint,
      () => gitService.getFileChangeFingerprint(repository, filePath),
      () => gitService.discardHunk(repository, patch),
      { type: 'hunkDiscarded', payload: { path: filePath } },
    );
  });
  ipcMain.handle('repo:discard-file', async (_event, filePath) => {
    const expectedFingerprint = await gitService.getFileChangeFingerprint(repository, filePath);
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Discard file changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Discard changes?',
      message: `Discard all changes to ${filePath}?`,
      detail: 'This cannot be undone by Git.',
    });
    if (result.response !== 1) return { ok: true, result: { cancelled: true } };
    return mutateIfUnchanged(
      expectedFingerprint,
      () => gitService.getFileChangeFingerprint(repository, filePath),
      () => gitService.discardFile(repository, filePath),
      { type: 'fileChangesDiscarded', payload: { path: filePath } },
    );
  });
  ipcMain.handle('repo:stage-selected', (_event, patch, indexes, section, filePath) =>
    mutate(
      () => gitService.stageSelectedLines(repository, patch, indexes, section),
      { type: section === 'staged' ? 'selectedLinesUnstaged' : 'selectedLinesStaged', payload: { path: filePath, lineCount: indexes.length } },
    ),
  );
  ipcMain.handle('repo:commit', async (_event, message, amend = false) => {
    let expectedFingerprint;
    if (amend) {
      const [state, fingerprint] = await confirmationSnapshot();
      expectedFingerprint = fingerprint;
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Amend commit'], defaultId: 0, cancelId: 0,
        title: 'Amend last commit?', message: `Replace commit ${state.head}?`,
        detail: state.upstream && state.ahead === 0 ? 'This commit may already be published. Amending it rewrites history.' : 'The last commit will be replaced with a new commit.',
      });
      if (answer.response !== 1) return { ok: true, result: { cancelled: true } };
    }
    const eventDescriptor = (_result, before, after) => ({
      type: amend ? 'commitAmended' : 'commitCreated',
      payload: { previousHead: before.head, currentHead: after.head },
    });
    if (!amend) return mutate(() => gitService.commit(repository, message, false), eventDescriptor);
    return mutateIfUnchanged(
      expectedFingerprint,
      () => gitService.getRepositoryMutationFingerprint(repository),
      () => gitService.commit(repository, message, true),
      eventDescriptor,
    );
  });
  ipcMain.handle('repo:history', (_event, limit) => inspect(() => gitService.getHistory(repository, limit)));
  ipcMain.handle('repo:commit-details', (_event, hash) => inspect(() => gitService.getCommitDetails(repository, hash)));
  ipcMain.handle('repo:commit-file-diff', (_event, hash, oldPath, filePath) => inspect(() => gitService.getCommitFileDiff(repository, hash, oldPath, filePath)));
  ipcMain.handle('repo:remotes', () => inspect(() => gitService.getRemotes(repository)));
  ipcMain.handle('repo:branches', () => inspect(() => gitService.getBranches(repository)));
  ipcMain.handle('repo:fetch', () => mutate(() => gitService.fetchRemote(repository), { type: 'fetchCompleted' }));
  ipcMain.handle('repo:pull', async () => {
    const [state, expectedFingerprint] = await confirmationSnapshot();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Pull'], defaultId: 0, cancelId: 0,
      title: 'Pull changes?', message: `Pull ${state.upstream || 'the configured upstream'} into ${state.branch}?`,
      detail: `Ahead ${state.ahead} · Behind ${state.behind}. Pull is restricted to fast-forward updates.`,
    });
    return answer.response === 1
      ? mutateIfUnchanged(expectedFingerprint, () => gitService.getRepositoryMutationFingerprint(repository), () => gitService.pull(repository), { type: 'pullCompleted' })
      : { ok: true, result: { cancelled: true } };
  });
  ipcMain.handle('repo:push', async () => {
    const [state, expectedFingerprint] = await confirmationSnapshot();
    const remotes = state.upstream ? [] : await gitService.getRemotes(repository);
    const destination = state.upstream || (remotes.length === 1 ? `${remotes[0].name}/${state.branch}` : 'a selected remote');
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Push'], defaultId: 0, cancelId: 0,
      title: 'Push commits?', message: `Push ${state.branch} to ${destination}?`,
      detail: `Ahead ${state.ahead} · Behind ${state.behind}`,
    });
    return answer.response === 1
      ? mutateIfUnchanged(expectedFingerprint, () => gitService.getRepositoryMutationFingerprint(repository), () => gitService.push(repository), { type: 'pushCompleted' })
      : { ok: true, result: { cancelled: true } };
  });
  ipcMain.handle('repo:undo-commit', async () => {
    const [state, expectedFingerprint] = await confirmationSnapshot();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Keep changes staged', 'Keep changes unstaged'],
      defaultId: 0, cancelId: 0,
      title: 'Undo last commit?',
      message: `Undo commit ${state.head} on ${state.branch}?`,
      detail: state.upstream && state.ahead === 0
        ? 'This commit may already be published. Rewriting published history can disrupt collaborators.'
        : 'The commit will be removed while its file changes are preserved.',
    });
    if (answer.response === 0) return { ok: true, result: { cancelled: true } };
    const keepStaged = answer.response === 1;
    return mutateIfUnchanged(
      expectedFingerprint,
      () => gitService.getRepositoryMutationFingerprint(repository),
      () => gitService.undoLastCommit(repository, keepStaged),
      (_result, before, after) => ({
        type: 'commitUndone',
        payload: { previousHead: before.head, currentHead: after.head, changesPreservedAs: keepStaged ? 'staged' : 'unstaged' },
      }),
    );
  });
  ipcMain.handle('repo:add-remote', (_event, name, url) => mutate(() => gitService.addRemote(repository, name, url), { type: 'remoteAdded', payload: { name } }));
  ipcMain.handle('repo:remove-remote', async (_event, name) => {
    const expectedFingerprint = await gitService.getRepositoryMutationFingerprint(repository);
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Cancel', 'Remove remote'], defaultId: 0, cancelId: 0,
      title: 'Remove remote?', message: `Remove remote “${name}”?`, detail: 'This changes repository configuration but does not delete remote data.',
    });
    return answer.response === 1
      ? mutateIfUnchanged(expectedFingerprint, () => gitService.getRepositoryMutationFingerprint(repository), () => gitService.removeRemote(repository, name), { type: 'remoteRemoved', payload: { name } })
      : { ok: true, result: { cancelled: true } };
  });
  ipcMain.handle('repo:switch-branch', (_event, name) => mutate(
    () => gitService.switchBranch(repository, name),
    (_result, before, after) => ({ type: 'branchSwitched', payload: { previousBranch: before.branch, currentBranch: after.branch } }),
  ));
  ipcMain.handle('repo:create-branch', (_event, name) => mutate(
    () => gitService.createBranch(repository, name),
    (_result, before, after) => ({ type: 'branchCreated', payload: { name, fromBranch: before.branch, currentBranch: after.branch } }),
  ));
}


  registerIpc();
  async function dispatch(method, args = []) {
    try {
      if (closed) throw new Error('Workspace is closed.');
      args = structuredClone(args);
      validateCall(method, args);
      if (method !== 'confirm' && pending.size >= 64) throw new Error('Too many pending confirmations.');
      // Recheck the canonical binding before every invocation, not just creation.
      const current = await gitService.getRepositoryIdentity(repository);
      if (current.repoIdentity !== repositoryIdentity) throw new Error('Workspace identity changed.');
      if (method === 'confirm') {
        const [id, choice] = args;
        const record = pending.get(id);
        if (!record) throw new Error('Invalid or expired confirmation.');
        pending.delete(id); clearTimeout(record.timer);
        if (Date.now() >= record.expires || choice >= record.choices.length) {
          record.resolve({ response: 0 });
          throw new Error('Invalid or expired confirmation choice.');
        }
        record.call.confirmationExpires = record.expires;
        record.resolve({ response: choice });
        return await record.call.result;
      }
      if (method === 'uiRequests') {
        const [focusRequest, commitMessageRequest] = await Promise.all([
          sessionStore.consumeCommentFocus(sessionId), require('./commit-proposals.cjs').readProposal(repository, current),
        ]);
        return { ok: true, result: { focusRequest, commitMessageRequest } };
      }
      // Verify patches against server-generated diffs before they can reach git apply.
      await validateReviewedPatch(repository, method, args);
      let present;
      const shown = new Promise((resolve) => { present = resolve; });
      const call = { present, method, args };
      call.result = invocation.run(call, async () => {
        try { return await handlers.get(channels[method])(null, ...args); }
        catch (error) { return { ok: false, error: serializeError(error) }; }
      });
      return await Promise.race([call.result, shown]);
    } catch (error) { return { ok: false, error: serializeError(error) }; }
  }
  return {
    identity, sessionId, dispatch, hasConfirmation: (id) => pending.has(id),
    close() { closed = true; for (const record of pending.values()) { clearTimeout(record.timer); record.resolve({ response: 0 }); } pending.clear(); return mutationQueue; },
  };
}
// A view owns selection; its invoking coordination session never changes.
async function createWorkspaceController(directory, options = {}) {
  const fs = require('node:fs/promises');
  const root = await fs.realpath(directory);
  let primary;
  try { primary = await createBoundController(root, { ...options, protectedRoots: () => [selected] }); }
  catch (error) {
    if (!/not a git repository/i.test(error.message)) throw error;
    if (!(await fs.stat(root)).isDirectory()) throw error;
  }
  let selected = primary?.identity.worktreeRoot || root;
  const invokingRoot = selected;
  let viewLease = primary ? await withFileLock(path.join(primary.identity.gitCommonDirectory, 'gittygo-mutation'), () => worktrees.createViewLease(invokingRoot, [invokingRoot])) : null;
  const cache = new Map(primary ? [[selected, primary]] : []);
  let closed = false;
  let initialization;
  const identity = primary?.identity || { worktreeRoot: root, repoIdentity: `nonrepo-${crypto.createHash('sha256').update(root).digest('hex')}`, nonRepository: true };
  const nonRepoState = () => ({ repo: root, name: path.basename(root), nonRepository: true, branch: '', head: '', changes: [], staged: [], ahead: 0, behind: 0 });
  const errorReply = (error) => ({ ok: false, error: serializeError(error) });
  const coordinator = {
    identity, get sessionId() { return primary?.sessionId || null; },
    async dispatch(method, args = []) {
      try {
        if (closed) throw new Error('Workspace is closed.');
        validateCall(method, args);
        if (!primary) {
          if (method === 'state') return { ok: true, result: nonRepoState() };
          if (method === 'reviewState') return { ok: true, result: { comments: [], openCommentCount: 0 } };
          if (method === 'uiRequests') return { ok: true, result: {} };
          if (method === 'initializeRepository') {
            if (initialization && Date.now() >= initialization.expires) initialization = null;
            if (initialization) throw new Error('An initialization confirmation is already pending.');
            const stat = await fs.stat(root);
            initialization = { id: crypto.randomBytes(24).toString('hex'), expires: Date.now() + (options.confirmationTtlMs ?? 120000), dev: stat.dev, ino: stat.ino, names: JSON.stringify((await fs.readdir(root)).sort()) };
            return { ok: true, confirmation: { id: initialization.id, title: 'Initialize Repository?', message: `Create a Git repository in ${root}?`, detail: 'Existing files are preserved. No files will be staged or committed.', choices: ['Cancel', 'Initialize Repository'] } };
          }
          if (method === 'confirm') {
            const pending = initialization; initialization = null;
            if (!pending || args[0] !== pending.id || Date.now() >= pending.expires || args[1] > 1) throw new Error('Invalid or expired confirmation.');
            if (args[1] === 0) return { ok: true, result: { cancelled: true } };
            return await withFileLock(path.join(root, '.gittygo-initialize'), async () => {
              if (Date.now() >= pending.expires) throw new Error('Initialization confirmation expired while waiting for the folder lock.');
              const stat = await fs.stat(root);
              const names = (await fs.readdir(root)).filter((name) => name !== '.gittygo-initialize.lock').sort();
              if (stat.dev !== pending.dev || stat.ino !== pending.ino || JSON.stringify(names) !== pending.names) throw new Error('Folder changed during confirmation. Review it and try again.');
              try { await gitService.getRepositoryIdentity(root); throw new Error('This folder is already in a repository. Reopen it to review.'); }
              catch (error) { if (!/not a git repository/i.test(error.message)) throw error; }
              await worktrees.command(root, ['init']);
              primary = await createBoundController(root, { ...options, protectedRoots: () => [selected] }); cache.set(root, primary);
              viewLease = await worktrees.createViewLease(root, [root]);
              await sessionStore.appendEvent(primary.sessionId, { type: 'repositoryInitialized', payload: { targetWorktree: root } }, await gitService.getState(root));
              return { ok: true, result: { initialized: true, path: root } };
            });
          }
          throw new Error('This folder is not a Git repository. Initialize Repository explicitly to use Git actions.');
        }
        if (method === 'initializeRepository') throw new Error('This folder is already a Git repository.');
        if (method === 'selectWorktree') return await withFileLock(path.join(primary.identity.gitCommonDirectory, 'gittygo-mutation'), async () => {
          const entry = await worktrees.member(invokingRoot, args[0], { status: false });
          if (!cache.has(entry.path)) {
            if (cache.size >= 16) throw new Error('Worktree view limit reached (16). Reopen GittyGo after copying drafts; no view was discarded.');
            const child = await createBoundController(entry.path, { ...options, sessionId: undefined, eventSessionId: primary.sessionId, invokingRoot, protectedRoots: () => [selected], onState: undefined, onReview: undefined });
            cache.set(entry.path, child);
          }
          await viewLease.update([...new Set([invokingRoot, ...cache.keys(), entry.path])]);
          selected = entry.path;
          return { ok: true, result: await gitService.getState(selected) };
        }, { timeoutMs: 30000 });
        if (method === 'confirm') {
          // Challenges are bound to their originating controller, not current selection.
          for (const child of cache.values()) {
            if (child.hasConfirmation(args[0])) return await child.dispatch(method, args);
          }
          throw new Error('Invalid or expired confirmation.');
        }
        if (method === 'target' || method === 'readTarget') {
          const [target, operation, operationArgs] = args;
          if (['target', 'readTarget', 'selectWorktree', 'confirm', 'initializeRepository'].includes(operation)) throw new Error('Invalid scoped operation.');
          if (method === 'readTarget' && !['state', 'reviewState', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'branches', 'remotes', 'worktrees'].includes(operation)) throw new Error('A read-only target cannot mutate or consume requests.');
          validateCall(operation, operationArgs);
          await worktrees.member(invokingRoot, target, { status: false });
          const child = cache.get(target);
          if (!child) throw new Error('Target view is no longer available. Review and select it first.');
          return await child.dispatch(operation, operationArgs);
        }
        // Family navigation must remain usable when an external Git command removes
        // the selected member. Never silently redirect a mutation to another root.
        if (method === 'worktrees') {
          const entries = await worktrees.list(invokingRoot);
          return { ok: true, result: entries.map((entry) => ({ ...entry, selected: entry.path === selected, invoking: entry.path === invokingRoot, retained: cache.has(entry.path) })) };
        }
        const target = selected;
        try { await worktrees.member(invokingRoot, target, { status: false }); }
        catch (error) {
          if (method === 'state') return { ok: true, result: { repo: target, name: path.basename(target), unavailable: true, branch: '', head: '', changes: [], staged: [], ahead: 0, behind: 0 } };
          if (method === 'reviewState') return { ok: true, result: { comments: [], openCommentCount: 0, worktreeRoot: target } };
          throw error;
        }
        const reply = await cache.get(target).dispatch(method, args);
        if (reply.ok && method === 'reviewState') reply.result = { ...reply.result, worktreeRoot: target };
        if (reply.ok && method === 'worktrees') reply.result = reply.result.map((entry) => ({ ...entry, selected: entry.path === selected, invoking: entry.path === invokingRoot, retained: cache.has(entry.path) }));
        return reply;
      } catch (error) { return errorReply(error); }
    },
    async close() { closed = true; await Promise.all([...cache.values()].map((child) => child.close())); await viewLease?.close(); },
  };
  return coordinator;
}
module.exports = { createWorkspaceController, channels, serializeError };
