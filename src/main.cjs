const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const gitService = require('./git-service.cjs');
const sessionStore = require('./session-store.cjs');
const reviewStore = require('./review-store.cjs');

let mainWindow;
let repository;
let sessionId;
let repositoryIdentity;
let refreshTimer;
let lastStateFingerprint = '';
let lastReviewFingerprint = '';
let mutationQueue = Promise.resolve();
let refreshInFlight = false;
let focusCheckInFlight = false;

function parseRepositoryArgument() {
  const separator = process.argv.indexOf('--');
  if (separator >= 0 && process.argv[separator + 1]) return process.argv[separator + 1];
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  return positional || process.cwd();
}

function parseSessionArgument() {
  const index = process.argv.indexOf('--session');
  return index >= 0 ? process.argv[index + 1] : null;
}

async function sendState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed() || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const state = await gitService.getState(repository);
    const fingerprint = JSON.stringify(state);
    if (force || fingerprint !== lastStateFingerprint) {
      lastStateFingerprint = fingerprint;
      mainWindow.webContents.send('repo:changed', state);
    }
  } catch (error) {
    mainWindow.webContents.send('repo:error', serializeError(error));
  } finally {
    refreshInFlight = false;
  }
}

async function sendReview(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const review = await reviewStore.getReviewState(repositoryIdentity);
    const fingerprint = JSON.stringify(review);
    if (force || fingerprint !== lastReviewFingerprint) {
      lastReviewFingerprint = fingerprint;
      mainWindow.webContents.send('review:changed', review);
    }
  } catch (error) {
    mainWindow.webContents.send('repo:error', serializeError(error));
  }
}

async function checkUiRequests() {
  if (!sessionId || !mainWindow || mainWindow.isDestroyed() || focusCheckInFlight) return;
  focusCheckInFlight = true;
  try {
    const [focusRequest, commitMessageRequest] = await Promise.all([
      sessionStore.consumeCommentFocus(sessionId),
      sessionStore.consumeCommitMessage(sessionId),
    ]);
    if (focusRequest || commitMessageRequest) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
    if (focusRequest) mainWindow.webContents.send('review:focus-comment', focusRequest.commentId);
    if (commitMessageRequest) mainWindow.webContents.send('ui:set-commit-message', commitMessageRequest.message);
  } catch (error) {
    mainWindow.webContents.send('repo:error', serializeError(error));
  } finally { focusCheckInFlight = false; }
}

function serializeError(error) {
  return { message: error.message || String(error), details: error.details || '' };
}

