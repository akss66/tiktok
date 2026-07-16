const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const APP_NAME = 'Vulcan\u6296\u97f3\u63a7\u5236\u53f0';
app.setName(APP_NAME);

if (process.env.VULCAN_USER_DATA_DIR && typeof app.setPath === 'function') {
  app.setPath('userData', path.resolve(process.env.VULCAN_USER_DATA_DIR));
}

let mainLogPath = null;

function writeMainLog(message) {
  try {
    if (!mainLogPath) {
      mainLogPath = path.join(app.getPath('userData'), 'logs', 'main.log');
    }
    fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
    fs.appendFileSync(mainLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Logging must never block app startup.
  }
}

function reportStartupModuleLoadFailure(error) {
  writeMainLog(`startup module load failed: ${error.stack || error.message || String(error)}`);
}

process.on('uncaughtException', (error) => {
  writeMainLog(`uncaughtException: ${error.stack || error.message || String(error)}`);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  writeMainLog(`unhandledRejection: ${message}`);
});

let browserTabs;
let docker;
let createDmClientManager;
let decodeDmPushFrame;
let createDmMonitor;
let createDmNotifier;
let createDmWorker;
let edgeHost;
let localBackend;

try {
  browserTabs = require('./browser-tabs');
  docker = require('./docker');
  ({ createDmClientManager } = require('./dm-client'));
  ({ decodeDmPushFrame } = require('./dm-protocol'));
  ({ createDmMonitor } = require('./dm-monitor'));
  ({ createDmNotifier } = require('./dm-notifications'));
  ({ createDmWorker } = require('./dm-worker'));
  edgeHost = require('./edge-host');
  localBackend = require('./local-backend');
} catch (error) {
  reportStartupModuleLoadFailure(error);
  throw error;
}

browserTabs.setLifecycleLogger?.(writeMainLog);

const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';
const BRIDGE_URL = process.env.DOUYIN_DESKTOP_BRIDGE_URL || getBridgeUrlFromConfig();
const DM_LOGIN_MONITOR_DEBOUNCE_MS = 30_000;
const DM_SETTINGS_CACHE_TTL_MS = 30_000;
const DM_SETTINGS_FETCH_TIMEOUT_MS = 1_000;
const DM_SETTINGS_FETCH_TIMED_OUT = Symbol('dm-settings-fetch-timed-out');
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
let dmSettingsCache = null;
let dmSettingsCacheRevision = 0;
let dmSettingsFetchPromise = null;
let dmRuntimeStartPromise = null;
let rendererReady = false;
let pendingDmNavigation = null;
let quitCleanupComplete = false;
let quitCleanupPromise = null;
let packagedSmokeExitWatcher = null;
const dmLoginMonitorTimers = new Map();

function stopPackagedSmokeExitWatcher() {
  if (!packagedSmokeExitWatcher) return;
  fs.unwatchFile(packagedSmokeExitWatcher.filePath, packagedSmokeExitWatcher.listener);
  packagedSmokeExitWatcher = null;
}

function startPackagedSmokeExitWatcher() {
  const requestedPath = process.env.VULCAN_PACKAGED_SMOKE_EXIT_FILE;
  if (!app.isPackaged || !requestedPath || packagedSmokeExitWatcher) return false;
  const filePath = path.resolve(requestedPath);
  const listener = (current) => {
    if (!current.isFile()) return;
    stopPackagedSmokeExitWatcher();
    writeMainLog(`packaged smoke graceful exit requested: ${filePath}`);
    app.quit();
  };
  packagedSmokeExitWatcher = { filePath, listener };
  fs.watchFile(filePath, { interval: 200, persistent: false }, listener);
  return true;
}

function isLoggedInAccount(account) {
  return account?.status === 'enabled' || account?.status === 'online';
}

function isDmMonitoringAllowed(dmSettings, monitorState) {
  if (monitorState?.settingSource === 'explicit') return monitorState.enabled === true;
  return dmSettings?.monitor_after_login === true;
}

function cancelDmLoginMonitorRefresh(accountId) {
  const normalizedId = String(accountId || '').trim();
  const timer = dmLoginMonitorTimers.get(normalizedId);
  if (!timer) return false;
  clearTimeout(timer);
  dmLoginMonitorTimers.delete(normalizedId);
  return true;
}

function clearDmLoginMonitorRefreshes() {
  for (const accountId of dmLoginMonitorTimers.keys()) cancelDmLoginMonitorRefresh(accountId);
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return true;
}

function sendDmNavigation(payload) {
  const accountId = typeof payload?.accountId === 'string' ? payload.accountId.trim() : '';
  const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
  if (!accountId || !conversationId || !mainWindow || mainWindow.isDestroyed()) return false;
  const navigation = { accountId, conversationId };
  if (!rendererReady) {
    pendingDmNavigation = navigation;
    return true;
  }
  mainWindow.webContents.send('dm:navigate', navigation);
  return true;
}

function markRendererReady() {
  rendererReady = true;
  if (!pendingDmNavigation || !mainWindow || mainWindow.isDestroyed()) return;
  const navigation = pendingDmNavigation;
  pendingDmNavigation = null;
  mainWindow.webContents.send('dm:navigate', navigation);
}

const dmNotifier = createDmNotifier({
  NotificationClass: Notification,
  showWindow: restoreMainWindow,
  sendNavigation: sendDmNavigation,
  now: () => new Date(),
});

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

function coordinateDmSettingsCacheWrite(settings, options = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { committed: false, value: null };
  }
  const value = { ...settings };
  const expectedRevision = options.expectedRevision;
  if (expectedRevision !== undefined && expectedRevision !== dmSettingsCacheRevision) {
    return { committed: false, value };
  }

  dmSettingsCacheRevision += 1;
  dmSettingsCache = {
    value,
    expiresAt: Date.now() + DM_SETTINGS_CACHE_TTL_MS,
  };
  return { committed: true, value: dmSettingsCache.value };
}

