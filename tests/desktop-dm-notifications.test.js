const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createDmNotifier } = require('../desktop/electron/dm-notifications');

function createNotificationHarness(options = {}) {
  const notifications = [];
  const events = [];

  class FakeNotification {
    static isSupported() {
      return options.supported !== false;
    }

    constructor(notificationOptions) {
      if (options.constructorError) throw options.constructorError;
      this.options = notificationOptions;
      this.listeners = new Map();
      this.shown = false;
      notifications.push(this);
    }

    on(eventName, handler) {
      this.listeners.set(eventName, handler);
      return this;
    }

    show() {
      if (options.showError) throw options.showError;
      this.shown = true;
    }

    emit(eventName) {
      this.listeners.get(eventName)?.();
    }
  }

  const showWindow = vi.fn(() => events.push('show'));
  const sendNavigation = vi.fn((payload) => events.push(`navigate:${payload.accountId}:${payload.conversationId}`));
  const notifier = createDmNotifier({
    NotificationClass: options.NotificationClass === undefined ? FakeNotification : options.NotificationClass,
    showWindow,
    sendNavigation,
    now: options.now || (() => new Date('2026-07-13T12:00:00+08:00')),
  });

  return {
    notifier,
    notifications,
    showWindow,
    sendNavigation,
    events,
  };
}

function incomingMessage(overrides = {}) {
  return {
    id: 'message-1',
    accountId: 'account-1',
    conversationId: 'conversation-1',
    peerName: '张先生',
    content: '请问这个服务怎么收费？',
    direction: 'inbound',
    messageType: 'text',
    ...overrides,
  };
}

