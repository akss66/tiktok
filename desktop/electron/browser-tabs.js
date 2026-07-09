const fs = require('fs');
const path = require('path');
const { BrowserView, BrowserWindow, session } = require('electron');
const { partitionForAccount } = require('./profiles');
const {
  BRIDGE_INJECTION_VERSION,
  DOUYIN_HOME_URL,
  DOUYIN_LOGIN_URL,
  LOGIN_COOKIE_CHECK_INTERVAL_MS,
  LOGIN_PAGE_COOLDOWN_MS,
  chromeCompatUserAgent,
  getDockedBrowserWidth,
  isHttpUrl,
  resolveBridgeConfig,
  shouldBlockExternalProtocol,
} = require('./browser-config');
const {
  buildLoginProbeScript,
  getLoginCookieResult,
  isLoggedInCookie,
  isLoggedInProbeResult,
  readDouyinLoginCookies,
} = require('./login-detector');
const { compileUserscriptForElectron } = require('./userscript-compiler');

let activeView = null;
let activeAccountKey = null;
let activeViewVisible = false;
let activePollController = null;
let activeDiagnosticView = false;
let activeBridgeDiagnostic = {
  status: 'idle',
  message: '',
  url: '',
  updatedAt: null,
};
const accountViews = new Map();
const loginDetectors = new Map();
const loginPageOpenedAt = new Map();

function createAccountBrowserView(account, options = {}) {
  const webPreferences = {
    partition: options.partition || partitionForAccount(account),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  if (options.bridgePreload) {
    webPreferences.preload = path.join(__dirname, 'bridge-preload.js');
  }
  const view = new BrowserView({ webPreferences });
  view.__douyinDesktopBridgePreload = Boolean(options.bridgePreload);
  view.webContents.setUserAgent(chromeCompatUserAgent(), 'zh-CN,zh;q=0.9');
  return view;
}

function destroyActiveView(mainWindow) {
  stopActivePoller();
  if (!activeView) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(activeView);
  }
  if (activeAccountKey) accountViews.delete(activeAccountKey);
  activeView.webContents.destroy();
  activeView = null;
  activeAccountKey = null;
  activeViewVisible = false;
  activeDiagnosticView = false;
}

function detachActiveView(mainWindow) {
  if (!activeView || !activeViewVisible) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(activeView);
  }
  activeViewVisible = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopActivePoller() {
  if (activePollController) {
    activePollController.stopped = true;
    if (activePollController.abortController) {
      activePollController.abortController.abort();
    }
    activePollController = null;
  }
}

function accountKeyFor(account) {
  return String(account?.id || account?.profileKey || '').trim();
}

function getLoginCooldown(accountKey) {
  const lastOpenedAt = loginPageOpenedAt.get(accountKey) || 0;
  const elapsed = Date.now() - lastOpenedAt;
  const remainingMs = Math.max(0, LOGIN_PAGE_COOLDOWN_MS - elapsed);
  return {
    blocked: remainingMs > 0,
    remainingSeconds: Math.ceil(remainingMs / 1000),
  };
}

function markLoginPageOpened(accountKey) {
  loginPageOpenedAt.set(accountKey, Date.now());
}

function stopLoginDetector(accountKey) {
  const detector = loginDetectors.get(accountKey);
  if (!detector) return;
  clearInterval(detector.timer);
  if (typeof detector.cleanup === 'function') detector.cleanup();
  loginDetectors.delete(accountKey);
}

