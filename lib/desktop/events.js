const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    taskId: row.task_id,
    level: row.level,
    message: row.message,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
  };
}

function appendEvent(db, input = {}) {
  const id = input.id || idWithPrefix('evt');
  const createdAt = input.createdAt || nowIso();

  db.prepare(`
    INSERT INTO event_logs (
      id, account_id, task_id, level, message, metadata, created_at
    ) VALUES (
      @id, @accountId, @taskId, @level, @message, @metadata, @createdAt
    )
  `).run({
    id,
    accountId: input.accountId || null,
    taskId: input.taskId || null,
    level: input.level || 'info',
    message: input.message || '',
    metadata: stringifyJson(input.metadata || {}),
    createdAt,
  });

  return mapEvent(db.prepare('SELECT * FROM event_logs WHERE id = ?').get(id));
}

function listEvents(db, filters = {}) {
  const clauses = [];
  const params = {};

  if (filters.accountId) {
    clauses.push('account_id = @accountId');
    params.accountId = filters.accountId;
  }
  if (filters.taskId) {
    clauses.push('task_id = @taskId');
    params.taskId = filters.taskId;
  }

  const limit = Math.max(1, Math.min(Number(filters.limit || 100), 500));
  params.limit = limit;

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM event_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT @limit
  `).all(params).map(mapEvent);
}

module.exports = {
  appendEvent,
  listEvents,
};
