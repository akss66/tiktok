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
  getDockedBrowserZoomFactor,
  isHttpUrl,
  normalizeBrowserDockMode,
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
const {
  createRecoveryScheduler,
  executeWithTimeout,
  nextBridgeRetryDelay,
} = require('./bridge-recovery');

let activeView = null;
let activeAccountKey = null;
let activeViewVisible = false;
let activePollController = null;
let activeDiagnosticView = false;
let browserDockMode = 'balanced';
let activeBrowserWidth = 0;
let activeBrowserZoomFactor = 1;
let activeBridgeDiagnostic = {
  status: 'idle',
  message: '',
  url: '',
  updatedAt: null,
};
const accountViews = new Map();
const loginDetectors = new Map();
const loginPageOpenedAt = new Map();
const bridgeRecoverySchedulers = new Map();
const bridgeInjectionPromises = new Map();
const backgroundBootstrapPromises = new Map();
let browserLifecycleLogger = null;
let lastBrowserLifecycleEvent = null;

function setLifecycleLogger(logger) {
  browserLifecycleLogger = typeof logger === 'function' ? logger : null;
}

function recordBrowserLifecycle(action, details = {}) {
  const event = {
    action,
    accountKey: details.accountKey || activeAccountKey || null,
    reason: details.reason || '',
    url: details.url || getViewUrl(details.view || activeView),
    active: Boolean((details.view || activeView) && (details.view || activeView) === activeView),
    visible: activeViewVisible,
    createdAt: new Date().toISOString(),
  };
  lastBrowserLifecycleEvent = event;
  if (browserLifecycleLogger) {
    browserLifecycleLogger(`browser lifecycle: ${JSON.stringify(event)}`);
  }
  return event;
}

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
  view.__douyinDesktopBridgeInjected = false;
  view.__douyinDesktopBridgeLastError = '';
  view.webContents.setUserAgent(chromeCompatUserAgent(), 'zh-CN,zh;q=0.9');
  return view;
}

function isViewDestroyed(view) {
  return !view || !view.webContents || view.webContents.isDestroyed();
}

function getViewUrl(view) {
  if (isViewDestroyed(view)) return '';
  return String(view.webContents.getURL() || '');
}

function markViewBridgeState(view, injected, error = '') {
  if (!view) return;
  view.__douyinDesktopBridgeInjected = injected === true;
  view.__douyinDesktopBridgeLastError = error || '';
}

function isAllowedDouyinUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const hostname = String(parsed.hostname || '').toLowerCase();
    return hostname === 'douyin.com' || hostname.endsWith('.douyin.com');
  } catch (_error) {
    return false;
  }
}

function destroyActiveView(mainWindow, reason = 'explicit-close') {
  stopActivePoller();
  if (!activeView) return;
  const view = activeView;
  const accountKey = activeAccountKey;
  recordBrowserLifecycle('destroy', { accountKey, view, reason });
  cancelBridgeRecovery(view);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(view);
  }
  if (accountKey) accountViews.delete(accountKey);
  activeView = null;
  activeAccountKey = null;
  activeViewVisible = false;
  activeDiagnosticView = false;
  activeBrowserWidth = 0;
  activeBrowserZoomFactor = 1;
  if (!view.webContents.isDestroyed()) view.webContents.destroy();
}

