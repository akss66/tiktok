const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const browserTabs = require('./browser-tabs');
const docker = require('./docker');
const edgeHost = require('./edge-host');
const localBackend = require('./local-backend');

const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';
const BRIDGE_URL = process.env.DOUYIN_DESKTOP_BRIDGE_URL || getBridgeUrlFromConfig();
const APP_NAME = 'Vulcan抖音控制台';
app.setName(APP_NAME);

function getBridgeUrlFromConfig() {
  try {
    const configPath = path.resolve(__dirname, '..', '..', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw) || {};
    const bridge = cfg.bridge || {};
    const rawHost = String(bridge.host || '127.0.0.1').trim().replace(/^[a-z]+:\/\//, '');
    const host = rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
    const port = Number(bridge.port || 19422);
    const resolvedPort = Number.isFinite(port) && port > 0 ? port : 19422;
    return `http://${host}:${resolvedPort}`;
  } catch {
    return 'http://127.0.0.1:19422';
  }
}

let mainWindow;
let backendStartup = null;

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

function queryString(filters = {}) {
  const query = new URLSearchParams();
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  return query.toString() ? `?${query}` : '';
}

async function bridgeRequest(pathname) {
  const response = await fetch(`${BRIDGE_URL}${pathname}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Bridge request failed: ${response.status}`);
  }
  return data;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#f4f6f8',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'renderer', 'src', 'assets', 'tongzhouxing-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(process.env.DOUYIN_DESKTOP_RENDERER_URL || 'http://127.0.0.1:5174');
  mainWindow.on('resize', () => browserTabs.resizeActiveBrowser(mainWindow));
}

