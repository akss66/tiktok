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
    currentItemId: row.current_item_id,
    progressMessage: row.progress_message || '',
    nextRunAt: row.next_run_at,
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
        current_item_id = @currentItemId,
        progress_message = @progressMessage,
        next_run_at = @nextRunAt,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    status,
    successCount: patch.successCount !== undefined ? patch.successCount : existing.successCount,
    failedCount: patch.failedCount !== undefined ? patch.failedCount : existing.failedCount,
    skippedCount: patch.skippedCount !== undefined ? patch.skippedCount : existing.skippedCount,
    error: patch.error !== undefined ? patch.error : existing.error,
    currentItemId: patch.currentItemId !== undefined ? patch.currentItemId : existing.currentItemId,
    progressMessage: patch.progressMessage !== undefined ? patch.progressMessage : existing.progressMessage,
    nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : existing.nextRunAt,
    updatedAt: nowIso(),
  });
  return getBatchJob(db, id);
}

function updateBatchJobProgress(db, id, patch = {}) {
  const existing = getBatchJob(db, id);
  if (!existing) return null;
  return updateBatchJobStatus(db, id, existing.status, patch);
}

function updateBatchJobInput(db, id, patch = {}) {
  const existing = getBatchJob(db, id);
  if (!existing) return null;
  db.prepare('UPDATE batch_jobs SET input = ?, updated_at = ? WHERE id = ?')
    .run(stringifyJson({ ...existing.input, ...patch }), nowIso(), id);
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

function updateOpenBatchItems(db, jobId, status) {
  db.prepare(`
    UPDATE batch_items
    SET status = ?, updated_at = ?
    WHERE batch_job_id = ? AND status IN ('pending', 'running')
  `).run(status, nowIso(), jobId);
  return listBatchItems(db, jobId);
}

function requestBatchJobPause(db, id) {
  const job = getBatchJob(db, id);
  if (!job) return null;
  if (['success', 'finished_with_errors', 'cancelled'].includes(job.status)) return job;
  return updateBatchJobStatus(db, id, job.status === 'running' ? 'pause_requested' : 'paused');
}

function requestBatchJobCancel(db, id) {
  const job = getBatchJob(db, id);
  if (!job) return null;
  if (['success', 'finished_with_errors', 'cancelled'].includes(job.status)) return job;
  if (job.status === 'running' || job.status === 'pause_requested') {
    return updateBatchJobStatus(db, id, 'cancel_requested');
  }
  updateOpenBatchItems(db, id, 'cancelled');
  return updateBatchJobStatus(db, id, 'cancelled');
}

function markBatchJobPaused(db, id) {
  return updateBatchJobStatus(db, id, 'paused');
}

function markBatchJobCancelled(db, id) {
  updateOpenBatchItems(db, id, 'cancelled');
  return updateBatchJobStatus(db, id, 'cancelled');
}

function prepareBatchJobResume(db, id) {
  const job = getBatchJob(db, id);
  if (!job) return null;
  if (!['paused', 'pause_requested', 'pending'].includes(job.status)) return job;
  return updateBatchJobStatus(db, id, 'pending', { error: null });
}

function resetFailedBatchItems(db, id) {
  const job = getBatchJob(db, id);
  if (!job) return null;
  db.prepare(`
    UPDATE batch_items
    SET status = 'pending', result = '{}', error = NULL, updated_at = ?
    WHERE batch_job_id = ? AND status = 'failed'
  `).run(nowIso(), id);
  updateBatchJobStatus(db, id, 'pending', { failedCount: 0, error: null });
  return recountBatchJob(db, id);
}

function recoverInterruptedBatchJobs(db) {
  const interrupted = db.prepare(`
    SELECT id, status FROM batch_jobs
    WHERE status IN ('running', 'pause_requested', 'cancel_requested')
  `).all();
  db.transaction(() => {
    for (const job of interrupted) {
      if (job.status === 'cancel_requested') {
        updateOpenBatchItems(db, job.id, 'cancelled');
        updateBatchJobStatus(db, job.id, 'cancelled', { error: '应用重启前已请求取消' });
      } else {
        db.prepare(`
          UPDATE batch_items SET status = 'pending', updated_at = ?
          WHERE batch_job_id = ? AND status = 'running'
        `).run(nowIso(), job.id);
        updateBatchJobStatus(db, job.id, 'paused', { error: '应用重启后已暂停，可继续执行' });
      }
    }
  })();
  return interrupted.length;
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
  const existing = getBatchJob(db, id);
  const controlStatuses = ['pause_requested', 'paused', 'cancel_requested', 'cancelled'];
  const status = controlStatuses.includes(existing?.status)
    ? existing.status
    : (counts.open_count > 0
      ? existing?.status === 'pending' ? 'pending' : 'running'
      : (counts.failed_count > 0 ? 'finished_with_errors' : 'success'));
  return updateBatchJobStatus(db, id, status, {
    successCount: counts.success_count || 0,
    failedCount: counts.failed_count || 0,
    skippedCount: counts.skipped_count || 0,
  });
}

module.exports = {
  createBatchJob,
  getBatchJob,
  getBatchItem,
  listBatchItems,
  listBatchJobs,
  markBatchJobCancelled,
  markBatchJobPaused,
  prepareBatchJobResume,
  recountBatchJob,
  recoverInterruptedBatchJobs,
  requestBatchJobCancel,
  requestBatchJobPause,
  resetFailedBatchItems,
  updateBatchItemStatus,
  updateBatchJobInput,
  updateBatchJobStatus,
  updateBatchJobProgress,
  updateOpenBatchItems,
};
