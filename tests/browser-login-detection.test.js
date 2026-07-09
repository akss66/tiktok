const {
  chromeCompatUserAgent,
  getLoginCookieResult,
  isLoggedInCookie,
  isLoggedInProbeResult,
} = require('../desktop/electron/browser-tabs');

describe('browser login detection', () => {
  it('detects a logged-in Douyin user from user info payload', () => {
    expect(isLoggedInProbeResult({
      user: {
        sec_uid: 'MS4wLjABAAAA',
        uid: '123',
        nickname: '测试账号',
      },
    })).toBe(true);
  });

  it('detects a nested logged-in Douyin user payload', () => {
    expect(isLoggedInProbeResult({
      data: {
        user: {
          secUid: 'MS4wLjABBBBB',
        },
      },
    })).toBe(true);
  });

  it('does not treat an empty user payload as logged in', () => {
    expect(isLoggedInProbeResult({ user: {} })).toBe(false);
    expect(isLoggedInProbeResult({ status_code: 0 })).toBe(false);
  });

  it('detects login state from Douyin session cookies without probing the network', () => {
    expect(isLoggedInCookie({
      domain: '.douyin.com',
      name: 'sessionid',
      value: 'session-value',
    })).toBe(true);

    expect(getLoginCookieResult([
      { domain: '.douyin.com', name: 'uid_tt', value: 'uid-value' },
      { domain: '.douyin.com', name: 'sid_guard', value: 'guard-value' },
    ])).toEqual({
      loggedIn: true,
      uid: 'uid-value',
      source: 'uid_tt',
    });
  });

  it('ignores unrelated or empty cookies', () => {
    expect(isLoggedInCookie({
      domain: '.douyin.com',
      name: 'sessionid',
      value: '',
    })).toBe(false);
    expect(isLoggedInCookie({
      domain: '.example.com',
      name: 'sessionid',
      value: 'session-value',
    })).toBe(false);
    expect(getLoginCookieResult([
      { domain: '.douyin.com', name: 'ttwid', value: 'anonymous-value' },
    ])).toEqual({ loggedIn: false });
  });

  it('uses a Chrome-compatible user agent for embedded login pages', () => {
    const ua = chromeCompatUserAgent();
    expect(ua).toContain('Chrome/');
    expect(ua).toContain('Safari/');
    expect(ua).not.toContain('Electron');
  });
});
