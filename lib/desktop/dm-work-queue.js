const crypto = require('crypto');

const { idWithPrefix, parseJson, stringifyJson } = require('./serialize');

const CLAIM_TTL_MS = 60_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const DEFAULT_MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const ALLOWED_DM_WORK_TYPES = new Set(['analyze', 'send_manual', 'send_auto', 'history_sync']);
const TERMINAL_STATUSES = new Set(['success', 'failed', 'needs_confirmation', 'cancelled']);

function isoAt(now, offsetMs = 0) {
  return new Date(now + offsetMs).toISOString();
}

function normalizeType(value, kind = '') {
  const text = String(value || '').trim();
  if (text) return text;
  if (String(kind || '').trim() === 'auto_reply') return 'send_auto';
  return '';
}

function assertSupportedType(type) {
  if (!ALLOWED_DM_WORK_TYPES.has(type)) {
    throw new Error(`Unsupported DM work type: ${type}`);
  }
}

function normalizeKind(type, kind = '') {
  const explicitKind = String(kind || '').trim();
  if (explicitKind) return explicitKind;
  return type === 'send_auto' ? 'auto_reply' : type;
}

function buildDedupeKey(input = {}) {
  const explicit = String(input.dedupeKey || input.dedupe_key || '').trim();
  if (explicit) return explicit;
  const messageId = String(input.messageId || input.message_id || '').trim();
  if (messageId) return `message:${messageId}`;
  return `payload:${crypto.createHash('sha256').update(stringifyJson(input.payload || {})).digest('hex')}`;
}

function isAnalyzableTextMessageType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  return type === 'text' || type === '7';
}

function createClaimToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashClaimToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function claimError() {
  return Object.assign(new Error('DM work claim is missing or no longer current'), {
    code: 'dm_work_claim_invalid',
    statusCode: 409,
  });
}