function startLoginDetector(mainWindow, view, account, options = {}) {
  const accountKey = accountKeyFor(account);
  if (!accountKey || !view || view.webContents.isDestroyed()) return;
  stopLoginDetector(accountKey);

  let detected = false;
  let running = false;
  const check = async () => {
    if (detected || running || view.webContents.isDestroyed()) return;
    const url = String(view.webContents.getURL() || '');
    if (!url.includes('douyin.com') || url.startsWith('chrome-error://')) return;
    running = true;
    try {
      const result = await readDouyinLoginCookies(view);
      if (result?.loggedIn) {
        detected = true;
        stopLoginDetector(accountKey);
        if (typeof options.onLoginDetected === 'function') {
          await options.onLoginDetected({
            account,
            nickname: '',
            uid: result.uid || '',
            secUid: '',
          });
        }
        notifyBrowserNotice(mainWindow, `检测到 ${account.name || '账号'} 已登录，账号状态已自动更新。`, {
          accountId: account.id,
          source: result.source || 'cookie',
        });
      }
    } catch (error) {
      if (process.env.DOUYIN_DEBUG) console.warn('[browser-tabs] login cookie check failed:', error.message);
    } finally {
      running = false;
    }
  };

  const handleCookieChanged = (_event, cookie, cause, removed) => {
    if (!removed && isLoggedInCookie(cookie)) {
      setTimeout(check, 300);
    }
  };
  view.webContents.session.cookies.on('changed', handleCookieChanged);

  const timer = setInterval(check, LOGIN_COOKIE_CHECK_INTERVAL_MS);
  loginDetectors.set(accountKey, {
    timer,
    cleanup: () => view.webContents.session.cookies.off('changed', handleCookieChanged),
  });
  setTimeout(check, 2500);
}

async function bridgeJson(config, pathname, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${config.server}${pathname}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `Bridge request failed: ${response.status}`);
  }
  return data;
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

async function executeBridgeEval(view, msg) {
  try {
    const value = await view.webContents.executeJavaScript(
      safePageEval(msg.expression, msg.awaitPromise),
      true,
    );
    return value;
  } catch (error) {
    const expression = String(msg?.expression || '');
    const preview = expression.length > 180 ? `${expression.slice(0, 180)}...` : expression;
    throw new Error(`页面任务执行失败：${error.message || String(error)}；表达式：${preview}`);
  }
}