function getCachedDmSettings() {
  if (!dmSettingsCache || Date.now() >= dmSettingsCache.expiresAt) return null;
  return dmSettingsCache.value;
}

async function getAccountDmMonitorPolicy(accountId) {
  const normalizedId = String(accountId || '').trim();
  if (!normalizedId) return { allowed: false, settings: null, monitorState: null };
  const [settings, monitorState] = await Promise.all([
    getDmSettingsForNotification(),
    backendRequest(`/api/dm/monitor-states/${encodeURIComponent(normalizedId)}`).catch(() => null),
  ]);
  return {
    allowed: isDmMonitoringAllowed(settings, monitorState),
    settings,
    monitorState,
  };
}

async function listDmMonitorEligibleAccounts() {
  const [accountList, monitorStates, settings] = await Promise.all([
    backendRequest('/api/accounts'),
    backendRequest('/api/dm/monitor-states'),
    getDmSettingsForNotification(),
  ]);
  const stateByAccountId = new Map(
    (Array.isArray(monitorStates) ? monitorStates : [])
      .map((state) => [String(state?.accountId || '').trim(), state]),
  );
  return (Array.isArray(accountList) ? accountList : []).map((account) => {
    if (!isLoggedInAccount(account)) return account;
    const allowed = isDmMonitoringAllowed(settings, stateByAccountId.get(String(account.id || '').trim()));
    return allowed
      ? { ...account, status: 'enabled' }
      : { ...account, status: 'monitor_disabled' };
  });
}

