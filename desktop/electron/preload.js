const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('douyinDesktop', {
  getBackendHealth: () => ipcRenderer.invoke('backend:health'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  createAccount: (input) => ipcRenderer.invoke('accounts:create', input),
  updateAccount: (id, patch) => ipcRenderer.invoke('accounts:update', id, patch),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (input) => ipcRenderer.invoke('tasks:create', input),
  listEvents: (filters) => ipcRenderer.invoke('events:list', filters),
  getDockerStatus: () => ipcRenderer.invoke('docker:status'),
  startBackend: () => ipcRenderer.invoke('docker:start'),
  stopBackend: () => ipcRenderer.invoke('docker:stop'),
  openAccountBrowser: (account) => ipcRenderer.invoke('browser:open-account', account),
  closeAccountBrowser: () => ipcRenderer.invoke('browser:close-account'),
});