function normalizeClaimCredential(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function withImmediateTransaction(db, fn) {
  if (db.inTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function mapWork(row) {
  if (!row) return null;
  const type = normalizeType(row.type, row.kind);
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_row_id,
    kind: row.kind,
    type,
    dedupeKey: row.dedupe_key,
    messageId: row.message_id,
    status: row.status,
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, {}),
    error: row.error,
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
    nextRunAt: row.next_run_at,
    workerId: row.worker_id,
    claimToken: row.claim_token,
    claimTokenHash: row.claim_token_hash,
    leaseExpiresAt: row.lease_expires_at,
    executionStartedAt: row.execution_started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getWork(db, id) {
  return mapWork(db.prepare('SELECT * FROM dm_work_items WHERE id = ?').get(id));
}

function getLatestAnalysisWork(db, conversationId) {
  return mapWork(db.prepare(`
    SELECT *
    FROM dm_work_items
    WHERE conversation_row_id = ? AND type = 'analyze'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(conversationId));
}

function recoverInterruptedWorkInternal(db, now) {
  const nowIso = isoAt(now);
  db.prepare(`
    UPDATE dm_messages
    SET status = 'needs_confirmation', updated_at = ?
    WHERE id IN (
      SELECT message_id FROM dm_work_items
      WHERE status = 'running'
        AND type IN ('send_manual', 'send_auto')
        AND execution_started_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND message_id IS NOT NULL
    )
      AND status = 'pending'
  `).run(nowIso, nowIso);
  const uncertain = db.prepare(`
    UPDATE dm_work_items
    SET status = 'needs_confirmation',
        error = COALESCE(error, 'Worker stopped after platform execution began; confirmation required'),
        next_run_at = NULL,
        worker_id = NULL,
        claim_token = NULL,
        claim_token_hash = NULL,
        lease_expires_at = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE status = 'running'
      AND type IN ('send_manual', 'send_auto')
      AND execution_started_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
  `).run(nowIso, nowIso, nowIso).changes;
  const recovered = db.prepare(`
    UPDATE dm_work_items
    SET status = 'pending',
        worker_id = NULL,
        claim_token = NULL,
        claim_token_hash = NULL,
        lease_expires_at = NULL,
        execution_started_at = NULL,
        updated_at = ?
    WHERE status = 'running'
      AND execution_started_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
  `).run(nowIso, nowIso).changes;
  const recoveredAnalysisCommit = db.prepare(`
    UPDATE dm_work_items
    SET status = 'pending',
        worker_id = NULL,
        claim_token = NULL,
        claim_token_hash = NULL,
        lease_expires_at = NULL,
        execution_started_at = NULL,
        updated_at = ?
    WHERE status = 'committing'
      AND type = 'analyze'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
  `).run(nowIso, nowIso).changes;
  return uncertain + recovered + recoveredAnalysisCommit;
}

function enqueueWork(db, input = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  if (!input.conversationId) throw new Error('conversationId is required');
  const type = normalizeType(input.type, input.kind);
  if (!type) throw new Error('type is required');
  assertSupportedType(type);
  const kind = normalizeKind(type, input.kind);
  const dedupeKey = buildDedupeKey(input);
  const timestamp = new Date().toISOString();
  const id = input.id || idWithPrefix('dmwork');
  const maxAttempts = Math.max(1, Number(input.maxAttempts || input.max_attempts || DEFAULT_MAX_ATTEMPTS));
  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT OR IGNORE INTO dm_work_items (
        id, account_id, conversation_row_id, kind, type, dedupe_key, message_id,
        status, payload, result, error, attempt_count, max_attempts, next_run_at,
        worker_id, lease_expires_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', NULL, 0, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      id,
      input.accountId,
      input.conversationId,
      kind,
      type,
      dedupeKey,
      String(input.messageId || input.message_id || '').trim() || null,
      stringifyJson(input.payload || {}),
      maxAttempts,
      timestamp,
      timestamp,
    );
    const existing = db.prepare(`
      SELECT * FROM dm_work_items
      WHERE conversation_row_id = ? AND kind = ? AND dedupe_key = ?
    `).get(input.conversationId, kind, dedupeKey);
    return mapWork(existing);
  });
}

function enqueueMissingAnalysisWork(db) {
  const messages = db.prepare(`
    SELECT
      dm_messages.id,
      dm_messages.account_id AS accountId,
      dm_messages.conversation_row_id AS conversationId,
      dm_messages.conversation_id AS platformConversationId,
      dm_messages.message_key AS messageKey
    FROM dm_messages
    WHERE dm_messages.direction = 'inbound'
      AND TRIM(dm_messages.content) <> ''
      AND LOWER(TRIM(CAST(dm_messages.message_type AS TEXT))) IN ('text', '7')
      AND NOT EXISTS (
        SELECT 1
        FROM dm_work_items
        WHERE dm_work_items.type = 'analyze'
          AND dm_work_items.message_id = dm_messages.id
      )
    ORDER BY dm_messages.timestamp_ms ASC, dm_messages.id ASC
  `).all();

  for (const message of messages) {
    enqueueWork(db, {
      type: 'analyze',
      accountId: message.accountId,
      conversationId: message.conversationId,
      messageId: message.id,
      dedupeKey: `source-message:${message.id}`,
      payload: {
        sourceMessageId: message.id,
        sourceConversationId: message.conversationId,
        platformConversationId: message.platformConversationId,
        messageKey: message.messageKey,
      },
    });
  }
  return messages.length;
}

function claimNextWork(db, workerId, now = Date.now(), options = {}) {
  const safeWorkerId = String(workerId || '').trim();
  if (!safeWorkerId) throw new Error('workerId is required');
  const types = Array.isArray(options.types)
    ? [...new Set(options.types.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  types.forEach(assertSupportedType);
  return withImmediateTransaction(db, () => {
    recoverInterruptedWorkInternal(db, now);
    const nowIso = isoAt(now);
    const active = db.prepare(`
      SELECT id FROM dm_work_items
      WHERE status IN ('running', 'committing')
        AND (lease_expires_at IS NULL OR lease_expires_at > ?)
      LIMIT 1
    `).get(nowIso);
    if (active) return null;
    const typeFilter = types.length ? `AND type IN (${types.map(() => '?').join(', ')})` : '';
    const row = db.prepare(`
      SELECT * FROM dm_work_items
      WHERE status = 'pending'
        AND (next_run_at IS NULL OR next_run_at <= ?)
        ${typeFilter}
      ORDER BY
        CASE WHEN type = 'send_manual' THEN 0 ELSE 1 END,
        created_at ASC,
        rowid ASC
      LIMIT 1
    `).get(nowIso, ...types);
    if (!row) return null;
    const claimToken = createClaimToken();
    db.prepare(`
      UPDATE dm_work_items
      SET status = 'running',
          worker_id = ?,
          claim_token = ?,
          claim_token_hash = ?,
          lease_expires_at = ?,
          execution_started_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      safeWorkerId,
      claimToken,
      hashClaimToken(claimToken),
      isoAt(now, CLAIM_TTL_MS),
      nowIso,
      row.id,
    );
    return getWork(db, row.id);
  });
}

function validateWorkClaim(db, id, workerId, claimToken, options = {}) {
  const safeWorkerId = normalizeClaimCredential(workerId);
  const safeClaimToken = normalizeClaimCredential(claimToken);
  if (!safeWorkerId || !safeClaimToken) throw claimError();
  const existing = getWork(db, id);
  if (!existing) throw new Error(`DM work item not found: ${id}`);
  if (options.type && existing.type !== options.type) throw claimError();
  if (TERMINAL_STATUSES.has(existing.status)) {
    if (options.allowTerminal === true
      && existing.claimTokenHash
      && existing.claimTokenHash === hashClaimToken(safeClaimToken)) {
      return existing;
    }
    throw claimError();
  }
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : ['running'];
  if (!statuses.includes(existing.status)
    || existing.workerId !== safeWorkerId
    || existing.claimToken !== safeClaimToken) {
    throw claimError();
  }
  return existing;
}

function acquireAnalysisCommit(db, id, workerId, claimToken, now = Date.now()) {
  const safeWorkerId = String(workerId || '').trim();
  const safeClaimToken = normalizeClaimCredential(claimToken);
  if (!safeWorkerId || !safeClaimToken) throw claimError();
  return withImmediateTransaction(db, () => {
    const existing = getWork(db, id);
    if (!existing) throw new Error(`DM work item not found: ${id}`);
    if (existing.type !== 'analyze') {
      throw Object.assign(new Error('DM work item is not an analysis item'), { statusCode: 409 });
    }
    if (existing.status === 'success') {
      validateWorkClaim(db, id, safeWorkerId, safeClaimToken, {
        allowTerminal: true,
        type: 'analyze',
      });
      return { acquired: false, workItem: existing };
    }
    if (existing.status === 'committing') {
      throw Object.assign(new Error('DM analysis result is currently committing'), {
        code: 'dm_analysis_committing',
        statusCode: 409,
      });
    }
    validateWorkClaim(db, id, safeWorkerId, safeClaimToken, { type: 'analyze' });
    const changed = db.prepare(`
      UPDATE dm_work_items
      SET status = 'committing', updated_at = ?
      WHERE id = ? AND type = 'analyze' AND status = 'running'
        AND worker_id = ? AND claim_token = ?
    `).run(isoAt(now), id, safeWorkerId, safeClaimToken).changes;
    if (changed !== 1) {
      const latest = getWork(db, id);
      if (latest?.status === 'success') {
        validateWorkClaim(db, id, safeWorkerId, safeClaimToken, {
          allowTerminal: true,
          type: 'analyze',
        });
        return { acquired: false, workItem: latest };
      }
      throw Object.assign(new Error('DM analysis commit ownership was lost'), {
        code: 'dm_analysis_claim_lost',
        statusCode: 409,
      });
    }
    return { acquired: true, workItem: getWork(db, id) };
  });
}

function markWorkExecutionStarted(db, id, workerId, claimToken, now = Date.now()) {
  return withImmediateTransaction(db, () => {
    const existing = validateWorkClaim(db, id, workerId, claimToken, { statuses: ['running'] });
    db.prepare(`
      UPDATE dm_work_items
      SET execution_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
    `).run(isoAt(now), isoAt(now), id, existing.workerId, existing.claimToken);
    return getWork(db, id);
  });
}

function completeWork(db, id, result = {}, options = {}) {
  const now = Number(options.now || Date.now());
  return withImmediateTransaction(db, () => {
    const existing = getWork(db, id);
    if (!existing) throw new Error(`DM work item not found: ${id}`);
    if (TERMINAL_STATUSES.has(existing.status)) {
      return validateWorkClaim(db, id, options.workerId, options.claimToken, { allowTerminal: true });
    }
    const expectedStatus = existing.type === 'analyze' && existing.status === 'committing'
      ? 'committing'
      : 'running';
    validateWorkClaim(db, id, options.workerId, options.claimToken, { statuses: [expectedStatus] });
    if ((existing.type === 'send_manual' || existing.type === 'send_auto') && !existing.executionStartedAt) {
      throw Object.assign(
        new Error('DM send execution has not started; complete is not allowed'),
        { code: 'dm_execution_not_started', statusCode: 409 },
      );
    }
    db.prepare(`
      UPDATE dm_work_items
      SET status = 'success',
          result = ?,
          error = NULL,
          next_run_at = NULL,
          worker_id = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          execution_started_at = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE id = ? AND status = ? AND worker_id = ? AND claim_token = ?
    `).run(
      stringifyJson(result || {}), isoAt(now), isoAt(now), id, expectedStatus,
      existing.workerId, existing.claimToken,
    );
    return getWork(db, id);
  });
}

function failWork(db, id, error, options = {}) {
  const now = Number(options.now || Date.now());
  return withImmediateTransaction(db, () => {
    const existing = getWork(db, id);
    if (!existing) throw new Error(`DM work item not found: ${id}`);
    if (TERMINAL_STATUSES.has(existing.status)) {
      return validateWorkClaim(db, id, options.workerId, options.claimToken, { allowTerminal: true });
    }
    validateWorkClaim(db, id, options.workerId, options.claimToken, { statuses: ['running'] });
    const attemptCount = existing.attemptCount + 1;
    const maxAttempts = Math.max(1, Number(options.maxAttempts || existing.maxAttempts || DEFAULT_MAX_ATTEMPTS));
    const errorMessage = String(error?.message || error || 'unknown error');
    if (Number.isFinite(Number(options.deferMs)) && Number(options.deferMs) > 0) {
      db.prepare(`
        UPDATE dm_work_items
        SET status = 'pending',
            error = ?,
            next_run_at = ?,
            worker_id = NULL,
            claim_token = NULL,
            claim_token_hash = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
      `).run(
        errorMessage,
        isoAt(now, Number(options.deferMs)),
        isoAt(now),
        id,
        existing.workerId,
        existing.claimToken,
      );
      return getWork(db, id);
    }
    if (options.uncertain === true) {
      db.prepare(`
        UPDATE dm_work_items
        SET status = 'needs_confirmation',
            error = ?,
            attempt_count = ?,
            next_run_at = NULL,
            worker_id = NULL,
            claim_token = NULL,
            lease_expires_at = NULL,
            execution_started_at = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
      `).run(
        errorMessage,
        attemptCount,
        isoAt(now),
        isoAt(now),
        id,
        existing.workerId,
        existing.claimToken,
      );
      return getWork(db, id);
    }
    if (options.retryable === false) {
      db.prepare(`
        UPDATE dm_work_items
        SET status = 'failed',
            error = ?,
            attempt_count = ?,
            next_run_at = NULL,
            worker_id = NULL,
            claim_token = NULL,
            lease_expires_at = NULL,
            execution_started_at = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
      `).run(
        errorMessage,
        attemptCount,
        isoAt(now),
        isoAt(now),
        id,
        existing.workerId,
        existing.claimToken,
      );
      return getWork(db, id);
    }
    if (attemptCount >= maxAttempts) {
      db.prepare(`
        UPDATE dm_work_items
        SET status = 'failed',
            error = ?,
            attempt_count = ?,
            max_attempts = ?,
            next_run_at = NULL,
            worker_id = NULL,
            claim_token = NULL,
            lease_expires_at = NULL,
            execution_started_at = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
      `).run(
        errorMessage,
        attemptCount,
        maxAttempts,
        isoAt(now),
        isoAt(now),
        id,
        existing.workerId,
        existing.claimToken,
      );
      return getWork(db, id);
    }
    const retryDelayMs = RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
    db.prepare(`
      UPDATE dm_work_items
      SET status = 'pending',
          error = ?,
          attempt_count = ?,
          max_attempts = ?,
          next_run_at = ?,
          worker_id = NULL,
          claim_token = NULL,
          claim_token_hash = NULL,
          lease_expires_at = NULL,
          execution_started_at = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token = ?
    `).run(
      errorMessage,
      attemptCount,
      maxAttempts,
      isoAt(now, retryDelayMs),
      isoAt(now),
      id,
      existing.workerId,
      existing.claimToken,
    );
    return getWork(db, id);
  });
}

function cancelPendingAutoReplies(db, conversationId) {
  if (!conversationId) throw new Error('conversationId is required');
  return withImmediateTransaction(db, () => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      UPDATE dm_messages
      SET status = 'cancelled', updated_at = ?
      WHERE status = 'pending'
        AND id IN (
          SELECT message_id FROM dm_work_items
          WHERE conversation_row_id = ?
            AND (status = 'pending' OR (status = 'running' AND execution_started_at IS NULL))
            AND (type = 'send_auto' OR kind = 'auto_reply')
            AND message_id IS NOT NULL
        )
    `).run(timestamp, conversationId);
    const cancelled = db.prepare(`
      UPDATE dm_work_items
      SET status = 'cancelled',
          next_run_at = NULL,
          worker_id = NULL,
          claim_token = NULL,
          claim_token_hash = NULL,
          lease_expires_at = NULL,
          execution_started_at = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE conversation_row_id = ?
        AND (status = 'pending' OR (status = 'running' AND execution_started_at IS NULL))
        AND (type = 'send_auto' OR kind = 'auto_reply')
    `).run(timestamp, timestamp, conversationId).changes;
    if (cancelled > 0) {
      db.prepare(`
        UPDATE dm_reply_drafts
        SET status = 'cancelled', updated_at = ?
        WHERE conversation_row_id = ? AND status IN ('queued', 'accepted')
      `).run(timestamp, conversationId);
    }
    return cancelled;
  });
}

function cancelPendingAccountWork(db, accountId) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) throw new Error('accountId is required');
  return withImmediateTransaction(db, () => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      UPDATE dm_messages
      SET status = 'cancelled', updated_at = ?
      WHERE account_id = ?
        AND status = 'pending'
        AND id IN (
          SELECT message_id FROM dm_work_items
          WHERE account_id = ?
            AND (status = 'pending' OR (status = 'running' AND execution_started_at IS NULL))
            AND message_id IS NOT NULL
        )
    `).run(timestamp, normalizedAccountId, normalizedAccountId);
    return db.prepare(`
      UPDATE dm_work_items
      SET status = 'cancelled',
          next_run_at = NULL,
          worker_id = NULL,
          claim_token = NULL,
          claim_token_hash = NULL,
          lease_expires_at = NULL,
          execution_started_at = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE account_id = ?
        AND (status = 'pending' OR (status = 'running' AND execution_started_at IS NULL))
    `).run(timestamp, timestamp, normalizedAccountId).changes;
  });
}

function recoverInterruptedWork(db, now = Date.now()) {
  return withImmediateTransaction(db, () => recoverInterruptedWorkInternal(db, now));
}

module.exports = {
  ALLOWED_DM_WORK_TYPES,
  acquireAnalysisCommit,
  cancelPendingAccountWork,
  cancelPendingAutoReplies,
  claimNextWork,
  completeWork,
  enqueueMissingAnalysisWork,
  enqueueWork,
  failWork,
  getLatestAnalysisWork,
  getWork,
  markWorkExecutionStarted,
  isAnalyzableTextMessageType,
  recoverInterruptedWork,
  validateWorkClaim,
};