async function startMainPoller(view) {
  if (
    activePollController
    && !activePollController.stopped
    && activePollController.view === view
  ) {
    return activePollController;
  }
  stopActivePoller();
  const config = resolveBridgeConfig();
  const controller = { stopped: false, abortController: null, view };
  activePollController = controller;

  try {
    const userAgent = await view.webContents.executeJavaScript('navigator.userAgent', true).catch(() => '');
    const payload = await bridgeJson(config, '/api/connect', {
      method: 'POST',
      body: JSON.stringify({
        site: config.site,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        userAgent,
      }),
    });
    const connId = payload.id || '';
    activeBridgeDiagnostic = {
      status: 'ready',
      message: '任务连接已建立',
      url: view.webContents.getURL(),
      updatedAt: new Date().toISOString(),
    };
    let failures = 0;

    while (!controller.stopped && !view.webContents.isDestroyed()) {
      const abortController = new AbortController();
      controller.abortController = abortController;
      const timeout = setTimeout(() => abortController.abort(), 35000);

      try {
        const suffix = `?site=${encodeURIComponent(config.site)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`;
        const msg = await bridgeJson(config, `/api/poll${suffix}`, {
          method: 'GET',
          signal: abortController.signal,
        });
        failures = 0;

        if (msg.type === 'eval') {
          try {
            const value = await executeBridgeEval(view, msg);
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
        }
      } catch (error) {
        if (controller.stopped) return;
        failures += 1;
        console.warn('[browser-tabs] bridge poll failed:', error.message);
        if (failures >= 3) {
          activeBridgeDiagnostic = {
            status: 'poll_failed',
            message: error.message || String(error),
            url: view.webContents.getURL(),
            updatedAt: new Date().toISOString(),
          };
          break;
        }
        await sleep(1000);
      } finally {
        clearTimeout(timeout);
        if (controller.abortController === abortController) {
          controller.abortController = null;
        }
      }
    }
  } catch (error) {
    if (!controller.stopped) {
      activeBridgeDiagnostic = {
        status: 'poll_failed',
        message: error.message || String(error),
        url: view.webContents.isDestroyed() ? '' : view.webContents.getURL(),
        updatedAt: new Date().toISOString(),
      };
      console.warn('[browser-tabs] bridge poller stopped:', error.message);
    }
  }

  if (!controller.stopped && activePollController === controller && !view.webContents.isDestroyed()) {
    await sleep(2000);
    if (!controller.stopped && activePollController === controller) {
      activePollController = null;
      startMainPoller(view);
    }
  }
  return controller;
}

function buildInjectionScript() {
  const bridgeConfig = resolveBridgeConfig();
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'douyin.user.js');
  const userscript = fs.readFileSync(scriptPath, 'utf8');
  const compiledUserscript = compileUserscriptForElectron(userscript);

  return `
    (function () {
      try {
        window.__douyinDesktopBridgeConfig = ${JSON.stringify(bridgeConfig)};
        if (
          window.__douyinDesktopBridgeInjectedVersion === ${JSON.stringify(BRIDGE_INJECTION_VERSION)}
          && window.__bridge
          && typeof window.__bridge.search === 'function'
        ) return { ok: true, reused: true };
        window.__douyinDesktopBridgeInjected = false;
        window.__douyinDesktopBridgeInjectedVersion = '';
        var bridgeFetch = window.__electronBridgeFetch;
        if (!bridgeFetch || typeof bridgeFetch.request !== 'function') {
          throw new Error('[Bridge] __electronBridgeFetch not available; preload may have failed');
        }

        window.GM_xmlhttpRequest = function(details) {
          if (!bridgeFetch) {
            if (details.onerror) details.onerror(new Error('Bridge preload not available'));
            return;
          }
          var timedOut = false;
          var timeout = details.timeout ? setTimeout(function() {
            timedOut = true;
            if (details.ontimeout) details.ontimeout();
          }, details.timeout) : null;

          bridgeFetch.request(
            details.method || 'GET',
            details.url,
            details.headers || {},
            details.data || details.body || null
          ).then(function(result) {
            if (timeout) clearTimeout(timeout);
            if (timedOut) return;
            if (result.error && details.onerror) {
              details.onerror(new Error(result.error));
              return;
            }
            if (details.onload) {
              details.onload({
                status: result.status || 0,
                statusText: result.statusText || '',
                responseText: result.responseText || '',
                finalUrl: result.finalUrl || details.url,
                responseHeaders: result.responseHeaders || ''
              });
            }
          }).catch(function(err) {
            if (timeout) clearTimeout(timeout);
            if (!timedOut && details.onerror) details.onerror(err);
          });
        };
        var unsafeWindow = window;
        window.unsafeWindow = unsafeWindow;
        var GM_xmlhttpRequest = window.GM_xmlhttpRequest;

        ${compiledUserscript}

        if (!window.__bridge || typeof window.__bridge.search !== 'function') {
          throw new Error('[Bridge] userscript did not create window.__bridge.search');
        }
        window.__douyinDesktopBridgeInjected = true;
        window.__douyinDesktopBridgeInjectedVersion = ${JSON.stringify(BRIDGE_INJECTION_VERSION)};
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error && error.message ? error.message : String(error),
          stack: error && error.stack ? String(error.stack).slice(0, 1000) : ''
        };
      }
    })();
  `;
}

