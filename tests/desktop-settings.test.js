const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const settings = require('../lib/desktop/settings');
const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const dmInbox = require('../lib/desktop/dm-inbox');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => data),
  };
}

async function createLoginDebounceHarness() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'desktop/electron/main.js'), 'utf8');
  const ipcHandlers = new Map();
  const appEvents = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let readyPromise;
  let loginCallback;
  let failMonitorStateRequests = false;
  const monitor = {
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    refresh: vi.fn(async () => ({ ok: true })),
    enableAccount: vi.fn(async () => ({ ok: true })),
    disableAccount: vi.fn(async () => ({ ok: true })),
    getStatus: vi.fn(() => ({ running: true })),
  };
  const account = { id: 'account-1', name: '测试账号', status: 'enabled', notes: '' };
  const monitorState = {
    accountId: account.id,
    enabled: false,
    settingSource: 'inherited',
    replyModeOverride: null,
    status: 'idle',
  };
  const dmSettings = { monitor_after_login: true, reply_mode: 'tiered' };
  const fetchMock = vi.fn(async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/accounts') return jsonResponse([account]);
    if (pathname === `/api/accounts/${account.id}`) {
      const patchBody = JSON.parse(options.body || '{}');
      Object.assign(account, patchBody);
      return jsonResponse({ ...account });
    }
    if (pathname === '/api/dm/monitor-states') return jsonResponse([{ ...monitorState }]);
    if (pathname === `/api/dm/monitor-states/${account.id}`) {
      if (failMonitorStateRequests && options.method !== 'PATCH') {
        return jsonResponse({ error: 'monitor state unavailable' }, 503);
      }
      if (options.method === 'PATCH') Object.assign(monitorState, JSON.parse(options.body || '{}'));
      return jsonResponse({ ...monitorState });
    }
    if (pathname === '/api/settings/dm') {
      if (options.method === 'PATCH') Object.assign(dmSettings, JSON.parse(options.body || '{}'));
      return jsonResponse({ ...dmSettings });
    }
    return jsonResponse({});
  });
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn(), on: vi.fn() },
  };
  class FakeBrowserWindow {
    constructor() { return window; }
    static getAllWindows() { return [window]; }
  }
  const app = {
    isPackaged: false,
    setName: vi.fn(),
    getPath: vi.fn(() => { throw new Error('test path unavailable'); }),
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: vi.fn(() => 'C:\\test-app'),
    on: vi.fn((event, handler) => appEvents.set(event, handler)),
    quit: vi.fn(),
    whenReady: vi.fn(() => ({
      then(handler) {
        readyPromise = Promise.resolve().then(handler);
        return readyPromise;
      },
    })),
  };
  const browserTabs = {
    resizeActiveBrowser: vi.fn(),
    ensureBackgroundAccountView: vi.fn(),
    executeInAccountView: vi.fn(),
    closeAccountView: vi.fn(),
    clearAccountPartition: vi.fn(async () => ({ ok: true })),
    shutdown: vi.fn(async () => ({ ok: true })),
    getBridgeDiagnostic: vi.fn(() => ({ activeAccountKey: account.id })),
    openAccountBrowser: vi.fn(async (_window, _account, options) => {
      loginCallback = options.onLoginDetected;
      return { ok: true };
    }),
    reloadAccountBrowser: vi.fn(async () => ({ ok: true })),
    resetAccountBrowserData: vi.fn(async () => ({ ok: true })),
  };
  const setTimer = vi.fn((callback, delay) => {
    const id = nextTimerId++;
    const timer = { id, callback, delay, unref: vi.fn() };
    timers.set(id, timer);
    return timer;
  });
  const clearTimer = vi.fn((timer) => timers.delete(timer?.id));
  const context = {
    __dirname: path.resolve(__dirname, '..', 'desktop/electron'),
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    fetch: fetchMock,
    process: {
      env: {}, platform: 'win32', arch: 'x64', resourcesPath: 'C:\\resources', on: vi.fn(),
    },
    URL,
    URLSearchParams,
    Promise,
    Date,
    AbortController,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    require(moduleName) {
      if (moduleName === 'electron') {
        return {
          app,
          BrowserWindow: FakeBrowserWindow,
          ipcMain: { handle: vi.fn((channel, handler) => ipcHandlers.set(channel, handler)) },
          Notification: class FakeNotification {},
        };
      }
      if (moduleName === './browser-tabs') return browserTabs;
      if (moduleName === './docker' || moduleName === './edge-host') return {};
      if (moduleName === './dm-client') {
        return {
          createDmClientManager: vi.fn(() => ({
            poll: vi.fn(async () => ({ messages: [], connection: { status: 'connected' } })),
            disconnect: vi.fn(async () => ({ status: 'disconnected' })),
            stopAll: vi.fn(async () => undefined),
          })),
        };
      }
      if (moduleName === './dm-protocol') return { decodeDmPushFrame: vi.fn(() => []) };
      if (moduleName === './dm-monitor') return { createDmMonitor: vi.fn(() => monitor) };
      if (moduleName === './dm-notifications') return { createDmNotifier: vi.fn(() => ({ notify: vi.fn() })) };
      if (moduleName === './dm-worker') {
        return { createDmWorker: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), getStatus: vi.fn(() => ({})) })) };
      }
      if (moduleName === './local-backend') {
        return { ensureStarted: vi.fn(async () => ({ ok: false })), isHealthy: vi.fn(async () => true), stop: vi.fn(async () => ({ ok: true })) };
      }
      return require(moduleName);
    },
  };

  vm.runInNewContext(source, context, { filename: 'desktop/electron/main.js' });
  await readyPromise;
  await ipcHandlers.get('browser:open-account')(null, account);
  monitor.enableAccount.mockClear();
  return {
    account,
    appEvents,
    browserTabs,
    dmSettings,
    fetchMock,
    ipcHandlers,
    login: (overrides = {}) => loginCallback({ account: { ...account, ...overrides }, nickname: '测试账号' }),
    monitor,
    monitorState,
    setMonitorStateFailure: (value) => { failMonitorStateRequests = Boolean(value); },
    timers,
  };
}

