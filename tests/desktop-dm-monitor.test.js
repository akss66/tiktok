const fs = require('fs');
const path = require('path');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeScheduler() {
  let nextId = 1;
  const active = new Map();
  const created = [];

  return {
    created,
    setTimer(callback, delayMs) {
      const timer = {
        id: nextId += 1,
        delayMs,
        callback,
        active: true,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
          return this;
        },
      };
      active.set(timer.id, timer);
      created.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (!timer) return;
      timer.active = false;
      active.delete(timer.id);
    },
    activeTimers() {
      return created.filter((timer) => timer.active);
    },
    takeNextTimer() {
      const timer = created.find((candidate) => candidate.active);
      if (!timer) throw new Error('No active timers available');
      timer.active = false;
      active.delete(timer.id);
      return timer;
    },
  };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function loadDmMonitor() {
  const modulePath = path.resolve(__dirname, '..', 'desktop', 'electron', 'dm-monitor.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

function createDependencies(overrides = {}) {
  const scheduler = overrides.scheduler || createFakeScheduler();
  const ensureCalls = [];
  const executeCalls = [];
  const ingestCalls = [];
  const disconnectCalls = [];
  const onIngestedCalls = [];
  const updateMonitorStateCalls = [];
  const backendStates = overrides.backendStates || [];
  const accounts = overrides.accounts || [];
  const executeInAccountView = overrides.executeInAccountView || vi.fn(async (accountId, expression) => {
    executeCalls.push({ accountId, expression });
    return { messages: [], connection: { status: 'connected' } };
  });
  const ingestMessages = overrides.ingestMessages || vi.fn(async (payload) => {
    ingestCalls.push(payload);
    return { inserted: payload.messages.length, duplicates: 0, insertedMessages: payload.messages };
  });
  const ensureBackgroundAccountView = overrides.ensureBackgroundAccountView || vi.fn(async (mainWindow, account) => {
    ensureCalls.push({ mainWindow, accountId: account.id });
    return { ok: true, accountId: account.id, reused: true };
  });
  const disconnectAccountView = overrides.disconnectAccountView || vi.fn(async (accountId) => {
    disconnectCalls.push(accountId);
    return { ok: true, accountId, closed: true };
  });
  const onIngested = overrides.onIngested || vi.fn((insertedMessages) => {
    onIngestedCalls.push(insertedMessages);
  });
  const updateMonitorState = overrides.updateMonitorState || vi.fn(async (accountId, patch) => {
    updateMonitorStateCalls.push({ accountId, patch });
    return { accountId, ...patch };
  });

  return {
    scheduler,
    ensureCalls,
    executeCalls,
    ingestCalls,
    disconnectCalls,
    onIngestedCalls,
    updateMonitorStateCalls,
    dependencies: {
      getMainWindow: () => overrides.mainWindow || { id: 'main-window' },
      isBackendHealthy: overrides.isBackendHealthy || vi.fn(async () => true),
      listAccounts: overrides.listAccounts || vi.fn(async () => accounts),
      listMonitorStates: overrides.listMonitorStates || vi.fn(async () => backendStates),
      updateMonitorState,
      ensureBackgroundAccountView,
      executeInAccountView,
      pollAccount: overrides.pollAccount,
      ingestMessages,
      disconnectAccountView,
      disconnectAccount: overrides.disconnectAccount,
      onIngested,
      setTimer: scheduler.setTimer.bind(scheduler),
      clearTimer: scheduler.clearTimer.bind(scheduler),
      isLoginRequiredError: overrides.isLoginRequiredError,
      logger: overrides.logger || { warn() {}, error() {}, info() {} },
    },
  };
}

function getAccountStatus(monitor, accountId) {
  return monitor.getStatus().accounts.find((item) => item.accountId === accountId);
}

describe('desktop dm monitor', () => {
  it('uses a main-process account transport without invoking the page Bridge adapter', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const pollAccount = vi.fn(async () => ({
      messages: [{ conversation_id: 'conversation-a', index: '1' }],
      selfPlatformId: 'douyin-user-a',
      connection: { status: 'connected' },
    }));
    const disconnectAccount = vi.fn(async () => ({ ok: true }));
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      pollAccount,
      disconnectAccount,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(pollAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'account-a' }),
      12000,
    );
    expect(context.dependencies.ensureBackgroundAccountView).not.toHaveBeenCalled();
    expect(context.dependencies.executeInAccountView).not.toHaveBeenCalled();
    expect(context.ingestCalls).toEqual([{
      accountId: 'account-a',
      selfPlatformId: 'douyin-user-a',
      messages: [{ conversation_id: 'conversation-a', index: '1' }],
    }]);

    await monitor.stop();
    expect(disconnectAccount).toHaveBeenCalledWith('account-a');
  });

  it('persists a newly discovered account uid once even when no messages are queued', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const pollAccount = vi.fn(async () => ({
      messages: [],
      selfPlatformId: 'douyin-user-a',
      connection: { status: 'connected', selfPlatformId: 'douyin-user-a' },
    }));
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      pollAccount,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();
    await context.scheduler.takeNextTimer().callback();

    expect(context.ingestCalls).toEqual([{
      accountId: 'account-a',
      selfPlatformId: 'douyin-user-a',
      messages: [],
    }]);
  });

  it('drains only enabled accounts, refreshes from backend monitor states, and staggers two enabled accounts at 0ms then 5000ms', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const context = createDependencies({
      accounts: [
        { id: 'account-a', status: 'enabled' },
        { id: 'account-b', status: 'enabled' },
        { id: 'account-c', status: 'login_required' },
        { id: 'account-d', status: 'online' },
      ],
      backendStates: [
        { accountId: 'account-a', cursor: 'cursor-a', status: 'running', lastError: 'old-error' },
        { accountId: 'account-b', cursor: 'cursor-b', status: 'idle', lastError: null },
        { accountId: 'account-c', cursor: 'cursor-c', status: 'idle', lastError: null },
      ],
    });
    const monitor = createDmMonitor(context.dependencies);

    const started = await monitor.start();

    expect(started).toMatchObject({ ok: true, started: true });
    expect(context.dependencies.listMonitorStates).toHaveBeenCalledTimes(1);
    expect(context.dependencies.listAccounts).toHaveBeenCalledTimes(1);
    expect(context.scheduler.created.map((timer) => timer.delayMs)).toEqual([0, 5000]);
    expect(context.scheduler.created.every((timer) => timer.unrefCalled)).toBe(true);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: true,
      cursor: 'cursor-a',
    });
    expect(getAccountStatus(monitor, 'account-b')).toMatchObject({
      accountId: 'account-b',
      enabled: true,
      cursor: 'cursor-b',
    });
    expect(getAccountStatus(monitor, 'account-c')).toMatchObject({
      accountId: 'account-c',
      enabled: false,
      status: 'login_required',
    });
    expect(getAccountStatus(monitor, 'account-d')).toMatchObject({
      accountId: 'account-d',
      enabled: false,
      status: 'online',
    });

    const firstRun = context.scheduler.takeNextTimer();
    await firstRun.callback();

    expect(context.ensureCalls.map((call) => call.accountId)).toEqual(['account-a']);
    expect(context.executeCalls).toEqual([
      { accountId: 'account-a', expression: 'window.__bridge.getDMHistoryCapabilities()' },
      { accountId: 'account-a', expression: 'window.__bridge.pollDMs(12000)' },
    ]);
    expect(context.scheduler.created.at(-1).delayMs).toBe(5000);

    const secondRun = context.scheduler.takeNextTimer();
    await secondRun.callback();

    expect(context.ensureCalls.map((call) => call.accountId)).toEqual(['account-a', 'account-b']);
  });

  it('ingests DM messages in serial chunks, notifies only real insertedMessages, and keeps POSTs non-concurrent', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION } = loadDmMonitor();
    const firstChunk = createDeferred();
    const secondChunk = createDeferred();
    const thirdChunk = createDeferred();
    let concurrentPosts = 0;
    let maxConcurrentPosts = 0;
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async (_accountId, expression) => {
        if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
          return { supported: false, reason: '仅实时监听' };
        }
        return {
          messages: Array.from({ length: 401 }, (_, index) => ({
            conversation_id: 'conv-1',
            index: String(index + 1),
            sender: `user-${index + 1}`,
            content: `message-${index + 1}`,
            timestamp: index + 1,
          })),
          connection: { status: 'connected' },
        };
      }),
      ingestMessages: vi.fn(async (payload) => {
        concurrentPosts += 1;
        maxConcurrentPosts = Math.max(maxConcurrentPosts, concurrentPosts);
        context.ingestCalls.push(payload);
        const gate = [firstChunk, secondChunk, thirdChunk][context.ingestCalls.length - 1];
        await gate.promise;
        concurrentPosts -= 1;
        if (context.ingestCalls.length === 1) {
          return {
            inserted: 2,
            duplicates: 198,
            insertedMessages: [
              { id: 'msg-1', accountId: 'account-a', conversationId: 'conv-row-1', peerName: 'Peer 1', content: 'message-1', direction: 'inbound', messageType: 'text' },
              { id: 'msg-2', accountId: 'account-a', conversationId: 'conv-row-1', peerName: 'Peer 1', content: 'message-2', direction: 'inbound', messageType: 'text' },
            ],
          };
        }
        if (context.ingestCalls.length === 2) {
          return { inserted: 1, duplicates: 199, insertedMessages: [] };
        }
        return {
          inserted: 1,
          duplicates: 0,
          insertedMessages: [
            { id: 'msg-401', accountId: 'account-a', conversationId: 'conv-row-1', peerName: 'Peer 1', content: 'message-401', direction: 'inbound', messageType: 'text' },
          ],
        };
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    const timer = context.scheduler.takeNextTimer();
    const runPromise = timer.callback();
    await flushPromises();
    await flushPromises();

    expect(context.ingestCalls).toHaveLength(1);
    expect(context.ingestCalls[0]).toMatchObject({ accountId: 'account-a' });
    expect(context.ingestCalls[0].messages).toHaveLength(200);
    expect(maxConcurrentPosts).toBe(1);

    firstChunk.resolve();
    await flushPromises();
    expect(context.ingestCalls).toHaveLength(2);
    expect(context.ingestCalls[1].messages).toHaveLength(200);
    expect(context.onIngestedCalls).toEqual([[
      expect.objectContaining({ id: 'msg-1', content: 'message-1' }),
      expect.objectContaining({ id: 'msg-2', content: 'message-2' }),
    ]]);

    secondChunk.resolve();
    await flushPromises();
    expect(context.ingestCalls).toHaveLength(3);
    expect(context.ingestCalls[2].messages).toHaveLength(1);
    expect(context.onIngestedCalls).toHaveLength(1);

    thirdChunk.resolve();
    await runPromise;

    expect(context.onIngestedCalls).toHaveLength(2);
    expect(context.onIngestedCalls[1]).toEqual([
      expect.objectContaining({ id: 'msg-401', content: 'message-401' }),
    ]);
    expect(maxConcurrentPosts).toBe(1);
    expect(context.scheduler.created.at(-1).delayMs).toBe(5000);
  });

  it('does not notify when ingest reports inserted count without a non-empty insertedMessages array', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION } = loadDmMonitor();
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async () => ({
        messages: [
          { conversation_id: 'conv-1', index: '1', sender: 'user-1', content: 'hello', timestamp: 1 },
        ],
      })),
      ingestMessages: vi.fn(async (payload) => {
        context.ingestCalls.push(payload);
        return { inserted: 1, duplicates: 0, insertedMessages: [] };
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    const timer = context.scheduler.takeNextTimer();
    await timer.callback();

    expect(context.onIngestedCalls).toEqual([]);
  });

  it('uses capped retry backoff delays and resets backoff after a later success', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION } = loadDmMonitor();
    let failuresRemaining = 6;
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async (_accountId, expression) => {
        if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
          return { supported: false, reason: '仅实时监听' };
        }
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('temporary bridge failure');
        }
        return { messages: [], connection: { status: 'connected' } };
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();

    const retryDelays = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const timer = context.scheduler.takeNextTimer();
      await timer.callback();
      retryDelays.push(context.scheduler.created.at(-1).delayMs);
    }

    expect(retryDelays).toEqual([30000, 60000, 120000, 300000, 600000, 600000]);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      failureCount: 6,
      status: 'backoff',
    });

    const recoveryTimer = context.scheduler.takeNextTimer();
    await recoveryTimer.callback();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      failureCount: 0,
      status: 'idle',
    });
    expect(context.scheduler.created.at(-1).delayMs).toBe(5000);
  });

  it('treats a disconnected websocket poll result as a retryable failure instead of idle', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION } = loadDmMonitor();
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async (_accountId, expression) => {
        if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
          return { supported: false, reason: 'realtime only' };
        }
        return {
          messages: [],
          connection: {
            status: 'disconnected',
            readyState: 3,
            reconnectRecommended: true,
            lastCloseCode: 1006,
            lastCloseReason: 'network',
          },
        };
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      status: 'backoff',
      failureCount: 1,
    });
    expect(getAccountStatus(monitor, 'account-a').lastError).toMatch(/WebSocket.*1006/i);
    expect(context.scheduler.created.at(-1).delayMs).toBe(30000);
  });

  it('keeps a websocket handshake in connecting state without counting a failure', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION, POLL_EXPRESSION } = loadDmMonitor();
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async (_accountId, expression) => {
        if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
          return { supported: false, reason: 'realtime only' };
        }
        if (expression === POLL_EXPRESSION) {
          return {
            messages: [],
            connection: {
              status: 'connecting',
              readyState: 0,
            },
          };
        }
        throw new Error(`unexpected expression: ${expression}`);
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      status: 'connecting',
      failureCount: 0,
      lastError: null,
    });
    expect(context.disconnectCalls).toEqual([]);
    expect(context.scheduler.created.at(-1).delayMs).toBe(10000);
  });

  it('stops retrying on login_required and disables an account immediately by clearing timers plus disconnecting', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const loginRequiredError = Object.assign(new Error('login required'), { code: 'login_required' });
    const context = createDependencies({
      accounts: [
        { id: 'account-a', status: 'enabled' },
        { id: 'account-b', status: 'enabled' },
      ],
      executeInAccountView: vi.fn(async (accountId) => {
        if (accountId === 'account-a') throw loginRequiredError;
        return { messages: [], connection: { status: 'connected' } };
      }),
      isLoginRequiredError: (error) => error && error.code === 'login_required',
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await monitor.disableAccount('account-b');

    expect(context.disconnectCalls).toContain('account-b');
    expect(context.scheduler.activeTimers()).toHaveLength(1);

    const timer = context.scheduler.takeNextTimer();
    await timer.callback();

    expect(context.scheduler.activeTimers()).toHaveLength(0);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      status: 'login_required',
      enabled: false,
      lastError: 'login required',
    });
    expect(context.disconnectCalls).toEqual(['account-b', 'account-a']);
  });

  it('guards against rescheduling after stop while an in-flight drain finishes', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const drainDeferred = createDeferred();
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView: vi.fn(async () => drainDeferred.promise),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    const timer = context.scheduler.takeNextTimer();
    const runPromise = timer.callback();
    await flushPromises();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      running: true,
      status: 'running',
    });
    expect(context.scheduler.activeTimers()).toHaveLength(0);

    await monitor.stop();
    drainDeferred.resolve({ messages: [], connection: { status: 'connected' } });
    await runPromise;

    expect(context.disconnectCalls).toEqual(['account-a']);
    expect(context.scheduler.activeTimers()).toHaveLength(0);
    expect(monitor.getStatus()).toMatchObject({ running: false });
  });

  it('does not let enableAccount bypass backend account status gating', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const accounts = [{ id: 'account-a', status: 'login_required' }];
    const context = createDependencies({
      accounts,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    expect(context.scheduler.created).toHaveLength(0);

    await monitor.enableAccount('account-a');

    expect(context.scheduler.created).toHaveLength(0);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: false,
      status: 'login_required',
    });

    accounts[0].status = 'enabled';
    await monitor.enableAccount('account-a');

    expect(context.scheduler.created).toHaveLength(1);
    expect(context.scheduler.created[0].delayMs).toBe(0);
  });

  it('clears existing timers and disconnects when enableAccount rechecks a now-login_required account', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const accounts = [{ id: 'account-a', status: 'enabled' }];
    const context = createDependencies({
      accounts,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    expect(context.scheduler.activeTimers()).toHaveLength(1);

    accounts[0].status = 'login_required';
    await monitor.enableAccount('account-a');

    expect(context.scheduler.activeTimers()).toHaveLength(0);
    expect(context.disconnectCalls).toEqual(['account-a']);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: false,
      status: 'login_required',
    });
  });

  it('disconnects immediately when refresh sees login_required and suppresses stale in-flight poll results', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const pollDeferred = createDeferred();
    const accounts = [{ id: 'account-a', status: 'enabled' }];
    const context = createDependencies({
      accounts,
      executeInAccountView: vi.fn(async () => pollDeferred.promise),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    const timer = context.scheduler.takeNextTimer();
    const runPromise = timer.callback();
    await flushPromises();

    accounts[0].status = 'login_required';
    await monitor.refresh();

    expect(context.disconnectCalls).toEqual(['account-a']);
    expect(context.scheduler.activeTimers()).toHaveLength(0);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: false,
      status: 'login_required',
    });

    pollDeferred.resolve({
      messages: [
        { conversation_id: 'conv-1', index: '1', sender: 'user-1', content: 'hello', timestamp: 1 },
      ],
      connection: { status: 'connected' },
    });
    await runPromise;

    expect(context.ingestCalls).toEqual([]);
    expect(context.onIngestedCalls).toEqual([]);
    expect(context.scheduler.activeTimers()).toHaveLength(0);
  });

  it('reschedules a fresh generation after re-enable while a stale drain is still running', async () => {
    const { createDmMonitor } = loadDmMonitor();
    const pollDeferred = createDeferred();
    const accounts = [{ id: 'account-a', status: 'enabled' }];
    const context = createDependencies({
      accounts,
      executeInAccountView: vi.fn(async () => pollDeferred.promise),
      ingestMessages: vi.fn(async (payload) => {
        context.ingestCalls.push(payload);
        return { inserted: payload.messages.length, duplicates: 0, insertedMessages: payload.messages };
      }),
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    const firstTimer = context.scheduler.takeNextTimer();
    const staleRunPromise = firstTimer.callback();
    await flushPromises();

    accounts[0].status = 'login_required';
    await monitor.refresh();
    expect(context.disconnectCalls).toEqual(['account-a']);
    expect(context.scheduler.activeTimers()).toHaveLength(0);

    accounts[0].status = 'enabled';
    await monitor.enableAccount('account-a');

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: true,
    });
    expect(context.scheduler.activeTimers()).toHaveLength(0);

    pollDeferred.reject(new Error('temporary bridge failure'));
    await staleRunPromise;

    expect(context.ingestCalls).toEqual([]);
    expect(context.onIngestedCalls).toEqual([]);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      accountId: 'account-a',
      enabled: true,
      running: false,
      status: 'idle',
      failureCount: 0,
    });
    expect(context.scheduler.activeTimers()).toHaveLength(1);
    expect(context.scheduler.activeTimers()[0].delayMs).toBe(0);
  });

  it('main adapter does not guess insertedMessages from the original chunk', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'desktop', 'electron', 'main.js'), 'utf8');

    expect(source).not.toContain('result.insertedMessages = Number(result.duplicates || 0) === 0 ? messages : []');
    expect(source).not.toContain('duplicates || 0) === 0 ? messages');
  });

  it('persists realtime_only capability state and continues websocket polling', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION, POLL_EXPRESSION } = loadDmMonitor();
    const executeInAccountView = vi.fn(async (_accountId, expression) => {
      if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
        return { supported: false, reason: '当前页面能力未验证，暂仅支持实时监听' };
      }
      if (expression === POLL_EXPRESSION) {
        return { messages: [], connection: { status: 'connected' } };
      }
      throw new Error(`unexpected expression: ${expression}`);
    });
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(executeInAccountView.mock.calls.map(([, expression]) => expression)).toEqual([
      HISTORY_CAPABILITIES_EXPRESSION,
      POLL_EXPRESSION,
    ]);
    expect(context.updateMonitorStateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: 'account-a',
        patch: expect.objectContaining({
          historyStatus: 'realtime_only',
          historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
        }),
      }),
    ]));
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      status: 'idle',
      historyStatus: 'realtime_only',
    });
    expect(context.scheduler.activeTimers()[0].delayMs).toBe(5000);
  });

  it.each([
    ['malformed capability', async () => ({ supported: true, messages: 'invalid' })],
    ['capability exception', async () => { throw new Error('capability unavailable'); }],
  ])('degrades safely on %s without interrupting realtime polling', async (_label, capabilityResult) => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION, POLL_EXPRESSION } = loadDmMonitor();
    const executeInAccountView = vi.fn(async (_accountId, expression) => {
      if (expression === HISTORY_CAPABILITIES_EXPRESSION) return capabilityResult();
      if (expression === POLL_EXPRESSION) return { messages: [], connection: { status: 'connected' } };
      throw new Error(`unexpected expression: ${expression}`);
    });
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(executeInAccountView).toHaveBeenCalledWith('account-a', POLL_EXPRESSION);
    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      status: 'idle',
      failureCount: 0,
      historyStatus: 'realtime_only',
    });
    expect(context.scheduler.activeTimers()[0].delayMs).toBe(5000);
  });

  it('rebuilds after a page reload loses Bridge, recovers polling after backoff, and does not probe capabilities on ordinary refresh', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION, POLL_EXPRESSION } = loadDmMonitor();
    let pollAttempts = 0;
    const executeInAccountView = vi.fn(async (_accountId, expression) => {
      if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
        return { supported: false, reason: '当前页面能力未验证，暂仅支持实时监听' };
      }
      if (expression === POLL_EXPRESSION) {
        pollAttempts += 1;
        if (pollAttempts === 1) throw new Error('Bridge temporarily missing after page reload');
        return { messages: [], connection: { status: 'connected' } };
      }
      throw new Error(`unexpected expression: ${expression}`);
    });
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      enabled: true,
      status: 'backoff',
      failureCount: 1,
      nextDelayMs: 30000,
      historyStatus: 'realtime_only',
    });
    expect(context.disconnectCalls).toEqual(['account-a']);

    await monitor.refresh();
    expect(executeInAccountView.mock.calls.filter(([, expression]) => (
      expression === HISTORY_CAPABILITIES_EXPRESSION
    ))).toHaveLength(1);

    await context.scheduler.takeNextTimer().callback();

    expect(getAccountStatus(monitor, 'account-a')).toMatchObject({
      enabled: true,
      status: 'idle',
      failureCount: 0,
      nextDelayMs: 5000,
      historyStatus: 'realtime_only',
    });
    expect(context.ensureCalls).toHaveLength(2);
    expect(executeInAccountView.mock.calls.filter(([, expression]) => (
      expression === HISTORY_CAPABILITIES_EXPRESSION
    ))).toHaveLength(2);
    expect(executeInAccountView.mock.calls.filter(([, expression]) => (
      expression === POLL_EXPRESSION
    ))).toHaveLength(2);

    await monitor.refresh();
    await context.scheduler.takeNextTimer().callback();

    expect(executeInAccountView.mock.calls.filter(([, expression]) => (
      expression === HISTORY_CAPABILITIES_EXPRESSION
    ))).toHaveLength(2);
    expect(executeInAccountView.mock.calls.filter(([, expression]) => (
      expression === POLL_EXPRESSION
    ))).toHaveLength(3);
    expect(getAccountStatus(monitor, 'account-a').status).toBe('idle');
  });

  it('caches capability per account view across refresh and never marks history complete', async () => {
    const { createDmMonitor, HISTORY_CAPABILITIES_EXPRESSION, POLL_EXPRESSION } = loadDmMonitor();
    const executeInAccountView = vi.fn(async (_accountId, expression) => {
      if (expression === HISTORY_CAPABILITIES_EXPRESSION) {
        return { supported: false, reason: '仅实时监听' };
      }
      if (expression === POLL_EXPRESSION) return { messages: [], connection: { status: 'connected' } };
      throw new Error(`unexpected expression: ${expression}`);
    });
    const context = createDependencies({
      accounts: [{ id: 'account-a', status: 'enabled' }],
      executeInAccountView,
    });
    const monitor = createDmMonitor(context.dependencies);

    await monitor.start();
    await context.scheduler.takeNextTimer().callback();
    await monitor.refresh();
    await context.scheduler.takeNextTimer().callback();

    const expressions = executeInAccountView.mock.calls.map(([, expression]) => expression);
    expect(expressions.filter((expression) => expression === HISTORY_CAPABILITIES_EXPRESSION)).toHaveLength(1);
    expect(expressions.filter((expression) => expression === POLL_EXPRESSION)).toHaveLength(2);
    expect(context.updateMonitorStateCalls.flatMap((call) => Object.values(call.patch)))
      .not.toContain('complete');
    expect(getAccountStatus(monitor, 'account-a').historyStatus).toBe('realtime_only');
  });
});
