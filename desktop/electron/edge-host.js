const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const WebSocket = require('ws');

const DOUYIN_HOME_URL = 'https://www.douyin.com/jingxuan';
const SITE = 'douyin.com';
const CDP_HOST = '127.0.0.1';
const PORT_BASE = 43000;
const PORT_RANGE = 2000;
const BRIDGE_INJECTION_VERSION = '2026-07-09-read-fetch-fallback';
const sessions = new Map();
let activeAccountKey = '';

function accountKeyFor(account = {}) {
  return String(account.profileKey || account.id || '').trim();
}

function sanitizeProfileKey(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function edgeProfileDir(userDataPath, account = {}) {
  return path.join(userDataPath, 'edge-profiles', sanitizeProfileKey(accountKeyFor(account)));
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function edgeDebugPortForAccount(account = {}) {
  const key = accountKeyFor(account) || 'default';
  return PORT_BASE + (hashString(key) % PORT_RANGE);
}

function getEdgeCandidates(env = process.env) {
  const candidates = [
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates;
}

function findEdgeExecutable() {
  for (const candidate of getEdgeCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const result = execFileSync('where', ['msedge'], { encoding: 'utf8', windowsHide: true });
    const found = result.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found && fs.existsSync(found)) return found;
  } catch {
    // ignore and report the friendly error below
  }
  return '';
}

function buildEdgeArgs({ port, profileDir, url = DOUYIN_HOME_URL }) {
  return [
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ];
}

function resolveBridgeConfig() {
  try {
    const configPath = path.resolve(__dirname, '..', '..', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw) || {};
    const bridge = cfg.bridge || {};
    const rawHost = String(bridge.host || '127.0.0.1').trim().replace(/^[a-z]+:\/\//, '');
    const host = rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
    const port = Number(bridge.port || 19422);
    const resolvedPort = Number.isFinite(port) && port > 0 ? port : 19422;
    return {
      host,
      port: resolvedPort,
      site: SITE,
      token: bridge.token || '',
      server: `http://${host}:${resolvedPort}`,
      managedPoll: true,
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: 19422,
      site: SITE,
      token: '',
      server: 'http://127.0.0.1:19422',
      managedPoll: true,
    };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function bridgeJson(config, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetchJson(`${config.server}${pathname}`, { ...options, headers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://${CDP_HOST}:${port}/json/version`);
      if (version?.Browser) return version;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`Edge 调试端口连接超时：${lastError?.message || port}`);
}

async function listCdpPages(port) {
  const pages = await fetchJson(`http://${CDP_HOST}:${port}/json/list`);
  return Array.isArray(pages) ? pages : [];
}

async function findDouyinPage(port) {
  const pages = await listCdpPages(port);
  return pages.find((page) => (
    page.type === 'page'
    && page.webSocketDebuggerUrl
    && String(page.url || '').includes('douyin.com')
  )) || pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const item = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else item.resolve(msg.result || {});
  });

  ws.on('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Edge CDP 连接已关闭'));
    }
    pending.clear();
  });

  async function send(method, params = {}, timeoutMs = 30000) {
    await opened;
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Edge CDP 调用超时：${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function close() {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  return { send, close };
}

function safePageEval(expression, awaitPromise) {
  return `
    (async function () {
      var value = (0, eval)(${JSON.stringify(expression)});
      if (${awaitPromise === false ? 'false' : 'true'}) {
        value = await Promise.resolve(value);
      }
      return JSON.parse(JSON.stringify(value === undefined ? null : value, function (_key, val) {
        return typeof val === 'bigint' ? val.toString() : val;
      }));
    })();
  `;
}

function buildInjectionScript() {
  const bridgeConfig = resolveBridgeConfig();
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'douyin.user.js');
  const userscript = fs.readFileSync(scriptPath, 'utf8');

  return `
    (function () {
      window.__douyinDesktopBridgeConfig = ${JSON.stringify(bridgeConfig)};
      if (window.__douyinDesktopBridgeInjectedVersion === ${JSON.stringify(BRIDGE_INJECTION_VERSION)}) return true;
      window.__douyinDesktopBridgeInjected = true;
      window.__douyinDesktopBridgeInjectedVersion = ${JSON.stringify(BRIDGE_INJECTION_VERSION)};
      window.unsafeWindow = window;
      ${userscript}
      return Boolean(window.__bridge);
    })();
  `;
}

async function cdpEvaluate(client, expression, awaitPromise = true, timeoutMs = 60000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || '页面执行失败';
    throw new Error(text);
  }
  return result.result?.value;
}

async function connectPageSession(session) {
  if (session.client) return session.client;
  await waitForCdp(session.port);
  const page = await findDouyinPage(session.port);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('没有找到可连接的 Edge 抖音页面，请确认 Edge 已打开 douyin.com');
  }
  const client = createCdpClient(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  session.client = client;
  session.pageId = page.id;
  session.url = page.url || '';
  return client;
}

async function startPoller(session) {
  if (session.poller?.running) return;
  const client = await connectPageSession(session);
  await cdpEvaluate(client, buildInjectionScript(), true);

  const config = resolveBridgeConfig();
  const userAgent = await cdpEvaluate(client, 'navigator.userAgent', true).catch(() => '');
  const locationHref = await cdpEvaluate(client, 'location.href', true).catch(() => '');
  const title = await cdpEvaluate(client, 'document.title', true).catch(() => '');
  const payload = await bridgeJson(config, '/api/connect', {
    method: 'POST',
    body: JSON.stringify({
      site: config.site,
      url: locationHref || session.url || '',
      title,
      userAgent,
    }),
  });

  const controller = { running: true, stopped: false };
  session.poller = controller;
  session.connId = payload.id || '';

  (async () => {
    let failures = 0;
    while (!controller.stopped) {
      try {
        const suffix = `?site=${encodeURIComponent(config.site)}${session.connId ? `&connId=${encodeURIComponent(session.connId)}` : ''}`;
        const msg = await bridgeJson(config, `/api/poll${suffix}`, { method: 'GET' });
        failures = 0;
        if (msg.type !== 'eval') continue;

        try {
          const value = await cdpEvaluate(client, safePageEval(msg.expression, msg.awaitPromise), true, 90000);
          await bridgeJson(config, '/api/result', {
            method: 'POST',
            body: JSON.stringify({ id: msg.id, value }),
          });
        } catch (error) {
          await bridgeJson(config, '/api/result', {
            method: 'POST',
            body: JSON.stringify({ id: msg.id, error: error.message || String(error) }),
          });
        }
      } catch (error) {
        if (controller.stopped) return;
        failures += 1;
        console.warn('[edge-host] bridge poll failed:', error.message);
        if (failures >= 3) controller.stopped = true;
        await sleep(1000);
      }
    }
    controller.running = false;
  })();
}

async function openAccountEdge(app, account = {}) {
  const accountKey = accountKeyFor(account);
  if (!accountKey) return { ok: false, error: '账号缺少 profileKey 或 id，无法创建独立 Edge 环境' };

  const existing = sessions.get(accountKey);
  if (existing?.process && !existing.process.killed) {
    activeAccountKey = accountKey;
    return {
      ok: true,
      reused: true,
      mode: 'edge',
      accountKey,
      port: existing.port,
      profileDir: existing.profileDir,
      pid: existing.process.pid,
    };
  }

  const executable = findEdgeExecutable();
  if (!executable) {
    return { ok: false, error: '没有找到 Microsoft Edge（msedge.exe），请先安装 Edge 或检查系统 PATH' };
  }

  const profileDir = edgeProfileDir(app.getPath('userData'), account);
  fs.mkdirSync(profileDir, { recursive: true });
  const port = edgeDebugPortForAccount(account);
  const args = buildEdgeArgs({ port, profileDir, url: DOUYIN_HOME_URL });

  const child = spawn(executable, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const session = {
    accountKey,
    account,
    executable,
    process: child,
    profileDir,
    port,
    startedAt: new Date().toISOString(),
    client: null,
    poller: null,
    connId: '',
  };
  sessions.set(accountKey, session);
  activeAccountKey = accountKey;

  child.once('exit', () => {
    if (session.client) session.client.close();
    if (session.poller) session.poller.stopped = true;
    sessions.delete(accountKey);
    if (activeAccountKey === accountKey) activeAccountKey = '';
  });

  await waitForCdp(port);
  return {
    ok: true,
    mode: 'edge',
    accountKey,
    port,
    profileDir,
    pid: child.pid,
  };
}

async function ensureEdgeBridge() {
  const session = sessions.get(activeAccountKey);
  if (!session) return { ok: false, error: '还没有打开托管 Edge，请先在账号页点击“打开 Edge 浏览器”' };
  try {
    await startPoller(session);
    return {
      ok: true,
      mode: 'edge',
      accountKey: session.accountKey,
      port: session.port,
      profileDir: session.profileDir,
    };
  } catch (error) {
    return { ok: false, error: `Edge Bridge 启用失败：${error.message || String(error)}` };
  }
}

async function getEdgeStatus() {
  const items = [];
  for (const session of sessions.values()) {
    let connected = false;
    let pages = [];
    try {
      await waitForCdp(session.port, 1000);
      pages = await listCdpPages(session.port);
      connected = true;
    } catch {
      connected = false;
    }
    items.push({
      accountKey: session.accountKey,
      active: session.accountKey === activeAccountKey,
      connected,
      port: session.port,
      profileDir: session.profileDir,
      pid: session.process?.pid || null,
      bridge: Boolean(session.poller?.running && !session.poller?.stopped),
      url: pages.find((page) => String(page.url || '').includes('douyin.com'))?.url || '',
    });
  }
  return { ok: true, activeAccountKey, sessions: items };
}

function hasActiveEdgeSession() {
  return Boolean(activeAccountKey && sessions.has(activeAccountKey));
}

module.exports = {
  buildEdgeArgs,
  edgeDebugPortForAccount,
  edgeProfileDir,
  ensureEdgeBridge,
  findEdgeExecutable,
  getEdgeCandidates,
  getEdgeStatus,
  hasActiveEdgeSession,
  openAccountEdge,
  sanitizeProfileKey,
};
