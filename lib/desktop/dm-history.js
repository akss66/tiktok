const HISTORY_REASON_MAX_LENGTH = 160;
const MALFORMED_HISTORY_REASON = '历史私信能力返回格式异常，暂仅支持实时监听';
const UNSUPPORTED_HISTORY_REASON = '当前页面能力未验证，暂仅支持实时监听';

function safeReason(value, fallback = UNSUPPORTED_HISTORY_REASON) {
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  return source
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HISTORY_REASON_MAX_LENGTH) || fallback;
}

function unsupportedHistoryPage(reason) {
  return {
    supported: false,
    messages: [],
    nextCursor: null,
    hasMore: false,
    incompleteReason: safeReason(reason),
  };
}

function normalizeHistoryPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unsupportedHistoryPage(MALFORMED_HISTORY_REASON);
  }
  if (value.supported !== true) {
    return unsupportedHistoryPage(value.reason || value.incompleteReason);
  }

  const hasMore = typeof value.hasMore === 'boolean'
    ? value.hasMore
    : typeof value.has_more === 'boolean'
      ? value.has_more
      : null;
  const messages = value.messages;
  const nextCursorValue = value.nextCursor !== undefined ? value.nextCursor : value.next_cursor;
  const nextCursor = nextCursorValue === undefined || nextCursorValue === null
    ? null
    : String(nextCursorValue).trim() || null;

  if (
    !Array.isArray(messages)
    || messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message))
    || hasMore === null
    || (hasMore && !nextCursor)
  ) {
    return unsupportedHistoryPage(MALFORMED_HISTORY_REASON);
  }

  return {
    supported: true,
    messages: [...messages],
    nextCursor,
    hasMore,
    incompleteReason: value.incompleteReason || value.reason
      ? safeReason(value.incompleteReason || value.reason)
      : null,
  };
}

module.exports = {
  HISTORY_REASON_MAX_LENGTH,
  MALFORMED_HISTORY_REASON,
  UNSUPPORTED_HISTORY_REASON,
  normalizeHistoryPage,
};