async function scheduleDmMonitorRefreshAfterLogin(account) {
  const accountId = String(account?.id || '').trim();
  cancelDmLoginMonitorRefresh(accountId);
  if (!accountId || !isLoggedInAccount(account)) return false;
  const policy = await getAccountDmMonitorPolicy(accountId);
  if (!policy.allowed) return false;

  const timer = setTimeout(async () => {
    if (dmLoginMonitorTimers.get(accountId) !== timer) return;
    dmLoginMonitorTimers.delete(accountId);
    try {
      const accountList = await backendRequest('/api/accounts');
      const currentAccount = Array.isArray(accountList)
        ? accountList.find((item) => String(item?.id || '').trim() === accountId)
        : null;
      if (!isLoggedInAccount(currentAccount)) return;
      const currentPolicy = await getAccountDmMonitorPolicy(accountId);
      if (!currentPolicy.allowed) return;
      await refreshDmMonitor();
    } catch (error) {
      console.warn('[main] dm monitor refresh after login failed:', error.message || String(error));
    }
  }, DM_LOGIN_MONITOR_DEBOUNCE_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  dmLoginMonitorTimers.set(accountId, timer);
  return true;
}

async function reconcileDmLoginMonitorTimers() {
  const accountIds = [...dmLoginMonitorTimers.keys()];
  await Promise.all(accountIds.map(async (accountId) => {
    const policy = await getAccountDmMonitorPolicy(accountId);
    if (!policy.allowed) cancelDmLoginMonitorRefresh(accountId);
  }));
}

function settleWithin(promise, timeoutMs, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // Timeout completion must not depend on abort support.
      }
      resolve(DM_SETTINGS_FETCH_TIMED_OUT);
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getDmSettingsForNotification() {
  const cached = getCachedDmSettings();
  if (cached) return Promise.resolve(cached);
  if (dmSettingsFetchPromise) return dmSettingsFetchPromise;

  const requestRevision = dmSettingsCacheRevision;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  dmSettingsFetchPromise = settleWithin(
    backendRequest('/api/settings/dm', controller ? { signal: controller.signal } : {}),
    DM_SETTINGS_FETCH_TIMEOUT_MS,
    () => controller?.abort(),
  ).then((settings) => {
    if (settings === DM_SETTINGS_FETCH_TIMED_OUT) {
      console.warn('[main] DM settings request timed out; skipping notifications for this batch');
      return null;
    }
    const commit = coordinateDmSettingsCacheWrite(settings, { expectedRevision: requestRevision });
    return commit.committed ? commit.value : getCachedDmSettings();
  }).catch((error) => {
    console.warn('[main] DM settings request failed:', error.message || String(error));
    return null;
  }).finally(() => {
    dmSettingsFetchPromise = null;
  });
  return dmSettingsFetchPromise;
}

async function dispatchDmNotifications(insertedMessages) {
  const dmSettings = await getDmSettingsForNotification();
  if (!dmSettings) return;
  insertedMessages.forEach((message) => {
    try {
      dmNotifier.notify(message, dmSettings);
    } catch (error) {
      console.warn('[main] DM notifier failed:', error.message || String(error));
    }
  });
}

function scheduleDmNotifications(insertedMessages) {
  void dispatchDmNotifications(insertedMessages).catch((error) => {
    console.warn('[main] DM notification dispatch failed:', error.message || String(error));
  });
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
  rendererReady = false;
  pendingDmNavigation = null;
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

  mainWindow.webContents.on('did-finish-load', markRendererReady);

  if (process.env.DOUYIN_DESKTOP_RENDERER_URL) {
    mainWindow.loadURL(process.env.DOUYIN_DESKTOP_RENDERER_URL);
  } else if (app.isPackaged) {
    const resourceIndex = path.join(process.resourcesPath, 'dist', 'index.html');
    const asarIndex = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(fs.existsSync(resourceIndex) ? resourceIndex : asarIndex);
  } else {
    mainWindow.loadURL('http://127.0.0.1:5174');
  }
  mainWindow.on('resize', () => browserTabs.resizeActiveBrowser(mainWindow));
  mainWindow.on('closed', () => {
    rendererReady = false;
    pendingDmNavigation = null;
    mainWindow = null;
  });
}

const dmClient = createDmClientManager({
  WebSocketImpl: require('ws'),
  getAccountCookies: async (account) => {
    const accountSession = browserTabs.getAccountSession(account);
    return accountSession.cookies.get({ url: 'https://www.douyin.com/' });
  },
  getDeviceId: async (account) => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const ensured = await browserTabs.ensureBackgroundAccountView(window, account, { requireBridge: false });
    if (ensured && ensured.ok === false) {
      const error = new Error(ensured.error || 'Failed to prepare the account browser');
      error.code = 'dm_device_id_missing';
      throw error;
    }
    return browserTabs.readAccountDeviceId(account.id, { timeoutMs: 5000 });
  },
  getAccountUserId: async (account) => browserTabs.readAccountUserId(account.id, { timeoutMs: 5000 }),
  decodeFrame: decodeDmPushFrame,
  userAgent: browserTabs.chromeCompatUserAgent?.() || '',
  logger: console,
});

