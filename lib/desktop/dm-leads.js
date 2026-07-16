const { idWithPrefix, nowIso } = require('./serialize');

const EDITABLE_FIELDS = new Map([
  ['userName', 'user_name'],
  ['commentId', 'comment_id'],
  ['awemeId', 'aweme_id'],
  ['commentText', 'comment_text'],
  ['intentLevel', 'intent_level'],
  ['reason', 'reason'],
  ['draftText', 'draft_text'],
  ['status', 'status'],
  ['conversationId', 'conversation_id'],
  ['messageId', 'message_id'],
  ['lastError', 'last_error'],
  ['sentAt', 'sent_at'],
]);

function mapLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    userName: row.user_name,
    commentId: row.comment_id,
    awemeId: row.aweme_id,
    commentText: row.comment_text,
    intentLevel: row.intent_level,
    reason: row.reason,
    draftText: row.draft_text,
    status: row.status,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    lastError: row.last_error,
    sentAt: row.sent_at,
    sourceCount: Number(row.source_count || 0),
    sourceTexts: row.source_texts || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getLead(db, id) {
  return mapLead(db.prepare(`
    SELECT dm_leads.*,
      (SELECT COUNT(*) FROM dm_lead_sources WHERE lead_id = dm_leads.id) AS source_count,
      (SELECT GROUP_CONCAT(comments.text, ' ')
       FROM dm_lead_sources INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
       WHERE dm_lead_sources.lead_id = dm_leads.id) AS source_texts
    FROM dm_leads WHERE id = ?
  `).get(id));
}

function getLeadByUser(db, accountId, userId) {
  return mapLead(db.prepare(`
    SELECT dm_leads.*,
      (SELECT COUNT(*) FROM dm_lead_sources WHERE lead_id = dm_leads.id) AS source_count,
      (SELECT GROUP_CONCAT(comments.text, ' ')
       FROM dm_lead_sources INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
       WHERE dm_lead_sources.lead_id = dm_leads.id) AS source_texts
    FROM dm_leads WHERE account_id = ? AND user_id = ?
  `).get(accountId, userId));
}