function resizeActiveBrowser(mainWindow) {
  if (!activeView || !activeViewVisible || !mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const browserWidth = getDockedBrowserWidth(width);
  activeView.setBounds({
    x: Math.max(0, width - browserWidth),
    y: 0,
    width: browserWidth,
    height,
  });
}

function notifyBrowserNotice(mainWindow, message, metadata = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('browser:notice', { message, metadata, createdAt: new Date().toISOString() });
}

function blockExternalNavigation(event, url, mainWindow) {
  if (shouldBlockExternalProtocol(url)) {
    event.preventDefault();
    console.warn('[browser-tabs] blocked external protocol:', url);
    notifyBrowserNotice(mainWindow, '已拦截抖音 App 跳转，请继续使用内置浏览器登录或操作。', { url });
    return true;
  }
  return false;
}

async function injectBridge(view) {
  if (view.webContents.getURL().startsWith('chrome-error://')) {
    return { ok: false, error: '当前页面加载失败，无法注入任务 Bridge。' };
  }
  if (
    activePollController
    && !activePollController.stopped
    && activePollController.view === view
    && activeBridgeDiagnostic.status === 'ready'
  ) {
    const ready = await view.webContents.executeJavaScript(
      'Boolean(window.__bridge && typeof window.__bridge.search === "function")',
      true,
    ).catch(() => false);
    if (ready) return { ok: true, reused: true };
  }
  activeBridgeDiagnostic = {
    status: 'injecting',
    message: '',
    url: view.webContents.getURL(),
    updatedAt: new Date().toISOString(),
  };
  stopActivePoller();
  try {
    const injectionResult = await view.webContents.executeJavaScript(buildInjectionScript(), true);
    if (!injectionResult?.ok) {
      throw new Error(injectionResult?.error || '页面注入脚本执行失败');
    }
    const ready = await view.webContents.executeJavaScript(
      'Boolean(window.__bridge && typeof window.__bridge.search === "function")',
      true,
    );
    if (!ready) {
      throw new Error('页面 Bridge API 未准备好：window.__bridge.search 不存在');
    }
    activeBridgeDiagnostic = {
      status: 'connecting',
      message: '页面 Bridge 已创建，正在连接任务服务',
      url: view.webContents.getURL(),
      updatedAt: new Date().toISOString(),
    };
    startMainPoller(view);
    return { ok: true };
  } catch (error) {
    stopActivePoller();
    activeBridgeDiagnostic = {
      status: 'inject_failed',
      message: error.message || String(error),
      url: view.webContents.getURL(),
      updatedAt: new Date().toISOString(),
    };
    console.error('[browser-tabs] bridge injection failed:', error.message);
    return { ok: false, error: error.message || String(error) };
  }
}

function getBridgeDiagnostic() {
  return {
    ...activeBridgeDiagnostic,
    hasActiveView: Boolean(activeView && !activeView.webContents.isDestroyed()),
    activeAccountKey,
    activeViewVisible,
    activeDiagnosticView,
    bridgePreload: Boolean(activeView?.__douyinDesktopBridgePreload),
    activeUrl: activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.getURL() : '',
  };
}

async function forceStartBridge(mainWindow) {
  if (!activeView || activeView.webContents.isDestroyed()) {
    return { ok: false, error: '没有已打开的账号浏览器。' };
  }
  const url = String(activeView.webContents.getURL() || '');
  if (!url.includes('douyin.com') || url.startsWith('chrome-error://')) {
    return { ok: false, error: '当前账号浏览器不在抖音页面。' };
  }
  const injected = await injectBridge(activeView);
  if (!injected.ok) return injected;
  notifyBrowserNotice(mainWindow, '已尝试重新连接任务 Bridge。', { url });
  return { ok: true, diagnostic: getBridgeDiagnostic() };
}


function isFreshBridgeConnection(conn, now = Date.now(), maxIdleMs = 45000) {
  if (!conn || conn.alive === false) return false;
  const last = Date.parse(conn.lastActivity || conn.connectedAt || '');
  if (!Number.isFinite(last)) return Boolean(conn.alive);
  return now - last <= maxIdleMs;
}

function isRealBridgeBrowser(conn) {
  const url = String(conn?.url || '').toLowerCase();
  const title = String(conn?.title || '').toLowerCase();
  const userAgent = String(conn?.userAgent || '').toLowerCase();
  if (title.includes('desktop poll mock')) return false;
  if (userAgent.includes('poll-mock-client')) return false;
  return url.includes('douyin.com');
}

async function waitForBridgePollClient(timeoutMs = 7000) {
  const config = resolveBridgeConfig();
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastStatus = await bridgeJson(config, '/api/status');
      const conns = lastStatus?.connections?.[config.site] || [];
      if (Array.isArray(conns) && conns.some((conn) => isFreshBridgeConnection(conn) && isRealBridgeBrowser(conn))) {
        return { ok: true };
      }
    } catch (error) {
      lastStatus = { error: error.message };
    }
    await sleep(300);
  }

  const aliveCount = Number(lastStatus?.totalAliveConnections || 0);
  const waiters = Number(lastStatus?.pollWaiters?.[config.site] || 0);
  return {
    ok: false,
    error: `任务 Bridge 未连接到当前账号浏览器。请在账号页打开该账号浏览器，确认抖音页面正常加载后再执行搜索。当前在线连接：${aliveCount}，等待中的浏览器：${waiters}。`,
  };
}

