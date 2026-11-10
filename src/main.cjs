const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const gitService = require('./git-service.cjs');
const sessionStore = require('./session-store.cjs');
const reviewStore = require('./review-store.cjs');
const { createWorkspaceController, channels } = require('./workspace-controller.cjs');
const { invokeNative } = require('./native-workspace-adapter.cjs');

app.setName('GittyGo');

let mainWindow;
let repository;
let sessionId;
let repositoryIdentity;
let refreshTimer;
let uiRequestTimer;
let lastStateFingerprint = '';
let lastReviewFingerprint = '';
let controller;
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
    const reply = await controller.dispatch('state');
    if (!reply.ok) throw new Error(reply.error.message);
    const state = reply.result;
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
    const reply = await controller.dispatch('reviewState');
    if (!reply.ok) throw new Error(reply.error.message);
    const review = reply.result;
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
    const response = await controller.dispatch('uiRequests');
    if (!response.ok) throw Object.assign(new Error(response.error.message), { details: response.error.details });
    const { focusRequest, commitMessageRequest } = response.result;
    if (focusRequest) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
    if (focusRequest) mainWindow.webContents.send('review:focus-comment', focusRequest.commentId);
    if (commitMessageRequest) mainWindow.webContents.send('ui:set-commit-message', commitMessageRequest);
  } catch (error) {
    mainWindow.webContents.send('repo:error', serializeError(error));
  } finally { focusCheckInFlight = false; }
}

function serializeError(error) {
  return { message: error.message || String(error), details: error.details || '' };
}

function registerIpc() {
  for (const [method, channel] of Object.entries(channels)) {
    ipcMain.handle(channel, (_event, ...args) =>
      invokeNative(controller, method, args, (spec) => dialog.showMessageBox(mainWindow, spec)),
    );
  }
}

async function createWindow() {
  repository = path.resolve(parseRepositoryArgument());
  controller = await createWorkspaceController(repository, {
    sessionId: parseSessionArgument() || undefined, onState: () => sendState(true), onReview: () => sendReview(true),
  });
  repository = controller.identity.worktreeRoot;
  sessionId = controller.sessionId;
  repositoryIdentity = controller.identity.repoIdentity;
  mainWindow = new BrowserWindow({
    title: `GittyGo — ${path.basename(repository)}`,
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
    controller?.close();
    mainWindow = null;
    clearInterval(refreshTimer); clearInterval(uiRequestTimer);
  });
  const refreshAfterVisibilityChange = () => { sendState(true); sendReview(true); };
  mainWindow.on('show', refreshAfterVisibilityChange);
  mainWindow.on('restore', refreshAfterVisibilityChange);

  refreshTimer = setInterval(() => {
    if (!mainWindow?.isVisible() || mainWindow.isMinimized()) return;
    sendState();
  }, 1500);
  uiRequestTimer = setInterval(() => { sendReview(); checkUiRequests(); }, 400);
}

app.whenReady().then(async () => {
  registerIpc();
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox('Could not open GittyGo', error.message || String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
