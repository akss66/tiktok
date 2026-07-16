const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FIELDS_PER_MESSAGE = 10000;

function protocolError(message, cause) {
  const error = new Error(`Unable to decode private-message frame: ${message}`);
  error.code = 'DM_PROTOCOL_DECODE_ERROR';
  if (cause) error.cause = cause;
  return error;
}

function readVarint(buffer, start) {
  let value = 0n;
  let position = start;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    if (position >= buffer.length) {
      throw protocolError('truncated varint');
    }
    const byte = buffer[position];
    position += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, position };
    }
  }
  throw protocolError('varint exceeds 64 bits');
}

function decodeFields(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const fields = [];
  let position = 0;
  while (position < buffer.length) {
    if (fields.length >= MAX_FIELDS_PER_MESSAGE) {
      throw protocolError('too many protobuf fields');
    }
    const tag = readVarint(buffer, position);
    position = tag.position;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!fieldNumber) throw protocolError('invalid protobuf field number');

    let value;
    if (wireType === 0) {
      const decoded = readVarint(buffer, position);
      value = decoded.value;
      position = decoded.position;
    } else if (wireType === 1) {
      if (position + 8 > buffer.length) throw protocolError('truncated fixed64 field');
      value = buffer.subarray(position, position + 8);
      position += 8;
    } else if (wireType === 2) {
      const decodedLength = readVarint(buffer, position);
      position = decodedLength.position;
      if (decodedLength.value > BigInt(buffer.length - position)) {
        throw protocolError('truncated length-delimited field');
      }
      const length = Number(decodedLength.value);
      value = buffer.subarray(position, position + length);
      position += length;
    } else if (wireType === 5) {
      if (position + 4 > buffer.length) throw protocolError('truncated fixed32 field');
      value = buffer.subarray(position, position + 4);
      position += 4;
    } else {
      throw protocolError(`unsupported protobuf wire type ${wireType}`);
    }
    fields.push({ fieldNumber, wireType, value });
  }
  return fields;
}

function firstField(fields, fieldNumber, wireType) {
  return fields.find((field) => field.fieldNumber === fieldNumber
    && (wireType === undefined || field.wireType === wireType));
}

function textValue(field) {
  return field?.wireType === 2 ? field.value.toString('utf8') : '';
}

function integerText(field) {
  return field?.wireType === 0 ? field.value.toString() : '';
}

function integerNumber(field) {
  return field?.wireType === 0 ? Number(field.value) : 0;
}

function decodeMessage(input, now) {
  const fields = decodeFields(input);
  const rawContent = textValue(firstField(fields, 8, 2));
  const messageType = integerNumber(firstField(fields, 6, 0));
  let content = rawContent;
  let parsedContent = null;
  if (rawContent) {
    try {
      parsedContent = JSON.parse(rawContent);
      if (parsedContent && typeof parsedContent === 'object' && typeof parsedContent.text === 'string') {
        content = parsedContent.text;
      }
    } catch {
      // Plain-text message bodies are valid and need no conversion.
    }
  }
  if (
    messageType === 50001
    || (
      parsedContent
      && typeof parsedContent === 'object'
      && parsedContent.command_type !== undefined
      && typeof parsedContent.text !== 'string'
    )
  ) {
    return null;
  }
  const serverMessageId = integerText(firstField(fields, 3, 0));
  const messageIndex = integerText(firstField(fields, 4, 0));
  return {
    conversation_id: textValue(firstField(fields, 1, 2)),
    conversation_short_id: integerText(firstField(fields, 5, 0)),
    sender: integerText(firstField(fields, 7, 0)),
    message_type: messageType,
    content,
    server_message_id: serverMessageId,
    message_id: serverMessageId,
    index_in_conversation: messageIndex,
    index: messageIndex,
    timestamp: now(),
  };
}

function decodeDmPushFrame(input, { now = () => Date.now() } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length > MAX_FRAME_BYTES) {
    throw protocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  try {
    const pushFields = decodeFields(buffer);
    if (textValue(firstField(pushFields, 7, 2)) !== 'pb') return [];
    const payload = firstField(pushFields, 8, 2);
    if (!payload) return [];

    const responseFields = decodeFields(payload.value);
    const responseBody = firstField(responseFields, 6, 2);
    if (!responseBody) return [];
    const bodyFields = decodeFields(responseBody.value);
    const notify = firstField(bodyFields, 500, 2);
    if (!notify) return [];
    const notifyFields = decodeFields(notify.value);
    const message = firstField(notifyFields, 5, 2);
    if (!message) return [];

    const normalized = decodeMessage(message.value, now);
    return normalized?.conversation_id ? [normalized] : [];
  } catch (error) {
    if (error?.code === 'DM_PROTOCOL_DECODE_ERROR') throw error;
    throw protocolError(error?.message || 'unknown protocol error', error);
  }
}

module.exports = {
  MAX_FRAME_BYTES,
  decodeDmPushFrame,
};
