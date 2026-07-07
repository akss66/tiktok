const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('douyinDesktop', {
  getBackendHealth: () => ipcRenderer.invoke('backend:health'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  createAccount: (input) => ipcRenderer.invoke('accounts:create', input),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (input) => ipcRenderer.invoke('tasks:create', input),
  listEvents: (filters) => ipcRenderer.invoke('events:list', filters),
  getDockerStatus: () => ipcRenderer.invoke('docker:status'),
  startBackend: () => ipcRenderer.invoke('docker:start'),
  stopBackend: () => ipcRenderer.invoke('docker:stop'),
});
