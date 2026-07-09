const fs = require('fs');
const path = require('path');

const DOUYIN_HOME_URL = 'https://www.douyin.com/jingxuan';
const DOUYIN_LOGIN_URL = 'https://www.douyin.com/?login=1';
const SIDEBAR_WIDTH = 220;
const BROWSER_DOCK_MIN_WIDTH = 560;
const BROWSER_DOCK_MAX_WIDTH = 980;
const APP_MIN_VISIBLE_WIDTH = 520;
const LOGIN_COOKIE_CHECK_INTERVAL_MS = 10000;
const LOGIN_PAGE_COOLDOWN_MS = 90000;
const BRIDGE_INJECTION_VERSION = '2026-07-09-bridge-ready-guard';
const BLOCKED_EXTERNAL_PROTOCOLS = new Set([
  'bytedance:',
  'douyin:',
  'douyinlite:',
  'snssdk1128:',
  'snssdk2329:',
  'snssdk143:',
  'aweme:',
]);
const DOUYIN_LOGIN_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
  'passport_auth_status_ss',
]);

function chromeCompatUserAgent() {
  const chromeVersion = process.versions.chrome || '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
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
      site: 'douyin.com',
      token: bridge.token || '',
      server: `http://${host}:${resolvedPort}`,
      managedPoll: true,
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: 19422,
      site: 'douyin.com',
      token: '',
      server: 'http://127.0.0.1:19422',
      managedPoll: true,
    };
  }
}

function getDockedBrowserWidth(windowWidth) {
  const preferred = Math.round(windowWidth * 0.52);
  const maxByAppSpace = Math.max(BROWSER_DOCK_MIN_WIDTH, windowWidth - SIDEBAR_WIDTH - APP_MIN_VISIBLE_WIDTH);
  return Math.min(
    BROWSER_DOCK_MAX_WIDTH,
    maxByAppSpace,
    Math.max(BROWSER_DOCK_MIN_WIDTH, preferred),
  );
}

function shouldBlockExternalProtocol(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return BLOCKED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = {
  APP_MIN_VISIBLE_WIDTH,
  BLOCKED_EXTERNAL_PROTOCOLS,
  BRIDGE_INJECTION_VERSION,
  BROWSER_DOCK_MAX_WIDTH,
  BROWSER_DOCK_MIN_WIDTH,
  DOUYIN_HOME_URL,
  DOUYIN_LOGIN_COOKIE_NAMES,
  DOUYIN_LOGIN_URL,
  LOGIN_COOKIE_CHECK_INTERVAL_MS,
  LOGIN_PAGE_COOLDOWN_MS,
  SIDEBAR_WIDTH,
  chromeCompatUserAgent,
  getDockedBrowserWidth,
  isHttpUrl,
  resolveBridgeConfig,
  shouldBlockExternalProtocol,
};

