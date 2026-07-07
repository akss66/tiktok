const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    status: row.status,
    input: parseJson(row.input, {}),
    resultSummary: parseJson(row.result_summary, {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function getTask(db, id) {
  return mapTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

function createTask(db, input = {}) {
  const id = input.id || idWithPrefix('task');
  const timestamp = nowIso();

  db.prepare(`
    INSERT INTO tasks (
      id, account_id, type, status, input, result_summary,
      started_at, finished_at, error, created_at, updated_at
    ) VALUES (
      @id, @accountId, @type, @status, @input, @resultSummary,
      @startedAt, @finishedAt, @error, @createdAt, @updatedAt
    )
  `).run({
    id,
    accountId: input.accountId,
    type: input.type,
    status: input.status || 'pending',
    input: stringifyJson(input.input || {}),
    resultSummary: stringifyJson(input.resultSummary || {}),
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    error: input.error || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return getTask(db, id);
}

function listTasks(db, filters = {}) {
  if (filters.accountId) {
    return db.prepare('SELECT * FROM tasks WHERE account_id = ? ORDER BY created_at DESC')
      .all(filters.accountId)
      .map(mapTask);
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(mapTask);
}

function updateTaskStatus(db, id, status, patch = {}) {
  const existing = getTask(db, id);
  if (!existing) return null;

  const next = {
    status,
    input: patch.input !== undefined ? patch.input : existing.input,
    resultSummary: patch.resultSummary !== undefined ? patch.resultSummary : existing.resultSummary,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
    finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : existing.finishedAt,
    error: patch.error !== undefined ? patch.error : existing.error,
    updatedAt: nowIso(),
  };

  db.prepare(`
    UPDATE tasks
    SET status = @status,
        input = @input,
        result_summary = @resultSummary,
        started_at = @startedAt,
        finished_at = @finishedAt,
        error = @error,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status: next.status,
    input: stringifyJson(next.input),
    resultSummary: stringifyJson(next.resultSummary),
    startedAt: next.startedAt,
    finishedAt: next.finishedAt,
    error: next.error,
    updatedAt: next.updatedAt,
  });

  return getTask(db, id);
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
};
