const crypto = require('crypto');

const DM_ENDPOINT = 'wss://frontier-im.douyin.com/ws/v2';
const DM_APP_KEY = 'e1bd35ec9db7b8d846de66ed140b1ad9';
const DM_FPID = '9';
const DM_ACCESS_SALT = 'f8a69f1719916z';
const DM_PROTOCOLS = Object.freeze(['binary', 'base64', 'pbbp2']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function accountIdFor(accountOrId) {
  const value = typeof accountOrId === 'object' && accountOrId
    ? accountOrId.id
    : accountOrId;
  return requiredText(value, 'account id');
}

function computeAccessKey(deviceId, fpid = DM_FPID, appKey = DM_APP_KEY) {
  const normalizedDeviceId = requiredText(deviceId, 'device id');
  const normalizedFpid = requiredText(fpid, 'fpid');
  const normalizedAppKey = requiredText(appKey, 'app key');
  return crypto
    .createHash('md5')
    .update(`${normalizedFpid}${normalizedAppKey}${normalizedDeviceId}${DM_ACCESS_SALT}`)
    .digest('hex');
}

function buildDmWebSocketConfig({
  deviceId,
  sessionToken,
  cookieHeader,
  userAgent,
} = {}) {
  const normalizedDeviceId = requiredText(deviceId, 'device id');
  const normalizedSessionToken = requiredText(sessionToken, 'session token');
  const normalizedCookieHeader = requiredText(cookieHeader, 'cookie header');
  const params = new URLSearchParams({
    aid: '6383',
    device_platform: 'douyin_pc',
    fpid: DM_FPID,
    device_id: normalizedDeviceId,
    token: normalizedSessionToken,
    access_key: computeAccessKey(normalizedDeviceId),
  });
  const headers = {
    Cookie: normalizedCookieHeader,
    Origin: 'https://www.douyin.com',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  };
  if (String(userAgent || '').trim()) {
    headers['User-Agent'] = String(userAgent).trim();
  }
  return {
    url: `${DM_ENDPOINT}?${params.toString()}`,
    protocols: [...DM_PROTOCOLS],
    options: { headers },
  };
}

function cookiesToHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && cookie.name && cookie.value !== undefined)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function findSessionToken(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  return list.find((cookie) => cookie?.name === 'sessionid')?.value
    || list.find((cookie) => cookie?.name === 'sessionid_ss')?.value
    || '';
}

function createPublicState(state) {
  return {
    accountId: state.accountId,
    selfPlatformId: state.selfPlatformId || '',
    status: state.status,
    connected: Boolean(state.connected),
    queuedMessages: state.queue.length,
    lastError: state.lastError || '',
    lastCloseCode: state.lastCloseCode ?? null,
    lastCloseReason: state.lastCloseReason || '',
    lastEventAt: state.lastEventAt || null,
  };
}

function createDmError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function redactCredentials(value) {
  return String(value || '')
    .replace(/\b(token|access_key|sessionid(?:_ss)?)=([^&;\s]+)/gi, '$1=[redacted]')
    .replace(/\bCookie:\s*[^\r\n]+/gi, 'Cookie: [redacted]');
}

function redactError(error, fallbackMessage) {
  const safeError = new Error(redactCredentials(error?.message || error || fallbackMessage));
  if (error?.code) safeError.code = error.code;
  if (error?.status) safeError.status = error.status;
  if (error?.disconnectRecommended === true) safeError.disconnectRecommended = true;
  return safeError;
}