function detachActiveView(mainWindow, reason = 'internal-detach') {
  if (!activeView || !activeViewVisible) return;
  recordBrowserLifecycle('hide', { view: activeView, reason });
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

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function executeBridgeEval(view, msg) {
  try {
    const value = await withTimeout(
      view.webContents.executeJavaScript(
        safePageEval(msg.expression, msg.awaitPromise),
        true,
      ),
      50000,
      '页面任务执行超时：抖音接口长时间没有返回，已释放任务队列，请刷新页面后重试。',
    );
    return value;
  } catch (error) {
    const expression = String(msg?.expression || '');
    const preview = expression.length > 180 ? `${expression.slice(0, 180)}...` : expression;
    throw new Error(`页面任务执行失败：${error.message || String(error)}；表达式：${preview}`);
  }
}

async function startMainPoller(view, reconnectAttempt = 0) {
  if (
    activePollController
    && !activePollController.stopped
    && activePollController.view === view
  ) {
    return activePollController;
  }
  stopActivePoller();
  const config = resolveBridgeConfig();
  const controller = { stopped: false, abortController: null, view, reconnectAttempt };
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
    const retryDelay = nextBridgeRetryDelay(reconnectAttempt);
    await sleep(retryDelay);
    if (!controller.stopped && activePollController === controller) {
      activePollController = null;
      startMainPoller(view, reconnectAttempt + 1);
    }
  }
  return controller;
}

function buildInjectionScript() {
  const bridgeConfig = resolveBridgeConfig();
  const resourceScriptPath = path.join(process.resourcesPath || '', 'backend', 'scripts', 'douyin.user.js');
  const unpackedScriptPath = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'backend', 'scripts', 'douyin.user.js');
  const packagedScriptPath = path.join(process.resourcesPath || '', 'app.asar', 'backend', 'scripts', 'douyin.user.js');
  const devScriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'douyin.user.js');
  const scriptPath = fs.existsSync(resourceScriptPath)
    ? resourceScriptPath
    : fs.existsSync(unpackedScriptPath)
    ? unpackedScriptPath
    : fs.existsSync(packagedScriptPath)
      ? packagedScriptPath
      : devScriptPath;
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

async function runBridgeInjectionScript(view) {
  const injectionResult = await view.webContents.executeJavaScript(buildInjectionScript(), true);
  if (!injectionResult?.ok) {
    throw new Error(injectionResult?.error || '页面注入脚本执行失败');
  }
  const ready = await view.webContents.executeJavaScript(
    'Boolean(window.__bridge && typeof window.__bridge.search === "function")',
    true,
  );
  if (!ready) {
    throw new Error('页面 Bridge API 未准备好，请刷新 douyin.com 页面后重试');
  }
  markViewBridgeState(view, true);
  return { ok: true };
}

