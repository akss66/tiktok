const { DOUYIN_LOGIN_COOKIE_NAMES } = require('./browser-config');

function isLoggedInProbeResult(value) {
  const user = value?.user || value?.data?.user || {};
  return Boolean(user.sec_uid || user.secUid || user.uid || user.user_id || user.nickname);
}

function isDouyinCookie(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '');
  return domain === 'douyin.com' || domain.endsWith('.douyin.com');
}

function isLoggedInCookie(cookie) {
  return Boolean(
    cookie
      && !cookie.expired
      && DOUYIN_LOGIN_COOKIE_NAMES.has(cookie.name)
      && String(cookie.value || '').trim()
      && isDouyinCookie(cookie),
  );
}

function getLoginCookieResult(cookies = []) {
  const loginCookie = cookies.find(isLoggedInCookie);
  if (!loginCookie) return { loggedIn: false };
  const uidCookie = cookies.find((cookie) => isDouyinCookie(cookie) && ['uid_tt', 'uid_tt_ss'].includes(cookie.name));
  return {
    loggedIn: true,
    uid: uidCookie?.value || '',
    source: loginCookie.name,
  };
}

async function readDouyinLoginCookies(view) {
  if (!view || view.webContents.isDestroyed()) return { loggedIn: false };
  const cookies = await view.webContents.session.cookies.get({ url: 'https://www.douyin.com' });
  return getLoginCookieResult(cookies);
}

function buildLoginProbeScript() {
  return `
    (async function () {
      try {
        var response = await fetch('/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web', {
          credentials: 'include',
          cache: 'no-store'
        });
        if (!response.ok) return { loggedIn: false, status: response.status };
        var data = await response.json();
        var user = (data && (data.user || (data.data && data.data.user))) || {};
        return {
          loggedIn: Boolean(user.sec_uid || user.secUid || user.uid || user.user_id || user.nickname),
          nickname: user.nickname || '',
          uid: user.uid || user.user_id || '',
          secUid: user.sec_uid || user.secUid || ''
        };
      } catch (error) {
        return { loggedIn: false, error: error.message || String(error) };
      }
    })();
  `;
}

module.exports = {
  buildLoginProbeScript,
  getLoginCookieResult,
  isDouyinCookie,
  isLoggedInCookie,
  isLoggedInProbeResult,
  readDouyinLoginCookies,
};