function createDmClientManager({
  WebSocketImpl,
  getAccountCookies,
    getDeviceId,
    getAccountUserId = async () => '',
  decodeFrame,
  userAgent = '',
  now = () => Date.now(),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  logger = console,
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new TypeError('WebSocketImpl is required');
  }
  if (typeof getAccountCookies !== 'function') {
    throw new TypeError('getAccountCookies is required');
  }
  if (typeof getDeviceId !== 'function') {
    throw new TypeError('getDeviceId is required');
  }
  if (typeof decodeFrame !== 'function') {
    throw new TypeError('decodeFrame is required');
  }

  const states = new Map();

  function ensureState(accountOrId) {
    const accountId = accountIdFor(accountOrId);
    if (!states.has(accountId)) {
      states.set(accountId, {
        accountId,
        selfPlatformId: '',
        socket: null,
        queue: [],
        status: 'disconnected',
        connected: false,
        lastError: '',
        lastCloseCode: null,
        lastCloseReason: '',
        lastEventAt: null,
        manuallyClosed: false,
      });
    }
    return states.get(accountId);
  }

  function markEvent(state) {
    state.lastEventAt = new Date(now()).toISOString();
  }

  function socketIsActive(socket) {
    return socket && (
      socket.readyState === WebSocketImpl.OPEN
      || socket.readyState === WebSocketImpl.CONNECTING
    );
  }

  function attachSocket(state, socket) {
    socket.on('open', () => {
      if (state.socket !== socket) return;
      state.status = 'connected';
      state.connected = true;
      state.lastError = '';
      markEvent(state);
    });
    socket.on('message', (payload) => {
      if (state.socket !== socket) return;
      try {
        const decoded = decodeFrame(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
        if (Array.isArray(decoded) && decoded.length > 0) {
          state.queue.push(...decoded);
        }
        state.lastError = '';
        markEvent(state);
      } catch (error) {
        state.lastError = redactCredentials(error?.message || 'Failed to decode private-message frame');
        markEvent(state);
        logger?.warn?.(`[dm-client] Frame decode failed for account ${state.accountId}: ${state.lastError}`);
      }
    });
    socket.on('error', (error) => {
      if (state.socket !== socket) return;
      state.status = 'error';
      state.connected = false;
      state.lastError = redactCredentials(error?.message || 'Private-message socket error');
      markEvent(state);
      logger?.warn?.(`[dm-client] Socket error for account ${state.accountId}: ${state.lastError}`);
    });
    socket.on('close', (code, reason) => {
      if (state.socket !== socket) return;
      state.connected = false;
      state.status = state.manuallyClosed ? 'disconnected' : 'closed';
      state.lastCloseCode = Number.isFinite(Number(code)) ? Number(code) : null;
      state.lastCloseReason = redactCredentials(Buffer.isBuffer(reason)
        ? reason.toString('utf8').slice(0, 200)
        : String(reason || '').slice(0, 200));
      state.socket = null;
      markEvent(state);
    });
  }

  async function connect(account) {
    const state = ensureState(account);
    if (socketIsActive(state.socket)) {
      return createPublicState(state);
    }

    state.manuallyClosed = false;
    state.status = 'connecting';
    state.connected = false;
    state.lastError = '';
    state.lastCloseCode = null;
    state.lastCloseReason = '';

    try {
      const cookies = await getAccountCookies(account);
      const sessionToken = findSessionToken(cookies);
      if (!sessionToken) {
        throw createDmError('The account session is not logged in', 'login_required');
      }
      const deviceId = await getDeviceId(account);
      if (!String(deviceId || '').trim()) {
        throw createDmError('The account browser has no stable device id', 'dm_device_id_missing');
      }
      try {
        state.selfPlatformId = String(await getAccountUserId(account) || '').trim();
      } catch (error) {
        state.selfPlatformId = '';
        logger?.warn?.(`[dm-client] Unable to read Douyin user id for account ${state.accountId}: ${error?.message || error}`);
      }
      const config = buildDmWebSocketConfig({
        deviceId,
        sessionToken,
        cookieHeader: cookiesToHeader(cookies),
        userAgent,
      });
      const socket = new WebSocketImpl(config.url, config.protocols, config.options);
      state.socket = socket;
      attachSocket(state, socket);
      markEvent(state);
      return createPublicState(state);
    } catch (error) {
      const safeError = redactError(error, 'Failed to connect private-message socket');
      state.status = 'error';
      state.connected = false;
      state.lastError = safeError.message;
      markEvent(state);
      throw safeError;
    }
  }

  function drainQueue(state) {
    return state.queue.splice(0, state.queue.length);
  }

  async function poll(account, timeoutMs = 12000) {
    const state = ensureState(account);
    if (!socketIsActive(state.socket)) {
      await connect(account);
    }
    if (state.queue.length > 0 || Number(timeoutMs) <= 0) {
      return {
        messages: drainQueue(state),
        has_more: false,
        selfPlatformId: state.selfPlatformId,
        connection: createPublicState(state),
      };
    }

    const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
    while (now() < deadline && state.queue.length === 0) {
      if (!socketIsActive(state.socket) && state.status !== 'connecting') break;
      await sleep(Math.min(200, Math.max(1, deadline - now())));
    }
    return {
      messages: drainQueue(state),
      has_more: false,
      selfPlatformId: state.selfPlatformId,
      connection: createPublicState(state),
    };
  }

  async function disconnect(accountOrId) {
    const state = ensureState(accountOrId);
    const socket = state.socket;
    state.manuallyClosed = true;
    state.status = 'disconnected';
    state.connected = false;
    state.socket = null;
    markEvent(state);
    if (socket && socket.readyState !== WebSocketImpl.CLOSED) {
      try {
        socket.close(1000, 'account monitor stopped');
      } catch (error) {
        logger?.warn?.(`[dm-client] Socket close failed for account ${state.accountId}: ${error?.message || error}`);
      }
    }
    return createPublicState(state);
  }

  async function stopAll() {
    await Promise.all([...states.keys()].map((accountId) => disconnect(accountId)));
  }

  function getStatus() {
    return {
      accounts: [...states.values()].map(createPublicState),
    };
  }

  return {
    connect,
    disconnect,
    getStatus,
    poll,
    stopAll,
  };
}

module.exports = {
  DM_APP_KEY,
  DM_ENDPOINT,
  DM_FPID,
  DM_PROTOCOLS,
  buildDmWebSocketConfig,
  computeAccessKey,
  createDmClientManager,
};