function enabledSettings(overrides = {}) {
  return {
    notifications_enabled: true,
    notification_preview: true,
    quiet_hours_start: '',
    quiet_hours_end: '',
    ...overrides,
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createJsonResponse(data, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    json: vi.fn(async () => data),
  };
}

async function createMainProcessHarness(options = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'desktop', 'electron', 'main.js'), 'utf8');
  const ipcHandlers = new Map();
  const appEvents = new Map();
  const windowEvents = new Map();
  const webContentsEvents = new Map();
  const notifier = { notify: options.notify || vi.fn() };
  let notifierDependencies;
  let monitorDependencies;
  let workerDependencies;
  let readyPromise;
  let minimized = options.minimized === true;
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(() => { minimized = false; }),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn((eventName, handler) => windowEvents.set(eventName, handler)),
    webContents: {
      send: vi.fn(),
      on: vi.fn((eventName, handler) => webContentsEvents.set(eventName, handler)),
    },
  };
  class FakeBrowserWindow {
    constructor() {
      return window;
    }

    static getAllWindows() {
      return [window];
    }
  }
  const monitor = {
    start: vi.fn(options.monitorStart || (async () => ({ running: true }))),
    stop: vi.fn(options.monitorStop || (async () => ({ running: false }))),
    refresh: vi.fn(async () => ({ running: true })),
    enableAccount: vi.fn(async () => ({})),
    disableAccount: vi.fn(options.disableAccount || (async () => ({}))),
    getStatus: vi.fn(() => ({ running: true })),
  };
  const worker = {
    getStatus: vi.fn(() => ({ running: false, active: false })),
    start: vi.fn(options.workerStart || (async () => ({ ok: true }))),
    stop: vi.fn(options.workerStop || (async () => ({ ok: true }))),
  };
  const dmClient = {
    poll: vi.fn(async () => ({ messages: [], connection: { status: 'connected' } })),
    disconnect: vi.fn(async () => ({ status: 'disconnected' })),
    stopAll: vi.fn(async () => undefined),
  };
  const fetchMock = options.fetch || vi.fn(async () => createJsonResponse(enabledSettings()));
  const warning = vi.fn();
  const app = {
    isPackaged: false,
    setName: vi.fn(),
    getPath: vi.fn(() => { throw new Error('test path unavailable'); }),
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: vi.fn(() => 'C:\\test-app'),
    on: vi.fn((eventName, handler) => appEvents.set(eventName, handler)),
    quit: vi.fn(options.quit),
    whenReady: vi.fn(() => ({
      then: (handler) => {
        readyPromise = Promise.resolve().then(handler);
        return readyPromise;
      },
    })),
  };
  const browserTabs = {
    resizeActiveBrowser: vi.fn(),
    ensureBackgroundAccountView: vi.fn(),
    executeInAccountView: vi.fn(),
    closeAccountView: vi.fn(options.closeAccountView || (async () => ({ ok: true }))),
    clearAccountPartition: vi.fn(options.clearAccountPartition || (async () => ({ ok: true }))),
    shutdown: vi.fn(options.shutdownBrowserTabs || (async () => ({ ok: true }))),
  };
  const localBackend = {
    ensureStarted: vi.fn(options.ensureBackendStarted || (async () => options.backendStartup || { ok: false, mode: 'test' })),
    isHealthy: vi.fn(async () => true),
    stop: vi.fn(options.stopBackend || (async () => ({ ok: true }))),
  };
  const processStub = {
    env: {},
    platform: 'win32',
    arch: 'x64',
    resourcesPath: 'C:\\test-resources',
    on: vi.fn(),
  };
  const context = {
    __dirname: path.resolve(__dirname, '..', 'desktop', 'electron'),
    console: { warn: warning, log: vi.fn(), error: vi.fn() },
    fetch: fetchMock,
    process: processStub,
    URL,
    URLSearchParams,
    Promise,
    Date: options.DateClass || Date,
    AbortController,
    setTimeout: options.contextSetTimeout || setTimeout,
    clearTimeout: options.contextClearTimeout || clearTimeout,
    require: (moduleName) => {
      if (moduleName === 'electron') {
        return {
          app,
          BrowserWindow: FakeBrowserWindow,
          ipcMain: { handle: vi.fn((channel, handler) => ipcHandlers.set(channel, handler)) },
          Notification: class FakeElectronNotification {},
        };
      }
      if (moduleName === './browser-tabs') return browserTabs;
      if (moduleName === './docker') return {};
      if (moduleName === './dm-client') {
        return { createDmClientManager: vi.fn(() => dmClient) };
      }
      if (moduleName === './dm-protocol') {
        return { decodeDmPushFrame: vi.fn(() => []) };
      }
      if (moduleName === './dm-monitor') {
        return {
          createDmMonitor: vi.fn((dependencies) => {
            monitorDependencies = dependencies;
            return monitor;
          }),
        };
      }
      if (moduleName === './dm-notifications') {
        return {
          createDmNotifier: vi.fn((dependencies) => {
            notifierDependencies = dependencies;
            return notifier;
          }),
        };
      }
      if (moduleName === './dm-worker') {
        return {
          createDmWorker: vi.fn((dependencies) => {
            workerDependencies = dependencies;
            return worker;
          }),
        };
      }
      if (moduleName === './edge-host') return {};
      if (moduleName === './local-backend') return localBackend;
      return require(moduleName);
    },
  };

  vm.runInNewContext(source, context, { filename: 'desktop/electron/main.js' });
  await readyPromise;

  return {
    app,
    appEvents,
    browserTabs,
    dmClient,
    fetchMock,
    ipcHandlers,
    localBackend,
    monitor,
    monitorDependencies,
    notifier,
    notifierDependencies,
    worker,
    workerDependencies,
    warning,
    window,
    webContentsEvents,
    windowEvents,
  };
}

