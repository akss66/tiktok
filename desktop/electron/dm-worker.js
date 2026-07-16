const crypto = require('crypto');

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WRITE_LEASE_TTL_MS = 120_000;
const DEFAULT_WRITE_LEASE_HEARTBEAT_MS = 40_000;
const LEASE_BUSY_DELAY_MS = 30_000;

function buildSendExpression(conversationKey, text, peerId = '') {
  return `(async function(){
    function jsonSafe(value){
      return JSON.parse(JSON.stringify(value===undefined?null:value,function(_key,item){
        return typeof item==='bigint'?item.toString():item;
      }));
    }
    var bridge=window.__bridge;
    if(!bridge || typeof bridge.sendDM !== 'function'){
      return {__dmSendOutcome:'preflight_error',error:'DM Bridge API is not ready'};
    }
    var conversationKey=${JSON.stringify(conversationKey)};
    var peerId=${JSON.stringify(peerId)};
    var keyParts=String(conversationKey||'').split('|');
    var existingConversationId=keyParts[0]||'';
    var existingShortId=keyParts[1]||'';
    var existingTicket=keyParts.slice(2).join('|')||'';
    if(!existingTicket && existingConversationId && existingShortId && existingShortId!=='0' && typeof bridge.getConversationInfo==='function'){
      try{
        var existingConversation=await bridge.getConversationInfo(existingConversationId,existingShortId);
        if(!existingConversation || !existingConversation.conversation_id || !existingConversation.conversation_short_id || !existingConversation.ticket){
          return {__dmSendOutcome:'preflight_error',error:'DM conversation information is incomplete'};
        }
        conversationKey=[
          existingConversation.conversation_id,
          existingConversation.conversation_short_id,
          existingConversation.ticket
        ].map(String).join('|');
      }catch(error){
        return {__dmSendOutcome:'preflight_error',error:String(error&&error.message||error||'DM conversation could not be refreshed')};
      }
    }else if(!existingTicket && peerId){
      if(typeof bridge.createConversation !== 'function'){
        return {__dmSendOutcome:'preflight_error',error:'DM conversation API is not ready'};
      }
      try{
        var conversation=await bridge.createConversation(peerId);
        if(!conversation || !conversation.conversation_id){
          return {__dmSendOutcome:'preflight_error',error:'DM conversation could not be resolved'};
        }
        conversationKey=[
          conversation.conversation_id,
          conversation.conversation_short_id||'0',
          conversation.ticket||''
        ].map(String).join('|');
      }catch(error){
        return {__dmSendOutcome:'preflight_error',error:String(error&&error.message||error||'DM conversation could not be resolved')};
      }
    }else if(!existingTicket){
      return {__dmSendOutcome:'preflight_error',error:'DM conversation ticket is missing'};
    }
    try{
      var result=await bridge.sendDM(conversationKey,${JSON.stringify(text)});
      return {__dmSendOutcome:'platform_response',result:jsonSafe(result)};
    }catch(error){
      return {__dmSendOutcome:'send_error',error:String(error&&error.message||error||'DM send failed')};
    }
  })()`;
}

function isExplicitPlatformRejection(error) {
  if (error?.code === 'platform_rejected') return true;
  return /\[sendDM\]\s+HTTP\s+4\d\d\b/i.test(String(error?.message || error || ''));
}

function messageFor(error) {
  return String(error?.message || error || 'DM send failed');
}

function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  )));
}

function isAccountReadyToSend(account) {
  return account?.status === 'enabled' || account?.status === 'online';
}

