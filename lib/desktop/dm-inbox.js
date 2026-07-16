const crypto = require('crypto');

const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

const EDITABLE_CONVERSATION_FIELDS = new Map([
  ['peerId', 'peer_id'],
  ['peerName', 'peer_name'],
  ['status', 'status'],
  ['autoReplyEnabled', 'auto_reply_enabled'],
  ['replyModeOverride', 'reply_mode_override'],
]);

const SUPPORTED_REPLY_MODE_OVERRIDES = new Set(['manual', 'tiered', 'automatic']);
const SUPPORTED_MONITOR_SETTING_SOURCES = new Set(['inherited', 'explicit']);
const SUPPORTED_HISTORY_STATUSES = new Set(['available', 'realtime_only', 'syncing', 'complete', 'incomplete']);
const UNVERIFIED_HISTORY_STATUSES = new Set(['realtime_only', 'incomplete']);
const SOURCE_COMMENT_MAX_LENGTH = 500;
const CONVERSATION_SELECT = `
  SELECT dm_conversations.*,
    (
      SELECT comments.text
      FROM dm_leads
      INNER JOIN dm_lead_sources ON dm_lead_sources.lead_id = dm_leads.id
      INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
      WHERE dm_leads.account_id = dm_conversations.account_id
        AND dm_leads.conversation_id = dm_conversations.conversation_id
      ORDER BY dm_lead_sources.created_at DESC, comments.created_at DESC, comments.cid DESC
      LIMIT 1
    ) AS source_comment
  FROM dm_conversations
`;

function bool(value) {
  return value ? 1 : 0;
}

function normalizeReplyModeOverride(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('replyModeOverride must be null, manual, tiered, or automatic');
  }
  if (!SUPPORTED_REPLY_MODE_OVERRIDES.has(value)) {
    throw new Error('replyModeOverride must be null, manual, tiered, or automatic');
  }
  return value;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return Date.now();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return Math.round(numeric);
}

function defaultMonitorState(accountId) {
  return {
    accountId,
    platformUserId: '',
    cursor: '',
    status: 'idle',
    lastError: null,
    enabled: false,
    settingSource: 'inherited',
    replyModeOverride: null,
    historyStatus: 'realtime_only',
    historyIncompleteReason: null,
    createdAt: null,
    updatedAt: null,
  };
}

function mapMonitorState(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    platformUserId: row.platform_user_id || '',
    cursor: row.cursor,
    status: row.status,
    lastError: row.last_error,
    enabled: Boolean(row.enabled),
    settingSource: row.setting_source === 'explicit' ? 'explicit' : 'inherited',
    replyModeOverride: row.reply_mode_override || null,
    historyStatus: SUPPORTED_HISTORY_STATUSES.has(row.history_status) ? row.history_status : 'realtime_only',
    historyIncompleteReason: row.history_incomplete_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMonitorSettingSource(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SUPPORTED_MONITOR_SETTING_SOURCES.has(value)) {
    throw new Error('settingSource must be inherited or explicit');
  }
  return value;
}

function normalizeMonitorEnabled(value, settingSource) {
  if (value === undefined) return undefined;
  if (settingSource === 'inherited' && value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error('enabled must be a boolean for explicit settings');
  }
  return value;
}

function normalizeUnverifiedHistoryStatus(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SUPPORTED_HISTORY_STATUSES.has(value)) {
    throw new Error('historyStatus is invalid');
  }
  if (!UNVERIFIED_HISTORY_STATUSES.has(value)) {
    throw new Error('historyStatus cannot be available or complete without verified history support');
  }
  return value;
}

function normalizeHistoryIncompleteReason(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || null;
}

