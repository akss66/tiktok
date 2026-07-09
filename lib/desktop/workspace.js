const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

function bool(value) {
  return value ? 1 : 0;
}

function mapVideo(row) {
  if (!row) return null;
  return {
    awemeId: row.aweme_id,
    accountId: row.account_id,
    searchSessionId: row.search_session_id,
    source: row.source,
    isMine: Boolean(row.is_mine),
    desc: row.desc,
    authorName: row.author_name,
    authorId: row.author_id,
    url: row.url,
    raw: parseJson(row.raw, {}),
    liked: Boolean(row.liked),
    commented: Boolean(row.commented),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapComment(row) {
  if (!row) return null;
  return {
    cid: row.cid,
    awemeId: row.aweme_id,
    accountId: row.account_id,
    userName: row.user_name,
    userId: row.user_id,
    text: row.text,
    diggCount: row.digg_count,
    replied: Boolean(row.replied),
    replyCid: row.reply_cid,
    raw: parseJson(row.raw, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSearchSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    keyword: row.keyword,
    targetCount: row.target_count,
    actualCount: row.actual_count,
    status: row.status,
    excludeKnown: Boolean(row.exclude_known),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnowledge(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReplyDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    awemeId: row.aweme_id,
    commentId: row.comment_id,
    category: row.category,
    intentLevel: row.intent_level,
    reason: row.reason,
    draftText: row.draft_text,
    status: row.status,
    knowledgeRefs: parseJson(row.knowledge_refs, []),
    raw: parseJson(row.raw, {}),
    publishedCid: row.published_cid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createSearchSession(db, input = {}) {
  const timestamp = nowIso();
  const id = input.id || idWithPrefix('search');
  const targetCount = Math.max(1, Math.min(Number(input.count || input.targetCount || 100), 500));
  db.prepare(`
    INSERT INTO search_sessions (
      id, account_id, keyword, target_count, actual_count, status, exclude_known, error, created_at, updated_at
    ) VALUES (
      @id, @accountId, @keyword, @targetCount, 0, @status, @excludeKnown, NULL, @createdAt, @updatedAt
    )
  `).run({
    id,
    accountId: input.accountId,
    keyword: String(input.keyword || '').trim(),
    targetCount,
    status: input.status || 'pending',
    excludeKnown: bool(input.excludeKnown !== false),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getSearchSession(db, id);
}

function updateSearchSession(db, id, patch = {}) {
  const existing = getSearchSession(db, id);
  if (!existing) return null;
  db.prepare(`
    UPDATE search_sessions
    SET actual_count = @actualCount,
        status = @status,
        error = @error,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    actualCount: patch.actualCount !== undefined ? patch.actualCount : existing.actualCount,
    status: patch.status || existing.status,
    error: patch.error !== undefined ? patch.error : existing.error,
    updatedAt: nowIso(),
  });
  return getSearchSession(db, id);
}

function getSearchSession(db, id) {
  return mapSearchSession(db.prepare('SELECT * FROM search_sessions WHERE id = ?').get(id));
}

function listSearchSessions(db, filters = {}) {
  if (filters.accountId) {
    return db.prepare('SELECT * FROM search_sessions WHERE account_id = ? ORDER BY created_at DESC')
      .all(filters.accountId)
      .map(mapSearchSession);
  }
  return db.prepare('SELECT * FROM search_sessions ORDER BY created_at DESC').all().map(mapSearchSession);
}

function upsertVideo(db, input = {}) {
  const awemeId = String(input.awemeId || input.aweme_id || '').trim();
  if (!awemeId) throw new Error('awemeId is required');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO videos (
      aweme_id, account_id, search_session_id, source, is_mine, desc, author_name, author_id, url, raw,
      liked, commented, created_at, updated_at
    ) VALUES (
      @awemeId, @accountId, @searchSessionId, @source, @isMine, @desc, @authorName, @authorId, @url, @raw,
      @liked, @commented, @createdAt, @updatedAt
    )
    ON CONFLICT(aweme_id) DO UPDATE SET
      account_id = COALESCE(excluded.account_id, videos.account_id),
      search_session_id = COALESCE(excluded.search_session_id, videos.search_session_id),
      source = excluded.source,
      is_mine = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE videos.is_mine END,
      desc = COALESCE(NULLIF(excluded.desc, ''), videos.desc),
      author_name = COALESCE(NULLIF(excluded.author_name, ''), videos.author_name),
      author_id = COALESCE(NULLIF(excluded.author_id, ''), videos.author_id),
      url = COALESCE(NULLIF(excluded.url, ''), videos.url),
      raw = excluded.raw,
      liked = CASE WHEN excluded.liked = 1 THEN 1 ELSE videos.liked END,
      commented = CASE WHEN excluded.commented = 1 THEN 1 ELSE videos.commented END,
      updated_at = excluded.updated_at
  `).run({
    awemeId,
    accountId: input.accountId || null,
    searchSessionId: input.searchSessionId || null,
    source: input.source || 'search',
    isMine: bool(input.isMine),
    desc: String(input.desc || ''),
    authorName: String(input.authorName || ''),
    authorId: String(input.authorId || ''),
    url: input.url || `https://www.douyin.com/video/${awemeId}`,
    raw: stringifyJson(input.raw || {}),
    liked: bool(input.liked),
    commented: bool(input.commented),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getVideo(db, awemeId);
}

function getVideo(db, awemeId) {
  return mapVideo(db.prepare('SELECT * FROM videos WHERE aweme_id = ?').get(awemeId));
}

function listVideos(db, filters = {}) {
  if (filters.searchSessionId) {
    return db.prepare('SELECT * FROM videos WHERE search_session_id = ? ORDER BY updated_at DESC')
      .all(filters.searchSessionId)
      .map(mapVideo);
  }
  if (filters.isMine !== undefined && filters.accountId) {
    return db.prepare('SELECT * FROM videos WHERE account_id = ? AND is_mine = ? ORDER BY updated_at DESC')
      .all(filters.accountId, bool(filters.isMine))
      .map(mapVideo);
  }
  return db.prepare('SELECT * FROM videos ORDER BY updated_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(filters.limit || 200), 1000)))
    .map(mapVideo);
}

function videoExists(db, awemeId) {
  return Boolean(db.prepare('SELECT 1 FROM videos WHERE aweme_id = ?').get(String(awemeId)));
}

function markVideoAction(db, awemeId, patch = {}) {
  const existing = getVideo(db, awemeId);
  if (!existing) return null;
  db.prepare(`
    UPDATE videos
    SET liked = CASE WHEN @liked IS NULL THEN liked ELSE @liked END,
        commented = CASE WHEN @commented IS NULL THEN commented ELSE @commented END,
        updated_at = @updatedAt
    WHERE aweme_id = @awemeId
  `).run({
    awemeId,
    liked: patch.liked === undefined ? null : bool(patch.liked),
    commented: patch.commented === undefined ? null : bool(patch.commented),
    updatedAt: nowIso(),
  });
  return getVideo(db, awemeId);
}

function upsertComment(db, input = {}) {
  const cid = String(input.cid || '').trim();
  if (!cid) throw new Error('cid is required');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO comments (
      cid, aweme_id, account_id, user_name, user_id, text, digg_count, replied, reply_cid, raw, created_at, updated_at
    ) VALUES (
      @cid, @awemeId, @accountId, @userName, @userId, @text, @diggCount, @replied, @replyCid, @raw, @createdAt, @updatedAt
    )
    ON CONFLICT(cid) DO UPDATE SET
      aweme_id = excluded.aweme_id,
      account_id = COALESCE(excluded.account_id, comments.account_id),
      user_name = COALESCE(NULLIF(excluded.user_name, ''), comments.user_name),
      user_id = COALESCE(NULLIF(excluded.user_id, ''), comments.user_id),
      text = COALESCE(NULLIF(excluded.text, ''), comments.text),
      digg_count = COALESCE(excluded.digg_count, comments.digg_count),
      replied = CASE WHEN excluded.replied = 1 THEN 1 ELSE comments.replied END,
      reply_cid = COALESCE(excluded.reply_cid, comments.reply_cid),
      raw = excluded.raw,
      updated_at = excluded.updated_at
  `).run({
    cid,
    awemeId: String(input.awemeId || ''),
    accountId: input.accountId || null,
    userName: String(input.userName || ''),
    userId: String(input.userId || ''),
    text: String(input.text || ''),
    diggCount: input.diggCount === undefined ? null : Number(input.diggCount),
    replied: bool(input.replied),
    replyCid: input.replyCid || null,
    raw: stringifyJson(input.raw || {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getComment(db, cid);
}

function getComment(db, cid) {
  return mapComment(db.prepare('SELECT * FROM comments WHERE cid = ?').get(cid));
}

function listComments(db, filters = {}) {
  if (filters.awemeId) {
    return db.prepare('SELECT * FROM comments WHERE aweme_id = ? ORDER BY COALESCE(digg_count, 0) DESC, updated_at DESC')
      .all(filters.awemeId)
      .map(mapComment);
  }
  if (filters.accountId) {
    return db.prepare('SELECT * FROM comments WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(filters.accountId, Math.max(1, Math.min(Number(filters.limit || 300), 1000)))
      .map(mapComment);
  }
  return db.prepare('SELECT * FROM comments ORDER BY updated_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(filters.limit || 300), 1000)))
    .map(mapComment);
}

function markCommentReplied(db, cid, replyCid) {
  db.prepare('UPDATE comments SET replied = 1, reply_cid = ?, updated_at = ? WHERE cid = ?')
    .run(replyCid || null, nowIso(), cid);
  return getComment(db, cid);
}

function createKnowledgeEntry(db, input = {}) {
  const id = input.id || idWithPrefix('know');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO knowledge_entries (id, title, content, tags, enabled, created_at, updated_at)
    VALUES (@id, @title, @content, @tags, @enabled, @createdAt, @updatedAt)
  `).run({
    id,
    title: String(input.title || '').trim() || '未命名知识',
    content: String(input.content || '').trim(),
    tags: String(input.tags || ''),
    enabled: bool(input.enabled !== false),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getKnowledgeEntry(db, id);
}

function getKnowledgeEntry(db, id) {
  return mapKnowledge(db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id));
}

function listKnowledgeEntries(db, filters = {}) {
  const rows = filters.enabledOnly
    ? db.prepare('SELECT * FROM knowledge_entries WHERE enabled = 1 ORDER BY updated_at DESC').all()
    : db.prepare('SELECT * FROM knowledge_entries ORDER BY updated_at DESC').all();
  return rows.map(mapKnowledge);
}

function updateKnowledgeEntry(db, id, patch = {}) {
  const existing = getKnowledgeEntry(db, id);
  if (!existing) return null;
  db.prepare(`
    UPDATE knowledge_entries
    SET title = @title,
        content = @content,
        tags = @tags,
        enabled = @enabled,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    title: patch.title !== undefined ? String(patch.title).trim() || existing.title : existing.title,
    content: patch.content !== undefined ? String(patch.content).trim() : existing.content,
    tags: patch.tags !== undefined ? String(patch.tags) : existing.tags,
    enabled: patch.enabled !== undefined ? bool(patch.enabled) : bool(existing.enabled),
    updatedAt: nowIso(),
  });
  return getKnowledgeEntry(db, id);
}

function deleteKnowledgeEntry(db, id) {
  return db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0;
}

function upsertReplyDraft(db, input = {}) {
  const id = input.id || idWithPrefix('draft');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO reply_drafts (
      id, account_id, aweme_id, comment_id, category, intent_level, reason, draft_text, status,
      knowledge_refs, raw, published_cid, created_at, updated_at
    ) VALUES (
      @id, @accountId, @awemeId, @commentId, @category, @intentLevel, @reason, @draftText, @status,
      @knowledgeRefs, @raw, @publishedCid, @createdAt, @updatedAt
    )
    ON CONFLICT(comment_id) DO UPDATE SET
      category = excluded.category,
      intent_level = excluded.intent_level,
      reason = excluded.reason,
      draft_text = excluded.draft_text,
      status = CASE WHEN reply_drafts.status = 'published' THEN reply_drafts.status ELSE excluded.status END,
      knowledge_refs = excluded.knowledge_refs,
      raw = excluded.raw,
      updated_at = excluded.updated_at
  `).run({
    id,
    accountId: input.accountId,
    awemeId: input.awemeId,
    commentId: input.commentId,
    category: input.category || '',
    intentLevel: input.intentLevel || '',
    reason: input.reason || '',
    draftText: String(input.draftText || '').trim(),
    status: input.status || 'draft',
    knowledgeRefs: stringifyJson(input.knowledgeRefs || []),
    raw: stringifyJson(input.raw || {}),
    publishedCid: input.publishedCid || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getReplyDraftByComment(db, input.commentId);
}

function getReplyDraft(db, id) {
  return mapReplyDraft(db.prepare('SELECT * FROM reply_drafts WHERE id = ?').get(id));
}

function getReplyDraftByComment(db, commentId) {
  return mapReplyDraft(db.prepare('SELECT * FROM reply_drafts WHERE comment_id = ?').get(commentId));
}

function listReplyDrafts(db, filters = {}) {
  if (filters.accountId) {
    return db.prepare('SELECT * FROM reply_drafts WHERE account_id = ? ORDER BY updated_at DESC')
      .all(filters.accountId)
      .map(mapReplyDraft);
  }
  return db.prepare('SELECT * FROM reply_drafts ORDER BY updated_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(filters.limit || 300), 1000)))
    .map(mapReplyDraft);
}

function updateReplyDraft(db, id, patch = {}) {
  const existing = getReplyDraft(db, id);
  if (!existing) return null;
  db.prepare(`
    UPDATE reply_drafts
    SET draft_text = @draftText,
        status = @status,
        published_cid = @publishedCid,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    draftText: patch.draftText !== undefined ? String(patch.draftText).trim() : existing.draftText,
    status: patch.status || existing.status,
    publishedCid: patch.publishedCid !== undefined ? patch.publishedCid : existing.publishedCid,
    updatedAt: nowIso(),
  });
  return getReplyDraft(db, id);
}

module.exports = {
  createKnowledgeEntry,
  createSearchSession,
  deleteKnowledgeEntry,
  getComment,
  getKnowledgeEntry,
  getReplyDraft,
  getSearchSession,
  getVideo,
  listComments,
  listKnowledgeEntries,
  listReplyDrafts,
  listSearchSessions,
  listVideos,
  markCommentReplied,
  markVideoAction,
  updateKnowledgeEntry,
  updateReplyDraft,
  updateSearchSession,
  upsertComment,
  upsertReplyDraft,
  upsertVideo,
  videoExists,
};