function createDmWorker(deps = {}) {
  if (typeof deps.backendRequest !== 'function') throw new Error('backendRequest is required');
  if (typeof deps.getAccount !== 'function') throw new Error('getAccount is required');
  if (typeof deps.ensureBackgroundAccountView !== 'function') {
    throw new Error('ensureBackgroundAccountView is required');
  }
  if (typeof deps.executeInAccountView !== 'function') throw new Error('executeInAccountView is required');

  const backendRequest = deps.backendRequest;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const logger = deps.logger || console;
  const workerId = deps.workerId || `dm-worker-${process.pid}-${crypto.randomUUID()}`;
  const pollIntervalMs = Math.max(250, Number(deps.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
  const writeLeaseTtlMs = Math.max(50, Number(deps.writeLeaseTtlMs || DEFAULT_WRITE_LEASE_TTL_MS));
  const writeLeaseHeartbeatMs = Math.max(
    10,
    Math.min(writeLeaseTtlMs - 10, Number(deps.writeLeaseHeartbeatMs || DEFAULT_WRITE_LEASE_HEARTBEAT_MS)),
  );
  const executionTimeoutMs = Math.max(10, Number(deps.executionTimeoutMs || 60_000));

  let running = false;
  let active = false;
  let generation = 0;
  let timer = null;
  let lastResult = null;
  let activeRunPromise = null;

  function post(pathname, body) {
    return backendRequest(pathname, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });
  }

  async function failWork(work, error, options = {}) {
    const response = await post(`/api/dm/work-items/${encodeURIComponent(work.id)}/fail`, {
      workerId,
      claimToken: work.claimToken,
      error: messageFor(error),
      uncertain: options.uncertain === true,
      retryable: options.retryable === true,
      ...(options.deferMs ? { deferMs: options.deferMs } : {}),
    });
    return response.workItem;
  }

  function startLeaseHeartbeat(token) {
    let heartbeatTimer = null;
    let stopped = false;
    let heartbeatPromise = null;
    let heartbeatError = null;

    const schedule = () => {
      if (stopped) return;
      heartbeatTimer = setTimeoutFn(() => {
        heartbeatPromise = post('/api/operations/write-lease/renew', {
          token,
          ttlMs: writeLeaseTtlMs,
        }).then((result) => {
          if (!result?.renewed) throw new Error('Global Douyin write lease renewal failed');
        }).catch((error) => {
          heartbeatError = error;
          stopped = true;
        }).finally(() => {
          heartbeatPromise = null;
          if (!stopped) schedule();
        });
      }, writeLeaseHeartbeatMs);
      if (typeof heartbeatTimer?.unref === 'function') heartbeatTimer.unref();
    };
    schedule();

    return {
      getError: () => heartbeatError,
      async stop() {
        stopped = true;
        if (heartbeatTimer) {
          clearTimeoutFn(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (heartbeatPromise) await Promise.allSettled([heartbeatPromise]);
      },
    };
  }

  async function executeClaimedWork(work) {
    if (work.type === 'analyze') {
      try {
        const result = await post(`/api/dm/work-items/${encodeURIComponent(work.id)}/analyze`, {
          workerId,
          claimToken: work.claimToken,
        });
        return result.workItem || result;
      } catch (error) {
        return failWork(work, new Error('DM analysis request failed'), { retryable: true });
      }
    }
    if (work.type !== 'send_manual' && work.type !== 'send_auto') {
      return failWork(work, new Error(`Unsupported DM work type: ${work.type}`), { retryable: false });
    }
    const account = await deps.getAccount(work.accountId);
    if (!account) {
      return failWork(work, new Error('Account not found'), { retryable: false });
    }
    if (!isAccountReadyToSend(account)) {
      return failWork(work, new Error('Account login is required before sending private messages'), {
        retryable: false,
      });
    }
    const mainWindow = deps.getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      return failWork(work, new Error('Application window is unavailable'), { retryable: false });
    }
    const ensured = await deps.ensureBackgroundAccountView(mainWindow, account);
    if (ensured?.ok === false) {
      return failWork(work, new Error(ensured.error || 'Account browser is unavailable'), { retryable: false });
    }
    let executionContext;
    try {
      executionContext = await post(
        `/api/dm/work-items/${encodeURIComponent(work.id)}/execution-context`,
        { workerId, claimToken: work.claimToken },
      );
    } catch (error) {
      return failWork(work, error, { retryable: false });
    }

    const lease = await post('/api/operations/write-lease/acquire', {
      owner: `dm:${work.id}`,
      ttlMs: writeLeaseTtlMs,
    });
    if (!lease?.acquired) {
      return failWork(work, new Error(`Global write queue is busy${lease?.owner ? `: ${lease.owner}` : ''}`), {
        retryable: true,
        deferMs: LEASE_BUSY_DELAY_MS,
      });
    }

    let executionStarted = false;
    const heartbeat = startLeaseHeartbeat(lease.token);
    try {
      const text = String(executionContext?.text || '');
      const conversationKey = String(executionContext?.conversationKey || '');
      const peerId = String(executionContext?.peerId || '');
      if (!text.trim()) throw new Error('Pending DM reply text is empty');
      if (!conversationKey.trim()) throw new Error('Pending DM conversation key is missing');
      const expression = buildSendExpression(conversationKey, text, peerId);
      await post(`/api/dm/work-items/${encodeURIComponent(work.id)}/start-execution`, {
        workerId,
        claimToken: work.claimToken,
      });
      executionStarted = true;
      const actionPromise = Promise.resolve()
        .then(() => deps.executeInAccountView(work.accountId, expression, { userGesture: false }))
        .then(
          (value) => ({ type: 'settled', status: 'fulfilled', value }),
          (reason) => ({ type: 'settled', status: 'rejected', reason }),
        );
      let timeoutTimer = null;
      const timeoutPromise = new Promise((resolve) => {
        timeoutTimer = setTimeoutFn(() => resolve({ type: 'timeout' }), executionTimeoutMs);
        if (typeof timeoutTimer?.unref === 'function') timeoutTimer.unref();
      });
      const first = await Promise.race([actionPromise, timeoutPromise]);
      if (timeoutTimer) clearTimeoutFn(timeoutTimer);
      if (first.type === 'timeout') {
        const uncertainWork = await failWork(
          work,
          new Error(`DM execution timed out after ${executionTimeoutMs}ms`),
          { uncertain: true },
        );
        await actionPromise;
        return uncertainWork;
      }
      if (first.status === 'rejected') throw first.reason;
      let result = toJsonSafe(first.value);
      if (result?.__dmSendOutcome === 'preflight_error') {
        return failWork(work, new Error(result.error || 'DM preflight failed'), { retryable: false });
      }
      if (result?.__dmSendOutcome === 'send_error') {
        return failWork(work, new Error(result.error || 'DM send failed'), { uncertain: true });
      }
      if (result?.__dmSendOutcome === 'platform_response') {
        result = result.result;
      }
      if (!result || typeof result !== 'object') {
        throw new Error('DM platform response was empty after execution started');
      }
      await heartbeat.stop();
      if (heartbeat.getError()) throw heartbeat.getError();
      const rejectionDescription = String(result.error_desc || '').trim();
      const rawStatusCode = result.status_code ?? result.statusCode;
      const statusCode = rawStatusCode === undefined ? 0 : Number(rawStatusCode);
      if (rawStatusCode !== undefined && !Number.isFinite(statusCode)) {
        throw new Error('DM platform response contained an invalid status code');
      }
      if (rejectionDescription || statusCode !== 0) {
        const detail = rejectionDescription || `status_code=${statusCode}`;
        const error = new Error(`DM send rejected by platform: ${detail}`);
        error.code = 'platform_rejected';
        throw error;
      }
      const completed = await post(`/api/dm/work-items/${encodeURIComponent(work.id)}/complete`, {
        workerId,
        claimToken: work.claimToken,
        result: result || {},
      });
      return completed.workItem;
    } catch (error) {
      if (isExplicitPlatformRejection(error)) {
        return failWork(work, error, { retryable: true });
      }
      return failWork(work, error, {
        uncertain: executionStarted,
        retryable: false,
      });
    } finally {
      await heartbeat.stop();
      await post('/api/operations/write-lease/release', { token: lease.token }).catch((error) => {
        logger.warn?.('[dm-worker] failed to release write lease:', messageFor(error));
      });
    }
  }

  function runOnce() {
    if (activeRunPromise) return Promise.resolve({ status: 'busy' });
    const operation = (async () => {
      active = true;
      try {
        const claimed = await post('/api/dm/work-items/claim', {
          workerId,
          types: ['send_manual', 'send_auto', 'analyze'],
        });
        if (!claimed?.workItem) {
          lastResult = { status: 'idle' };
          return lastResult;
        }
        lastResult = await executeClaimedWork(claimed.workItem);
        return lastResult;
      } catch (error) {
        lastResult = { status: 'error', error: messageFor(error) };
        logger.error?.('[dm-worker] run failed:', lastResult.error);
        return lastResult;
      } finally {
        active = false;
      }
    })();
    activeRunPromise = operation;
    return operation.finally(() => {
      if (activeRunPromise === operation) activeRunPromise = null;
    });
  }

  function schedule(delay, expectedGeneration) {
    if (!running || expectedGeneration !== generation) return;
    timer = setTimeoutFn(async () => {
      timer = null;
      if (!running || expectedGeneration !== generation) return;
      await runOnce();
      schedule(pollIntervalMs, expectedGeneration);
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  async function start() {
    if (running) return { ok: true, started: false, status: getStatus() };
    running = true;
    generation += 1;
    schedule(0, generation);
    return { ok: true, started: true, status: getStatus() };
  }

  async function stop() {
    running = false;
    generation += 1;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (activeRunPromise) await activeRunPromise;
    return { ok: true, stopped: true, status: getStatus() };
  }

  function getStatus() {
    return { running, active, workerId, lastResult };
  }

  return { getStatus, runOnce, start, stop };
}

module.exports = {
  buildSendExpression,
  createDmWorker,
  isAccountReadyToSend,
  isExplicitPlatformRejection,
  toJsonSafe,
};
