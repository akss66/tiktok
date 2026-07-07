const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const browserTabs = require('./browser-tabs');
const docker = require('./docker');

const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';

let mainWindow;

async function backendRequest(pathname, options = {}) {
  const response = await fetch(`${BACKEND_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Backend request failed: ${response.status}`);
  }
  return data;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#f6f7f9',
    title: 'Douyin Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(process.env.DOUYIN_DESKTOP_RENDERER_URL || 'http://127.0.0.1:5173');
  mainWindow.on('resize', () => browserTabs.resizeActiveBrowser(mainWindow));
}

function registerIpc() {
  ipcMain.handle('backend:health', async () => backendRequest('/api/health'));
  ipcMain.handle('accounts:list', async () => backendRequest('/api/accounts'));
  ipcMain.handle('accounts:create', async (_event, input) => backendRequest('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('accounts:update', async (_event, id, patch) => backendRequest(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('accounts:delete', async (_event, id) => backendRequest(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }));
  ipcMain.handle('tasks:list', async () => backendRequest('/api/tasks'));
  ipcMain.handle('tasks:create', async (_event, input) => backendRequest('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('tasks:run', async (_event, id) => backendRequest(`/api/tasks/${encodeURIComponent(id)}/run`, {
    method: 'POST',
  }));
  ipcMain.handle('events:list', async (_event, filters = {}) => {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    });
    const suffix = query.toString() ? `?${query}` : '';
    return backendRequest(`/api/events${suffix}`);
  });
  ipcMain.handle('docker:status', async () => docker.getDockerStatus());
  ipcMain.handle('docker:start', async () => docker.startBackend());
  ipcMain.handle('docker:stop', async () => docker.stopBackend());
  ipcMain.handle('browser:open-account', async (_event, account) => browserTabs.openAccountBrowser(mainWindow, account));
  ipcMain.handle('browser:close-account', async () => browserTabs.closeAccountBrowser(mainWindow));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
