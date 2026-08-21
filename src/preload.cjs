const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitReview', {
  state: () => ipcRenderer.invoke('repo:state'),
  diff: (filePath, section) => ipcRenderer.invoke('repo:diff', filePath, section),
  stageFile: (filePath) => ipcRenderer.invoke('repo:stage-file', filePath),
  unstageFile: (filePath) => ipcRenderer.invoke('repo:unstage-file', filePath),
  discardFile: (filePath) => ipcRenderer.invoke('repo:discard-file', filePath),
  stageHunk: (patch) => ipcRenderer.invoke('repo:stage-hunk', patch),
  unstageHunk: (patch) => ipcRenderer.invoke('repo:unstage-hunk', patch),
  discardHunk: (patch) => ipcRenderer.invoke('repo:discard-hunk', patch),
  commit: (message) => ipcRenderer.invoke('repo:commit', message),
  onChanged: (callback) => ipcRenderer.on('repo:changed', (_event, state) => callback(state)),
  onError: (callback) => ipcRenderer.on('repo:error', (_event, error) => callback(error)),
});