function mapConversation(row) {
  if (!row) return null;
  const sourceComment = typeof row.source_comment === 'string'
    ? row.source_comment.trim().slice(0, SOURCE_COMMENT_MAX_LENGTH)
    : '';
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    peerId: row.peer_id,
    peerName: row.peer_name,
    status: row.status,
    lastMessageId: row.last_message_id,
    lastMessageText: row.last_message_text,
    lastMessageAt: row.last_message_at === null || row.last_message_at === undefined
      ? null
      : Number(row.last_message_at),
    unreadCount: Number(row.unread_count || 0),
    lastReadAt: row.last_read_at,
    autoReplyEnabled: Boolean(row.auto_reply_enabled),
    autoReplyAuthorized: Boolean(row.auto_reply_authorized),
    autoReplyConsumedAt: row.auto_reply_consumed_at,
    replyModeOverride: row.reply_mode_override || null,
    sourceComment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_row_id,
    platformConversationId: row.conversation_id,
    messageKey: row.message_key,
    sender: row.sender,
    messageType: row.message_type,
    direction: row.direction,
    status: row.status || (row.direction === 'outbound' ? 'pending' : 'received'),
    peerName: row.peer_name || '',
    content: row.content,
    timestamp: Number(row.timestamp_ms),
    raw: parseJson(row.raw, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReplyDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    conversationRowId: row.conversation_row_id,
    content: row.content,
    status: row.status,
    meta: parseJson(row.meta, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    conversationRowId: row.conversation_row_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    messageId: row.message_id,
    status: row.status,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getConversationRow(db, id) {
  return db.prepare(`${CONVERSATION_SELECT} WHERE dm_conversations.id = ?`).get(id);
}

function getConversation(db, id) {
  return mapConversation(getConversationRow(db, id));
}

function getConversationByPlatformId(db, accountId, platformConversationId) {
  return mapConversation(db.prepare(`${CONVERSATION_SELECT}
    WHERE dm_conversations.account_id = ? AND dm_conversations.conversation_id = ?
  `).get(accountId, String(platformConversationId || '').trim()));
}

function getReplyDraftByConversation(db, conversationRowId) {
  return mapReplyDraft(db.prepare(`
    SELECT * FROM dm_reply_drafts WHERE conversation_row_id = ?
  `).get(conversationRowId));
}

function getMessageByIdentity(db, accountId, conversationId, messageKey) {
  return mapMessage(db.prepare(`
    SELECT dm_messages.*, dm_conversations.peer_name AS peer_name
    FROM dm_messages
    INNER JOIN dm_conversations ON dm_conversations.id = dm_messages.conversation_row_id
    WHERE dm_messages.account_id = ? AND dm_messages.conversation_id = ? AND dm_messages.message_key = ?
  `).get(accountId, conversationId, messageKey));
}

function getMessage(db, id) {
  return mapMessage(db.prepare(`
    SELECT dm_messages.*, dm_conversations.peer_name AS peer_name
    FROM dm_messages
    INNER JOIN dm_conversations ON dm_conversations.id = dm_messages.conversation_row_id
    WHERE dm_messages.id = ?
  `).get(id));
}

function getWorkItemByDedupe(db, conversationRowId, kind, dedupeKey) {
  return mapWorkItem(db.prepare(`
    SELECT * FROM dm_work_items
    WHERE conversation_row_id = ? AND kind = ? AND dedupe_key = ?
  `).get(conversationRowId, kind, dedupeKey));
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizePlatformUserId(value) {
  return String(value || '').trim().slice(0, 128);
}

function oneToOnePeerId(conversationId, selfPlatformId) {
  const selfId = normalizePlatformUserId(selfPlatformId);
  if (!selfId) return '';
  const parts = String(conversationId || '').trim().split(':');
  if (parts.length < 4 || parts[0] !== '0' || parts[1] !== '1') return '';
  const participants = parts.slice(-2).map((value) => value.trim()).filter(Boolean);
  if (participants.length !== 2 || !participants.includes(selfId)) return '';
  return participants.find((participant) => participant !== selfId) || '';
}

function isOutgoingMessage(message = {}, context = {}) {
  const explicitlyOutgoing = Boolean(
    message.isOutgoing
    || message.is_outgoing
    || message.outgoing
    || message.isSelf
    || message.is_self
    || message.from_self
    || message.sender_self
    || message.direction === 'outbound',
  );
  if (explicitlyOutgoing) return true;
  const sender = pickFirstNonEmpty(message.sender, message.sender_id, message.user_id);
  const selfPlatformId = pickFirstNonEmpty(
    message.selfPlatformId,
    message.self_platform_id,
    context.selfPlatformId,
    context.self_platform_id,
  );
  if (sender && selfPlatformId) return sender === selfPlatformId;
  const peerId = pickFirstNonEmpty(context.peerId, context.peer_id);
  return Boolean(sender && peerId && sender !== peerId);
}

function readMessageIndex(message = {}) {
  for (const field of ['index', 'message_index', 'messageIndex']) {
    if (!Object.prototype.hasOwnProperty.call(message, field)) continue;
    const value = message[field];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text === '') continue;
    return text;
  }
  return '';
}

function messageKey(message = {}) {
  const index = readMessageIndex(message);
  if (index) return `index:${index}`;
  const source = [
    String(message.sender || message.sender_id || message.user_id || '').trim(),
    String(message.conversation_id || message.conversationId || '').trim(),
    String(message.message_type || message.messageType || 'text').trim(),
    String(message.content || message.text || ''),
    Math.floor(normalizeTimestamp(message.timestamp || message.created_at || Date.now()) / 30000),
  ].join('|');
  return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

function normalizeMessage(message = {}, context = {}) {
  const conversationId = String(message.conversation_id || message.conversationId || '').trim();
  if (!conversationId) throw new Error('message conversation_id is required');
  const direction = isOutgoingMessage(message, context) ? 'outbound' : 'inbound';
  const sender = pickFirstNonEmpty(
    message.sender,
    message.sender_id,
    message.user_id,
    direction === 'outbound' ? message.account_id : message.peer_id,
  );
  const selfPlatformId = pickFirstNonEmpty(
    message.selfPlatformId,
    message.self_platform_id,
    context.selfPlatformId,
    context.self_platform_id,
  );
  const conversationPeerId = oneToOnePeerId(conversationId, selfPlatformId);
  return {
    conversationId,
    peerId: pickFirstNonEmpty(
      message.peer_id,
      message.peerId,
      context.peerId,
      context.peer_id,
      conversationPeerId,
      direction === 'inbound' ? sender : '',
    ),
    peerName: pickFirstNonEmpty(
      message.conversation_name,
      message.conversationName,
      message.peer_name,
      message.peerName,
      message.sender_name,
      message.user_name,
    ),
    sender,
    messageType: pickFirstNonEmpty(message.message_type, message.messageType, 'text'),
    direction,
    content: String(message.content || message.text || ''),
    timestampMs: normalizeTimestamp(message.timestamp || message.created_at),
    messageKey: messageKey(message),
    raw: message,
  };
}

function repairAccountMessageDirections(db, accountId, selfPlatformId) {
  const selfId = normalizePlatformUserId(selfPlatformId);
  if (!selfId) return { messages: 0, conversations: 0 };
  const timestamp = nowIso();
  const messageResult = db.prepare(`
    UPDATE dm_messages
    SET direction = CASE WHEN sender = ? THEN 'outbound' ELSE 'inbound' END,
        status = CASE
          WHEN sender = ? AND status = 'received' THEN 'sent'
          WHEN sender <> ? AND status = 'sent' THEN 'received'
          ELSE status
        END,
        updated_at = ?
    WHERE account_id = ?
      AND TRIM(sender) <> ''
      AND message_key NOT LIKE 'outbound:%'
      AND direction <> CASE WHEN sender = ? THEN 'outbound' ELSE 'inbound' END
  `).run(selfId, selfId, selfId, timestamp, accountId, selfId);

  const conversationRows = db.prepare(`
    SELECT id, conversation_id, peer_id
    FROM dm_conversations
    WHERE account_id = ?
  `).all(accountId);
  const updateConversation = db.prepare(`
    UPDATE dm_conversations
    SET peer_id = ?, updated_at = ?
    WHERE id = ?
  `);
  let repairedConversations = 0;
  for (const row of conversationRows) {
    const peerId = oneToOnePeerId(row.conversation_id, selfId);
    if (!peerId || peerId === row.peer_id) continue;
    repairedConversations += updateConversation.run(peerId, timestamp, row.id).changes;
  }

  if (messageResult.changes > 0) {
    db.prepare(`
      UPDATE dm_conversations
      SET unread_count = (
        SELECT COUNT(*)
        FROM dm_messages
        WHERE dm_messages.conversation_row_id = dm_conversations.id
          AND dm_messages.direction = 'inbound'
          AND (
            dm_conversations.last_read_at IS NULL
            OR dm_messages.timestamp_ms > CAST(
              (julianday(dm_conversations.last_read_at) - 2440587.5) * 86400000 AS INTEGER
            )
          )
      )
      WHERE account_id = ?
    `).run(accountId);
  }
  return { messages: messageResult.changes, conversations: repairedConversations };
}

function findOutboundEchoCandidate(db, conversationRowId, normalizedMessage) {
  if (normalizedMessage.direction !== 'outbound' || !normalizedMessage.content) return null;
  const windowStart = normalizedMessage.timestampMs - 120_000;
  const windowEnd = normalizedMessage.timestampMs + 10_000;
  return db.prepare(`
    SELECT id
    FROM dm_messages
    WHERE conversation_row_id = ?
      AND direction = 'outbound'
      AND message_key LIKE 'outbound:%'
      AND status IN ('pending', 'accepted', 'sent', 'needs_confirmation')
      AND (
        status IN ('accepted', 'sent', 'needs_confirmation')
        OR EXISTS (
          SELECT 1
          FROM dm_work_items
          WHERE dm_work_items.message_id = dm_messages.id
            AND dm_work_items.type IN ('send_manual', 'send_auto')
            AND dm_work_items.execution_started_at IS NOT NULL
        )
      )
      AND content = ?
      AND timestamp_ms BETWEEN ? AND ?
    ORDER BY ABS(timestamp_ms - ?) ASC, timestamp_ms ASC, created_at ASC
    LIMIT 1
  `).get(
    conversationRowId,
    normalizedMessage.content,
    windowStart,
    windowEnd,
    normalizedMessage.timestampMs,
  );
}

function reconcileOutboundEcho(db, conversationRow, normalizedMessage) {
  const candidate = findOutboundEchoCandidate(db, conversationRow.id, normalizedMessage);
  if (!candidate) return null;
  const timestamp = nowIso();
  db.prepare(`
    UPDATE dm_messages
    SET message_key = ?, sender = ?, message_type = ?, direction = 'outbound',
        status = 'sent', content = ?, timestamp_ms = ?, raw = ?, updated_at = ?
    WHERE id = ?
  `).run(
    normalizedMessage.messageKey,
    normalizedMessage.sender,
    normalizedMessage.messageType,
    normalizedMessage.content,
    normalizedMessage.timestampMs,
    stringifyJson(normalizedMessage.raw),
    timestamp,
    candidate.id,
  );
  const sourceWork = db.prepare(`
    SELECT payload
    FROM dm_work_items
    WHERE message_id = ? AND type IN ('send_manual', 'send_auto')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(candidate.id);
  const sourceDraftId = String(parseJson(sourceWork?.payload, {}).sourceDraftId || '').trim();
  if (sourceDraftId) {
    const draft = db.prepare('SELECT meta FROM dm_reply_drafts WHERE id = ?').get(sourceDraftId);
    if (draft) {
      db.prepare(`
        UPDATE dm_reply_drafts
        SET status = 'sent', meta = ?, updated_at = ?
        WHERE id = ?
      `).run(
        stringifyJson({ ...parseJson(draft.meta, {}), sentAt: timestamp }),
        timestamp,
        sourceDraftId,
      );
    }
  }
  return getMessage(db, candidate.id);
}

function isSystemNotification(message = {}) {
  if (Number(message.message_type ?? message.messageType) === 50001) return true;
  const rawContent = message.content ?? message.text;
  let parsed = rawContent;
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  return Boolean(
    parsed
      && typeof parsed === 'object'
      && parsed.command_type !== undefined
      && typeof parsed.text !== 'string',
  );
}

function findKnownPeerName(db, accountId, peerId) {
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedPeerId = String(peerId || '').trim();
  if (!normalizedAccountId || !normalizedPeerId) return '';
  const lead = db.prepare(`
    SELECT user_name
    FROM dm_leads
    WHERE account_id = ? AND user_id = ? AND TRIM(user_name) <> ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalizedAccountId, normalizedPeerId);
  if (String(lead?.user_name || '').trim()) return String(lead.user_name).trim();
  const comment = db.prepare(`
    SELECT user_name
    FROM comments
    WHERE account_id = ? AND user_id = ? AND TRIM(user_name) <> ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalizedAccountId, normalizedPeerId);
  return String(comment?.user_name || '').trim();
}

function backfillConversationPeerNames(db) {
  const missing = db.prepare(`
    SELECT id, account_id, peer_id
    FROM dm_conversations
    WHERE TRIM(peer_name) = '' AND TRIM(peer_id) <> ''
  `).all();
  if (missing.length === 0) return 0;
  return db.transaction(() => {
    const update = db.prepare(`
      UPDATE dm_conversations
      SET peer_name = ?, updated_at = ?
      WHERE id = ? AND TRIM(peer_name) = ''
    `);
    let updated = 0;
    for (const conversation of missing) {
      const peerName = findKnownPeerName(db, conversation.account_id, conversation.peer_id);
      if (!peerName) continue;
      updated += update.run(peerName, nowIso(), conversation.id).changes;
    }
    return updated;
  })();
}

function purgeSystemNotifications(db) {
  const candidates = db.prepare(`
    SELECT id, conversation_row_id, message_type, direction, content
    FROM dm_messages
    WHERE CAST(message_type AS TEXT) = '50001'
       OR content LIKE '%"command_type"%'
  `).all().filter((row) => isSystemNotification({
    message_type: row.message_type,
    content: row.content,
  }));
  if (candidates.length === 0) {
    return { removed: 0, updatedConversations: 0, removedConversations: 0 };
  }

  return db.transaction(() => {
    const affected = new Map();
    const removeMessage = db.prepare('DELETE FROM dm_messages WHERE id = ?');
    for (const row of candidates) {
      const summary = affected.get(row.conversation_row_id) || { removedInbound: 0 };
      if (row.direction === 'inbound') summary.removedInbound += 1;
      affected.set(row.conversation_row_id, summary);
      removeMessage.run(row.id);
    }

    let updatedConversations = 0;
    let removedConversations = 0;
    const listRemaining = db.prepare(`
      SELECT id, message_key, content, timestamp_ms
      FROM dm_messages
      WHERE conversation_row_id = ?
    `);
    const updateConversation = db.prepare(`
      UPDATE dm_conversations
      SET last_message_id = ?, last_message_key = ?, last_message_text = ?,
          last_message_at = ?, unread_count = MAX(0, unread_count - ?), updated_at = ?
      WHERE id = ?
    `);
    const removeConversation = db.prepare('DELETE FROM dm_conversations WHERE id = ?');

    for (const [conversationRowId, summary] of affected.entries()) {
      const remaining = listRemaining.all(conversationRowId);
      if (remaining.length === 0) {
        removedConversations += removeConversation.run(conversationRowId).changes;
        continue;
      }
      const latest = remaining.reduce((current, message) => (
        compareMessageOrder(
          Number(current.timestamp_ms),
          current.message_key,
          Number(message.timestamp_ms),
          message.message_key,
        ) < 0 ? message : current
      ));
      updatedConversations += updateConversation.run(
        latest.id,
        latest.message_key,
        latest.content,
        latest.timestamp_ms,
        summary.removedInbound,
        nowIso(),
        conversationRowId,
      ).changes;
    }

    return {
      removed: candidates.length,
      updatedConversations,
      removedConversations,
    };
  })();
}

function compareMessageOrder(leftTimestamp, leftKey, rightTimestamp, rightKey) {
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  const leftIndex = /^index:(\d+)$/.exec(String(leftKey || ''));
  const rightIndex = /^index:(\d+)$/.exec(String(rightKey || ''));
  if (leftIndex && rightIndex) return Number(leftIndex[1]) - Number(rightIndex[1]);
  return String(leftKey || '').localeCompare(String(rightKey || ''));
}

function buildWorkItemDedupeKey(workInput = {}) {
  const explicit = String(workInput.dedupeKey || workInput.dedupe_key || '').trim();
  if (explicit) return explicit;
  const messageId = String(workInput.messageId || workInput.message_id || '').trim();
  if (messageId) return `message:${messageId}`;
  return `payload:${crypto.createHash('sha256').update(stringifyJson(workInput || {})).digest('hex')}`;
}

function ensureConversation(db, accountId, message) {
  const existing = db.prepare(`
    SELECT * FROM dm_conversations
    WHERE account_id = ? AND conversation_id = ?
  `).get(accountId, message.conversationId);
  if (existing) return existing;
  const timestamp = nowIso();
  const id = idWithPrefix('dmc');
  const peerName = pickFirstNonEmpty(
    message.peerName,
    findKnownPeerName(db, accountId, message.peerId),
  );
  db.prepare(`
    INSERT INTO dm_conversations (
      id, account_id, conversation_id, peer_id, peer_name, status,
      last_message_id, last_message_key, last_message_text, last_message_at,
      unread_count, last_read_at, auto_reply_enabled, auto_reply_authorized,
      auto_reply_consumed_at, reply_mode_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, '', NULL, 0, NULL, 1, 1, NULL, NULL, ?, ?)
  `).run(
    id,
    accountId,
    message.conversationId,
    message.peerId,
    peerName,
    timestamp,
    timestamp,
  );
  return getConversationRow(db, id);
}

function touchConversationForMessage(db, conversationRow, insertedMessage, normalizedMessage) {
  const timestamp = nowIso();
  const nextUnread = conversationRow.unread_count + (insertedMessage.direction === 'inbound' ? 1 : 0);
  const shouldAdvanceLastMessage = compareMessageOrder(
    Number(conversationRow.last_message_at || 0),
    conversationRow.last_message_key || '',
    insertedMessage.timestamp,
    insertedMessage.messageKey,
  ) <= 0;
  db.prepare(`
    UPDATE dm_conversations
    SET peer_id = ?,
        peer_name = ?,
        last_message_id = ?,
        last_message_key = ?,
        last_message_text = ?,
        last_message_at = ?,
        unread_count = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    pickFirstNonEmpty(conversationRow.peer_id, normalizedMessage.peerId, insertedMessage.sender),
    pickFirstNonEmpty(
      conversationRow.peer_name,
      normalizedMessage.peerName,
      insertedMessage.peerName,
      findKnownPeerName(db, conversationRow.account_id, normalizedMessage.peerId),
    ),
    shouldAdvanceLastMessage ? insertedMessage.id : conversationRow.last_message_id,
    shouldAdvanceLastMessage ? insertedMessage.messageKey : conversationRow.last_message_key,
    shouldAdvanceLastMessage ? insertedMessage.content : conversationRow.last_message_text,
    shouldAdvanceLastMessage ? insertedMessage.timestamp : conversationRow.last_message_at,
    nextUnread,
    timestamp,
    conversationRow.id,
  );
  return getConversation(db, conversationRow.id);
}

function getMonitorState(db, accountId) {
  if (!accountId) throw new Error('accountId is required');
  return mapMonitorState(db.prepare(`
    SELECT * FROM dm_monitor_states WHERE account_id = ?
  `).get(accountId)) || defaultMonitorState(accountId);
}

function updateMonitorState(db, accountId, patch = {}) {
  if (!accountId) throw new Error('accountId is required');
  const existing = mapMonitorState(db.prepare(`
    SELECT * FROM dm_monitor_states WHERE account_id = ?
  `).get(accountId));
  const timestamp = nowIso();
  const settingSource = normalizeMonitorSettingSource(patch.settingSource);
  const nextSettingSource = settingSource || existing?.settingSource || 'inherited';
  const enabled = normalizeMonitorEnabled(patch.enabled, nextSettingSource);
  const replyModeOverride = normalizeReplyModeOverride(patch.replyModeOverride);
  const historyStatus = normalizeUnverifiedHistoryStatus(patch.historyStatus);
  const historyIncompleteReason = normalizeHistoryIncompleteReason(patch.historyIncompleteReason);
  const platformUserId = patch.platformUserId === undefined
    ? undefined
    : normalizePlatformUserId(patch.platformUserId);
  if (settingSource === 'explicit' && enabled === undefined && existing?.settingSource !== 'explicit') {
    throw new Error('enabled must be a boolean for explicit settings');
  }
  const next = {
    accountId,
    platformUserId: platformUserId !== undefined ? platformUserId : existing?.platformUserId || '',
    cursor: patch.cursor !== undefined ? String(patch.cursor || '') : existing?.cursor || '',
    status: patch.status !== undefined ? String(patch.status || 'idle') : existing?.status || 'idle',
    lastError: patch.lastError !== undefined ? patch.lastError : existing?.lastError || null,
    enabled: nextSettingSource === 'inherited'
      ? false
      : enabled !== undefined
        ? enabled
        : Boolean(existing?.enabled),
    settingSource: nextSettingSource,
    replyModeOverride: nextSettingSource === 'inherited'
      ? null
      : replyModeOverride !== undefined
        ? replyModeOverride
        : existing?.replyModeOverride || null,
    historyStatus: historyStatus || existing?.historyStatus || 'realtime_only',
    historyIncompleteReason: historyIncompleteReason !== undefined
      ? historyIncompleteReason
      : existing?.historyIncompleteReason || null,
  };
  if (existing) {
    db.prepare(`
      UPDATE dm_monitor_states
      SET platform_user_id = ?, cursor = ?, status = ?, last_error = ?, enabled = ?, setting_source = ?,
          reply_mode_override = ?, history_status = ?, history_incomplete_reason = ?, updated_at = ?
      WHERE account_id = ?
    `).run(
      next.platformUserId,
      next.cursor,
      next.status,
      next.lastError,
      next.enabled ? 1 : 0,
      next.settingSource,
      next.replyModeOverride,
      next.historyStatus,
      next.historyIncompleteReason,
      timestamp,
      accountId,
    );
  } else {
    db.prepare(`
      INSERT INTO dm_monitor_states (
        account_id, platform_user_id, cursor, status, last_error, enabled, setting_source,
        reply_mode_override, history_status, history_incomplete_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      next.platformUserId,
      next.cursor,
      next.status,
      next.lastError,
      next.enabled ? 1 : 0,
      next.settingSource,
      next.replyModeOverride,
      next.historyStatus,
      next.historyIncompleteReason,
      timestamp,
      timestamp,
    );
  }
  return getMonitorState(db, accountId);
}

function ingestMessages(db, input = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return db.transaction(() => {
    const suppliedSelfPlatformId = normalizePlatformUserId(input.selfPlatformId);
    const existingSelfPlatformId = getMonitorState(db, input.accountId).platformUserId;
    const identityChanged = Boolean(
      suppliedSelfPlatformId && suppliedSelfPlatformId !== existingSelfPlatformId,
    );
    if (identityChanged) {
      updateMonitorState(db, input.accountId, { platformUserId: suppliedSelfPlatformId });
      repairAccountMessageDirections(db, input.accountId, suppliedSelfPlatformId);
    }
    let selfPlatformId = suppliedSelfPlatformId || existingSelfPlatformId;
    const result = {
      inserted: 0,
      duplicates: 0,
      reconciled: 0,
      skipped: 0,
      conversations: [],
      insertedMessages: [],
    };
    for (const raw of messages) {
      if (isSystemNotification(raw)) {
        result.skipped += 1;
        continue;
      }
      const platformConversationId = String(raw.conversation_id || raw.conversationId || '').trim();
      const existingConversationRow = platformConversationId
        ? db.prepare(`
          SELECT * FROM dm_conversations
          WHERE account_id = ? AND conversation_id = ?
        `).get(input.accountId, platformConversationId)
        : null;
      const sender = pickFirstNonEmpty(raw.sender, raw.sender_id, raw.user_id);
      if (!selfPlatformId && sender && existingConversationRow?.peer_id && sender !== existingConversationRow.peer_id) {
        selfPlatformId = sender;
        updateMonitorState(db, input.accountId, { platformUserId: selfPlatformId });
        repairAccountMessageDirections(db, input.accountId, selfPlatformId);
      }
      const normalized = normalizeMessage(raw, {
        peerId: existingConversationRow?.peer_id,
        selfPlatformId,
      });
      const conversationRow = existingConversationRow || ensureConversation(db, input.accountId, normalized);
      if (getMessageByIdentity(db, input.accountId, normalized.conversationId, normalized.messageKey)) {
        result.duplicates += 1;
        continue;
      }
      const reconciledMessage = reconcileOutboundEcho(db, conversationRow, normalized);
      if (reconciledMessage) {
        const conversation = touchConversationForMessage(
          db,
          conversationRow,
          reconciledMessage,
          normalized,
        );
        result.reconciled += 1;
        result.conversations.push(conversation);
        continue;
      }
      const messageId = idWithPrefix('dmm');
      const timestamp = nowIso();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO dm_messages (
          id, account_id, conversation_row_id, conversation_id, message_key,
          sender, message_type, direction, status, content, timestamp_ms, raw, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        input.accountId,
        conversationRow.id,
        normalized.conversationId,
        normalized.messageKey,
        normalized.sender,
        normalized.messageType,
        normalized.direction,
        normalized.direction === 'outbound' ? 'sent' : 'received',
        normalized.content,
        normalized.timestampMs,
        stringifyJson(normalized.raw),
        timestamp,
        timestamp,
      );
      if (insert.changes === 0) {
        result.duplicates += 1;
        continue;
      }
      const savedMessage = getMessageByIdentity(
        db,
        input.accountId,
        normalized.conversationId,
        normalized.messageKey,
      );
      const conversation = touchConversationForMessage(db, conversationRow, savedMessage, normalized);
      result.inserted += 1;
      result.insertedMessages.push(savedMessage);
      result.conversations.push(conversation);
    }
    return result;
  })();
}

function conversationKeyFromLatestMessage(db, conversation) {
  const row = db.prepare(`
    SELECT raw FROM dm_messages
    WHERE conversation_row_id = ?
      AND direction = 'inbound'
    ORDER BY timestamp_ms DESC, created_at DESC
    LIMIT 1
  `).get(conversation.id);
  const raw = parseJson(row?.raw, {});
  const shortId = pickFirstNonEmpty(
    raw.conversation_short_id,
    raw.conversationShortId,
    raw.conversation_shortid,
  ) || '0';
  const ticket = pickFirstNonEmpty(raw.ticket, raw.conversation_ticket);
  return [conversation.conversationId, shortId, ticket].join('|');
}

function createPendingOutboundMessage(db, input = {}) {
  const conversation = getConversation(db, input.conversationId || input.conversationRowId);
  if (!conversation) throw new Error('conversation not found');
  const accountId = String(input.accountId || conversation.accountId).trim();
  if (accountId !== conversation.accountId) throw new Error('outbound message account mismatch');
  const content = String(input.content || '');
  if (!content.trim()) throw new Error('outbound message content is required');
  const id = input.id || idWithPrefix('dmm');
  const timestampMs = normalizeTimestamp(input.timestamp || Date.now());
  const timestamp = nowIso();
  const messageKeyValue = `outbound:${id}`;
  db.prepare(`
    INSERT INTO dm_messages (
      id, account_id, conversation_row_id, conversation_id, message_key,
      sender, message_type, direction, status, content, timestamp_ms, raw,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'text', 'outbound', 'pending', ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    conversation.id,
    conversation.conversationId,
    messageKeyValue,
    accountId,
    content,
    timestampMs,
    stringifyJson({ mode: input.mode || 'manual' }),
    timestamp,
    timestamp,
  );
  return {
    message: getMessage(db, id),
    conversationKey: conversationKeyFromLatestMessage(db, conversation),
  };
}

function updateOutboundMessageStatus(db, id, status, result = {}) {
  const allowed = new Set(['accepted', 'sent', 'failed', 'needs_confirmation', 'cancelled']);
  if (!allowed.has(status)) throw new Error(`unsupported outbound message status: ${status}`);
  const existing = getMessage(db, id);
  if (!existing) return null;
  if (existing.direction !== 'outbound') throw new Error('message is not outbound');
  if (existing.status !== 'pending') return existing;
  const timestamp = nowIso();
  const raw = { ...existing.raw, result: result || {} };
  db.prepare(`
    UPDATE dm_messages
    SET status = ?, raw = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, stringifyJson(raw), timestamp, id);
  const updated = getMessage(db, id);
  if (updated?.status === 'sent') {
    db.prepare(`
      UPDATE dm_conversations
      SET last_message_id = ?, last_message_key = ?, last_message_text = ?,
          last_message_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.id,
      updated.messageKey,
      updated.content,
      updated.timestamp,
      timestamp,
      updated.conversationId,
    );
  }
  return updated;
}

function listConversations(db, filters = {}) {
  if (!filters.accountId) throw new Error('accountId is required');
  const where = [];
  const params = [];
  where.push('account_id = ?');
  params.push(filters.accountId);
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.query) {
    const query = `%${String(filters.query).trim()}%`;
    where.push('(peer_name LIKE ? OR last_message_text LIKE ? OR conversation_id LIKE ?)');
    params.push(query, query, query);
  }
  const limit = Math.max(1, Math.min(Number(filters.limit || 500), 1000));
  const offset = Math.max(0, Number(filters.offset || 0));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`${CONVERSATION_SELECT}
    ${clause}
    ORDER BY
      CASE WHEN last_message_at IS NULL THEN 1 ELSE 0 END,
      last_message_at DESC,
      conversation_id ASC,
      id ASC
    LIMIT ?
    OFFSET ?
  `).all(...params, limit, offset).map(mapConversation);
}

function listMessages(db, conversationRowId, filters = {}) {
  const where = ['dm_messages.conversation_row_id = ?'];
  const params = [conversationRowId];
  if (filters.direction) {
    where.push('dm_messages.direction = ?');
    params.push(filters.direction);
  }
  if (filters.before !== undefined && filters.before !== null && filters.before !== '') {
    where.push('dm_messages.timestamp_ms < ?');
    params.push(Number(filters.before));
  }
  const limit = Math.max(1, Math.min(Number(filters.limit || 1000), 5000));
  return db.prepare(`
    SELECT dm_messages.*, dm_conversations.peer_name AS peer_name
    FROM dm_messages
    INNER JOIN dm_conversations ON dm_conversations.id = dm_messages.conversation_row_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      dm_messages.timestamp_ms ASC,
      CASE WHEN dm_messages.message_key GLOB 'index:[0-9]*' THEN 0 ELSE 1 END ASC,
      CASE
        WHEN dm_messages.message_key GLOB 'index:[0-9]*'
        THEN CAST(SUBSTR(dm_messages.message_key, 7) AS INTEGER)
        ELSE NULL
      END ASC,
      dm_messages.message_key ASC,
      dm_messages.id ASC
    LIMIT ?
  `).all(...params, limit).map(mapMessage);
}

function markConversationRead(db, id) {
  const existing = getConversation(db, id);
  if (!existing) return null;
  const timestamp = nowIso();
  db.prepare(`
    UPDATE dm_conversations
    SET unread_count = 0, last_read_at = ?, updated_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, id);
  return getConversation(db, id);
}

function updateConversation(db, id, patch = {}) {
  const existing = getConversation(db, id);
  if (!existing) return null;
  const assignments = [];
  const params = [];
  for (const [field, column] of EDITABLE_CONVERSATION_FIELDS) {
    if (patch[field] === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(
      column === 'auto_reply_enabled'
        ? bool(patch[field])
        : (column === 'reply_mode_override'
          ? normalizeReplyModeOverride(patch[field])
          : patch[field]),
    );
  }
  if (!assignments.length) return existing;
  assignments.push('updated_at = ?');
  params.push(nowIso(), id);
  db.prepare(`UPDATE dm_conversations SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
  return getConversation(db, id);
}

function deleteConversationLocal(db, id, accountId) {
  const conversation = getConversation(db, id);
  const normalizedAccountId = String(accountId || '').trim();
  if (!conversation || !normalizedAccountId || conversation.accountId !== normalizedAccountId) {
    return null;
  }
  const activeSend = db.prepare(`
    SELECT id
    FROM dm_work_items
    WHERE conversation_row_id = ?
      AND type IN ('send_manual', 'send_auto')
      AND status IN ('pending', 'running', 'committing')
    LIMIT 1
  `).get(conversation.id);
  if (activeSend) {
    throw Object.assign(
      new Error('conversation has active sending work'),
      { code: 'dm_conversation_sending', statusCode: 409 },
    );
  }
  return db.transaction(() => {
    const deleted = db.prepare(`
      DELETE FROM dm_conversations
      WHERE id = ? AND account_id = ?
    `).run(conversation.id, normalizedAccountId).changes;
    return deleted ? { id: conversation.id, deleted: true } : null;
  })();
}

function reauthorizeAutoReply(db, id) {
  if (!getConversation(db, id)) return null;
  db.prepare(`
    UPDATE dm_conversations
    SET auto_reply_authorized = 1,
        auto_reply_consumed_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), id);
  return getConversation(db, id);
}

function upsertReplyDraft(db, input = {}) {
  const conversation = getConversation(db, input.conversationRowId);
  if (!conversation) throw new Error('conversationRowId is required');
  const accountId = input.accountId || conversation.accountId;
  if (accountId !== conversation.accountId) throw new Error('reply draft account mismatch');
  const existing = getReplyDraftByConversation(db, conversation.id);
  const timestamp = nowIso();
  if (existing) {
    db.prepare(`
      UPDATE dm_reply_drafts
      SET content = ?, status = ?, meta = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.content !== undefined ? String(input.content) : existing.content,
      input.status !== undefined ? String(input.status) : existing.status,
      input.meta !== undefined ? stringifyJson(input.meta) : stringifyJson(existing.meta),
      timestamp,
      existing.id,
    );
    return getReplyDraftByConversation(db, conversation.id);
  }
  const id = input.id || idWithPrefix('dmdraft');
  db.prepare(`
    INSERT INTO dm_reply_drafts (
      id, account_id, conversation_row_id, content, status, meta, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    conversation.id,
    String(input.content || ''),
    String(input.status || 'draft'),
    stringifyJson(input.meta || {}),
    timestamp,
    timestamp,
  );
  return getReplyDraftByConversation(db, conversation.id);
}

function consumeAutoReplyAuthorization(db, conversationRowId, workInput = {}, options = {}) {
  return db.transaction(() => {
    const conversation = getConversation(db, conversationRowId);
    if (!conversation) return { consumed: false, reason: 'conversation_not_found' };
    const kind = 'auto_reply';
    const dedupeKey = buildWorkItemDedupeKey(workInput);
    const existing = getWorkItemByDedupe(db, conversationRowId, kind, dedupeKey);
    if (existing) return { consumed: true, created: false, workItem: existing };
    if (!conversation.autoReplyEnabled) return { consumed: false, reason: 'auto_reply_disabled' };
    const shouldConsumeAuthorization = options.frequency !== 'always';
    if (shouldConsumeAuthorization && !conversation.autoReplyAuthorized) {
      return { consumed: false, reason: 'authorization_required' };
    }
    const timestamp = nowIso();
    const id = idWithPrefix('dmwork');
    const messageId = String(workInput.messageId || workInput.message_id || '').trim() || null;
    db.prepare(`
      INSERT INTO dm_work_items (
        id, account_id, conversation_row_id, kind, dedupe_key,
        message_id, status, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      conversation.accountId,
      conversationRowId,
      kind,
      dedupeKey,
      messageId,
      stringifyJson(workInput || {}),
      timestamp,
      timestamp,
    );
    if (shouldConsumeAuthorization) {
      db.prepare(`
        UPDATE dm_conversations
        SET auto_reply_authorized = 0,
            auto_reply_consumed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, conversationRowId);
    }
    return {
      consumed: true,
      created: true,
      workItem: mapWorkItem(db.prepare('SELECT * FROM dm_work_items WHERE id = ?').get(id)),
    };
  })();
}

module.exports = {
  backfillConversationPeerNames,
  consumeAutoReplyAuthorization,
  createPendingOutboundMessage,
  deleteConversationLocal,
  getConversation,
  getConversationByPlatformId,
  getMessage,
  getMonitorState,
  getReplyDraftByConversation,
  ingestMessages,
  listConversations,
  listMessages,
  markConversationRead,
  messageKey,
  normalizeReplyModeOverride,
  purgeSystemNotifications,
  reauthorizeAutoReply,
  SUPPORTED_REPLY_MODE_OVERRIDES,
  SUPPORTED_MONITOR_SETTING_SOURCES,
  SUPPORTED_HISTORY_STATUSES,
  updateConversation,
  updateMonitorState,
  updateOutboundMessageStatus,
  upsertReplyDraft,
};
