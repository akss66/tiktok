const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const batch = require('../lib/desktop/batch');
const inbox = require('../lib/desktop/dm-inbox');
const dmLeads = require('../lib/desktop/dm-leads');
const queue = require('../lib/desktop/dm-work-queue');
const workspace = require('../lib/desktop/workspace');
const workflows = require('../lib/desktop/mvp-workflows');
const { createDesktopApiServer } = require('../lib/desktop/api-server');
const { buildSendExpression, createDmWorker } = require('../desktop/electron/dm-worker');

function extractSection(source, startMarker, endMarker, options = {}) {
  const start = options.last === true ? source.lastIndexOf(startMarker) : source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end marker after: ${startMarker}`);
  return source.slice(start, end).trimEnd();
}

function loadUserscriptDmRuntime(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');
  const helperBlock = extractSection(source, 'var DM_WS_STATE = {', 'window.__bridge = {');
  const connectBlock = extractSection(source, '  connectDMWS: async function(){', '  getDMConnectionState: function(){', { last: true });
  const getStateBlock = extractSection(source, '  getDMConnectionState: function(){', '  disconnectDMWS: function(){', { last: true });
  const disconnectBlock = extractSection(source, '  disconnectDMWS: function(){', '  pollDMs: async function(timeoutMs){', { last: true });
  const pollBlock = extractSection(source, '  pollDMs: async function(timeoutMs){', '  getDMs: function(){', { last: true });

  const sockets = [];
  const setTimeoutCalls = [];
  function FakeUint8Array(value) {
    return value;
  }
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    close(code, reason) {
      this.closeArgs = { code, reason };
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const context = {
    URLSearchParams,
    WebSocket: FakeWebSocket,
    Uint8Array: FakeUint8Array,
    _DM_HELPERS: {
      computeAccessKey: () => 'access-key',
    },
    _DM_PROTO: {
      decodePushFrame: (value) => value,
      decodeResponse: (value) => value,
    },
    getCookie: (name) => String(options.cookies?.[name] || ''),
    localStorage: {
      getItem: (name) => String(options.localStorage?.[name] || ''),
    },
    console: {
      log() {},
      warn() {},
    },
    setTimeout(callback, delay) {
      setTimeoutCalls.push({ callback, delay });
      return setTimeoutCalls.length;
    },
    clearTimeout() {},
    bridgeFetchJson: vi.fn(async () => ({ id: 'device-id-from-network' })),
    window: {
      __dmQueue: [],
      __dmWs: null,
      __electronBridgeSession: {
        getDmAuth: async () => ({ sessionToken: 'session-token-123' }),
      },
    },
  };
  context.globalThis = context;

  const script = `
${helperBlock}
window.__bridge = {
${connectBlock}
${getStateBlock}
${disconnectBlock}
${pollBlock}
};
`;
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    bridge: context.window.__bridge,
    context,
    sockets,
    setTimeoutCalls,
    WebSocket: FakeWebSocket,
  };
}

describe('desktop dm workflows', () => {
  let dir;
  let db;
  let account;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-workflows-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A' });
    workspace.upsertVideo(db, { awemeId: 'external-1', accountId: account.id, source: 'search' });
    workspace.upsertComment(db, {
      cid: 'comment-1', awemeId: 'external-1', accountId: account.id,
      userId: 'user-1', userName: '张三', text: '怎么收费？',
    });
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'external-1' });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('analyzes leads with knowledge and saves reviewable drafts', async () => {
    workspace.createKnowledgeEntry(db, {
      title: 'GEO 收费', content: '根据需求评估后报价。', tags: 'GEO,价格',
    });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    const result = await workflows.analyzeDmLeads(db, {
      accountId: account.id,
      leadIds: [lead.id],
    }, {
      llmClient: {
        analyzeDmLeads: async (items, context) => {
          expect(items[0]).toMatchObject({ userId: 'user-1', commentText: '怎么收费？' });
          expect(items[0].sources).toHaveLength(1);
          expect(items[0].sources[0].commentText).toBe('怎么收费？');
          expect(context.knowledge[0].title).toBe('GEO 收费');
          return [{
            userId: 'user-1', intentLevel: 'high', reason: '明确询价',
            draft: '你好，看到你在评论区咨询收费，可以先了解一下需求。',
          }];
        },
      },
    });

    expect(result[0]).toMatchObject({ intentLevel: 'high', status: 'draft' });
    expect(result[0].draftText).toContain('了解一下需求');
  });

  it('creates an approved-only job and sends DMs strictly one at a time', async () => {
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    dmLeads.updateLead(db, lead.id, { draftText: '你好，可以沟通一下需求。', status: 'approved' });
    const job = workflows.createDmSendJob(db, {
      accountId: account.id,
      leadIds: [lead.id],
      minDelayMs: 60000,
      maxDelayMs: 60000,
    });
    expect(job.type).toBe('dm-send');
    expect(job.input).toMatchObject({ concurrency: 1, minDelayMs: 60000 });

    const expressions = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const fakeBridge = {
      call: async ({ expression }) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        expressions.push(expression);
        activeCalls -= 1;
        return {
          ok: true,
          value: { status_code: 0, conversation_id: 'conv-1', message_id: 'msg-1' },
        };
      },
    };
    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: fakeBridge,
      sleepFn: async () => {},
    });

    expect(maxActiveCalls).toBe(1);
    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("window.__bridge.createConversation('user-1')");
    expect(expressions[0]).toContain('window.__bridge.sendDM');
    expect(result.job.status).toBe('success');
    expect(batch.listBatchItems(db, job.id)[0].status).toBe('success');
    expect(dmLeads.getLead(db, lead.id)).toMatchObject({ status: 'sent', conversationId: 'conv-1' });
  });

  it('keeps DM idempotency fields and exposes managed websocket lifecycle methods in the userscript', () => {
    const userscript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');

    expect(userscript).toContain('server_message_id');
    expect(userscript).toContain('index_in_conversation');
    expect(userscript).toContain('getDMConnectionState');
    expect(userscript).toContain('disconnectDMWS');
    expect(userscript).not.toContain('window.__bridge.connectDMWS();},5000');
  });

  it('serializes BigInt fields when reporting an unrecognized create-conversation response', () => {
    const dmFunctions = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'dm-bridge-funcs.js'),
      'utf8',
    );
    const createConversation = extractSection(
      dmFunctions,
      '  createConversation: async function(toUserId){',
      '  sendDM: async function(convId,text){',
    );

    expect(createConversation).toContain("typeof val==='bigint'?val.toString():val");
    expect(createConversation).not.toContain('JSON.stringify(result)');
  });

  it('wraps DM payloads in the command-specific RequestBody protobuf field', () => {
    for (const filename of ['dm-bridge-lib.js', 'douyin.user.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', filename), 'utf8');
      expect(source).toContain(
        'encodeMessageField(8, encodeMessageField(bodyFieldNum, bodyBytes))',
      );
      expect(source).not.toContain('encodeMessageField(8, bodyBytes)');
    }
  });

  it('exposes the conversation-info request used to refresh an existing DM ticket', () => {
    for (const filename of ['dm-bridge-lib.js', 'douyin.user.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', filename), 'utf8');
      expect(source).toContain('encodeGetConversationInfoListBody');
    }
    for (const filename of ['dm-bridge-funcs.js', 'douyin.user.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', filename), 'utf8');
      expect(source).toContain('getConversationInfo: async function(conversationId,conversationShortId)');
      expect(source).toContain('cmd:610');
      expect(source).toContain('/v2/conversation/get_info_list');
    }
  });

  it('encodes DM conversation short ids as uint64 values', () => {
    for (const filename of ['dm-bridge-lib.js', 'douyin.user.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', filename), 'utf8');
      const sendBody = source.match(/function encodeSendMessageBody\(opts\) \{([\s\S]*?)\n  \}/)?.[1] || '';
      expect(sendBody).toContain('encodeUint64Field(3, opts.conversation_short_id || 0)');
      expect(sendBody).not.toContain('encodeIntField(3, opts.conversation_short_id || 0)');
    }
  });

  it('uses the repository baseline DM websocket parameters without a blocking auth request', async () => {
    const runtime = loadUserscriptDmRuntime({
      cookies: { uid: 'device-id-from-cookie' },
    });

    const connecting = await runtime.bridge.connectDMWS();
    const url = new URL(runtime.sockets[0].url);

    expect(connecting).toMatchObject({ status: 'connecting' });
    expect(url.searchParams.get('device_platform')).toBe('web');
    expect(url.searchParams.get('version_code')).toBe('fws_1.0.0');
    expect(url.searchParams.get('device_id')).toBe('device-id-from-cookie');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.get('access_key')).toBe('access-key');
    expect(url.searchParams.get('qos_sdk_version')).toBe('2');
    expect(runtime.sockets[0].protocols).toBeUndefined();
    expect(runtime.context.bridgeFetchJson).not.toHaveBeenCalled();
  });

  it('keeps reconnectRecommended false after manual disconnect and async onclose', async () => {
    const runtime = loadUserscriptDmRuntime();
    const first = await runtime.bridge.connectDMWS();
    const ws = runtime.sockets[0];

    expect(first).toMatchObject({ status: 'connecting', reconnectRecommended: false });
    expect(runtime.setTimeoutCalls).toHaveLength(0);

    ws.readyState = runtime.WebSocket.OPEN;
    ws.onopen();
    expect(runtime.bridge.getDMConnectionState()).toMatchObject({
      status: 'connected',
      reconnectRecommended: false,
    });

    const disconnected = runtime.bridge.disconnectDMWS();
    expect(disconnected).toMatchObject({
      status: 'disconnected',
      reconnectRecommended: false,
      lastCloseReason: 'manual_disconnect',
    });
    expect(ws.closeArgs).toEqual({ code: 1000, reason: 'manual_disconnect' });

    ws.onclose({ code: 1000, reason: 'manual_disconnect' });
    expect(runtime.bridge.getDMConnectionState()).toMatchObject({
      status: 'disconnected',
      reconnectRecommended: false,
      lastCloseReason: 'manual_disconnect',
    });
    expect(runtime.setTimeoutCalls).toHaveLength(0);
  });

  it('resets the manual disconnect marker so unexpected closes recommend reconnect', async () => {
    const runtime = loadUserscriptDmRuntime();

    await runtime.bridge.connectDMWS();
    const ws1 = runtime.sockets[0];
    ws1.readyState = runtime.WebSocket.OPEN;
    ws1.onopen();
    runtime.bridge.disconnectDMWS();
    ws1.onclose({ code: 1000, reason: 'manual_disconnect' });

    const reconnecting = await runtime.bridge.connectDMWS();
    const ws2 = runtime.sockets[1];
    ws2.readyState = runtime.WebSocket.OPEN;
    ws2.onopen();
    ws2.onclose({ code: 1006, reason: 'network' });

    expect(reconnecting).toMatchObject({ status: 'connecting', reconnectRecommended: false });
    expect(runtime.bridge.getDMConnectionState()).toMatchObject({
      status: 'disconnected',
      reconnectRecommended: true,
      lastCloseCode: 1006,
      lastCloseReason: 'network',
    });
    expect(runtime.setTimeoutCalls).toHaveLength(0);
  });

  it('ignores stale socket callbacks after a newer websocket becomes current', async () => {
    const runtime = loadUserscriptDmRuntime();

    await runtime.bridge.connectDMWS();
    const ws1 = runtime.sockets[0];
    ws1.readyState = runtime.WebSocket.OPEN;
    ws1.onopen();

    ws1.readyState = runtime.WebSocket.CLOSED;
    await runtime.bridge.connectDMWS();
    const ws2 = runtime.sockets[1];
    ws2.readyState = runtime.WebSocket.OPEN;
    ws2.onopen();

    const before = runtime.bridge.getDMConnectionState();
    ws1.onclose({ code: 1006, reason: 'stale-close' });
    ws1.onerror({ message: 'stale-error' });
    ws1.onmessage({
      data: {
        payloadType: 'pb',
        payload: {
          body: {
            new_message_notify: {
              message: {
                sender: 'old-socket',
                conversation_id: 'conv-old',
                message_type: 7,
                content: 'ignore me',
                index_in_conversation: '1',
                server_message_id: 'server-old',
              },
            },
          },
        },
      },
    });

    expect(runtime.bridge.getDMConnectionState()).toMatchObject(before);
    expect(runtime.context.window.__dmQueue).toEqual([]);
    expect(runtime.bridge.getDMConnectionState()).toMatchObject({
      status: 'connected',
      reconnectRecommended: false,
      lastError: '',
    });
  });
});

describe('manual inbox replies through the persistent worker', () => {
  let dir;
  let db;
  let account;
  let conversation;
  let server;
  let baseUrl;

  async function backendRequest(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `request failed: ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  }

  async function createManualReply(text = 'manual reply', conversationId = conversation.id, body = {}) {
    return backendRequest(`/api/dm/conversations/${encodeURIComponent(conversationId)}/replies`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.id, text, mode: 'manual', ...body }),
    });
  }

  function createWorker(overrides = {}) {
    return createDmWorker({
      backendRequest,
      getMainWindow: () => ({ isDestroyed: () => false }),
      getAccount: async (accountId) => {
        const rows = await backendRequest('/api/accounts');
        return rows.find((row) => row.id === accountId) || null;
      },
      ensureBackgroundAccountView: async () => ({ ok: true }),
      executeInAccountView: async () => ({ status_code: 0, message_id: 'platform-message-1' }),
      pollIntervalMs: 60_000,
      writeLeaseTtlMs: 120,
      writeLeaseHeartbeatMs: 30,
      logger: { warn() {}, error() {}, info() {} },
      ...overrides,
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-manual-workflow-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: 'Account A', status: 'enabled' });
    inbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{
        conversation_id: 'conversation-platform-1',
        conversation_short_id: 'short-1',
        ticket: 'ticket-1',
        index: '1',
        sender: 'peer-1',
        peer_name: 'Peer One',
        content: 'hello',
        timestamp: 1000,
      }],
    });
    conversation = inbox.getConversationByPlatformId(db, account.id, 'conversation-platform-1');
    server = createDesktopApiServer({ db });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomically persists a pending outbound message, enqueues manual send, and cancels pending auto sends', async () => {
    const automaticMessages = ['automatic reply one', 'automatic reply two'].map((content, index) => {
      const pending = inbox.createPendingOutboundMessage(db, {
        accountId: account.id,
        conversationId: conversation.id,
        content,
        mode: 'automatic',
      });
      queue.enqueueWork(db, {
        type: 'send_auto',
        accountId: account.id,
        conversationId: conversation.id,
        messageId: pending.message.id,
        dedupeKey: `auto-before-human-${index}`,
        payload: { text: content },
      });
      return pending.message;
    });

    const response = await createManualReply('human answer');

    expect(response.message).toMatchObject({
      accountId: account.id,
      conversationId: conversation.id,
      direction: 'outbound',
      content: 'human answer',
      status: 'pending',
    });
    expect(response.workItem).toMatchObject({
      accountId: account.id,
      conversationId: conversation.id,
      messageId: response.message.id,
      type: 'send_manual',
      status: 'pending',
    });
    const autoStatuses = db.prepare("SELECT status FROM dm_work_items WHERE type = 'send_auto'").all();
    expect(autoStatuses).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(automaticMessages.map((message) => inbox.getMessage(db, message.id).status))
      .toEqual(['cancelled', 'cancelled']);
  });

  it.each([
    [{ text: '', mode: 'manual' }, /text is required/i],
    [{ text: 'x'.repeat(501), mode: 'manual' }, /500 characters/i],
    [{ text: 'hello', mode: 'automatic' }, /mode must be manual/i],
    [{ text: 'hello', mode: 'manual', unexpected: true }, /unknown reply fields/i],
  ])('rejects invalid manual reply input %#', async (body, message) => {
    const response = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, ...body }),
    });
    const result = await response.json();
    expect(response.status).toBe(400);
    expect(result.error).toMatch(message);
  });

  it('sends through the exact account view with JSON-safe arguments and completes message state', async () => {
    const created = await createManualReply(`quote ' and \\ slash`);
    const executions = [];
    const worker = createWorker({
      executeInAccountView: async (accountId, expression) => {
        executions.push({ accountId, expression });
        return { status_code: 0, message_id: 'platform-message-success' };
      },
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('success');
    expect(executions).toHaveLength(1);
    expect(executions[0].accountId).toBe(account.id);
    expect(executions[0].expression).toContain('bridge.createConversation');
    expect(executions[0].expression).toContain('bridge.sendDM');
    expect(executions[0].expression).toContain(JSON.stringify('conversation-platform-1|short-1|ticket-1'));
    expect(executions[0].expression).toContain(JSON.stringify(`quote ' and \\ slash`));
    let message = inbox.listMessages(db, conversation.id).find((item) => item.id === created.message.id);
    expect(message.status).toBe('accepted');
    expect(inbox.getConversation(db, conversation.id).lastMessageText).toBe('hello');

    inbox.updateMonitorState(db, account.id, { platformUserId: 'self-platform-id' });
    inbox.ingestMessages(db, {
      accountId: account.id,
      selfPlatformId: 'self-platform-id',
      messages: [{
        conversation_id: 'conversation-platform-1',
        conversation_short_id: 'short-1',
        ticket: 'ticket-1',
        index: '2',
        sender: 'self-platform-id',
        content: `quote ' and \\ slash`,
        timestamp: Date.now(),
      }],
    });
    message = inbox.listMessages(db, conversation.id).find((item) => item.id === created.message.id);
    expect(message.status).toBe('sent');
    expect(inbox.getConversation(db, conversation.id).lastMessageText).toBe(`quote ' and \\ slash`);
  });

  it('reuses an existing complete conversation ticket without creating a new conversation', async () => {
    const calls = [];
    const expression = buildSendExpression('existing-conversation|123|existing-ticket', 'hello', 'peer-1');
    const result = await vm.runInNewContext(expression, {
      window: {
        __bridge: {
          createConversation: async () => calls.push('createConversation'),
          getConversationInfo: async () => calls.push('getConversationInfo'),
          sendDM: async (conversationKey, text) => {
            calls.push(['sendDM', conversationKey, text]);
            return { status_code: 0 };
          },
        },
      },
    });

    expect(calls).toEqual([
      ['sendDM', 'existing-conversation|123|existing-ticket', 'hello'],
    ]);
    expect(result.__dmSendOutcome).toBe('platform_response');
  });

  it('refreshes a missing ticket through conversation info and returns a JSON-safe result', async () => {
    const calls = [];
    const expression = buildSendExpression('old-conversation|old-short|', 'hello', 'peer-1');
    const result = await vm.runInNewContext(expression, {
      window: {
        __bridge: {
          getConversationInfo: async (conversationId, conversationShortId) => {
            calls.push(['getConversationInfo', conversationId, conversationShortId]);
            return {
              conversation_id: 'fresh-conversation',
              conversation_short_id: 123n,
              ticket: 'fresh-ticket',
            };
          },
          sendDM: async (conversationKey, text) => {
            calls.push(['sendDM', conversationKey, text]);
            return { status_code: 0n, server_message_id: 456n };
          },
        },
      },
    });

    expect(calls).toEqual([
      ['getConversationInfo', 'old-conversation', 'old-short'],
      ['sendDM', 'fresh-conversation|123|fresh-ticket', 'hello'],
    ]);
    expect(result).toEqual({
      __dmSendOutcome: 'platform_response',
      result: { status_code: '0', server_message_id: '456' },
    });
  });

  it('reports conversation-info failures as preflight errors before any send attempt', async () => {
    const calls = [];
    const expression = buildSendExpression('old-conversation|old-short|', 'hello', 'peer-1');
    const result = await vm.runInNewContext(expression, {
      window: {
        __bridge: {
          getConversationInfo: async () => {
            calls.push('get-info');
            throw new Error('conversation response could not be decoded');
          },
          sendDM: async () => calls.push('send'),
        },
      },
    });

    expect(calls).toEqual(['get-info']);
    expect(result).toEqual({
      __dmSendOutcome: 'preflight_error',
      error: 'conversation response could not be decoded',
    });
  });

  it('resolves a new conversation through createConversation and returns a JSON-safe result', async () => {
    const calls = [];
    const expression = buildSendExpression('old-conversation|old-short|', '你好', 'peer-1');
    const result = await vm.runInNewContext(expression, {
      window: {
        __bridge: {
          createConversation: async (peerId) => {
            calls.push(['createConversation', peerId]);
            return {
              conversation_id: 'fresh-conversation',
              conversation_short_id: 123n,
              ticket: 'fresh-ticket',
            };
          },
          sendDM: async (conversationKey, text) => {
            calls.push(['sendDM', conversationKey, text]);
            return { status_code: 0n, server_message_id: 456n };
          },
        },
      },
    });

    expect(calls).toEqual([
      ['createConversation', 'peer-1'],
      ['sendDM', 'fresh-conversation|123|fresh-ticket', '你好'],
    ]);
    expect(result).toEqual({
      __dmSendOutcome: 'platform_response',
      result: { status_code: '0', server_message_id: '456' },
    });
  });

  it('reports create-conversation failures as preflight errors before any send attempt', async () => {
    const calls = [];
    const expression = buildSendExpression('old-conversation|old-short|', 'hello', 'peer-1');
    const result = await vm.runInNewContext(expression, {
      window: {
        __bridge: {
          createConversation: async () => {
            calls.push('create');
            throw new Error('conversation response could not be decoded');
          },
          sendDM: async () => calls.push('send'),
        },
      },
    });

    expect(calls).toEqual(['create']);
    expect(result).toEqual({
      __dmSendOutcome: 'preflight_error',
      error: 'conversation response could not be decoded',
    });
  });

  it('does not mark a create-conversation failure as possibly sent', async () => {
    const created = await createManualReply('preflight failure');
    const worker = createWorker({
      executeInAccountView: async () => ({
        __dmSendOutcome: 'preflight_error',
        error: '[createConversation] response did not contain a conversation',
      }),
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/createConversation/);
    expect(inbox.getMessage(db, created.message.id).status).toBe('failed');
  });

  it('normalizes BigInt fields returned by the page before persisting send success', async () => {
    const created = await createManualReply('BigInt response');
    const worker = createWorker({
      executeInAccountView: async () => ({ status_code: 0n, server_message_id: 789n }),
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('success');
    expect(inbox.getMessage(db, created.message.id).status).toBe('accepted');
    expect(queue.getWork(db, created.workItem.id).result).toMatchObject({
      status_code: '0',
      server_message_id: '789',
    });
  });

  it('treats the runtime online account state as logged in when sending', async () => {
    const created = await createManualReply('send while online');
    accounts.updateAccount(db, account.id, { status: 'online' });
    let calls = 0;
    const worker = createWorker({
      executeInAccountView: async () => {
        calls += 1;
        return { status_code: 0, message_id: 'platform-online-message' };
      },
    });

    const result = await worker.runOnce();

    expect(calls).toBe(1);
    expect(result.status).toBe('success');
    expect(inbox.getMessage(db, created.message.id).status).toBe('accepted');
  });

  it('marks uncertain execution outcomes for confirmation and never schedules an automatic retry', async () => {
    const created = await createManualReply('possibly delivered');
    const worker = createWorker({
      executeInAccountView: async () => {
        throw Object.assign(new Error('IPC timed out after execution started'), { code: 'ETIMEDOUT' });
      },
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('needs_confirmation');
    const work = db.prepare('SELECT status, next_run_at FROM dm_work_items WHERE id = ?').get(created.workItem.id);
    expect(work).toEqual({ status: 'needs_confirmation', next_run_at: null });
    const message = inbox.listMessages(db, conversation.id).find((item) => item.id === created.message.id);
    expect(message.status).toBe('needs_confirmation');
    expect(await worker.runOnce()).toMatchObject({ status: 'idle' });
  });

  it('treats an empty platform response as uncertain instead of reporting a false success', async () => {
    const created = await createManualReply('response was lost');
    const worker = createWorker({ executeInAccountView: async () => undefined });

    const result = await worker.runOnce();

    expect(result.status).toBe('needs_confirmation');
    expect(inbox.getMessage(db, created.message.id).status).toBe('needs_confirmation');
  });

  it('marks a timed-out execution uncertain but keeps serialization until the page action settles', async () => {
    const created = await createManualReply('slow request');
    let actionSettled = false;
    const worker = createWorker({
      executionTimeoutMs: 20,
      executeInAccountView: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        actionSettled = true;
        return { status_code: 0, message_id: 'late-success' };
      },
    });

    const startedAt = Date.now();
    const result = await worker.runOnce();

    expect(result.status).toBe('needs_confirmation');
    expect(actionSettled).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(inbox.getMessage(db, created.message.id).status).toBe('needs_confirmation');
  });

  it('retries only an explicit platform rejection with the persistent backoff schedule', async () => {
    const created = await createManualReply('retry explicit rejection');
    const worker = createWorker({
      executeInAccountView: async () => ({ status_code: 5, status_message: 'rejected' }),
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('pending');
    const work = db.prepare('SELECT status, attempt_count, next_run_at, error FROM dm_work_items WHERE id = ?')
      .get(created.workItem.id);
    expect(work.status).toBe('pending');
    expect(work.attempt_count).toBe(1);
    expect(work.next_run_at).toBeTruthy();
    expect(work.error).toMatch(/status_code=5/i);
  });

  it('treats the original bridge error_desc response as an explicit platform rejection', async () => {
    const created = await createManualReply('retry decoded rejection');
    const worker = createWorker({
      executeInAccountView: async () => ({ cmd: 100, error_desc: 'request rejected by platform' }),
    });

    const result = await worker.runOnce();

    expect(result.status).toBe('pending');
    expect(queue.getWork(db, created.workItem.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
    expect(inbox.getMessage(db, created.message.id).status).toBe('pending');
  });

  it('fails safely before execution when the account needs login', async () => {
    const created = await createManualReply('do not execute');
    accounts.updateAccount(db, account.id, { status: 'login_required' });
    let calls = 0;
    const worker = createWorker({
      executeInAccountView: async () => {
        calls += 1;
        return { status_code: 0 };
      },
    });

    const result = await worker.runOnce();

    expect(calls).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/login|登录/i);
    const message = inbox.listMessages(db, conversation.id).find((item) => item.id === created.message.id);
    expect(message.status).toBe('failed');
  });

  it('prevents runOnce re-entry and renews the global write lease while sending', async () => {
    await createManualReply('first serial send');
    await createManualReply('second serial send');
    let releaseExecution;
    let executions = 0;
    const worker = createWorker({
      executeInAccountView: async () => {
        executions += 1;
        if (executions > 1) {
          return { status_code: 0, message_id: `message-${executions}` };
        }
        return new Promise((resolve) => {
          releaseExecution = () => resolve({ status_code: 0, message_id: `message-${executions}` });
        });
      },
    });

    const firstRun = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const secondRun = await worker.runOnce();
    const blockedLease = await backendRequest('/api/operations/write-lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ owner: 'another-writer', ttlMs: 120 }),
    });

    expect(secondRun).toMatchObject({ status: 'busy' });
    expect(executions).toBe(1);
    expect(blockedLease.acquired).toBe(false);
    releaseExecution();
    await expect(firstRun).resolves.toMatchObject({ status: 'success' });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'success' });
    expect(executions).toBe(2);
  });

  it('waits for active work to settle before stop resolves', async () => {
    await createManualReply('finish before shutdown');
    let releaseExecution;
    const worker = createWorker({
      executeInAccountView: async () => new Promise((resolve) => {
        releaseExecution = () => resolve({ status_code: 0, message_id: 'shutdown-safe' });
      }),
    });

    const activeRun = worker.runOnce();
    await vi.waitFor(() => expect(releaseExecution).toBeTypeOf('function'));
    let stopSettled = false;
    const stopping = worker.stop().then((result) => {
      stopSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseExecution();
    await expect(activeRun).resolves.toMatchObject({ status: 'success' });
    await expect(stopping).resolves.toMatchObject({ ok: true, stopped: true });
    expect(worker.getStatus()).toMatchObject({ running: false, active: false });
  });

  it('stops scheduled work with a generation guard and unref timers', async () => {
    const timers = [];
    const worker = createWorker({
      setTimeoutFn: (callback, delay) => {
        const timer = { callback, delay, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: vi.fn(),
    });

    await worker.start();
    expect(timers[0].unref).toHaveBeenCalled();
    await worker.stop();
    await timers[0].callback();
    expect(worker.getStatus()).toMatchObject({ running: false, active: false });
  });

});