async function ensureBridgeInjected(mainWindow) {
  if (!activeView || activeView.webContents.isDestroyed()) {
    return { ok: false, error: '没有已打开的账号浏览器，请先在账号页打开浏览器并登录。' };
  }
  if (activeDiagnosticView) {
    return { ok: false, error: '当前是纯净登录诊断浏览器，请切回账号浏览器后再执行任务。' };
  }
  const currentUrl = String(activeView.webContents.getURL() || '');
  if (!currentUrl.includes('douyin.com') || currentUrl.startsWith('chrome-error://')) {
    return { ok: false, error: '当前账号浏览器不在抖音页面，请先打开并登录 douyin.com。' };
  }
  if (!activeView.__douyinDesktopBridgePreload) {
    const upgraded = await upgradeActiveViewForBridge(mainWindow, currentUrl);
    if (!upgraded.ok) return upgraded;
  }
  await forceStartBridge(mainWindow);
  const ready = await waitForBridgePollClient();
  if (!ready.ok) {
    notifyBrowserNotice(mainWindow, ready.error, { url: currentUrl });
    return ready;
  }
  notifyBrowserNotice(mainWindow, '已启用任务 Bridge，正在使用当前账号浏览器执行操作。', { url: currentUrl });
  return { ok: true };
}

async function upgradeActiveViewForBridge(mainWindow, currentUrl) {
  if (!activeView || !activeAccountKey || activeDiagnosticView) {
    return { ok: false, error: '当前浏览器不能切换为任务模式。' };
  }
  const accountKey = activeAccountKey;
  const existing = activeView;
  const existingAccount = { id: accountKey, profileKey: accountKey };
  detachActiveView(mainWindow);
  stopActivePoller();

  const nextView = createAccountBrowserView(existingAccount, { bridgePreload: true });
  accountViews.set(accountKey, nextView);
  activeView = nextView;
  activeAccountKey = accountKey;
  activeDiagnosticView = false;
  mainWindow.setBrowserView(nextView);
  activeViewVisible = true;
  resizeActiveBrowser(mainWindow);
  attachBrowserHandlers(mainWindow, nextView, existingAccount, { taskMode: true });

  if (!existing.webContents.isDestroyed()) existing.webContents.destroy();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: '任务浏览器切换超时，请重新打开账号浏览器后再执行任务。' });
    }, 20000);
    nextView.webContents.once('did-finish-load', () => finish({ ok: true }));
    nextView.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      finish({
        ok: false,
        error: `任务浏览器切换失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      });
    });
    nextView.webContents.loadURL(currentUrl || DOUYIN_HOME_URL).catch((error) => {
      finish({ ok: false, error: `任务浏览器切换失败：${error.message}` });
    });
  });
}

async function resetAccountBrowserData(mainWindow, account) {
  const accountKey = accountKeyFor(account);
  if (!accountKey) return { ok: false, error: '账号信息缺少 Profile Key' };

  const view = accountViews.get(accountKey);
  if (view) {
    destroyCurrentAccountView(mainWindow, accountKey, view);
  }

  const ses = session.fromPartition(partitionForAccount(account));
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
  });
  await ses.clearCache();
  notifyBrowserNotice(mainWindow, `${account.name || '账号'} 的浏览器环境已重置，请重新打开浏览器扫码。`, {
    accountId: account.id,
  });
  return { ok: true };
}

async function fetchWithActiveBrowserSession({ method, url, headers, body }) {
  if (!activeView || activeView.webContents.isDestroyed()) return null;
  const ses = activeView.webContents.session;
  if (!ses || typeof ses.fetch !== 'function') return null;

  const safeHeaders = {};
  let referrer = '';
  Object.entries(headers || {}).forEach(([key, value]) => {
    const normalized = String(key).toLowerCase();
    if (normalized === 'referer' || normalized === 'referrer') {
      referrer = String(value || '');
      return;
    }
    if (['cookie', 'host', 'connection', 'content-length'].includes(normalized)) return;
    safeHeaders[key] = value;
  });

  let response;
  try {
    response = await ses.fetch(url, {
      method: method || 'GET',
      headers: safeHeaders,
      body: body || undefined,
      credentials: 'include',
      ...(referrer ? { referrer } : {}),
    });
  } catch (error) {
    throw new Error(`浏览器会话请求失败：${error.message || String(error)}；URL：${url}`);
  }
  const responseText = await response.text();
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    responseText,
    finalUrl: response.url || url,
    responseHeaders: JSON.stringify(responseHeaders),
  };
}

async function fetchWithActiveBrowserSessionWithFallback(request) {
  try {
    return await fetchWithActiveBrowserSession(request);
  } catch (error) {
    const fallback = await fetchWithHiddenNavigation({
      ...request,
      session: activeView && !activeView.webContents.isDestroyed()
        ? activeView.webContents.session
        : null,
      userAgent: activeView && !activeView.webContents.isDestroyed()
        ? activeView.webContents.getUserAgent()
        : '',
    }).catch((fallbackError) => ({
      status: 0,
      error: `browser session fetch failed: ${error.message || String(error)}; navigation fallback failed: ${fallbackError.message || String(fallbackError)}; URL: ${request && request.url}`,
    }));
    if (fallback) return fallback;
    throw error;
  }
}

async function fetchWithHiddenNavigation({ method, url, headers, session: browserSession, userAgent }) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(normalizedMethod)) return null;
  if (!browserSession || !url) return null;

  const safeHeaders = {};
  let referrer = '';
  Object.entries(headers || {}).forEach(([key, value]) => {
    const normalized = String(key).toLowerCase();
    if (normalized === 'referer' || normalized === 'referrer') {
      referrer = String(value || '');
      return;
    }
    if (['cookie', 'host', 'connection', 'content-length'].includes(normalized)) return;
    safeHeaders[key] = value;
  });

  const requestWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (userAgent) requestWindow.webContents.setUserAgent(userAgent, 'zh-CN,zh;q=0.9');

  let statusCode = 200;
  const completedHandler = (details) => {
    if (details.webContentsId === requestWindow.webContents.id) {
      statusCode = details.statusCode || statusCode;
    }
  };
  browserSession.webRequest.onCompleted({ urls: [url] }, completedHandler);

  try {
    const extraHeaders = Object.entries(safeHeaders)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    await Promise.race([
      requestWindow.webContents.loadURL(url, {
        ...(referrer ? { httpReferrer: referrer } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('navigation fallback timeout')), 35000)),
    ]);
    const responseText = await requestWindow.webContents.executeJavaScript(
      'document.body ? document.body.innerText : document.documentElement.innerText',
      true,
    );
    return {
      status: statusCode,
      statusText: '',
      responseText: String(responseText || ''),
      finalUrl: requestWindow.webContents.getURL() || url,
      responseHeaders: '{}',
    };
  } finally {
    browserSession.webRequest.onCompleted({ urls: [url] }, null);
    if (!requestWindow.isDestroyed()) requestWindow.destroy();
  }
}

async function runBridgeSelfTest() {
  if (!activeView || activeView.webContents.isDestroyed()) {
    return { ok: false, stage: 'browser', error: '没有已打开的账号浏览器' };
  }
  const url = String(activeView.webContents.getURL() || '');
  const result = {
    ok: false,
    url,
    stages: {},
  };

  try {
    result.stages.page = await activeView.webContents.executeJavaScript(`(() => ({
      href: location.href,
      title: document.title,
      hasBridge: Boolean(window.__bridge),
      hasSearch: Boolean(window.__bridge && typeof window.__bridge.search === 'function'),
      hasGM: typeof window.GM_xmlhttpRequest === 'function',
      hasElectronFetch: Boolean(window.__electronBridgeFetch && typeof window.__electronBridgeFetch.request === 'function')
    }))()`, true);
  } catch (error) {
    result.stages.page = { ok: false, error: error.message || String(error) };
  }

  try {
    const proxyResult = await activeView.webContents.executeJavaScript(`new Promise((resolve) => {
      if (!window.GM_xmlhttpRequest) {
        resolve({ ok: false, error: 'GM_xmlhttpRequest 不存在' });
        return;
      }
      window.GM_xmlhttpRequest({
        method: 'GET',
        url: location.origin + '/favicon.ico',
        timeout: 10000,
        onload: function(resp) { resolve({ ok: true, status: resp.status, finalUrl: resp.finalUrl || '' }); },
        onerror: function(err) { resolve({ ok: false, error: (err && err.message) || String(err) }); },
        ontimeout: function() { resolve({ ok: false, error: 'timeout' }); }
      });
    })`, true);
    result.stages.proxyFetch = proxyResult;
  } catch (error) {
    result.stages.proxyFetch = { ok: false, error: error.message || String(error) };
  }

  result.ok = Boolean(result.stages.page?.hasSearch && result.stages.proxyFetch?.ok);
  return result;
}

async function openAccountBrowser(mainWindow, account, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '主窗口不可用' };
  }

  const accountKey = accountKeyFor(account);
  if (!accountKey) {
    return { ok: false, error: '账号信息缺少 Profile Key' };
  }

  const cooldown = getLoginCooldown(accountKey);
  if (!activeView || activeAccountKey !== accountKey) {
    if (cooldown.blocked) {
      return {
        ok: false,
        error: `登录页冷却中，还剩 ${cooldown.remainingSeconds} 秒。刚出现“访问太频繁/系统繁忙”时不要反复重开或刷新。`,
      };
    }
  }

  if (activeView && activeAccountKey !== accountKey) {
    detachActiveView(mainWindow);
    stopActivePoller();
  }

  let view = accountViews.get(accountKey);
  if (view && !view.webContents.isDestroyed() && !view.__douyinDesktopBridgePreload) {
    if (activeView === view) {
      detachActiveView(mainWindow);
      stopActivePoller();
      activeView = null;
      activeAccountKey = null;
      activeViewVisible = false;
    }
    view.webContents.destroy();
    accountViews.delete(accountKey);
    view = null;
  }
  const reused = Boolean(view && !view.webContents.isDestroyed());
  if (!reused) {
    view = createAccountBrowserView(account, { bridgePreload: true });
    accountViews.set(accountKey, view);
  }

  activeView = view;
  activeAccountKey = accountKey;
  activeDiagnosticView = false;
  mainWindow.setBrowserView(view);
  activeViewVisible = true;
  resizeActiveBrowser(mainWindow);

  if (reused) {
    if (view.__douyinDesktopBridgePreload) {
      injectBridge(view);
    }
    return { ok: true, reused: true };
  }

  attachBrowserHandlers(mainWindow, view, account, options);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      destroyCurrentAccountView(mainWindow, accountKey, view);
      finish({ ok: false, error: '内置浏览器打开超时，请检查网络或代理后重试' });
    }, 20000);

    view.webContents.once('did-finish-load', () => {
      const currentUrl = view.webContents.getURL();
      if (!currentUrl.startsWith('chrome-error://')) {
        finish({ ok: true });
      }
    });

    view.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (shouldBlockExternalProtocol(validatedURL)) {
        finish({ ok: true });
        return;
      }
      destroyCurrentAccountView(mainWindow, accountKey, view);
      finish({
        ok: false,
        error: `内置浏览器打开失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      });
    });

    view.webContents.loadURL(DOUYIN_HOME_URL).catch((error) => {
      destroyCurrentAccountView(mainWindow, accountKey, view);
      finish({ ok: false, error: `内置浏览器打开失败：${error.message}` });
    });
    markLoginPageOpened(accountKey);
  });
}