const dmMonitor = createDmMonitor({
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  isBackendHealthy: async () => localBackend.isHealthy(),
  listAccounts: listDmMonitorEligibleAccounts,
  listMonitorStates: async () => backendRequest('/api/dm/monitor-states'),
  updateMonitorState: async (accountId, patch) => backendRequest(`/api/dm/monitor-states/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }),
  ensureBackgroundAccountView: async (window, account) => browserTabs.ensureBackgroundAccountView(window, account),
  executeInAccountView: async (accountId, expression) => browserTabs.executeInAccountView(accountId, expression),
  pollAccount: async (account, timeoutMs) => dmClient.poll(account, timeoutMs),
  ingestMessages: async ({ accountId, selfPlatformId, messages }) => backendRequest('/api/dm/messages/ingest', {
    method: 'POST',
    body: JSON.stringify({ accountId, selfPlatformId, messages }),
  }),
  disconnectAccountView: async (accountId) => browserTabs.releaseBackgroundAccountView(mainWindow, accountId),
  disconnectAccount: async (accountId) => dmClient.disconnect(accountId),
  onIngested: (insertedMessages) => {
    if (!mainWindow || mainWindow.isDestroyed() || !Array.isArray(insertedMessages) || insertedMessages.length === 0) return;
    try {
      mainWindow.webContents.send('dm-monitor:ingested', {
        insertedMessages,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[main] DM renderer update failed:', error.message || String(error));
    }
    scheduleDmNotifications(insertedMessages);
  },
  logger: console,
});

const dmWorker = createDmWorker({
  backendRequest,
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  getAccount: async (accountId) => {
    const accountList = await backendRequest('/api/accounts');
    return Array.isArray(accountList)
      ? accountList.find((account) => account.id === accountId) || null
      : null;
  },
  ensureBackgroundAccountView: async (window, account) => browserTabs.ensureBackgroundAccountView(window, account),
  executeInAccountView: async (accountId, expression, options) => (
    browserTabs.executeInAccountView(accountId, expression, options)
  ),
  logger: console,
});

async function startDmMonitorIfReady() {
  return dmMonitor.start();
}

async function stopDmMonitor() {
  return dmMonitor.stop();
}

function refreshDmMonitor() {
  return dmMonitor.refresh();
}

async function wakeDmMonitorForAccount(accountIdValue) {
  const accountId = String(accountIdValue || '').trim();
  if (!accountId) return false;

  const accountList = await backendRequest('/api/accounts');
  const account = Array.isArray(accountList)
    ? accountList.find((item) => String(item?.id || '').trim() === accountId)
    : null;
  if (!isLoggedInAccount(account)) return false;

  const policy = await getAccountDmMonitorPolicy(accountId);
  if (!policy.allowed) return false;
  await dmMonitor.enableAccount(accountId);
  return true;
}

async function wakeDmMonitorAfterBrowserAction(accountId, action) {
  try {
    return await wakeDmMonitorForAccount(accountId);
  } catch (error) {
    console.warn(`[main] dm monitor wake after browser ${action} failed:`, error.message || String(error));
    return false;
  }
}

async function startDmWorkerIfReady() {
  return dmWorker.start();
}

async function stopDmWorker() {
  return dmWorker.stop();
}

async function startDmRuntime() {
  if (dmRuntimeStartPromise) return dmRuntimeStartPromise;
  dmRuntimeStartPromise = (async () => {
    const worker = await dmWorker.start();
    const monitor = await dmMonitor.start();
    return { worker, monitor };
  })();
  try {
    return await dmRuntimeStartPromise;
  } finally {
    dmRuntimeStartPromise = null;
  }
}

function accountDeletionError(stage, error) {
  const detail = error?.message || String(error);
  const wrapped = new Error(`Account deletion failed during ${stage}: ${detail}`);
  wrapped.cause = error;
  return wrapped;
}

async function deleteAccount(accountIdValue) {
  const accountId = String(accountIdValue || '').trim();
  if (!accountId) throw new Error('Account deletion failed during validation: account id is required');
  cancelDmLoginMonitorRefresh(accountId);

  let account;
  try {
    const accountList = await backendRequest('/api/accounts');
    account = Array.isArray(accountList) ? accountList.find((item) => item.id === accountId) : null;
    if (!account) throw new Error('account not found');
  } catch (error) {
    throw accountDeletionError('account lookup', error);
  }

  let workerStopped = false;
  try {
    try {
      await dmMonitor.disableAccount(accountId);
    } catch (error) {
      throw accountDeletionError('monitor stop', error);
    }
    try {
      await stopDmWorker();
      workerStopped = true;
    } catch (error) {
      throw accountDeletionError('worker quiesce', error);
    }
    try {
      await backendRequest(`/api/accounts/${encodeURIComponent(accountId)}/cancel-dm-work`, { method: 'POST' });
    } catch (error) {
      throw accountDeletionError('pending DM work cancellation', error);
    }
    try {
      await browserTabs.closeAccountView(mainWindow, accountId);
    } catch (error) {
      throw accountDeletionError('BrowserView destruction', error);
    }
    try {
      await browserTabs.clearAccountPartition(account);
    } catch (error) {
      throw accountDeletionError('partition cleanup', error);
    }
    try {
      return await backendRequest(`/api/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    } catch (error) {
      throw accountDeletionError('account record deletion', error);
    }
  } finally {
    if (workerStopped && !quitCleanupPromise) {
      try {
        if (await localBackend.isHealthy()) await startDmWorkerIfReady();
      } catch (error) {
        console.warn('[main] dm worker restart after account deletion failed:', error.message || String(error));
      }
    }
  }
}

