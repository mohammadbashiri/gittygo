const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const gitService = require('./git-service.cjs');

let mainWindow;
let repository;
let refreshTimer;
let lastStateFingerprint = '';

function parseRepositoryArgument() {
  const separator = process.argv.indexOf('--');
  if (separator >= 0 && process.argv[separator + 1]) return process.argv[separator + 1];
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  return positional || process.cwd();
}

async function sendState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const state = await gitService.getState(repository);
    const fingerprint = JSON.stringify(state);
    if (force || fingerprint !== lastStateFingerprint) {
      lastStateFingerprint = fingerprint;
      mainWindow.webContents.send('repo:changed', state);
    }
  } catch (error) {
    mainWindow.webContents.send('repo:error', serializeError(error));
  }
}

function serializeError(error) {
  return { message: error.message || String(error), details: error.details || '' };
}

async function perform(action) {
  try {
    const result = await action();
    await sendState(true);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function registerIpc() {
  ipcMain.handle('repo:state', () => perform(() => gitService.getState(repository)));
  ipcMain.handle('repo:diff', (_event, filePath, section) =>
    perform(async () => {
      const result = await gitService.getDiff(repository, filePath, section);
      return { ...result, hunks: gitService.extractHunks(result.patch) };
    }),
  );
  ipcMain.handle('repo:stage-file', (_event, filePath) =>
    perform(() => gitService.stageFile(repository, filePath)),
  );
  ipcMain.handle('repo:unstage-file', (_event, filePath) =>
    perform(() => gitService.unstageFile(repository, filePath)),
  );
  ipcMain.handle('repo:stage-hunk', (_event, patch) =>
    perform(() => gitService.stageHunk(repository, patch)),
  );
  ipcMain.handle('repo:unstage-hunk', (_event, patch) =>
    perform(() => gitService.unstageHunk(repository, patch)),
  );
  ipcMain.handle('repo:discard-hunk', async (_event, patch) => {
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
    return perform(() => gitService.discardHunk(repository, patch));
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
    return perform(() => gitService.discardFile(repository, filePath));
  });
  ipcMain.handle('repo:commit', (_event, message) =>
    perform(() => gitService.commit(repository, message)),
  );
}

async function createWindow() {
  repository = await gitService.resolveRepository(parseRepositoryArgument());
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

  refreshTimer = setInterval(() => sendState(), 900);
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