async function openCleanLoginBrowser(mainWindow, account) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '主窗口不可用' };
  }

  const accountKey = accountKeyFor(account);
  if (!accountKey) {
    return { ok: false, error: '账号信息缺少 Profile Key' };
  }
  const cleanAccountKey = `clean-login:${accountKey}`;
  const cooldown = getLoginCooldown(cleanAccountKey);
  if (cooldown.blocked) {
    return {
      ok: false,
      error: `纯净登录诊断冷却中，还剩 ${cooldown.remainingSeconds} 秒。不要连续打开登录页，否则会继续触发验证码限流。`,
    };
  }

  if (activeView) {
    detachActiveView(mainWindow);
    stopActivePoller();
  }

  const view = createAccountBrowserView(account, {
    bridgePreload: false,
    partition: `douyin-clean-login-${accountKey}-${Date.now()}`,
  });

  activeView = view;
  activeAccountKey = cleanAccountKey;
  activeDiagnosticView = true;
  mainWindow.setBrowserView(view);
  activeViewVisible = true;
  resizeActiveBrowser(mainWindow);
  attachBrowserHandlers(mainWindow, view, account, { diagnostic: true });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      destroyCurrentAccountView(mainWindow, activeAccountKey, view);
      finish({ ok: false, error: '纯净登录诊断浏览器打开超时，请检查网络后重试' });
    }, 20000);

    view.webContents.once('did-finish-load', () => {
      const currentUrl = view.webContents.getURL();
      if (!currentUrl.startsWith('chrome-error://')) {
        finish({ ok: true, diagnostic: true });
      }
    });

    view.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (shouldBlockExternalProtocol(validatedURL)) {
        finish({ ok: true, diagnostic: true });
        return;
      }
      destroyCurrentAccountView(mainWindow, activeAccountKey, view);
      finish({
        ok: false,
        error: `纯净登录诊断浏览器打开失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      });
    });

    view.webContents.loadURL(DOUYIN_LOGIN_URL).catch((error) => {
      destroyCurrentAccountView(mainWindow, activeAccountKey, view);
      finish({ ok: false, error: `纯净登录诊断浏览器打开失败：${error.message}` });
    });
    markLoginPageOpened(cleanAccountKey);
  });
}

function attachBrowserHandlers(mainWindow, view, account, options = {}) {
  if (process.env.DOUYIN_DEBUG) {
    view.webContents.session.webRequest.onCompleted({ urls: ['*://*.douyin.com/*'] }, (details) => {
      console.log('[browser-tabs] douyin request:', details.method, details.statusCode, details.url);
    });
  }

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldBlockExternalProtocol(url)) {
      notifyBrowserNotice(mainWindow, '已拦截抖音 App 跳转，请继续使用内置浏览器登录或操作。', { url });
      return { action: 'deny' };
    }
    if (isHttpUrl(url)) {
      view.webContents.loadURL(url).catch((error) => {
        console.warn('[browser-tabs] popup navigation failed:', error.message);
      });
    }
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, url) => {
    blockExternalNavigation(event, url, mainWindow);
  });

  view.webContents.on('will-frame-navigate', (event, url) => {
    blockExternalNavigation(event, url, mainWindow);
  });

  view.webContents.on('will-redirect', (event, url) => {
    blockExternalNavigation(event, url, mainWindow);
  });

  const reinjectTaskBridge = () => {
    if (view !== activeView || activeDiagnosticView || !view.__douyinDesktopBridgePreload) return;
    if (view.webContents.isDestroyed()) return;
    const url = String(view.webContents.getURL() || '');
    if (!url.includes('douyin.com') || url.startsWith('chrome-error://')) return;
    setTimeout(() => {
      if (view === activeView && !view.webContents.isDestroyed()) {
        injectBridge(view);
      }
    }, 500);
  };

  view.webContents.on('did-finish-load', reinjectTaskBridge);
  view.webContents.on('did-navigate-in-page', reinjectTaskBridge);
  view.webContents.on('dom-ready', reinjectTaskBridge);

}

function destroyCurrentAccountView(mainWindow, accountKey, view) {
  if (accountViews.get(accountKey) === view) accountViews.delete(accountKey);
  stopLoginDetector(accountKey);
  if (activeView === view) {
    stopActivePoller();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(view);
    activeView = null;
    activeAccountKey = null;
    activeViewVisible = false;
  }
  if (!view.webContents.isDestroyed()) view.webContents.destroy();
}

function hideAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return { ok: true };
  detachActiveView(mainWindow);
  return { ok: true, hidden: true };
}

function closeAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return { ok: true, closed: true };
  destroyActiveView(mainWindow);
  return { ok: true, closed: true };
}

function showAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '没有已打开的账号浏览器，请先在账号页打开浏览器' };
  }
  mainWindow.setBrowserView(activeView);
  activeViewVisible = true;
  resizeActiveBrowser(mainWindow);
  return { ok: true };
}

module.exports = {
  buildLoginProbeScript,
  closeAccountBrowser,
  ensureBridgeInjected,
  fetchWithActiveBrowserSession: fetchWithActiveBrowserSessionWithFallback,
  forceStartBridge,
  getBridgeDiagnostic,
  getLoginCooldown,
  getLoginCookieResult,
  chromeCompatUserAgent,
  hideAccountBrowser,
  isLoggedInCookie,
  isLoggedInProbeResult,
  openAccountBrowser,
  openCleanLoginBrowser,
  resetAccountBrowserData,
  resizeActiveBrowser,
  runBridgeSelfTest,
  showAccountBrowser,
};