describe('desktop settings', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-desktop-settings-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists conservative reply defaults and sanitizes updates', () => {
    expect(settings.getReplySettings({ storageDir: dir })).toEqual({
      intent_threshold: 'medium',
      require_knowledge: true,
      max_draft_chars: 60,
    });

    const updated = settings.updateReplySettings({
      intent_threshold: 'high',
      require_knowledge: false,
      max_draft_chars: 999,
    }, { storageDir: dir });

    expect(updated).toEqual({
      intent_threshold: 'high',
      require_knowledge: false,
      max_draft_chars: 200,
    });
    expect(settings.getReplySettings({ storageDir: dir })).toEqual(updated);
  });

  it('returns DM defaults, clamps ranges, normalizes quiet hours, and preserves other setting groups', () => {
    settings.updateLlmSettings({
      api_key: 'secret-key',
      model: 'saved-model',
    }, { storageDir: dir });
    settings.updateReplySettings({
      intent_threshold: 'high',
      require_knowledge: false,
      max_draft_chars: 80,
    }, { storageDir: dir });

    expect(settings.getDmSettings({ storageDir: dir })).toEqual({
      reply_mode: 'manual',
      auto_reply_frequency: 'once',
      knowledge_confidence: 0.85,
      auto_delay_min_ms: 15000,
      auto_delay_max_ms: 45000,
      monitor_after_login: false,
      notifications_enabled: true,
      notification_preview: true,
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    const updated = settings.updateDmSettings({
      reply_mode: 'tiered',
      auto_reply_frequency: 'always',
      knowledge_confidence: 0.1,
      auto_delay_min_ms: 15000,
      auto_delay_max_ms: 900000,
      monitor_after_login: true,
      notifications_enabled: false,
      notification_preview: false,
      quiet_hours_start: '8:5',
      quiet_hours_end: ' 23:7 ',
      llm: { api_key: 'should-not-change' },
      reply: { intent_threshold: 'medium' },
      api_key: 'should-not-change',
    }, { storageDir: dir });

    expect(updated).toEqual({
      reply_mode: 'tiered',
      auto_reply_frequency: 'always',
      knowledge_confidence: 0.5,
      auto_delay_min_ms: 15000,
      auto_delay_max_ms: 100000,
      monitor_after_login: true,
      notifications_enabled: false,
      notification_preview: false,
      quiet_hours_start: '08:05',
      quiet_hours_end: '23:07',
    });
    expect(settings.readSettings({ storageDir: dir })).toMatchObject({
      llm: {
        api_key: 'secret-key',
        model: 'saved-model',
      },
      reply: {
        intent_threshold: 'high',
        require_knowledge: false,
        max_draft_chars: 80,
      },
      dm: updated,
    });
  });

  it('accepts zero-second DM delay and caps the range at 100 seconds', () => {
    expect(settings.updateDmSettings({
      auto_delay_min_ms: 0,
      auto_delay_max_ms: 100000,
    }, { storageDir: dir })).toMatchObject({
      auto_delay_min_ms: 0,
      auto_delay_max_ms: 100000,
    });

    expect(settings.updateDmSettings({
      auto_delay_min_ms: -1000,
      auto_delay_max_ms: 180000,
    }, { storageDir: dir })).toMatchObject({
      auto_delay_min_ms: 0,
      auto_delay_max_ms: 100000,
    });
  });

  it('ignores invalid DM enum and quiet-hour values, and blank values disable quiet hours', () => {
    const seeded = settings.updateDmSettings({
      reply_mode: 'automatic',
      knowledge_confidence: 0.9,
      auto_delay_min_ms: 240000,
      auto_delay_max_ms: 300000,
      quiet_hours_start: '09:00',
      quiet_hours_end: '21:00',
    }, { storageDir: dir });

    const invalid = settings.updateDmSettings({
      reply_mode: 'robot',
      knowledge_confidence: Number.NaN,
      auto_delay_min_ms: 480000,
      auto_delay_max_ms: 30000,
      quiet_hours_start: '24:00',
      quiet_hours_end: 'bad',
    }, { storageDir: dir });

    expect(invalid).toEqual({
      ...seeded,
      auto_delay_min_ms: 100000,
      auto_delay_max_ms: 100000,
    });

    const disabled = settings.updateDmSettings({
      quiet_hours_start: '',
      quiet_hours_end: '',
    }, { storageDir: dir });

    expect(disabled).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });
  });

  it('clears both quiet-hour boundaries when either side is explicitly blank', () => {
    settings.updateDmSettings({
      quiet_hours_start: '09:00',
      quiet_hours_end: '21:00',
    }, { storageDir: dir });

    expect(settings.updateDmSettings({
      quiet_hours_start: '',
    }, { storageDir: dir })).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    settings.updateDmSettings({
      quiet_hours_start: '09:00',
      quiet_hours_end: '21:00',
    }, { storageDir: dir });

    expect(settings.updateDmSettings({
      quiet_hours_end: '',
    }, { storageDir: dir })).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });
  });

  it('does not create a half-configured quiet-hour pair from an unconfigured state', () => {
    expect(settings.updateDmSettings({
      quiet_hours_start: '09:00',
    }, { storageDir: dir })).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    expect(settings.updateDmSettings({
      quiet_hours_end: '21:00',
    }, { storageDir: dir })).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });
  });

  it('persists strict account monitor inheritance and explicit overrides', () => {
    const db = openDesktopDb({ storageDir: dir });
    try {
      const account = accounts.createAccount(db, { name: '账号A' });
      expect(dmInbox.getMonitorState(db, account.id)).toMatchObject({
        accountId: account.id,
        enabled: false,
        settingSource: 'inherited',
        replyModeOverride: null,
      });

      expect(dmInbox.updateMonitorState(db, account.id, {
        enabled: true,
        settingSource: 'explicit',
        replyModeOverride: 'automatic',
      })).toMatchObject({
        enabled: true,
        settingSource: 'explicit',
        replyModeOverride: 'automatic',
      });

      expect(dmInbox.updateMonitorState(db, account.id, {
        enabled: null,
        settingSource: 'inherited',
        replyModeOverride: null,
      })).toMatchObject({
        enabled: false,
        settingSource: 'inherited',
        replyModeOverride: null,
      });

      expect(() => dmInbox.updateMonitorState(db, account.id, {
        enabled: 'yes',
        settingSource: 'explicit',
        replyModeOverride: 'automatic',
      })).toThrow(/enabled/);
      expect(() => dmInbox.updateMonitorState(db, account.id, {
        enabled: true,
        settingSource: ' explicit ',
        replyModeOverride: 'automatic',
      })).toThrow(/settingSource/);
    } finally {
      db.close();
    }
  });

  it('debounces enabled login monitoring for 30 seconds and cancels pending work on disable and quit', async () => {
    const harness = await createLoginDebounceHarness();
    harness.monitor.refresh.mockClear();

    await harness.login();
    await harness.login();
    expect(harness.monitor.enableAccount).not.toHaveBeenCalled();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);
    const loginTimer = [...harness.timers.values()].find((timer) => timer.delay === 30_000);
    expect(loginTimer.unref).toHaveBeenCalledTimes(1);

    harness.timers.delete(loginTimer.id);
    await loginTimer.callback();
    expect(harness.monitor.refresh).toHaveBeenCalledTimes(1);

    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);
    await harness.ipcHandlers.get('accounts:update')(null, harness.account.id, { status: 'disabled' });
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);

    Object.assign(harness.account, { status: 'enabled' });
    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);
    await harness.ipcHandlers.get('accounts:delete')(null, harness.account.id);
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);

    Object.assign(harness.account, { status: 'enabled' });
    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);
    harness.appEvents.get('before-quit')({ preventDefault: vi.fn() });
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);
  });

  it('immediately wakes enabled DM monitoring after reopening or reloading an account browser', async () => {
    const harness = await createLoginDebounceHarness();

    await harness.ipcHandlers.get('browser:open-account')(null, harness.account);
    expect(harness.monitor.enableAccount).toHaveBeenCalledTimes(1);
    expect(harness.monitor.enableAccount).toHaveBeenCalledWith(harness.account.id);

    harness.monitor.enableAccount.mockClear();
    await harness.ipcHandlers.get('browser:reload-account')();
    expect(harness.monitor.enableAccount).toHaveBeenCalledTimes(1);
    expect(harness.monitor.enableAccount).toHaveBeenCalledWith(harness.account.id);
  });

  it('honors inherited global monitoring, explicit account overrides, and exact null serialization', async () => {
    const harness = await createLoginDebounceHarness();
    await harness.ipcHandlers.get('settings:dm:update')(null, { monitor_after_login: false });

    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);

    const enabled = await harness.ipcHandlers.get('dm:monitor-state:update')(null, harness.account.id, {
      enabled: true,
      settingSource: 'explicit',
      replyModeOverride: 'automatic',
    });
    expect(enabled).toMatchObject({
      enabled: true,
      settingSource: 'explicit',
      replyModeOverride: 'automatic',
    });
    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);

    await harness.ipcHandlers.get('dm:monitor-state:update')(null, harness.account.id, {
      enabled: null,
      settingSource: 'inherited',
      replyModeOverride: null,
    });
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);
    const lastPatch = [...harness.fetchMock.mock.calls]
      .reverse()
      .find(([url, options]) => new URL(url).pathname.includes('/api/dm/monitor-states/') && options?.method === 'PATCH');
    expect(JSON.parse(lastPatch[1].body)).toEqual({
      enabled: null,
      settingSource: 'inherited',
      replyModeOverride: null,
    });
  });

  it('cancels inherited login debounce when global monitoring is disabled', async () => {
    const harness = await createLoginDebounceHarness();
    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);

    await harness.ipcHandlers.get('settings:dm:update')(null, { monitor_after_login: false });
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);
  });

  it('keeps a saved global setting successful and cancels pending work when policy refresh fails', async () => {
    const harness = await createLoginDebounceHarness();
    await harness.login();
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(1);
    harness.setMonitorStateFailure(true);

    await expect(harness.ipcHandlers.get('settings:dm:update')(null, {
      monitor_after_login: false,
    })).resolves.toMatchObject({ monitor_after_login: false });
    expect([...harness.timers.values()].filter((timer) => timer.delay === 30_000)).toHaveLength(0);
  });
});
