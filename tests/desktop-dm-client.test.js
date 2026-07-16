const { EventEmitter } = require('events');

const {
  buildDmWebSocketConfig,
  computeAccessKey,
  createDmClientManager,
} = require('../desktop/electron/dm-client');

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols, options) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
}
FakeWebSocket.instances = [];

function account(id) {
  return { id, name: `account-${id}`, profileKey: `profile-${id}` };
}

describe('Electron account DM client', () => {
  it('builds the authenticated Douyin PC websocket handshake without exposing credentials in public state', async () => {
    FakeWebSocket.instances = [];
    const manager = createDmClientManager({
      WebSocketImpl: FakeWebSocket,
      getAccountCookies: vi.fn(async () => [
        { name: 'sessionid', value: 'session-secret' },
        { name: 'sid_guard', value: 'guard-secret' },
      ]),
      getDeviceId: vi.fn(async () => 'device-123'),
      decodeFrame: vi.fn(() => []),
    });

    const state = await manager.connect(account('a'));
    const socket = FakeWebSocket.instances[0];
    const url = new URL(socket.url);

    expect(url.origin).toBe('wss://frontier-im.douyin.com');
    expect(url.searchParams.get('aid')).toBe('6383');
    expect(url.searchParams.get('device_platform')).toBe('douyin_pc');
    expect(url.searchParams.get('fpid')).toBe('9');
    expect(url.searchParams.get('device_id')).toBe('device-123');
    expect(url.searchParams.get('token')).toBe('session-secret');
    expect(url.searchParams.get('access_key')).toBe(computeAccessKey('device-123'));
    expect(socket.protocols).toEqual(['binary', 'base64', 'pbbp2']);
    expect(socket.options.headers).toMatchObject({
      Cookie: 'sessionid=session-secret; sid_guard=guard-secret',
      Origin: 'https://www.douyin.com',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    });
    expect(JSON.stringify(state)).not.toContain('session-secret');
    expect(JSON.stringify(manager.getStatus())).not.toContain('session-secret');
  });

  it('keeps sockets and queues isolated by account and drains normalized messages', async () => {
    FakeWebSocket.instances = [];
    const manager = createDmClientManager({
      WebSocketImpl: FakeWebSocket,
      getAccountCookies: async (value) => [{ name: 'sessionid', value: `token-${value.id}` }],
      getDeviceId: async (value) => `device-${value.id}`,
      decodeFrame: (buffer) => [{
        conversation_id: `conversation-${buffer.toString()}`,
        sender: 'peer-1',
        message_type: 7,
        content: 'hello',
        index: '3',
      }],
    });

    await manager.connect(account('a'));
    await manager.connect(account('b'));
    const [socketA, socketB] = FakeWebSocket.instances;
    socketA.open();
    socketB.open();
    socketA.emit('message', Buffer.from('a'));

    const resultA = await manager.poll(account('a'), 20);
    const resultB = await manager.poll(account('b'), 0);

    expect(resultA.messages).toEqual([expect.objectContaining({ conversation_id: 'conversation-a' })]);
    expect(resultB.messages).toEqual([]);
    expect(manager.getStatus().accounts).toHaveLength(2);

    await manager.disconnect('a');
    expect(manager.getStatus().accounts.find((item) => item.accountId === 'a')).toMatchObject({
      status: 'disconnected',
      connected: false,
    });
    expect(manager.getStatus().accounts.find((item) => item.accountId === 'b')).toMatchObject({
      status: 'connected',
      connected: true,
    });
  });

  it('keeps the logged-in Douyin user id with polled messages', async () => {
    FakeWebSocket.instances = [];
    const getAccountUserId = vi.fn(async (value) => `douyin-user-${value.id}`);
    const manager = createDmClientManager({
      WebSocketImpl: FakeWebSocket,
      getAccountCookies: async (value) => [{ name: 'sessionid', value: `token-${value.id}` }],
      getDeviceId: async (value) => `device-${value.id}`,
      getAccountUserId,
      decodeFrame: () => [{
        conversation_id: '0:1:peer-a:douyin-user-a',
        sender: 'douyin-user-a',
        message_type: 7,
        content: 'sent from another Douyin client',
        index: '4',
      }],
    });

    await manager.connect(account('a'));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.emit('message', Buffer.from('outbound'));

    const result = await manager.poll(account('a'), 0);
    expect(getAccountUserId).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(result).toMatchObject({
      selfPlatformId: 'douyin-user-a',
      connection: { selfPlatformId: 'douyin-user-a' },
    });
  });

  it('reports a login-required error when the isolated account session has no session cookie', async () => {
    const manager = createDmClientManager({
      WebSocketImpl: FakeWebSocket,
      getAccountCookies: async () => [],
      getDeviceId: async () => 'device-a',
      decodeFrame: () => [],
    });

    await expect(manager.connect(account('a'))).rejects.toMatchObject({ code: 'login_required' });
  });

  it('redacts credentials even when a websocket implementation includes them in an error', async () => {
    FakeWebSocket.instances = [];
    const manager = createDmClientManager({
      WebSocketImpl: FakeWebSocket,
      getAccountCookies: async () => [{ name: 'sessionid', value: 'session-secret' }],
      getDeviceId: async () => 'device-a',
      decodeFrame: () => [],
      logger: { warn: vi.fn() },
    });

    await manager.connect(account('a'));
    FakeWebSocket.instances[0].emit(
      'error',
      new Error('failed wss://frontier-im.douyin.com/ws/v2?token=session-secret&access_key=key-secret; sessionid=session-secret'),
    );

    const serialized = JSON.stringify(manager.getStatus());
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('key-secret');
    expect(serialized).toContain('[redacted]');
  });

  it('constructs a deterministic access key and validates required handshake inputs', () => {
    expect(computeAccessKey('device-123')).toMatch(/^[a-f0-9]{32}$/);
    expect(() => buildDmWebSocketConfig({ deviceId: '', sessionToken: 'token', cookieHeader: 'x=1' }))
      .toThrow(/device id/i);
    expect(() => buildDmWebSocketConfig({ deviceId: 'device', sessionToken: '', cookieHeader: 'x=1' }))
      .toThrow(/session/i);
  });
});