function registerIpc() {
  ipcMain.handle('backend:health', async () => backendRequest('/api/health'));
  ipcMain.handle('bridge:health', async () => bridgeRequest('/api/status'));
  ipcMain.handle('accounts:list', async () => backendRequest('/api/accounts'));
  ipcMain.handle('accounts:create', async (_event, input) => backendRequest('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }).then((account) => {
    refreshDmMonitor().catch((error) => {
      console.warn('[main] dm monitor refresh after account create failed:', error.message);
    });
    return account;
  }));
  ipcMain.handle('accounts:update', async (_event, id, patch) => backendRequest(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }).then(async (account) => {
    if (!isLoggedInAccount(account)) cancelDmLoginMonitorRefresh(account.id);
    if (account?.status === 'disabled') {
      await dmMonitor.disableAccount(account.id).catch((error) => {
        console.warn('[main] dm monitor disable failed:', error.message);
      });
    } else {
      refreshDmMonitor().catch((error) => {
        console.warn('[main] dm monitor refresh after account update failed:', error.message);
      });
    }
    return account;
  }));
  ipcMain.handle('accounts:delete', async (_event, id) => deleteAccount(id));
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
  ipcMain.handle('comment-sync-jobs:create', async (_event, input) => backendRequest('/api/comment-sync-jobs', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('batch-jobs:run', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/run`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:pause', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:cancel', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:resume', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:retry-failed', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/retry-failed`, {
    method: 'POST',
  }));
  ipcMain.handle('batch-jobs:items', async (_event, id) => backendRequest(`/api/batch-jobs/${encodeURIComponent(id)}/items`));
  ipcMain.handle('videos:list', async (_event, filters = {}) => backendRequest(`/api/videos${queryString(filters)}`));
  ipcMain.handle('external-videos:resolve', async (_event, input) => backendRequest('/api/external-videos/resolve', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
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
  ipcMain.handle('dm-leads:list', async (_event, filters = {}) => backendRequest(`/api/dm-leads${queryString(filters)}`));
  ipcMain.handle('dm-leads:sources', async (_event, id) => backendRequest(`/api/dm-leads/${encodeURIComponent(id)}/sources`));
  ipcMain.handle('dm-leads:sync', async (_event, input) => backendRequest('/api/dm-leads/sync', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('dm-leads:analyze', async (_event, input) => backendRequest('/api/dm-leads/analyze', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('dm-leads:update', async (_event, id, patch) => backendRequest(`/api/dm-leads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('dm-leads:send-job', async (_event, input) => backendRequest('/api/dm-leads/send-job', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
  ipcMain.handle('dm:monitor-states:list', async () => backendRequest('/api/dm/monitor-states'));
  ipcMain.handle('dm:conversations:list', async (_event, filters = {}) => (
    backendRequest(`/api/dm/conversations${queryString(filters)}`)
  ));
  ipcMain.handle('dm:conversation:get', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}${queryString({ accountId })}`)
  ));
  ipcMain.handle('dm:conversation:delete', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}${queryString({ accountId })}`, {
      method: 'DELETE',
    })
  ));
  ipcMain.handle('dm:messages:list', async (_event, accountId, conversationId, filters = {}) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/messages${queryString({ ...filters, accountId })}`)
  ));
  ipcMain.handle('dm:conversation:analysis', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/analysis${queryString({ accountId })}`)
  ));
  ipcMain.handle('dm:conversation:reanalyze', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/reanalyze`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    })
  ));
  ipcMain.handle('dm:conversation:read', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    })
  ));
  ipcMain.handle('dm:conversation:update', async (_event, accountId, conversationId, patch) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...(patch || {}), accountId }),
    })
  ));
  ipcMain.handle('dm:conversation:reauthorize', async (_event, accountId, conversationId) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/reauthorize-auto-reply`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    })
  ));
  ipcMain.handle('dm:reply', async (_event, accountId, conversationId, input) => (
    backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/replies`, {
      method: 'POST',
      body: JSON.stringify({ ...(input || {}), accountId }),
    })
  ));
  ipcMain.handle('dm-worker:status', async () => dmWorker.getStatus());
  ipcMain.handle('knowledge:list', async () => backendRequest('/api/knowledge'));
  ipcMain.handle('knowledge:query', async (_event, filters = {}) => (
    backendRequest(`/api/knowledge${queryString(filters)}`)
  ));
  ipcMain.handle('knowledge:check-duplicate', async (_event, content) => backendRequest('/api/knowledge/check-duplicate', {
    method: 'POST',
    body: JSON.stringify({ content: String(content || '') }),
  }));
  ipcMain.handle('knowledge:bulk', async (_event, input) => backendRequest('/api/knowledge/bulk', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  }));
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
  ipcMain.handle('settings:llm:test', async (_event, patch) => backendRequest('/api/settings/llm/test', {
    method: 'POST',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('settings:reply:get', async () => backendRequest('/api/settings/reply'));
  ipcMain.handle('settings:reply:update', async (_event, patch) => backendRequest('/api/settings/reply', {
    method: 'PATCH',
    body: JSON.stringify(patch || {}),
  }));
  ipcMain.handle('settings:dm:get', async () => {
    const requestRevision = dmSettingsCacheRevision;
    const settings = await backendRequest('/api/settings/dm');
    coordinateDmSettingsCacheWrite(settings, { expectedRevision: requestRevision });
    return settings;
  });
  ipcMain.handle('settings:dm:update', async (_event, patch) => {
    const settings = await backendRequest('/api/settings/dm', {
      method: 'PATCH',
      body: JSON.stringify(patch || {}),
    });
    coordinateDmSettingsCacheWrite(settings);
    await reconcileDmLoginMonitorTimers();
    await refreshDmMonitor().catch((error) => {
      console.warn('[main] dm monitor refresh after settings update failed:', error.message || String(error));
    });
    return settings;
  });
  ipcMain.handle('dm:monitor-state:update', async (_event, accountId, patch) => {
    const normalizedId = String(accountId || '').trim();
    const monitorState = await backendRequest(`/api/dm/monitor-states/${encodeURIComponent(normalizedId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        enabled: patch?.enabled === undefined ? null : patch.enabled,
        settingSource: patch?.settingSource,
        replyModeOverride: patch?.replyModeOverride === undefined ? null : patch.replyModeOverride,
      }),
    });
    const settings = await getDmSettingsForNotification();
    if (!isDmMonitoringAllowed(settings, monitorState)) {
      cancelDmLoginMonitorRefresh(normalizedId);
    }
    await refreshDmMonitor().catch((error) => {
      console.warn('[main] dm monitor refresh after account setting update failed:', error.message || String(error));
    });
    return monitorState;
  });
  ipcMain.handle('app:info', async () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    installerName: `${APP_NAME}-${app.getVersion()}-Setup.exe`,
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
    if (backendStartup?.ok) {
      await startDmRuntime();
    }
    return backendStartup;
  });
  ipcMain.handle('backend:stop-local', async () => {
    await stopDmMonitor().catch((error) => {
      console.warn('[main] dm monitor stop before backend stop failed:', error.message);
    });
    await stopDmWorker().catch((error) => {
      console.warn('[main] dm worker stop before backend stop failed:', error.message);
    });
    backendStartup = await localBackend.stop();
    return backendStartup;
  });
  ipcMain.handle('dm-monitor:status', async () => dmMonitor.getStatus());
  ipcMain.handle('dm-monitor:start', async () => startDmMonitorIfReady());
  ipcMain.handle('dm-monitor:stop', async () => stopDmMonitor());
  ipcMain.handle('browser:open-account', async (_event, account) => {
    const result = await browserTabs.openAccountBrowser(mainWindow, account, {
    onLoginDetected: async ({ account: detectedAccount, nickname, uid, secUid }) => {
      if (!detectedAccount?.id) return null;
      const updated = await backendRequest(`/api/accounts/${encodeURIComponent(detectedAccount.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'enabled',
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
      await scheduleDmMonitorRefreshAfterLogin(updated).catch((error) => {
        console.warn('[main] dm monitor schedule after login failed:', error.message || String(error));
      });
      return updated;
    },
    });
    if (result?.ok !== false) {
      await wakeDmMonitorAfterBrowserAction(account?.id, 'open');
    }
    return result;
  });
  ipcMain.handle('browser:open-edge-account', async (_event, account) => edgeHost.openAccountEdge(app, account));
  ipcMain.handle('browser:edge-status', async () => edgeHost.getEdgeStatus());
  ipcMain.handle('browser:open-clean-login', async (_event, account) => browserTabs.openCleanLoginBrowser(mainWindow, account));
  ipcMain.handle('browser:close-account', async () => browserTabs.closeAccountBrowser(mainWindow));
  ipcMain.handle('browser:hide-account', async () => browserTabs.hideAccountBrowser(mainWindow));
  ipcMain.handle('browser:show-account', async () => browserTabs.showAccountBrowser(mainWindow));
  ipcMain.handle('browser:reload-account', async () => {
    const result = await browserTabs.reloadAccountBrowser();
    if (result?.ok !== false) {
      const accountId = browserTabs.getBridgeDiagnostic()?.activeAccountKey;
      await wakeDmMonitorAfterBrowserAction(accountId, 'reload');
    }
    return result;
  });
  ipcMain.handle('browser:set-dock-mode', async (_event, mode) => browserTabs.setBrowserDockMode(mainWindow, mode));
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
  ipcMain.handle('bridge:dm-auth', async (event) => {
    const senderUrl = String(event.sender?.getURL?.() || '');
    let senderHost = '';
    try {
      senderHost = new URL(senderUrl).hostname.toLowerCase();
    } catch (_error) {}
    if (senderHost !== 'douyin.com' && !senderHost.endsWith('.douyin.com')) {
      throw new Error('仅允许抖音账号浏览器读取私信登录凭据');
    }
    const cookies = await event.sender.session.cookies.get({ url: 'https://www.douyin.com/' });
    const sessionCookie = cookies.find((cookie) => cookie.name === 'sessionid')
      || cookies.find((cookie) => cookie.name === 'sessionid_ss');
    return { sessionToken: sessionCookie?.value || '' };
  });
}

app.whenReady().then(async () => {
  writeMainLog(`app ready packaged=${app.isPackaged} appPath=${app.getAppPath()} resourcesPath=${process.resourcesPath || ''}`);
  startPackagedSmokeExitWatcher();
  try {
    backendStartup = await localBackend.ensureStarted(app);
    writeMainLog(`backend startup: ${JSON.stringify(backendStartup)}`);
  } catch (error) {
    backendStartup = {
      ok: false,
      mode: 'local',
      message: error.message || String(error),
    };
    writeMainLog(`backend startup failed: ${error.stack || error.message || String(error)}`);
  }
  registerIpc();
  createWindow();
  if (backendStartup?.ok) {
    try {
      await startDmRuntime();
    } catch (error) {
      console.warn('[main] DM runtime autostart failed:', error.message || String(error));
    }
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (backendStartup?.ok) {
        await startDmRuntime().catch((error) => {
          console.warn('[main] DM runtime start on activate failed:', error.message || String(error));
        });
      }
    }
  });
});

async function shutdownApplication() {
  const stages = [
    ['DM monitor stop', () => stopDmMonitor()],
    ['DM transport stop', () => dmClient.stopAll()],
    ['DM worker stop', () => stopDmWorker()],
    ['BrowserView shutdown', () => browserTabs.shutdown(mainWindow)],
    ['local backend stop', () => localBackend.stop()],
  ];
  for (const [stage, action] of stages) {
    try {
      await action();
    } catch (error) {
      writeMainLog(`${stage} failed during quit: ${error.stack || error.message || String(error)}`);
    }
  }
}

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  stopPackagedSmokeExitWatcher();
  clearDmLoginMonitorRefreshes();
  if (quitCleanupPromise) return;
  quitCleanupPromise = shutdownApplication().finally(() => {
    quitCleanupComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