function waitForViewLoad(view, url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      view.webContents.removeListener('did-finish-load', onLoadFinished);
      view.webContents.removeListener('did-fail-load', onLoadFailed);
    };
    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(payload);
    };
    const onLoadFinished = () => {
      finish(resolve, { ok: true, url: getViewUrl(view) });
    };
    const onLoadFailed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      finish(reject, new Error(
        `账号浏览器加载失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      ));
    };
    timer = setTimeout(() => {
      finish(reject, new Error('账号浏览器加载超时，请检查网络后重试'));
    }, timeoutMs);

    view.webContents.on('did-finish-load', onLoadFinished);
    view.webContents.on('did-fail-load', onLoadFailed);

    view.webContents.loadURL(url).catch((error) => {
      finish(reject, error);
    });
  });
}

function resizeActiveBrowser(mainWindow) {
  if (!activeView || !activeViewVisible || !mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const browserWidth = getDockedBrowserWidth(width, browserDockMode);
  const zoomFactor = getDockedBrowserZoomFactor(browserWidth);
  activeView.setBounds({
    x: Math.max(0, width - browserWidth),
    y: 0,
    width: browserWidth,
    height,
  });
  activeView.webContents.setZoomFactor(zoomFactor);
  activeBrowserWidth = browserWidth;
  activeBrowserZoomFactor = zoomFactor;
  mainWindow.webContents.send('browser:layout', {
    mode: browserDockMode,
    browserWidth,
    appWidth: Math.max(0, width - browserWidth),
    zoomFactor,
  });
}

function setBrowserDockMode(mainWindow, mode) {
  browserDockMode = normalizeBrowserDockMode(mode);
  resizeActiveBrowser(mainWindow);
  return {
    ok: true,
    mode: browserDockMode,
    browserWidth: activeBrowserWidth,
    zoomFactor: activeBrowserZoomFactor,
  };
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

async function performBridgeInjection(view) {
  if (view.webContents.getURL().startsWith('chrome-error://')) {
    markViewBridgeState(view, false, '当前页面加载失败，无法注入任务 Bridge');
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
    await runBridgeInjectionScript(view);
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
    markViewBridgeState(view, false, error.message || String(error));
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

function injectBridge(view) {
  const existing = bridgeInjectionPromises.get(view);
  if (existing) return existing;
  const pending = performBridgeInjection(view).finally(() => {
    if (bridgeInjectionPromises.get(view) === pending) {
      bridgeInjectionPromises.delete(view);
    }
  });
  bridgeInjectionPromises.set(view, pending);
  return pending;
}

function scheduleBridgeRecovery(view, delayMs = 500) {
  if (!view || view.webContents.isDestroyed()) return;
  let scheduler = bridgeRecoverySchedulers.get(view);
  if (!scheduler) {
    scheduler = createRecoveryScheduler(async () => {
      if (view !== activeView || activeDiagnosticView || view.webContents.isDestroyed()) return;
      const url = String(view.webContents.getURL() || '');
      if (!url.includes('douyin.com') || url.startsWith('chrome-error://')) return;
      const result = await injectBridge(view);
      if (!result?.ok && view === activeView && !view.webContents.isDestroyed()) {
        scheduler.schedule(3000);
      }
    });
    bridgeRecoverySchedulers.set(view, scheduler);
  }
  scheduler.schedule(delayMs);
}

function cancelBridgeRecovery(view) {
  const scheduler = bridgeRecoverySchedulers.get(view);
  if (scheduler) scheduler.cancel();
  bridgeRecoverySchedulers.delete(view);
  bridgeInjectionPromises.delete(view);
}

async function ensureBackgroundAccountView(mainWindow, account, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '主窗口不可用' };
  }
  const accountKey = accountKeyFor(account);
  if (!accountKey) {
    return { ok: false, error: '账号信息缺少 Profile Key' };
  }

  let view = accountViews.get(accountKey);
  if (view && isViewDestroyed(view)) {
    accountViews.delete(accountKey);
    view = null;
  }

  const pendingBootstrap = backgroundBootstrapPromises.get(accountKey);
  if (pendingBootstrap) {
    return pendingBootstrap;
  }

  const reused = Boolean(view);
  if (!reused) {
    const bootstrapPromise = (async () => {
      const createView = typeof options.createView === 'function'
        ? options.createView
        : (nextAccount) => createAccountBrowserView(nextAccount, { bridgePreload: true });
      const nextView = createView(account, {
        partition: partitionForAccount(account),
        bridgePreload: true,
      });
      nextView.__douyinDesktopBridgePreload = true;
      markViewBridgeState(nextView, false);
      accountViews.set(accountKey, nextView);
      attachBrowserHandlers(mainWindow, nextView, account, options);
      try {
        await waitForViewLoad(nextView, DOUYIN_HOME_URL);
        if (options.requireBridge !== false) {
          await runBridgeInjectionScript(nextView);
        }
      } catch (error) {
        const message = error.message || String(error);
        markViewBridgeState(nextView, false, message);
        if (activeView !== nextView) {
          destroyCurrentAccountView(mainWindow, accountKey, nextView, 'background-bootstrap-failed');
        } else {
          recordBrowserLifecycle('load-error-retained', {
            accountKey,
            view: nextView,
            reason: 'background-bootstrap-became-visible',
          });
        }
        return { ok: false, accountId: accountKey, error: message };
      }
      return {
        ok: true,
        accountId: accountKey,
        reused: false,
        state: getAccountViewState(accountKey),
      };
    })();
    backgroundBootstrapPromises.set(accountKey, bootstrapPromise);
    try {
      return await bootstrapPromise;
    } finally {
      if (backgroundBootstrapPromises.get(accountKey) === bootstrapPromise) {
        backgroundBootstrapPromises.delete(accountKey);
      }
    }
  }

  return {
    ok: true,
    accountId: accountKey,
    reused,
    state: getAccountViewState(accountKey),
  };
}

async function executeInAccountView(accountId, expression, options = {}) {
  const accountKey = String(accountId || '').trim();
  if (!accountKey) {
    throw new Error('缺少账号 ID，无法定位账号浏览器');
  }
  const view = accountViews.get(accountKey);
  if (!view) {
    throw new Error(`未找到账号 ${accountKey} 的浏览器，请先打开该账号浏览器或启动私信监控`);
  }
  if (isViewDestroyed(view)) {
    throw new Error(`账号浏览器已经销毁，请先重新打开账号 ${accountKey} 的浏览器`);
  }

  const url = getViewUrl(view);
  if (url.startsWith('chrome-error://')) {
    throw new Error(`账号浏览器当前页面加载失败，请先重新打开账号 ${accountKey} 的浏览器后再试`);
  }
  if (!isAllowedDouyinUrl(url)) {
    if (!url) {
      throw new Error(`账号浏览器当前页面缺少 URL，请先打开账号 ${accountKey} 的 douyin.com 页面后再试`);
    }
    try {
      new URL(url);
    } catch (_error) {
      throw new Error(`账号浏览器当前页面 URL 无效，请先打开账号 ${accountKey} 的 douyin.com 页面后再试`);
    }
    throw new Error(`账号浏览器未停留在抖音页面，请先让账号 ${accountKey} 打开 douyin.com 后再试`);
  }

  const executionTimeoutMs = Math.max(1_000, Number(options.timeoutMs) || 20_000);
  const probeBridgeReady = () => executeWithTimeout(
    () => view.webContents.executeJavaScript(
      'Boolean(window.__bridge && typeof window.__bridge === "object")',
      options.userGesture === true,
    ),
    Math.min(5_000, executionTimeoutMs),
    { timeoutMessage: `账号 ${accountKey} 的页面 Bridge 状态检查超时` },
  ).catch(() => false);

  let bridgeReady = await probeBridgeReady();
  if (!bridgeReady) {
    const recovery = await executeWithTimeout(
      () => injectBridge(view),
      Math.min(10_000, executionTimeoutMs),
      { timeoutMessage: `账号 ${accountKey} 的页面 Bridge 恢复超时` },
    ).catch((error) => ({ ok: false, error: error.message || String(error) }));
    bridgeReady = Boolean(recovery?.ok) && await probeBridgeReady();
  }
  markViewBridgeState(view, bridgeReady, bridgeReady ? '' : '页面 Bridge 未就绪');
  if (!bridgeReady) {
    throw new Error(`账号浏览器中的页面 Bridge 未就绪，请先刷新账号 ${accountKey} 的 douyin.com 页面后再重试`);
  }

  return executeWithTimeout(
    () => view.webContents.executeJavaScript(expression, options.userGesture === true),
    executionTimeoutMs,
    {
      timeoutMessage: `账号 ${accountKey} 的页面执行超过 ${Math.ceil(executionTimeoutMs / 1000)} 秒，页面可能已刷新，系统将自动重新连接`,
    },
  );
}

async function readAccountDeviceId(accountId, options = {}) {
  const accountKey = String(accountId || '').trim();
  if (!accountKey) throw new Error('Missing account ID for device ID lookup');
  const view = accountViews.get(accountKey);
  if (!view || isViewDestroyed(view)) {
    throw new Error(`Account ${accountKey} browser is unavailable`);
  }
  const url = getViewUrl(view);
  if (!isAllowedDouyinUrl(url) || url.startsWith('chrome-error://')) {
    throw new Error(`Account ${accountKey} browser is not on a valid douyin.com page`);
  }
  const expression = `(async () => {
    const response = await fetch(
      '/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web',
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      throw new Error('query/user returned HTTP ' + response.status);
    }
    const payload = await response.json();
    const remoteId = String(payload?.id || payload?.data?.id || '').trim();
    if (!remoteId) throw new Error('query/user did not return a device id');
    return remoteId;
  })()`;
  return executeWithTimeout(
    () => view.webContents.executeJavaScript(expression, false),
    Math.max(1_000, Number(options.timeoutMs) || 5_000),
    { timeoutMessage: `Account ${accountKey} device ID lookup timed out` },
  );
}

async function readAccountUserId(accountId, options = {}) {
  const accountKey = String(accountId || '').trim();
  if (!accountKey) throw new Error('Missing account ID for user ID lookup');
  const view = accountViews.get(accountKey);
  if (!view || isViewDestroyed(view)) {
    throw new Error(`Account ${accountKey} browser is unavailable`);
  }
  const url = getViewUrl(view);
  if (!isAllowedDouyinUrl(url) || url.startsWith('chrome-error://')) {
    throw new Error(`Account ${accountKey} browser is not on a valid douyin.com page`);
  }
  const expression = `(async () => {
    const response = await fetch(
      '/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web',
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) throw new Error('query/user returned HTTP ' + response.status);
    const payload = await response.json();
    const user = payload?.user || payload?.data?.user || {};
    const userId = String(user?.uid || user?.short_id || '').trim();
    if (!userId) throw new Error('query/user did not return a user id');
    return userId;
  })()`;
  return executeWithTimeout(
    () => view.webContents.executeJavaScript(expression, false),
    Math.max(1_000, Number(options.timeoutMs) || 5_000),
    { timeoutMessage: `Account ${accountKey} user ID lookup timed out` },
  );
}

function getAccountViewState(accountId) {
  const accountKey = String(accountId || '').trim();
  const view = accountViews.get(accountKey);
  if (!view) {
    return {
      accountId: accountKey,
      exists: false,
      destroyed: true,
      url: '',
      visible: false,
      active: false,
      bridgeInjected: false,
      bridgePreload: false,
      lastError: '',
    };
  }
  const destroyed = isViewDestroyed(view);
  return {
    accountId: accountKey,
    exists: true,
    destroyed,
    url: destroyed ? '' : getViewUrl(view),
    visible: view === activeView && activeViewVisible,
    active: view === activeView,
    bridgeInjected: Boolean(view.__douyinDesktopBridgeInjected),
    bridgePreload: Boolean(view.__douyinDesktopBridgePreload),
    lastError: String(view.__douyinDesktopBridgeLastError || ''),
  };
}

function closeAccountView(mainWindow, accountId) {
  const accountKey = String(accountId || '').trim();
  const view = accountViews.get(accountKey);
  if (!view) return { ok: true, accountId: accountKey, closed: false };
  destroyCurrentAccountView(mainWindow, accountKey, view, 'explicit-account-close');
  return { ok: true, accountId: accountKey, closed: true };
}

function releaseBackgroundAccountView(mainWindow, accountId) {
  const accountKey = String(accountId || '').trim();
  const view = accountViews.get(accountKey);
  if (!view) return { ok: true, accountId: accountKey, closed: false, retained: false };
  if (view === activeView) {
    recordBrowserLifecycle('background-release-retained', {
      accountKey,
      view,
      reason: 'user-owned-active-view',
    });
    return { ok: true, accountId: accountKey, closed: false, retained: true };
  }
  destroyCurrentAccountView(mainWindow, accountKey, view, 'background-monitor-release');
  return { ok: true, accountId: accountKey, closed: true, retained: false };
}

function getBridgeDiagnostic() {
  return {
    ...activeBridgeDiagnostic,
    hasActiveView: Boolean(activeView && !activeView.webContents.isDestroyed()),
    activeAccountKey,
    activeViewVisible,
    activeDiagnosticView,
    browserDockMode,
    browserDockWidth: activeBrowserWidth,
    browserZoomFactor: activeBrowserZoomFactor,
    bridgePreload: Boolean(activeView?.__douyinDesktopBridgePreload),
    activeUrl: activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.getURL() : '',
    lastLifecycleEvent: lastBrowserLifecycleEvent,
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
      const waiters = Number(lastStatus?.pollWaiters?.[config.site] || 0);
      if (
        waiters > 0
        && Array.isArray(conns)
        && conns.some((conn) => isFreshBridgeConnection(conn) && isRealBridgeBrowser(conn))
      ) {
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
  detachActiveView(mainWindow, 'bridge-preload-upgrade');
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

  if (!existing.webContents.isDestroyed()) {
    recordBrowserLifecycle('destroy', {
      accountKey,
      view: existing,
      reason: 'bridge-preload-upgrade-replacement',
    });
    existing.webContents.destroy();
  }

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

async function clearAccountPartition(account) {
  const accountKey = accountKeyFor(account);
  if (!accountKey) return { ok: false, error: '账号信息缺少 Profile Key' };
  const ses = session.fromPartition(partitionForAccount(account));
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
  });
  await ses.clearCache();
  return { ok: true };
}

function getAccountSession(account) {
  return session.fromPartition(partitionForAccount(account));
}

async function resetAccountBrowserData(mainWindow, account) {
  const accountKey = accountKeyFor(account);
  if (!accountKey) return { ok: false, error: '账号信息缺少 Profile Key' };

  const view = accountViews.get(accountKey);
  if (view) destroyCurrentAccountView(mainWindow, accountKey, view, 'account-data-reset');
  await clearAccountPartition(account);
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
    detachActiveView(mainWindow, 'account-switch');
    stopActivePoller();
  }

  let view = accountViews.get(accountKey);
  if (view && !view.webContents.isDestroyed() && !view.__douyinDesktopBridgePreload) {
    if (activeView === view) {
      detachActiveView(mainWindow, 'replace-non-bridge-view');
      stopActivePoller();
      activeView = null;
      activeAccountKey = null;
      activeViewVisible = false;
    }
    recordBrowserLifecycle('destroy', { accountKey, view, reason: 'upgrade-to-bridge-preload' });
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
      scheduleBridgeRecovery(view, 100);
    }
    return { ok: true, reused: true };
  }

  attachBrowserHandlers(mainWindow, view, account, options);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanupInitialLoadListeners = () => {
      view.webContents.removeListener('did-finish-load', onInitialLoadFinished);
      view.webContents.removeListener('did-fail-load', onInitialLoadFailed);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupInitialLoadListeners();
      resolve(result);
    };

    const onInitialLoadFinished = () => {
      const currentUrl = view.webContents.getURL();
      if (!currentUrl.startsWith('chrome-error://')) {
        finish({ ok: true });
      }
    };

    const onInitialLoadFailed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (shouldBlockExternalProtocol(validatedURL)) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        error: `内置浏览器打开失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      });
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'initial-load-failed',
      });
    };

    view.webContents.on('did-finish-load', onInitialLoadFinished);
    view.webContents.on('did-fail-load', onInitialLoadFailed);
    timer = setTimeout(() => {
      finish({ ok: false, error: '内置浏览器打开超时，请检查网络或代理后重试' });
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'initial-load-timeout',
      });
    }, 20000);

    view.webContents.loadURL(DOUYIN_HOME_URL).catch((error) => {
      finish({ ok: false, error: `内置浏览器打开失败：${error.message}` });
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'initial-load-rejected',
      });
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
    detachActiveView(mainWindow, 'open-clean-login');
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
    let timer = null;
    const cleanupInitialLoadListeners = () => {
      view.webContents.removeListener('did-finish-load', onInitialLoadFinished);
      view.webContents.removeListener('did-fail-load', onInitialLoadFailed);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupInitialLoadListeners();
      resolve(result);
    };

    const onInitialLoadFinished = () => {
      const currentUrl = view.webContents.getURL();
      if (!currentUrl.startsWith('chrome-error://')) {
        finish({ ok: true, diagnostic: true });
      }
    };

    const onInitialLoadFailed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (shouldBlockExternalProtocol(validatedURL)) {
        finish({ ok: true, diagnostic: true });
        return;
      }
      finish({
        ok: false,
        error: `纯净登录诊断浏览器打开失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim(),
      });
      recordBrowserLifecycle('load-error-retained', {
        accountKey: cleanAccountKey,
        view,
        reason: 'clean-login-load-failed',
      });
    };

    timer = setTimeout(() => {
      finish({ ok: false, error: '纯净登录诊断浏览器打开超时，请检查网络后重试' });
      recordBrowserLifecycle('load-error-retained', {
        accountKey: cleanAccountKey,
        view,
        reason: 'clean-login-load-timeout',
      });
    }, 20000);

    view.webContents.on('did-finish-load', onInitialLoadFinished);
    view.webContents.on('did-fail-load', onInitialLoadFailed);

    view.webContents.loadURL(DOUYIN_LOGIN_URL).catch((error) => {
      finish({ ok: false, error: `纯净登录诊断浏览器打开失败：${error.message}` });
      recordBrowserLifecycle('load-error-retained', {
        accountKey: cleanAccountKey,
        view,
        reason: 'clean-login-load-rejected',
      });
    });
    markLoginPageOpened(cleanAccountKey);
  });
}

function attachBrowserHandlers(mainWindow, view, account, options = {}) {
  const accountKey = options.diagnostic
    ? `clean-login:${accountKeyFor(account)}`
    : accountKeyFor(account);
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
    scheduleBridgeRecovery(view, 500);
  };

  view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || view !== activeView) return;
    stopActivePoller();
    activeBridgeDiagnostic = {
      status: 'reconnecting',
      message: '页面跳转中，等待自动恢复任务连接',
      url: view.webContents.getURL(),
      updatedAt: new Date().toISOString(),
    };
  });
  view.webContents.on('did-finish-load', reinjectTaskBridge);
  view.webContents.on('did-navigate-in-page', reinjectTaskBridge);
  view.webContents.on('dom-ready', reinjectTaskBridge);

  view.webContents.on('render-process-gone', (_event, details) => {
    recordBrowserLifecycle('render-process-gone', {
      accountKey,
      view,
      reason: `${details?.reason || 'unknown'}:${details?.exitCode ?? ''}`,
    });
  });

  view.webContents.once('destroyed', () => {
    recordBrowserLifecycle('web-contents-destroyed', {
      accountKey,
      view,
      reason: 'electron-destroyed-event',
    });
    if (accountViews.get(accountKey) === view) accountViews.delete(accountKey);
    if (activeView === view) {
      activeView = null;
      activeAccountKey = null;
      activeViewVisible = false;
      activeBrowserWidth = 0;
      activeBrowserZoomFactor = 1;
    }
  });

}

function destroyCurrentAccountView(mainWindow, accountKey, view, reason = 'unspecified') {
  recordBrowserLifecycle('destroy', { accountKey, view, reason });
  if (accountViews.get(accountKey) === view) accountViews.delete(accountKey);
  stopLoginDetector(accountKey);
  cancelBridgeRecovery(view);
  if (activeView === view) {
    stopActivePoller();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(view);
    activeView = null;
    activeAccountKey = null;
    activeViewVisible = false;
    activeBrowserWidth = 0;
    activeBrowserZoomFactor = 1;
  }
  if (!view.webContents.isDestroyed()) view.webContents.destroy();
}

function hideAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return { ok: true };
  detachActiveView(mainWindow, 'user-hide');
  return { ok: true, hidden: true };
}

function closeAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return { ok: true, closed: true };
  destroyActiveView(mainWindow, 'user-close-browser');
  return { ok: true, closed: true };
}

async function shutdown(mainWindow) {
  const pendingBootstraps = [...backgroundBootstrapPromises.values()];
  if (pendingBootstraps.length > 0) await Promise.allSettled(pendingBootstraps);

  for (const [accountKey, view] of [...accountViews.entries()]) {
    destroyCurrentAccountView(mainWindow, accountKey, view, 'application-shutdown');
  }
  if (activeView) destroyActiveView(mainWindow, 'application-shutdown-active-view');
  for (const accountKey of [...loginDetectors.keys()]) stopLoginDetector(accountKey);
  for (const scheduler of bridgeRecoverySchedulers.values()) scheduler.cancel();
  bridgeRecoverySchedulers.clear();
  bridgeInjectionPromises.clear();
  backgroundBootstrapPromises.clear();
  loginPageOpenedAt.clear();
  return { ok: true };
}

function showAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '没有已打开的账号浏览器，请先在账号页打开浏览器' };
  }
  mainWindow.setBrowserView(activeView);
  activeViewVisible = true;
  recordBrowserLifecycle('show', { accountKey: activeAccountKey, view: activeView, reason: 'user-show' });
  resizeActiveBrowser(mainWindow);
  scheduleBridgeRecovery(activeView, 100);
  return { ok: true };
}

async function reloadAccountBrowser(timeoutMs = 30000) {
  if (!activeView || activeView.webContents.isDestroyed()) {
    return { ok: false, error: '没有可刷新的账号浏览器，请先在账号页打开浏览器' };
  }
  const view = activeView;
  const accountKey = activeAccountKey;
  const url = view.webContents.getURL();
  recordBrowserLifecycle('reload-start', { accountKey, view, reason: 'user-reload' });

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      view.webContents.removeListener('did-finish-load', onLoadFinished);
      view.webContents.removeListener('did-fail-load', onLoadFailed);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };
    const onLoadFinished = () => {
      recordBrowserLifecycle('reload-finished', { accountKey, view, reason: 'reload-succeeded' });
      finish({ ok: true, url: getViewUrl(view) || url });
    };
    const onLoadFailed = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      const error = `浏览器刷新失败：${errorDescription || '页面加载失败'} (${errorCode}) ${validatedURL || ''}`.trim();
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'reload-failed',
      });
      finish({ ok: false, error, url: getViewUrl(view) || url, retained: true });
    };

    view.webContents.on('did-finish-load', onLoadFinished);
    view.webContents.on('did-fail-load', onLoadFailed);
    timer = setTimeout(() => {
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'reload-timeout',
      });
      finish({ ok: false, error: '浏览器刷新超时，已保留当前浏览器，请检查网络后重试', url, retained: true });
    }, timeoutMs);

    try {
      view.webContents.reload();
    } catch (error) {
      recordBrowserLifecycle('load-error-retained', {
        accountKey,
        view,
        reason: 'reload-threw',
      });
      finish({ ok: false, error: `浏览器刷新失败：${error.message || String(error)}`, url, retained: true });
    }
  });
}

module.exports = {
  buildLoginProbeScript,
  clearAccountPartition,
  closeAccountBrowser,
  closeAccountView,
  ensureBridgeInjected,
  ensureBackgroundAccountView,
  executeInAccountView,
  fetchWithActiveBrowserSession: fetchWithActiveBrowserSessionWithFallback,
  forceStartBridge,
  getAccountViewState,
  getAccountSession,
  getBridgeDiagnostic,
  getLoginCooldown,
  getLoginCookieResult,
  chromeCompatUserAgent,
  hideAccountBrowser,
  isLoggedInCookie,
  isLoggedInProbeResult,
  openAccountBrowser,
  openCleanLoginBrowser,
  readAccountDeviceId,
  readAccountUserId,
  releaseBackgroundAccountView,
  reloadAccountBrowser,
  resetAccountBrowserData,
  resizeActiveBrowser,
  runBridgeSelfTest,
  showAccountBrowser,
  shutdown,
  setBrowserDockMode,
  setLifecycleLogger,
};