describe('desktop DM notifications', () => {
  it('creates one notification for a new inbound text message', () => {
    const harness = createNotificationHarness();

    expect(harness.notifier.notify(incomingMessage(), enabledSettings())).toBe(true);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0].shown).toBe(true);
    expect(harness.notifications[0].options.title).toContain('张先生');
    expect(harness.notifications[0].options.body).toContain('怎么收费');
  });

  it('does not notify when notifications are disabled or the message is not a usable inbound text', () => {
    const harness = createNotificationHarness();

    expect(harness.notifier.notify(incomingMessage(), enabledSettings({ notifications_enabled: false }))).toBe(false);
    expect(harness.notifier.notify(incomingMessage({ id: 'outbound', direction: 'outbound' }), enabledSettings())).toBe(false);
    expect(harness.notifier.notify(incomingMessage({ id: 'image', messageType: 'image' }), enabledSettings())).toBe(false);
    expect(harness.notifier.notify(incomingMessage({ id: 'blank', content: '   ' }), enabledSettings())).toBe(false);
    expect(harness.notifications).toHaveLength(0);
  });

  it('deduplicates valid message ids without content-hashing id-less messages', () => {
    const harness = createNotificationHarness();
    const message = incomingMessage();

    expect(harness.notifier.notify(message, enabledSettings())).toBe(true);
    expect(harness.notifier.notify(message, enabledSettings())).toBe(false);
    expect(harness.notifier.notify(incomingMessage({ id: '' }), enabledSettings())).toBe(true);
    expect(harness.notifier.notify(incomingMessage({ id: '   ' }), enabledSettings())).toBe(true);
    expect(harness.notifications).toHaveLength(3);
  });

  it('suppresses notifications during ordinary quiet hours without changing the message', () => {
    const message = incomingMessage();
    const harness = createNotificationHarness({
      now: () => new Date(2026, 6, 13, 10, 30),
    });

    expect(harness.notifier.notify(message, enabledSettings({
      quiet_hours_start: '09:00',
      quiet_hours_end: '11:00',
    }))).toBe(false);
    expect(message).toEqual(incomingMessage());
    expect(harness.notifications).toHaveLength(0);
  });

  it('suppresses notifications during quiet hours that cross midnight', () => {
    const lateHarness = createNotificationHarness({
      now: () => new Date(2026, 6, 13, 23, 30),
    });
    const earlyHarness = createNotificationHarness({
      now: () => new Date(2026, 6, 14, 6, 30),
    });
    const daytimeHarness = createNotificationHarness({
      now: () => new Date(2026, 6, 14, 8, 0),
    });
    const settings = enabledSettings({ quiet_hours_start: '22:00', quiet_hours_end: '07:00' });

    expect(lateHarness.notifier.notify(incomingMessage(), settings)).toBe(false);
    expect(earlyHarness.notifier.notify(incomingMessage(), settings)).toBe(false);
    expect(daytimeHarness.notifier.notify(incomingMessage(), settings)).toBe(true);
  });

  it('uses a fixed private body and title when notification preview is disabled', () => {
    const harness = createNotificationHarness();

    harness.notifier.notify(incomingMessage(), enabledSettings({ notification_preview: false }));

    expect(harness.notifications[0].options).toMatchObject({
      title: 'Vulcan抖音控制台',
      body: '收到一条新私信',
    });
    expect(JSON.stringify(harness.notifications[0].options)).not.toContain('张先生');
    expect(JSON.stringify(harness.notifications[0].options)).not.toContain('怎么收费');
  });

  it('safely truncates preview text and strips control characters', () => {
    const harness = createNotificationHarness();
    const content = `第一行\n第二行\u0000${'很长'.repeat(100)}`;

    harness.notifier.notify(incomingMessage({ peerName: `客户\n${'甲'.repeat(100)}`, content }), enabledSettings());

    const { title, body } = harness.notifications[0].options;
    expect(title).not.toMatch(/[\r\n\u0000]/);
    expect(body).not.toMatch(/[\r\n\u0000]/);
    expect(title.length).toBeLessThanOrEqual(48);
    expect(body.length).toBeLessThanOrEqual(120);
  });

  it('restores the window before navigating to the exact account conversation', () => {
    const harness = createNotificationHarness();

    harness.notifier.notify(incomingMessage(), enabledSettings());
    harness.notifications[0].emit('click');

    expect(harness.showWindow).toHaveBeenCalledTimes(1);
    expect(harness.sendNavigation).toHaveBeenCalledWith({
      accountId: 'account-1',
      conversationId: 'conversation-1',
    });
    expect(harness.events).toEqual(['show', 'navigate:account-1:conversation-1']);
  });

  it('rejects invalid navigation payloads before creating a notification', () => {
    const harness = createNotificationHarness();

    expect(harness.notifier.notify(incomingMessage({ accountId: ' ' }), enabledSettings())).toBe(false);
    expect(harness.notifier.notify(incomingMessage({ id: 'message-2', conversationId: null }), enabledSettings())).toBe(false);
    expect(harness.notifications).toHaveLength(0);
    expect(harness.sendNavigation).not.toHaveBeenCalled();
  });

  it('degrades without throwing when Electron notifications are unavailable or fail', () => {
    const missing = createNotificationHarness({ NotificationClass: null });
    const unsupported = createNotificationHarness({ supported: false });
    const constructorFailure = createNotificationHarness({ constructorError: new Error('constructor failed') });
    const showFailure = createNotificationHarness({ showError: new Error('show failed') });

    expect(() => missing.notifier.notify(incomingMessage(), enabledSettings())).not.toThrow();
    expect(() => unsupported.notifier.notify(incomingMessage(), enabledSettings())).not.toThrow();
    expect(() => constructorFailure.notifier.notify(incomingMessage(), enabledSettings())).not.toThrow();
    expect(() => showFailure.notifier.notify(incomingMessage(), enabledSettings())).not.toThrow();
    expect(missing.notifier.notify(incomingMessage(), enabledSettings())).toBe(false);
    expect(unsupported.notifier.notify(incomingMessage(), enabledSettings())).toBe(false);
  });

  it('preload exposes one leak-free dm:navigate subscription with idempotent unsubscribe', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'desktop', 'electron', 'preload.js'), 'utf8');
    const channelListeners = new Map();
    let exposedApi;
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn((channel, listener) => channelListeners.set(channel, listener)),
      removeListener: vi.fn((channel, listener) => {
        if (channelListeners.get(channel) === listener) channelListeners.delete(channel);
      }),
    };
    vm.runInNewContext(source, {
      require: (moduleName) => {
        if (moduleName !== 'electron') throw new Error(`Unexpected module: ${moduleName}`);
        return {
          contextBridge: { exposeInMainWorld: (_name, api) => { exposedApi = api; } },
          ipcRenderer,
        };
      },
    });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = exposedApi.onDmNavigate(first);
    const unsubscribeFirstAgain = exposedApi.onDmNavigate(first);
    const unsubscribeSecond = exposedApi.onDmNavigate(second);

    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    channelListeners.get('dm:navigate')({}, { accountId: 'a1', conversationId: 'c1' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeFirst();
    expect(ipcRenderer.removeListener).not.toHaveBeenCalled();
    unsubscribeFirstAgain();
    unsubscribeSecond();
    unsubscribeSecond();
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    expect(channelListeners.has('dm:navigate')).toBe(false);

    exposedApi.getDmSettings();
    exposedApi.updateDmSettings({ notifications_enabled: false });
    exposedApi.sendDmReply('account-1', 'conversation-1', { text: 'manual reply', mode: 'manual' });
    exposedApi.getDmWorkerStatus();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('settings:dm:get');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('settings:dm:update', {
      notifications_enabled: false,
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'dm:reply',
      'account-1',
      'conversation-1',
      { text: 'manual reply', mode: 'manual' },
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('dm-worker:status');
    expect(exposedApi.claimDmWork).toBeUndefined();
    expect(exposedApi.acquireWriteLease).toBeUndefined();
  });

  it('passes Task 6 inserted messages to the notifier with runtime DM settings', async () => {
    const settings = enabledSettings({ notification_preview: false });
    const fetchMock = vi.fn(async () => createJsonResponse(settings));
    const harness = await createMainProcessHarness({ fetch: fetchMock });
    const message = incomingMessage();

    harness.monitorDependencies.onIngested([message]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19522/api/settings/dm',
      expect.any(Object),
    );
    expect(harness.notifier.notify).toHaveBeenCalledWith(message, settings);
  });

  it('returns from onIngested without waiting for a hanging settings request', async () => {
    const hangingRequest = createDeferred();
    const scheduledTimers = [];
    let requestSignal;
    const harness = await createMainProcessHarness({
      fetch: vi.fn((_url, requestOptions) => {
        requestSignal = requestOptions.signal;
        return hangingRequest.promise;
      }),
      contextSetTimeout: (callback, delayMs) => {
        const timer = { callback, delayMs, unref: vi.fn() };
        scheduledTimers.push(timer);
        return timer;
      },
      contextClearTimeout: vi.fn(),
    });

    const outcome = await Promise.race([
      Promise.resolve(harness.monitorDependencies.onIngested([incomingMessage()])).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);

    expect(outcome).toBe('returned');
    expect(harness.notifier.notify).not.toHaveBeenCalled();
    expect(scheduledTimers).toHaveLength(1);
    expect(scheduledTimers[0].delayMs).toBeLessThanOrEqual(1000);
    expect(scheduledTimers[0].unref).toHaveBeenCalledTimes(1);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal.aborted).toBe(false);
    scheduledTimers[0].callback();
    expect(requestSignal.aborted).toBe(true);
  });

  it('contains asynchronous settings and notifier failures without unhandled rejection', async () => {
    const settingsFailure = await createMainProcessHarness({
      fetch: vi.fn(async () => { throw new Error('settings failed'); }),
    });
    settingsFailure.monitorDependencies.onIngested([incomingMessage()]);
    await vi.waitFor(() => expect(settingsFailure.warning).toHaveBeenCalled());

    const notifierFailure = await createMainProcessHarness({
      notify: vi.fn(() => { throw new Error('notifier failed'); }),
    });
    notifierFailure.monitorDependencies.onIngested([incomingMessage()]);
    await vi.waitFor(() => expect(notifierFailure.warning).toHaveBeenCalled());

    expect(settingsFailure.notifier.notify).not.toHaveBeenCalled();
    expect(notifierFailure.notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('injects working window restoration and exact navigation dependencies into the notifier', async () => {
    const harness = await createMainProcessHarness({ minimized: true });
    harness.webContentsEvents.get('did-finish-load')?.();

    expect(harness.notifierDependencies.showWindow()).toBe(true);
    expect(harness.window.restore).toHaveBeenCalledTimes(1);
    expect(harness.window.show).toHaveBeenCalledTimes(1);
    expect(harness.window.focus).toHaveBeenCalledTimes(1);

    expect(harness.notifierDependencies.sendNavigation({ accountId: ' a1 ', conversationId: ' c1 ' })).toBe(true);
    expect(harness.window.webContents.send).toHaveBeenCalledWith('dm:navigate', {
      accountId: 'a1',
      conversationId: 'c1',
    });
  });

  it('starts and stops the Task 8 worker and injects exact account BrowserView execution', async () => {
    const harness = await createMainProcessHarness({
      backendStartup: { ok: true, mode: 'test' },
    });
    const account = { id: 'account-exact', name: 'Exact account' };

    expect(harness.worker.start).toHaveBeenCalledTimes(1);
    expect(harness.workerDependencies.getMainWindow()).toBe(harness.window);
    await harness.workerDependencies.ensureBackgroundAccountView(harness.window, account);
    await harness.workerDependencies.executeInAccountView(account.id, 'window.__bridge.sendDM()', {
      userGesture: false,
    });
    expect(harness.browserTabs.ensureBackgroundAccountView)
      .toHaveBeenCalledWith(harness.window, account);
    expect(harness.browserTabs.executeInAccountView)
      .toHaveBeenCalledWith(account.id, 'window.__bridge.sendDM()', { userGesture: false });

    const event = { preventDefault: vi.fn() };
    harness.appEvents.get('before-quit')(event);
    await vi.waitFor(() => expect(harness.worker.stop).toHaveBeenCalledTimes(1));
  });

  it('waits for backend recovery, then starts one worker before restoring monitors', async () => {
    const order = [];
    const harness = await createMainProcessHarness({
      ensureBackendStarted: async () => {
        order.push('backend-ready-after-recovery');
        return { ok: true, mode: 'test' };
      },
      workerStart: async () => {
        order.push('worker');
        return { ok: true };
      },
      monitorStart: async () => {
        order.push('monitor');
        return { ok: true };
      },
    });

    expect(order).toEqual(['backend-ready-after-recovery', 'worker', 'monitor']);
    expect(harness.worker.start).toHaveBeenCalledTimes(1);
    expect(harness.monitor.start).toHaveBeenCalledTimes(1);
  });

  it('queues exact DM navigation until the renderer finishes loading', async () => {
    const harness = await createMainProcessHarness();

    expect(harness.notifierDependencies.sendNavigation({
      accountId: 'account-ready',
      conversationId: 'conversation-ready',
    })).toBe(true);
    expect(harness.window.webContents.send).not.toHaveBeenCalled();

    harness.webContentsEvents.get('did-finish-load')();
    expect(harness.window.webContents.send).toHaveBeenCalledWith('dm:navigate', {
      accountId: 'account-ready',
      conversationId: 'conversation-ready',
    });
  });

  it('prevents the first quit and awaits ordered cleanup without recursive shutdown', async () => {
    const order = [];
    const monitorStop = createDeferred();
    const harness = await createMainProcessHarness({
      monitorStop: async () => {
        order.push('monitor');
        return monitorStop.promise;
      },
      workerStop: async () => { order.push('worker'); },
      shutdownBrowserTabs: async () => { order.push('browser'); },
      stopBackend: async () => { order.push('backend'); },
      quit: () => { order.push('quit'); },
    });
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    harness.appEvents.get('before-quit')(firstEvent);
    harness.appEvents.get('before-quit')(repeatedEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeatedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['monitor']);
    expect(harness.app.quit).not.toHaveBeenCalled();

    monitorStop.resolve({ ok: true });
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['monitor', 'worker', 'browser', 'backend', 'quit']);
    expect(harness.monitor.stop).toHaveBeenCalledTimes(1);
    expect(harness.worker.stop).toHaveBeenCalledTimes(1);
    expect(harness.browserTabs.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.localBackend.stop).toHaveBeenCalledTimes(1);

    const recursiveEvent = { preventDefault: vi.fn() };
    harness.appEvents.get('before-quit')(recursiveEvent);
    expect(recursiveEvent.preventDefault).not.toHaveBeenCalled();
    expect(harness.app.quit).toHaveBeenCalledTimes(1);
  });

  it('awaits account monitor, queue, view, partition, and record deletion in order', async () => {
    const order = [];
    const account = { id: 'account-delete', name: 'Delete me', profileKey: 'profile-delete' };
    const fetchMock = vi.fn(async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/accounts') return createJsonResponse([account]);
      if (pathname === `/api/accounts/${account.id}/cancel-dm-work`) {
        order.push('queue');
        return createJsonResponse({ ok: true, cancelled: 2 });
      }
      if (pathname === `/api/accounts/${account.id}` && options.method === 'DELETE') {
        order.push('record');
        return createJsonResponse({ ok: true });
      }
      return createJsonResponse({});
    });
    const harness = await createMainProcessHarness({
      fetch: fetchMock,
      disableAccount: async () => { order.push('monitor'); },
      workerStop: async () => { order.push('worker'); },
      closeAccountView: async () => { order.push('view'); },
      clearAccountPartition: async () => { order.push('partition'); },
      workerStart: async () => { order.push('worker-restarted'); },
    });

    await expect(harness.ipcHandlers.get('accounts:delete')(null, account.id)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['monitor', 'worker', 'queue', 'view', 'partition', 'record', 'worker-restarted']);
  });

  it('reports the failed account deletion stage and preserves the account record', async () => {
    const account = { id: 'account-preserved', name: 'Preserve me', profileKey: 'profile-preserved' };
    const fetchMock = vi.fn(async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/accounts') return createJsonResponse([account]);
      if (pathname === `/api/accounts/${account.id}/cancel-dm-work`) {
        return createJsonResponse({ ok: true, cancelled: 1 });
      }
      if (pathname === `/api/accounts/${account.id}` && options.method === 'DELETE') {
        return createJsonResponse({ ok: true });
      }
      return createJsonResponse({});
    });
    const harness = await createMainProcessHarness({
      fetch: fetchMock,
      clearAccountPartition: async () => { throw new Error('storage is locked'); },
    });

    await expect(harness.ipcHandlers.get('accounts:delete')(null, account.id))
      .rejects.toThrow('Account deletion failed during partition cleanup: storage is locked');
    expect(fetchMock).not.toHaveBeenCalledWith(
      `http://127.0.0.1:19522/api/accounts/${account.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(harness.worker.start).toHaveBeenCalledTimes(1);
  });

  it('refreshes the bounded settings cache immediately after a settings update', async () => {
    const updatedSettings = enabledSettings({ notifications_enabled: false });
    const fetchMock = vi.fn(async () => createJsonResponse(updatedSettings));
    const harness = await createMainProcessHarness({ fetch: fetchMock });
    const updateHandler = harness.ipcHandlers.get('settings:dm:update');

    expect(updateHandler).toBeTypeOf('function');
    await updateHandler({}, updatedSettings);
    harness.monitorDependencies.onIngested([incomingMessage()]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(1));

    expect(harness.notifier.notify).toHaveBeenCalledWith(expect.any(Object), updatedSettings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow IPC settings read overwrite a newer settings update', async () => {
    const deferredRead = createDeferred();
    const oldSettings = enabledSettings({ notification_preview: true });
    const newSettings = enabledSettings({ notification_preview: false });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => deferredRead.promise)
      .mockResolvedValueOnce(createJsonResponse(newSettings));
    const harness = await createMainProcessHarness({ fetch: fetchMock });
    const getHandler = harness.ipcHandlers.get('settings:dm:get');
    const updateHandler = harness.ipcHandlers.get('settings:dm:update');

    const oldReadPromise = getHandler();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(updateHandler({}, newSettings)).resolves.toEqual(newSettings);

    deferredRead.resolve(createJsonResponse(oldSettings));
    await expect(oldReadPromise).resolves.toEqual(oldSettings);

    harness.monitorDependencies.onIngested([incomingMessage({ id: 'after-update' })]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(1));

    expect(harness.notifier.notify).toHaveBeenCalledWith(expect.any(Object), newSettings);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer update when an older notification single-flight request finishes later', async () => {
    const deferredNotificationRead = createDeferred();
    const oldSettings = enabledSettings({ notification_preview: true });
    const newSettings = enabledSettings({ notification_preview: false });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => deferredNotificationRead.promise)
      .mockResolvedValueOnce(createJsonResponse(newSettings));
    const harness = await createMainProcessHarness({ fetch: fetchMock });
    const updateHandler = harness.ipcHandlers.get('settings:dm:update');

    harness.monitorDependencies.onIngested([incomingMessage({ id: 'during-read' })]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(updateHandler({}, newSettings)).resolves.toEqual(newSettings);

    deferredNotificationRead.resolve(createJsonResponse(oldSettings));
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(1));
    expect(harness.notifier.notify).toHaveBeenLastCalledWith(expect.any(Object), newSettings);

    harness.monitorDependencies.onIngested([incomingMessage({ id: 'after-single-flight' })]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(2));
    expect(harness.notifier.notify).toHaveBeenLastCalledWith(expect.any(Object), newSettings);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires the single DM settings cache entry instead of retaining stale settings forever', async () => {
    let nowMs = 1_000;
    class FakeDate extends Date {
      static now() {
        return nowMs;
      }
    }
    const firstSettings = enabledSettings({ notification_preview: true });
    const refreshedSettings = enabledSettings({ notification_preview: false });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse(firstSettings))
      .mockResolvedValueOnce(createJsonResponse(refreshedSettings));
    const harness = await createMainProcessHarness({ fetch: fetchMock, DateClass: FakeDate });

    harness.monitorDependencies.onIngested([incomingMessage({ id: 'm1' })]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(1));

    nowMs += 29_000;
    harness.monitorDependencies.onIngested([incomingMessage({ id: 'm2' })]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs += 2_000;
    harness.monitorDependencies.onIngested([incomingMessage({ id: 'm3' })]);
    await vi.waitFor(() => expect(harness.notifier.notify).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.notifier.notify).toHaveBeenLastCalledWith(expect.any(Object), refreshedSettings);
  });
});