async function inspect(action) {
  try {
    return { ok: true, result: await action() };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function perform(action, eventDescriptor = null) {
  try {
    const before = eventDescriptor ? await gitService.getState(repository) : null;
    const result = await action();
    const after = await gitService.getState(repository);
    if (eventDescriptor && sessionId) {
      const event = typeof eventDescriptor === 'function'
        ? eventDescriptor(result, before, after)
        : eventDescriptor;
      await sessionStore.appendEvent(sessionId, event, after);
    }
    await sendState(true);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function mutate(action, eventDescriptor = null) {
  const result = mutationQueue.then(() => perform(action, eventDescriptor));
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function registerIpc() {
  ipcMain.handle('repo:state', () => inspect(() => gitService.getState(repository)));
  ipcMain.handle('review:state', () => inspect(() => reviewStore.getReviewState(repositoryIdentity)));
  ipcMain.handle('review:add-comment', (_event, anchor, body) => inspect(async () => {
    const state = await gitService.getState(repository);
    const files = [...state.staged, ...state.changes];
    if (!files.some((file) => file.path === anchor.path && file.section === anchor.section)) throw new Error('The commented file is no longer present in this change section.');
    const result = await reviewStore.addComment(repositoryIdentity, anchor, body);
    if (sessionId) await sessionStore.appendEvent(sessionId, { type: 'reviewCommentCreated', payload: { comment: result.comment } }, state);
    await sendReview(true);
    return result;
  }));
  ipcMain.handle('review:edit-comment', (_event, commentId, body) => inspect(async () => {
    const result = await reviewStore.editComment(repositoryIdentity, commentId, body);
    if (sessionId) await sessionStore.appendEvent(sessionId, { type: 'reviewCommentEdited', payload: { comment: result.comment } });
    await sendReview(true); return result;
  }));
  ipcMain.handle('review:resolve-comment', (_event, commentId) => inspect(async () => {
    const result = await reviewStore.resolveComment(repositoryIdentity, commentId, undefined, 'user-ui');
    if (sessionId) {
      const state = await gitService.getState(repository);
      await sessionStore.appendEvent(sessionId, {
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
  ipcMain.handle('repo:stage-hunk', (_event, patch, filePath) =>
    mutate(() => gitService.stageHunk(repository, patch), { type: 'hunkStaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:unstage-hunk', (_event, patch, filePath) =>
    mutate(() => gitService.unstageHunk(repository, patch), { type: 'hunkUnstaged', payload: { path: filePath } }),
  );
  ipcMain.handle('repo:discard-hunk', async (_event, patch, filePath) => {
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
    return mutate(() => gitService.discardHunk(repository, patch), { type: 'hunkDiscarded', payload: { path: filePath } });
  });
  ipcMain.handle('repo:discard-file', async (_event, filePath) => {
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
    return mutate(() => gitService.discardFile(repository, filePath), { type: 'fileChangesDiscarded', payload: { path: filePath } });
  });
  ipcMain.handle('repo:stage-selected', (_event, patch, indexes, section, filePath) =>
    mutate(
      () => gitService.stageSelectedLines(repository, patch, indexes, section),
      { type: section === 'staged' ? 'selectedLinesUnstaged' : 'selectedLinesStaged', payload: { path: filePath, lineCount: indexes.length } },
    ),
  );
  ipcMain.handle('repo:commit', async (_event, message, amend = false) => {
    if (amend) {
      const state = await gitService.getState(repository);
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Amend commit'], defaultId: 0, cancelId: 0,
        title: 'Amend last commit?', message: `Replace commit ${state.head}?`,
        detail: state.upstream && state.ahead === 0 ? 'This commit may already be published. Amending it rewrites history.' : 'The last commit will be replaced with a new commit.',
      });
      if (answer.response !== 1) return { ok: true, result: { cancelled: true } };
    }
    return mutate(
      () => gitService.commit(repository, message, amend),
      (_result, before, after) => ({
        type: amend ? 'commitAmended' : 'commitCreated',
        payload: { previousHead: before.head, currentHead: after.head },
      }),
    );
  });
  ipcMain.handle('repo:history', (_event, limit) => inspect(() => gitService.getHistory(repository, limit)));
  ipcMain.handle('repo:commit-details', (_event, hash) => inspect(() => gitService.getCommitDetails(repository, hash)));
  ipcMain.handle('repo:commit-file-diff', (_event, hash, oldPath, filePath) => inspect(() => gitService.getCommitFileDiff(repository, hash, oldPath, filePath)));
  ipcMain.handle('repo:remotes', () => inspect(() => gitService.getRemotes(repository)));
  ipcMain.handle('repo:branches', () => inspect(() => gitService.getBranches(repository)));
  ipcMain.handle('repo:fetch', () => mutate(() => gitService.fetchRemote(repository), { type: 'fetchCompleted' }));
  ipcMain.handle('repo:pull', async () => {
    const state = await gitService.getState(repository);
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Pull'], defaultId: 0, cancelId: 0,
      title: 'Pull changes?', message: `Pull ${state.upstream || 'the configured upstream'} into ${state.branch}?`,
      detail: `Ahead ${state.ahead} · Behind ${state.behind}. Pull is restricted to fast-forward updates.`,
    });
    return answer.response === 1 ? mutate(() => gitService.pull(repository), { type: 'pullCompleted' }) : { ok: true, result: { cancelled: true } };
  });
  ipcMain.handle('repo:push', async () => {
    const state = await gitService.getState(repository);
    const remotes = state.upstream ? [] : await gitService.getRemotes(repository);
    const destination = state.upstream || (remotes.length === 1 ? `${remotes[0].name}/${state.branch}` : 'a selected remote');
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Push'], defaultId: 0, cancelId: 0,
      title: 'Push commits?', message: `Push ${state.branch} to ${destination}?`,
      detail: `Ahead ${state.ahead} · Behind ${state.behind}`,
    });
    return answer.response === 1 ? mutate(() => gitService.push(repository), { type: 'pushCompleted' }) : { ok: true, result: { cancelled: true } };
  });
  ipcMain.handle('repo:undo-commit', async () => {
    const state = await gitService.getState(repository);
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
    return mutate(
      () => gitService.undoLastCommit(repository, keepStaged),
      (_result, before, after) => ({
        type: 'commitUndone',
        payload: { previousHead: before.head, currentHead: after.head, changesPreservedAs: keepStaged ? 'staged' : 'unstaged' },
      }),
    );
  });
  ipcMain.handle('repo:add-remote', (_event, name, url) => mutate(() => gitService.addRemote(repository, name, url), { type: 'remoteAdded', payload: { name } }));
  ipcMain.handle('repo:remove-remote', async (_event, name) => {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Cancel', 'Remove remote'], defaultId: 0, cancelId: 0,
      title: 'Remove remote?', message: `Remove remote “${name}”?`, detail: 'This changes repository configuration but does not delete remote data.',
    });
    return answer.response === 1 ? mutate(() => gitService.removeRemote(repository, name), { type: 'remoteRemoved', payload: { name } }) : { ok: true, result: { cancelled: true } };
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

async function createWindow() {
  repository = await gitService.resolveRepository(parseRepositoryArgument());
  sessionId = parseSessionArgument();
  if (sessionId) {
    const session = await sessionStore.loadSession(sessionId);
    if (session.worktreeRoot !== repository) throw new Error('The supplied Git Review session belongs to a different worktree.');
    repositoryIdentity = session.repoIdentity;
  } else {
    const created = await sessionStore.createSession(repository);
    sessionId = created.session.sessionId;
    repositoryIdentity = created.session.repoIdentity;
  }
  mainWindow = new BrowserWindow({
    title: `Git Review — ${path.basename(repository)}`,
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#111318',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('closed', () => {
    mainWindow = null;
    clearInterval(refreshTimer);
  });

  refreshTimer = setInterval(() => { sendState(); sendReview(); checkUiRequests(); }, 500);
}

app.whenReady().then(async () => {
  registerIpc();
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox('Could not open Git Review', error.message || String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
