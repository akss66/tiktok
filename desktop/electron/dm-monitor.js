const { normalizeHistoryPage } = require('./dm-history');

const HISTORY_CAPABILITIES_EXPRESSION = 'window.__bridge.getDMHistoryCapabilities()';
const POLL_EXPRESSION = 'window.__bridge.pollDMs(12000)';
// The WebSocket receives remotely in real time; this only controls local queue draining.
const NORMAL_DELAY_MS = 5_000;
const CONNECTING_RETRY_DELAY_MS = 10_000;
const INITIAL_STAGGER_MS = 5_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

function defaultIsAccountEnabled(account) {
  return Boolean(account && String(account.status || '') === 'enabled');
}

function defaultIsLoginRequiredError(error) {
  if (!error) return false;
  if (error.code === 'login_required' || error.status === 'login_required') return true;
  const message = String(error.message || error || '').toLowerCase();
  return message.includes('login_required') || message.includes('login required');
}

function defaultShouldDisconnectOnFailure(error) {
  const message = String(error && error.message ? error.message : error || '');
  return error?.disconnectRecommended === true
    || message.includes('Bridge')
    || message.includes('chrome-error')
    || message.includes('douyin.com')
    || message.includes('URL')
    || message.includes('load');
}

function chunkMessages(messages, size = 200) {
  const chunks = [];
  for (let index = 0; index < messages.length; index += size) {
    chunks.push(messages.slice(index, index + size));
  }
  return chunks;
}

function assertConnectedPollResult(pollResult) {
  if (!pollResult || Array.isArray(pollResult) || !pollResult.connection) return 'connected';
  const connection = pollResult.connection;
  if (connection.status === 'connected') return 'connected';
  if (connection.status === 'connecting') return 'connecting';
  const closeCode = Number(connection.lastCloseCode || 0);
  const details = [
    `status=${connection.status || 'unknown'}`,
    closeCode ? `closeCode=${closeCode}` : '',
    connection.lastCloseReason ? `reason=${connection.lastCloseReason}` : '',
    connection.lastError ? `error=${connection.lastError}` : '',
  ].filter(Boolean).join(', ');
  const error = new Error(`私信 WebSocket 未连接（${details}）`);
  error.disconnectRecommended = false;
  throw error;
}