function addLeadSource(db, leadId, comment) {
  const commentId = String(comment?.cid || '').trim();
  const awemeId = String(comment?.awemeId || '').trim();
  if (!leadId || !commentId || !awemeId) return false;
  const result = db.prepare(`
    INSERT OR IGNORE INTO dm_lead_sources (lead_id, comment_id, aweme_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(leadId, commentId, awemeId, nowIso());
  return result.changes > 0;
}

function listLeadSources(db, leadId) {
  return db.prepare(`
    SELECT
      dm_lead_sources.lead_id AS lead_id,
      comments.cid AS comment_id,
      comments.aweme_id AS aweme_id,
      comments.user_id AS user_id,
      comments.user_name AS user_name,
      comments.text AS comment_text,
      comments.created_at AS comment_created_at,
      dm_lead_sources.created_at AS linked_at
    FROM dm_lead_sources
    INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
    WHERE dm_lead_sources.lead_id = ?
    ORDER BY comments.created_at ASC, comments.cid ASC
  `).all(leadId).map((row) => ({
    leadId: row.lead_id,
    commentId: row.comment_id,
    awemeId: row.aweme_id,
    userId: row.user_id,
    userName: row.user_name,
    commentText: row.comment_text,
    commentCreatedAt: row.comment_created_at,
    linkedAt: row.linked_at,
  }));
}

function upsertLeadFromComment(db, accountId, comment) {
  const userId = String(comment?.userId || '').trim();
  if (!accountId || !userId) return { lead: null, created: false };
  const existing = getLeadByUser(db, accountId, userId);
  const timestamp = nowIso();
  if (existing) {
    db.prepare(`
      UPDATE dm_leads
      SET user_name = ?, comment_id = ?, aweme_id = ?, comment_text = ?, updated_at = ?
      WHERE id = ?
    `).run(
      comment.userName || existing.userName,
      comment.cid || existing.commentId,
      comment.awemeId || existing.awemeId,
      comment.text || existing.commentText,
      timestamp,
      existing.id,
    );
    addLeadSource(db, existing.id, comment);
    return { lead: getLead(db, existing.id), created: false };
  }
  const id = idWithPrefix('lead');
  db.prepare(`
    INSERT INTO dm_leads (
      id, account_id, user_id, user_name, comment_id, aweme_id, comment_text,
      intent_level, reason, draft_text, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unreviewed', '', '', 'new', ?, ?)
  `).run(
    id,
    accountId,
    userId,
    comment.userName || '',
    comment.cid || null,
    comment.awemeId || null,
    comment.text || '',
    timestamp,
    timestamp,
  );
  addLeadSource(db, id, comment);
  return { lead: getLead(db, id), created: true };
}

function syncLeadsFromComments(db, input = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const where = ['account_id = ?', "user_id <> ''", 'deleted = 0', 'is_own = 0'];
  const params = [input.accountId];
  if (input.awemeId) {
    where.push('aweme_id = ?');
    params.push(input.awemeId);
  }
  const commentIds = Array.isArray(input.commentIds)
    ? [...new Set(input.commentIds.map(String).filter(Boolean))]
    : [];
  if (commentIds.length) {
    where.push(`cid IN (${commentIds.map(() => '?').join(', ')})`);
    params.push(...commentIds);
  }
  const rows = db.prepare(`SELECT * FROM comments WHERE ${where.join(' AND ')} ORDER BY created_at ASC`).all(...params);
  let created = 0;
  let duplicates = 0;
  const leads = [];
  db.transaction(() => {
    for (const row of rows) {
      const result = upsertLeadFromComment(db, input.accountId, {
        cid: row.cid,
        awemeId: row.aweme_id,
        userId: row.user_id,
        userName: row.user_name,
        text: row.text,
      });
      if (!result.lead) continue;
      if (result.created) created += 1;
      else duplicates += 1;
      leads.push(result.lead);
    }
  })();
  return { created, duplicates, total: rows.length, leads };
}

function listLeads(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.accountId) {
    where.push('account_id = ?');
    params.push(filters.accountId);
  }
  if (filters.intentLevel) {
    where.push('intent_level = ?');
    params.push(filters.intentLevel);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.query) {
    where.push(`(user_name LIKE ? OR comment_text LIKE ? OR user_id LIKE ? OR EXISTS (
      SELECT 1 FROM dm_lead_sources
      INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
      WHERE dm_lead_sources.lead_id = dm_leads.id AND comments.text LIKE ?
    ))`);
    const query = `%${String(filters.query).trim()}%`;
    params.push(query, query, query, query);
  }
  const limit = Math.max(1, Math.min(1000, Number(filters.limit || 500)));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT dm_leads.*,
      (SELECT COUNT(*) FROM dm_lead_sources WHERE lead_id = dm_leads.id) AS source_count,
      (SELECT GROUP_CONCAT(comments.text, ' ')
       FROM dm_lead_sources INNER JOIN comments ON comments.cid = dm_lead_sources.comment_id
       WHERE dm_lead_sources.lead_id = dm_leads.id) AS source_texts
    FROM dm_leads ${clause}
    ORDER BY updated_at DESC LIMIT ?
  `)
    .all(...params, limit)
    .map(mapLead);
}

function updateLead(db, id, patch = {}) {
  const existing = getLead(db, id);
  if (!existing) return null;
  const assignments = [];
  const params = [];
  for (const [field, column] of EDITABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(patch[field]);
  }
  if (!assignments.length) return existing;
  assignments.push('updated_at = ?');
  params.push(nowIso(), id);
  db.prepare(`UPDATE dm_leads SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
  return getLead(db, id);
}

function assertSendable(lead) {
  if (!lead) throw new Error('私信线索不存在');
  if (lead.status === 'sent') throw new Error('该用户已发送过私信');
  if (!['approved', 'failed'].includes(lead.status)) throw new Error('私信草稿必须先审核通过');
  if (!String(lead.userId || '').trim()) throw new Error('目标用户 ID 为空');
  if (!String(lead.draftText || '').trim()) throw new Error('私信内容不能为空');
  return true;
}

function markLeadSent(db, id, result = {}) {
  return updateLead(db, id, {
    status: 'sent',
    conversationId: result.conversationId || null,
    messageId: result.messageId || null,
    lastError: null,
    sentAt: nowIso(),
  });
}

function markLeadFailed(db, id, error) {
  return updateLead(db, id, {
    status: 'failed',
    lastError: String(error?.message || error || '私信发送失败'),
  });
}

module.exports = {
  assertSendable,
  getLead,
  getLeadByUser,
  listLeadSources,
  listLeads,
  markLeadFailed,
  markLeadSent,
  syncLeadsFromComments,
  updateLead,
  upsertLeadFromComment,
};
