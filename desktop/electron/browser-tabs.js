const fs = require('fs');
const path = require('path');
const { BrowserView } = require('electron');
const { partitionForAccount } = require('./profiles');

const SIDEBAR_WIDTH = 220;

let activeView = null;

function buildInjectionScript() {
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'douyin.user.js');
  const userscript = fs.readFileSync(scriptPath, 'utf8');

  return `
    (function () {
      if (window.__douyinDesktopBridgeInjected) return;
      window.__douyinDesktopBridgeInjected = true;
      window.unsafeWindow = window;
      window.GM_xmlhttpRequest = function(details) {
        var controller = new AbortController();
        var timedOut = false;
        var timeout = details.timeout ? setTimeout(function() {
          timedOut = true;
          controller.abort();
        }, details.timeout) : null;

        fetch(details.url, {
          method: details.method || 'GET',
          headers: details.headers || {},
          body: details.data || details.body,
          credentials: 'include',
          signal: controller.signal
        }).then(function(response) {
          return response.text().then(function(text) {
            if (timeout) clearTimeout(timeout);
            if (details.onload) {
              details.onload({
                status: response.status,
                statusText: response.statusText,
                responseText: text,
                finalUrl: response.url,
                responseHeaders: ''
              });
            }
          });
        }).catch(function(error) {
          if (timeout) clearTimeout(timeout);
          if (timedOut && details.ontimeout) {
            details.ontimeout();
            return;
          }
          if (details.onerror) details.onerror(error);
        });
      };
      ${userscript}
    })();
  `;
}

function resizeActiveBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  activeView.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(360, width - SIDEBAR_WIDTH),
    height,
  });
}

function openAccountBrowser(mainWindow, account) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: '主窗口不可用' };
  }

  if (activeView) {
    mainWindow.removeBrowserView(activeView);
    activeView.webContents.destroy();
    activeView = null;
  }

  const view = new BrowserView({
    webPreferences: {
      partition: partitionForAccount(account),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  activeView = view;
  mainWindow.setBrowserView(view);
  resizeActiveBrowser(mainWindow);

  view.webContents.on('did-finish-load', async () => {
    try {
      await view.webContents.executeJavaScript(buildInjectionScript(), true);
    } catch (error) {
      console.error('[browser-tabs] bridge injection failed:', error.message);
    }
  });

  view.webContents.loadURL('https://www.douyin.com/');
  return { ok: true };
}

function closeAccountBrowser(mainWindow) {
  if (!activeView || !mainWindow || mainWindow.isDestroyed()) return { ok: true };
  mainWindow.removeBrowserView(activeView);
  activeView.webContents.destroy();
  activeView = null;
  return { ok: true };
}

module.exports = {
  closeAccountBrowser,
  openAccountBrowser,
  resizeActiveBrowser,
};
