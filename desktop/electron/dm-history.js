const HISTORY_REASON_MAX_LENGTH = 160;
const MALFORMED_HISTORY_REASON = '\u5386\u53f2\u79c1\u4fe1\u80fd\u529b\u8fd4\u56de\u683c\u5f0f\u5f02\u5e38\uff0c\u6682\u4ec5\u652f\u6301\u5b9e\u65f6\u76d1\u542c';
const UNSUPPORTED_HISTORY_REASON = '\u5f53\u524d\u9875\u9762\u80fd\u529b\u672a\u9a8c\u8bc1\uff0c\u6682\u4ec5\u652f\u6301\u5b9e\u65f6\u76d1\u542c';

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
