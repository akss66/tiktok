const { hasPollClient } = require('../lib/desktop/task-runner');

describe('task runner bridge status guard', () => {
  const now = Date.parse('2026-07-08T00:00:30.000Z');

  it('accepts a fresh douyin browser poll client', () => {
    const status = {
      ok: true,
      connections: {
        'douyin.com': [{
          url: 'https://www.douyin.com/',
          title: 'Douyin',
          userAgent: 'Mozilla/5.0 Chrome',
          lastActivity: '2026-07-08T00:00:20.000Z',
          alive: true,
        }],
      },
      pollWaiters: {
        'douyin.com': 1,
      },
    };

    expect(hasPollClient(status, { now })).toBe(true);
  });

  it('rejects desktop poll mock by default', () => {
    const status = {
      ok: true,
      totalConnections: 1,
      connections: {
        'douyin.com': [{
          url: 'http://127.0.0.1:19422/',
          title: 'Desktop Poll Mock',
          userAgent: 'poll-mock-client',
          lastActivity: '2026-07-08T00:00:20.000Z',
          alive: true,
        }],
      },
      pollWaiters: {
        'douyin.com': 1,
      },
    };

    expect(hasPollClient(status, { now })).toBe(false);
    expect(hasPollClient(status, { now, allowMock: true })).toBe(true);
  });

  it('rejects stale douyin browser connections', () => {
    const status = {
      ok: true,
      connections: {
        'douyin.com': [{
          url: 'https://www.douyin.com/',
          title: 'Douyin',
          userAgent: 'Mozilla/5.0 Chrome',
          lastActivity: '2026-07-07T23:59:00.000Z',
          alive: true,
        }],
      },
    };

    expect(hasPollClient(status, { now, maxIdleMs: 45000 })).toBe(false);
  });

  it('rejects fresh connection records without an active poll waiter', () => {
    const status = {
      ok: true,
      connections: {
        'douyin.com': [{
          url: 'https://www.douyin.com/',
          title: 'Douyin',
          userAgent: 'Mozilla/5.0 Chrome',
          lastActivity: '2026-07-08T00:00:20.000Z',
          alive: true,
        }],
      },
      pollWaiters: {},
    };

    expect(hasPollClient(status, { now })).toBe(false);
  });
});
