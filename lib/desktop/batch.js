const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    status: row.status,
    input: parseJson(row.input, {}),
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchJobId: row.batch_job_id,
    accountId: row.account_id,
    awemeId: row.aweme_id,
    commentId: row.comment_id,
    status: row.status,
    input: parseJson(row.input, {}),
    result: parseJson(row.result, {}),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createBatchJob(db, input = {}) {
  const id = input.id || idWithPrefix('batch');
  const timestamp = nowIso();
  const items = Array.isArray(input.items) ? input.items : [];

  const insertJob = db.prepare(`
    INSERT INTO batch_jobs (
      id, account_id, type, status, input, total_count, success_count, failed_count, skipped_count,
      error, created_at, updated_at
    ) VALUES (
      @id, @accountId, @type, @status, @input, @totalCount, 0, 0, 0, NULL, @createdAt, @updatedAt
    )
  `);
  const insertItem = db.prepare(`
    INSERT INTO batch_items (
      id, batch_job_id, account_id, aweme_id, comment_id, status, input, result, error, created_at, updated_at
    ) VALUES (
      @id, @batchJobId, @accountId, @awemeId, @commentId, 'pending', @input, '{}', NULL, @createdAt, @updatedAt
    )
  `);

  db.transaction(() => {
    insertJob.run({
      id,
      accountId: input.accountId,
      type: input.type,
      status: input.status || 'pending',
      input: stringifyJson(input.input || {}),
      totalCount: items.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    for (const item of items) {
      insertItem.run({
        id: item.id || idWithPrefix('item'),
        batchJobId: id,
        accountId: input.accountId,
        awemeId: item.awemeId || null,
        commentId: item.commentId || null,
        input: stringifyJson(item.input || {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  })();

  return getBatchJob(db, id);
}

function getBatchJob(db, id) {
  return mapJob(db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id));
}

function listBatchJobs(db, filters = {}) {
  if (filters.accountId) {
    return db.prepare('SELECT * FROM batch_jobs WHERE account_id = ? ORDER BY created_at DESC')
      .all(filters.accountId)
      .map(mapJob);
  }
  return db.prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC').all().map(mapJob);
}

function listBatchItems(db, jobId) {
  return db.prepare('SELECT * FROM batch_items WHERE batch_job_id = ? ORDER BY created_at ASC')
    .all(jobId)
    .map(mapItem);
}

function getBatchItem(db, id) {
  return mapItem(db.prepare('SELECT * FROM batch_items WHERE id = ?').get(id));
}

function updateBatchJobStatus(db, id, status, patch = {}) {
  const existing = getBatchJob(db, id);
  if (!existing) return null;
  db.prepare(`
    UPDATE batch_jobs
    SET status = @status,
        success_count = @successCount,
        failed_count = @failedCount,
        skipped_count = @skippedCount,
        error = @error,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status,
    successCount: patch.successCount !== undefined ? patch.successCount : existing.successCount,
    failedCount: patch.failedCount !== undefined ? patch.failedCount : existing.failedCount,
    skippedCount: patch.skippedCount !== undefined ? patch.skippedCount : existing.skippedCount,
    error: patch.error !== undefined ? patch.error : existing.error,
    updatedAt: nowIso(),
  });
  return getBatchJob(db, id);
}

function updateBatchItemStatus(db, id, status, patch = {}) {
  const existing = getBatchItem(db, id);
  if (!existing) return null;
  db.prepare(`
    UPDATE batch_items
    SET status = @status,
        result = @result,
        error = @error,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status,
    result: stringifyJson(patch.result !== undefined ? patch.result : existing.result),
    error: patch.error !== undefined ? patch.error : existing.error,
    updatedAt: nowIso(),
  });
  return getBatchItem(db, id);
}

function recountBatchJob(db, id) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS open_count
    FROM batch_items
    WHERE batch_job_id = ?
  `).get(id);
  const status = counts.open_count > 0
    ? 'running'
    : (counts.failed_count > 0 ? 'finished_with_errors' : 'success');
  return updateBatchJobStatus(db, id, status, {
    successCount: counts.success_count || 0,
    failedCount: counts.failed_count || 0,
    skippedCount: counts.skipped_count || 0,
  });
}

module.exports = {
  createBatchJob,
  getBatchJob,
  listBatchItems,
  listBatchJobs,
  recountBatchJob,
  updateBatchItemStatus,
  updateBatchJobStatus,
};