function createDmMonitor(dependencies = {}) {
  const {
    getMainWindow = () => null,
    isBackendHealthy = async () => true,
    listAccounts = async () => [],
    listMonitorStates = async () => [],
    updateMonitorState = async (accountId, patch) => ({ accountId, ...patch }),
    ensureBackgroundAccountView,
    executeInAccountView,
    pollAccount,
    ingestMessages = async () => ({ inserted: 0, duplicates: 0, insertedMessages: [] }),
    disconnectAccountView = async () => ({ ok: true, closed: false }),
    disconnectAccount,
    onIngested = () => {},
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
    isAccountEnabled = defaultIsAccountEnabled,
    isLoginRequiredError = defaultIsLoginRequiredError,
    shouldDisconnectOnFailure = defaultShouldDisconnectOnFailure,
    logger = console,
  } = dependencies;

  const usesNativeTransport = typeof pollAccount === 'function';
  if (!usesNativeTransport && typeof ensureBackgroundAccountView !== 'function') {
    throw new Error('ensureBackgroundAccountView dependency is required');
  }
  if (!usesNativeTransport && typeof executeInAccountView !== 'function') {
    throw new Error('executeInAccountView dependency is required');
  }

  const accountStates = new Map();
  let monitorRunning = false;
  let monitorGeneration = 0;

  function getOrCreateState(accountId) {
    const normalizedId = String(accountId || '').trim();
    if (!accountStates.has(normalizedId)) {
      accountStates.set(normalizedId, {
        accountId: normalizedId,
        account: null,
        enabled: false,
        running: false,
        runPromise: null,
        timer: null,
        nextDelayMs: null,
        failureCount: 0,
        cursor: '',
        selfPlatformId: '',
        status: 'idle',
        lastError: null,
        historyStatus: 'realtime_only',
        historyIncompleteReason: null,
        historyCapabilityChecked: false,
        generation: 0,
        pendingScheduleDelayMs: null,
      });
    }
    return accountStates.get(normalizedId);
  }

  function snapshotState(state) {
    return {
      accountId: state.accountId,
      enabled: state.enabled,
      running: state.running,
      nextDelayMs: state.nextDelayMs,
      failureCount: state.failureCount,
      cursor: state.cursor,
      selfPlatformId: state.selfPlatformId,
      status: state.status,
      lastError: state.lastError,
      historyStatus: state.historyStatus,
      historyIncompleteReason: state.historyIncompleteReason,
      accountStatus: state.account?.status || null,
    };
  }

  function getStatus() {
    return {
      running: monitorRunning,
      generation: monitorGeneration,
      accounts: Array.from(accountStates.values()).map(snapshotState),
    };
  }

  function updateLocalState(state, patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) state.enabled = Boolean(patch.enabled);
    if (Object.prototype.hasOwnProperty.call(patch, 'running')) state.running = Boolean(patch.running);
    if (Object.prototype.hasOwnProperty.call(patch, 'failureCount')) state.failureCount = Math.max(0, Number(patch.failureCount) || 0);
    if (Object.prototype.hasOwnProperty.call(patch, 'cursor')) state.cursor = String(patch.cursor || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'platformUserId')) {
      state.selfPlatformId = String(patch.platformUserId || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'status')) state.status = String(patch.status || 'idle');
    if (Object.prototype.hasOwnProperty.call(patch, 'historyStatus')) {
      state.historyStatus = String(patch.historyStatus || 'realtime_only');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'historyIncompleteReason')) {
      state.historyIncompleteReason = patch.historyIncompleteReason === null
        ? null
        : String(patch.historyIncompleteReason || '');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastError')) {
      state.lastError = patch.lastError === undefined ? state.lastError : patch.lastError;
    }
  }

  async function persistState(state, patch = {}) {
    updateLocalState(state, patch);
    try {
      await updateMonitorState(state.accountId, {
        cursor: state.cursor,
        status: state.status,
        lastError: state.lastError,
        historyStatus: state.historyStatus,
        historyIncompleteReason: state.historyIncompleteReason,
      });
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn('[dm-monitor] failed to persist monitor state:', error.message || String(error));
      }
    }
  }

  function clearAccountTimer(state) {
    if (!state?.timer) return;
    clearTimer(state.timer);
    state.timer = null;
    state.nextDelayMs = null;
  }

  function bumpAccountGeneration(state) {
    state.generation = Number(state.generation || 0) + 1;
    return state.generation;
  }

  function shouldKeepScheduling(state, runGeneration, accountGeneration) {
    return monitorRunning
      && monitorGeneration === runGeneration
      && state.enabled
      && state.generation === accountGeneration;
  }

  function scheduleAccount(state, delayMs) {
    clearAccountTimer(state);
    if (!monitorRunning || !state.enabled || state.status === 'login_required') return null;
    const nextDelayMs = Math.max(0, Number(delayMs) || 0);
    const scheduledGeneration = monitorGeneration;
    const scheduledAccountGeneration = state.generation;
    state.pendingScheduleDelayMs = null;
    state.nextDelayMs = nextDelayMs;
    const timer = setTimer(() => drainAccount(state.accountId, scheduledGeneration, scheduledAccountGeneration), nextDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    state.timer = timer;
    return timer;
  }

  async function disconnectState(state) {
    clearAccountTimer(state);
    state.historyCapabilityChecked = false;
    try {
      if (typeof disconnectAccount === 'function') {
        await disconnectAccount(state.accountId);
      } else {
        await disconnectAccountView(state.accountId);
      }
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn('[dm-monitor] disconnect failed:', error.message || String(error));
      }
    }
  }

  async function ensureHistoryCapability(state, isCurrentRun) {
    if (state.historyCapabilityChecked) return true;

    let normalized;
    try {
      const capability = await executeInAccountView(state.accountId, HISTORY_CAPABILITIES_EXPRESSION);
      if (!isCurrentRun()) return false;
      normalized = normalizeHistoryPage(capability);
      if (capability?.supported === true) {
        normalized = normalizeHistoryPage({
          supported: false,
          reason: '页面报告了历史私信能力，但当前版本未通过脱敏结构验证，暂仅支持实时监听',
        });
      }
    } catch (error) {
      if (!isCurrentRun()) return false;
      normalized = normalizeHistoryPage({
        supported: false,
        reason: `历史私信能力检测失败，暂仅支持实时监听：${error?.message || error}`,
      });
    }

    if (!isCurrentRun()) return false;
    state.historyCapabilityChecked = true;
    await persistState(state, {
      historyStatus: 'realtime_only',
      historyIncompleteReason: normalized.incompleteReason,
    });
    return isCurrentRun();
  }

  async function disableAccount(accountId) {
    const state = getOrCreateState(accountId);
    state.enabled = false;
    bumpAccountGeneration(state);
    state.pendingScheduleDelayMs = null;
    clearAccountTimer(state);
    await disconnectState(state);
    await persistState(state, {
      failureCount: 0,
      status: 'disabled',
    });
    return snapshotState(state);
  }

  async function enableAccount(accountId) {
    const state = getOrCreateState(accountId);
    const accounts = await listAccounts();
    const account = Array.isArray(accounts)
      ? accounts.find((item) => String(item?.id || '').trim() === state.accountId)
      : null;
    state.account = account || state.account;
    if (!isAccountEnabled(account)) {
      state.enabled = false;
      bumpAccountGeneration(state);
      state.pendingScheduleDelayMs = null;
      await disconnectState(state);
      await persistState(state, {
        status: String(account?.status || state.status || 'idle'),
      });
      return snapshotState(state);
    }
    state.enabled = true;
    bumpAccountGeneration(state);
    await persistState(state, {
      failureCount: 0,
      status: state.status === 'login_required' ? 'idle' : state.status,
      lastError: state.status === 'login_required' ? null : state.lastError,
    });
    clearAccountTimer(state);
    if (monitorRunning) {
      if (state.running) {
        state.pendingScheduleDelayMs = 0;
        state.nextDelayMs = 0;
      } else {
        scheduleAccount(state, 0);
      }
    }
    return snapshotState(state);
  }

  async function drainAccount(accountId, runGeneration, accountGeneration = getOrCreateState(accountId).generation) {
    const state = getOrCreateState(accountId);
    clearAccountTimer(state);
    if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);
    if (state.running && state.runPromise) return state.runPromise;

    state.runPromise = (async () => {
      state.running = true;
      await persistState(state, {
        status: 'running',
        lastError: null,
      });
      try {
        let pollResult;
        if (usesNativeTransport) {
          pollResult = await pollAccount(state.account, 12000);
        } else {
          const mainWindow = getMainWindow();
          const ensured = await ensureBackgroundAccountView(mainWindow, state.account);
          if (ensured && ensured.ok === false) {
            throw new Error(ensured.error || 'Failed to ensure account background view');
          }
          if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);

          const historyCapabilityReady = await ensureHistoryCapability(
            state,
            () => shouldKeepScheduling(state, runGeneration, accountGeneration),
          );
          if (!historyCapabilityReady) return snapshotState(state);
          pollResult = await executeInAccountView(state.accountId, POLL_EXPRESSION);
        }
        if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);

        const connection = pollResult && !Array.isArray(pollResult)
          ? pollResult.connection
          : null;
        if (typeof logger?.info === 'function') {
          logger.info('[dm-monitor] poll result', {
            accountId: state.accountId,
            messageCount: Array.isArray(pollResult)
              ? pollResult.length
              : Array.isArray(pollResult?.messages)
                ? pollResult.messages.length
                : 0,
            connection: connection ? {
              status: connection.status || 'unknown',
              readyState: connection.readyState ?? null,
              queueLength: connection.queueLength ?? null,
              reconnectRecommended: connection.reconnectRecommended === true,
              lastError: connection.lastError || '',
              lastCloseCode: connection.lastCloseCode || 0,
              lastCloseReason: connection.lastCloseReason || '',
            } : null,
          });
        }
        const connectionStatus = assertConnectedPollResult(pollResult);
        if (connectionStatus === 'connecting') {
          await persistState(state, {
            failureCount: 0,
            status: 'connecting',
            lastError: null,
          });
          if (shouldKeepScheduling(state, runGeneration, accountGeneration)) {
            scheduleAccount(state, CONNECTING_RETRY_DELAY_MS);
          }
          return snapshotState(state);
        }

        const messages = Array.isArray(pollResult)
          ? pollResult
          : Array.isArray(pollResult?.messages)
            ? pollResult.messages
            : [];
        const discoveredSelfPlatformId = String(
          pollResult?.selfPlatformId || connection?.selfPlatformId || '',
        ).trim();
        const shouldPersistIdentity = Boolean(
          discoveredSelfPlatformId && discoveredSelfPlatformId !== state.selfPlatformId,
        );
        if (messages.length === 0 && shouldPersistIdentity) {
          await ingestMessages({
            accountId: state.accountId,
            selfPlatformId: discoveredSelfPlatformId,
            messages: [],
          });
          if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);
          state.selfPlatformId = discoveredSelfPlatformId;
        }
        for (const chunk of chunkMessages(messages, 200)) {
          if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);
          const result = await ingestMessages({
            accountId: state.accountId,
            selfPlatformId: discoveredSelfPlatformId,
            messages: chunk,
          });
          if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);
          const insertedMessages = Array.isArray(result?.insertedMessages) ? result.insertedMessages : [];
          if (Number(result?.inserted || 0) > 0 && insertedMessages.length > 0) {
            await Promise.resolve(onIngested(insertedMessages));
          }
        }
        if (messages.length > 0 && discoveredSelfPlatformId) {
          state.selfPlatformId = discoveredSelfPlatformId;
        }

        if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) return snapshotState(state);
        await persistState(state, {
          failureCount: 0,
          status: 'idle',
          lastError: null,
        });
        if (shouldKeepScheduling(state, runGeneration, accountGeneration)) {
          scheduleAccount(state, NORMAL_DELAY_MS);
        }
        return snapshotState(state);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (!shouldKeepScheduling(state, runGeneration, accountGeneration)) {
          return snapshotState(state);
        }
        if (isLoginRequiredError(error)) {
          state.enabled = false;
          bumpAccountGeneration(state);
          state.pendingScheduleDelayMs = null;
          await disconnectState(state);
          await persistState(state, {
            status: 'login_required',
            lastError: message,
          });
          return snapshotState(state);
        }

        const nextFailureCount = state.failureCount + 1;
        const retryDelayMs = RETRY_DELAYS_MS[Math.min(state.failureCount, RETRY_DELAYS_MS.length - 1)];
        if (shouldDisconnectOnFailure(error)) {
          await disconnectState(state);
        }
        await persistState(state, {
          failureCount: nextFailureCount,
          status: 'backoff',
          lastError: message,
        });
        if (shouldKeepScheduling(state, runGeneration, accountGeneration)) {
          scheduleAccount(state, retryDelayMs);
        }
        return snapshotState(state);
      } finally {
        state.running = false;
        state.runPromise = null;
        if (
          monitorRunning
          && state.enabled
          && !state.timer
          && state.status !== 'login_required'
          && state.pendingScheduleDelayMs !== null
        ) {
          const pendingDelayMs = state.pendingScheduleDelayMs;
          scheduleAccount(state, pendingDelayMs);
        }
      }
    })();

    return state.runPromise;
  }

  async function refresh(options = {}) {
    const [accounts, backendStates] = await Promise.all([
      listAccounts(),
      listMonitorStates(),
    ]);
    const backendStateByAccountId = new Map(
      (Array.isArray(backendStates) ? backendStates : []).map((item) => [String(item.accountId || '').trim(), item]),
    );
    const seenAccountIds = new Set();
    const accountsToSchedule = [];

    for (const account of Array.isArray(accounts) ? accounts : []) {
      const accountId = String(account?.id || '').trim();
      if (!accountId) continue;
      seenAccountIds.add(accountId);
      const state = getOrCreateState(accountId);
      state.account = account;
      if (options.seedFromBackend === true) {
        const snapshot = backendStateByAccountId.get(accountId);
        if (snapshot) {
          updateLocalState(state, {
            cursor: snapshot.cursor,
            platformUserId: snapshot.platformUserId,
            status: snapshot.status,
            lastError: snapshot.lastError,
            historyStatus: snapshot.historyStatus,
            historyIncompleteReason: snapshot.historyIncompleteReason,
          });
        }
      }
      if (isAccountEnabled(account)) {
        const wasEnabled = state.enabled;
        state.enabled = true;
        if (!wasEnabled || options.initialSchedule === true) {
          accountsToSchedule.push(state);
        }
      } else {
        const nextStatus = String(account.status || state.status || 'idle');
        if (state.enabled || state.timer || state.running) {
          state.enabled = false;
          bumpAccountGeneration(state);
          state.pendingScheduleDelayMs = null;
          await disconnectState(state);
        } else {
          clearAccountTimer(state);
        }
        updateLocalState(state, {
          status: nextStatus,
        });
      }
    }

    for (const [accountId, state] of accountStates.entries()) {
      if (seenAccountIds.has(accountId)) continue;
      if (state.enabled || state.timer || state.running) {
        await disableAccount(accountId);
      }
    }

    if (monitorRunning) {
      const scheduleTargets = options.initialSchedule === true
        ? accountsToSchedule.filter((state) => state.enabled)
        : accountsToSchedule.filter((state) => state.enabled && !state.timer);
      scheduleTargets.forEach((state, index) => {
        if (state.status === 'login_required') return;
        const nextDelayMs = options.initialSchedule === true ? index * INITIAL_STAGGER_MS : 0;
        if (state.running) {
          state.pendingScheduleDelayMs = nextDelayMs;
          state.nextDelayMs = nextDelayMs;
          return;
        }
        scheduleAccount(state, nextDelayMs);
      });
    }

    return getStatus();
  }

  async function start() {
    if (monitorRunning) {
      await refresh();
      return { ok: true, started: false, status: getStatus() };
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) {
      return { ok: false, error: 'main_window_unavailable' };
    }
    const backendHealthy = await isBackendHealthy();
    if (!backendHealthy) {
      return { ok: false, error: 'backend_unhealthy' };
    }
    monitorRunning = true;
    monitorGeneration += 1;
    await refresh({ seedFromBackend: true, initialSchedule: true });
    return { ok: true, started: true, status: getStatus() };
  }

  async function stop() {
    monitorRunning = false;
    monitorGeneration += 1;
    const disconnectTasks = [];
    for (const state of accountStates.values()) {
      clearAccountTimer(state);
      state.nextDelayMs = null;
      state.pendingScheduleDelayMs = null;
      if (state.enabled) {
        disconnectTasks.push(disconnectState(state));
      }
      if (state.status !== 'login_required' && state.status !== 'disabled') {
        state.status = 'stopped';
      }
    }
    await Promise.allSettled(disconnectTasks);
    return { ok: true, stopped: true, status: getStatus() };
  }

  return {
    start,
    stop,
    refresh,
    enableAccount,
    disableAccount,
    getStatus,
  };
}

module.exports = {
  CONNECTING_RETRY_DELAY_MS,
  HISTORY_CAPABILITIES_EXPRESSION,
  INITIAL_STAGGER_MS,
  NORMAL_DELAY_MS,
  POLL_EXPRESSION,
  RETRY_DELAYS_MS,
  createDmMonitor,
};
