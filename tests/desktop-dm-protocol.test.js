const { decodeDmPushFrame } = require('../desktop/electron/dm-protocol');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let next = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) next |= 0x80;
    bytes.push(next);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function scalar(fieldNumber, value) {
  return Buffer.concat([varint(BigInt(fieldNumber) << 3n), varint(value)]);
}

function bytes(fieldNumber, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([
    varint((BigInt(fieldNumber) << 3n) | 2n),
    varint(payload.length),
    payload,
  ]);
}

function fixturePushFrame(options = {}) {
  const content = options.content || JSON.stringify({ text: 'hello' });
  const messageType = options.messageType || 7;
  const message = Buffer.concat([
    bytes(1, 'conversation-1'),
    scalar(3, 90210),
    scalar(4, 7),
    scalar(5, 8001),
    scalar(6, messageType),
    scalar(7, 12345),
    bytes(8, content),
  ]);
  const notify = bytes(5, message);
  const responseBody = bytes(500, notify);
  const response = bytes(6, responseBody);
  return Buffer.concat([bytes(7, 'pb'), bytes(8, response)]);
}

describe('Electron DM protocol decoder', () => {
  it('decodes and normalizes a new-message PushFrame', () => {
    const messages = decodeDmPushFrame(fixturePushFrame(), { now: () => 1700000000000 });

    expect(messages).toEqual([{
      conversation_id: 'conversation-1',
      conversation_short_id: '8001',
      sender: '12345',
      message_type: 7,
      content: 'hello',
      server_message_id: '90210',
      message_id: '90210',
      index_in_conversation: '7',
      index: '7',
      timestamp: 1700000000000,
    }]);
  });

  it('ignores non-protobuf and protobuf responses without a new message', () => {
    expect(decodeDmPushFrame(bytes(7, 'json'))).toEqual([]);
    expect(decodeDmPushFrame(Buffer.concat([bytes(7, 'pb'), bytes(8, bytes(1, 'noop'))])))
      .toEqual([]);
  });

  it('ignores read-badge and other system command notifications', () => {
    const command = JSON.stringify({
      command_type: 14,
      conversation_id: 'conversation-1',
      read_badge_count: 6,
      read_index_v2: 8,
    });

    expect(decodeDmPushFrame(fixturePushFrame({ content: command }))).toEqual([]);
    expect(decodeDmPushFrame(fixturePushFrame({ messageType: 50001 }))).toEqual([]);
  });

  it('rejects malformed or oversized frames with a controlled protocol error', () => {
    expect(() => decodeDmPushFrame(Buffer.from([0x3a, 0x80])))
      .toThrow(expect.objectContaining({ code: 'DM_PROTOCOL_DECODE_ERROR' }));
    expect(() => decodeDmPushFrame(Buffer.alloc((8 * 1024 * 1024) + 1)))
      .toThrow(expect.objectContaining({ code: 'DM_PROTOCOL_DECODE_ERROR' }));
  });
});