function registerIpc() {
  ipcMain.handle('backend:health', async () => backendRequest('/api/health'));
  ipcMain.handle('bridge:health', async () => bridgeRequest('/api/status'));
  ipcMain.handle('accounts:list', async () => backendRequest('/api/accounts'));
  ipcMain.handle('accounts:create', async (_event, input) => backendRequest('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('accounts:update', async (_event, id, patch) => backendRequest(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('accounts:delete', async (_event, id) => {
    const accountId = String(id || '');
    const accountList = await backendRequest('/api/accounts').catch(() => []);
    const account = Array.isArray(accountList) ? accountList.find((item) => item.id === accountId) : null;
    const result = await backendRequest(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    });
    if (account) {
      browserTabs.resetAccountBrowserData(mainWindow, account).catch((error) => {
        console.warn('[main] async account browser cleanup failed:', error.message);
      });
    }
    return result;
  });
  ipcMain.handle('tasks:list', async () => backendRequest('/api/tasks'));
  ipcMain.handle('tasks:create', async (_event, input) => backendRequest('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('tasks:run', async (_event, id) => backendRequest(`/api/tasks/${encodeURIComponent(id)}/run`, {
    method: 'POST',
  }));
  ipcMain.handle('search-sessions:list', async (_event, filters = {}) => backendRequest(`/api/search-sessions${queryString(filters)}`));
  ipcMain.handle('search-sessions:create', async (_event, input) => backendRequest('/api/search-sessions', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('search-sessions:results', async (_event, id) => backendRequest(`/api/search-sessions/${encodeURIComponent(id)}/results`));
  ipcMain.handle('batch-jobs:list', async (_event, filters = {}) => backendRequest(`/api/batch-jobs${queryString(filters)}`));
  ipcMain.handle('batch-jobs:create', async (_event, input) => backendRequest('/api/batch-jobs', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('batch-jobs:run', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/run`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:items', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/items`));
  ipcMain.handle('videos:list', async (_event, filters = {}) => backendRequest(`/api/videos${queryString(filters)}`));
  ipcMain.handle('my-videos:sync', async (_event, input) => backendRequest('/api/my-videos/sync', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('videos:comments-sync', async (_event, awemeId, input) => backendRequest(`/api/videos/${encodeURIComponent(awemeId)}/comments-sync`, {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('videos:comments', async (_event, awemeId) => backendRequest(`/api/videos/${encodeURIComponent(awemeId)}/comments`));
  ipcMain.handle('comments:list', async (_event, filters = {}) => backendRequest(`/api/comments${queryString(filters)}`));
  ipcMain.handle('comments:analyze', async (_event, input) => backendRequest('/api/comments/analyze', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('reply-drafts:list', async (_event, filters = {}) => backendRequest(`/api/reply-drafts${queryString(filters)}`));
  ipcMain.handle('reply-drafts:approve', async (_event, id, input) => backendRequest(`/api/reply-drafts/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('reply-drafts:publish', async (_event, id) => backendRequest(`/api/reply-drafts/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
  }));
  ipcMain.handle('knowledge:list', async () => backendRequest('/api/knowledge'));
  ipcMain.handle('knowledge:create', async (_event, input) => backendRequest('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('knowledge:update', async (_event, id, patch) => backendRequest(`/api/knowledge/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('knowledge:delete', async (_event, id) => backendRequest(`/api/knowledge/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }));
  ipcMain.handle('events:list', async (_event, filters = {}) => {
    return backendRequest(`/api/events${queryString(filters)}`);
  });
  ipcMain.handle('settings:llm:get', async () => backendRequest('/api/settings/llm'));
  ipcMain.handle('settings:llm:update', async (_event, patch) => backendRequest('/api/settings/llm', {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('app:info', async () => ({
    name: APP_NAME,
    version: app.getVersion(),
    userDataPath: app.getPath('userData'),
    backendUrl: BACKEND_URL,
    bridgeUrl: BRIDGE_URL,
    backendStartup,
    browserBridge: browserTabs.getBridgeDiagnostic(),
  }));
  ipcMain.handle('docker:status', async () => docker.getDockerStatus());
  ipcMain.handle('docker:start', async () => docker.startBackend());
  ipcMain.handle('docker:stop', async () => docker.stopBackend());
  ipcMain.handle('backend:start-local', async () => {
    backendStartup = await localBackend.ensureStarted(app);
    return backendStartup;
  });
  ipcMain.handle('backend:stop-local', async () => {
    backendStartup = localBackend.stop();
    return backendStartup;
  });
  ipcMain.handle('browser:open-account', async (_event, account) => browserTabs.openAccountBrowser(mainWindow, account, {
    onLoginDetected: async ({ account: detectedAccount, nickname, uid, secUid }) => {
      if (!detectedAccount?.id) return null;
      const updated = await backendRequest(`/api/accounts/${encodeURIComponent(detectedAccount.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'online',
          lastSeenAt: new Date().toISOString(),
          notes: detectedAccount.notes || (nickname ? `已登录：${nickname}` : ''),
        }),
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('accounts:changed', {
          account: updated,
          login: { nickname, uid, secUid },
        });
      }
      return updated;
    },
  }));
  ipcMain.handle('browser:open-edge-account', async (_event, account) => edgeHost.openAccountEdge(app, account));
  ipcMain.handle('browser:edge-status', async () => edgeHost.getEdgeStatus());
  ipcMain.handle('browser:open-clean-login', async (_event, account) => browserTabs.openCleanLoginBrowser(mainWindow, account));
  ipcMain.handle('browser:close-account', async () => browserTabs.closeAccountBrowser(mainWindow));
  ipcMain.handle('browser:hide-account', async () => browserTabs.hideAccountBrowser(mainWindow));
  ipcMain.handle('browser:show-account', async () => browserTabs.showAccountBrowser(mainWindow));
  ipcMain.handle('browser:ensure-bridge', async () => {
    if (edgeHost.hasActiveEdgeSession()) {
      return edgeHost.ensureEdgeBridge();
    }
    return browserTabs.ensureBridgeInjected(mainWindow);
  });
  ipcMain.handle('browser:bridge-self-test', async () => browserTabs.runBridgeSelfTest());
  ipcMain.handle('browser:reset-account', async (_event, account) => browserTabs.resetAccountBrowserData(mainWindow, account));

  // Bridge HTTP 代理：页面通过 IPC → 主进程转发，绕过 PNA 限制
  ipcMain.handle('bridge:fetch', async (_event, { method, url, headers, body }) => {
    try {
      const sessionResult = await browserTabs.fetchWithActiveBrowserSession({ method, url, headers, body });
      if (sessionResult) return sessionResult;
    } catch (error) {
      return { status: 0, error: error.message || String(error) };
    }

    return new Promise((resolve) => {
      try {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: method || 'GET',
          headers: headers || {},
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              responseText: data,
              finalUrl: url,
              responseHeaders: JSON.stringify(res.headers),
            });
          });
        });
        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        req.setTimeout(35000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
        if (body) req.write(body);
        req.end();
      } catch (e) {
        resolve({ status: 0, error: e.message });
      }
    });
  });
}

app.whenReady().then(async () => {
  backendStartup = await localBackend.ensureStarted(app);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
