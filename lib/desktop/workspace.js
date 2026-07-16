const crypto = require('crypto');

const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

const KNOWLEDGE_CHUNK_MAX_CHARS = 1200;

function bool(value) {
  return value ? 1 : 0;
}

function normalizePublishTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric < 1e12 ? numeric * 1000 : numeric);
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
    publishTime: row.publish_time === null || row.publish_time === undefined
      ? null
      : Number(row.publish_time),
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
    parentCid: row.parent_cid,
    rootCid: row.root_cid,
    depth: Number(row.depth || 0),
    isOwn: Boolean(row.is_own),
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted_at,
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
    category: row.category || '未分类',
    sourceType: row.source_type || 'manual',
    sourceName: row.source_name || '',
    sourceSize: Number(row.source_size || 0),
    contentHash: row.content_hash || '',
    version: Number(row.version || 1),
    importedAt: row.imported_at || null,
    chunkCount: Number(row.chunk_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeKnowledgeContent(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function computeKnowledgeHash(content) {
  return crypto.createHash('sha256').update(normalizeKnowledgeContent(content), 'utf8').digest('hex');
}

function splitKnowledgeContent(content, maxChars = KNOWLEDGE_CHUNK_MAX_CHARS) {
  const normalized = normalizeKnowledgeContent(content);
  if (!normalized) return [];
  const limit = Math.max(200, Math.floor(Number(maxChars) || KNOWLEDGE_CHUNK_MAX_CHARS));
  const segments = [];
  for (const paragraph of normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    if (paragraph.length <= limit) {
      segments.push(paragraph);
      continue;
    }
    for (let offset = 0; offset < paragraph.length; offset += limit) {
      segments.push(paragraph.slice(offset, offset + limit));
    }
  }
  const chunks = [];
  let current = '';
  for (const segment of segments) {
    const candidate = current ? `${current}\n\n${segment}` : segment;
    if (current && candidate.length > limit) {
      chunks.push(current);
      current = segment;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function rebuildKnowledgeChunks(db, knowledgeId, contentOverride) {
  const row = contentOverride === undefined
    ? db.prepare('SELECT content FROM knowledge_entries WHERE id = ?').get(knowledgeId)
    : { content: contentOverride };
  if (!row) return 0;
  const chunks = splitKnowledgeContent(row.content);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM knowledge_chunks WHERE knowledge_id = ?').run(knowledgeId);
    const insert = db.prepare(`
      INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, content, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const timestamp = nowIso();
    chunks.forEach((chunk, index) => {
      insert.run(idWithPrefix('kchunk'), knowledgeId, index, chunk, chunk.length, timestamp);
    });
  });
  replace();
  return chunks.length;
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
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), 100))
    : null;
  if (filters.accountId) {
    const sql = `
      SELECT * FROM search_sessions
      WHERE account_id = ?
      ORDER BY created_at DESC, rowid DESC
      ${limit ? 'LIMIT ?' : ''}
    `;
    return db.prepare(sql)
      .all(...(limit ? [filters.accountId, limit] : [filters.accountId]))
      .map(mapSearchSession);
  }
  const sql = `
    SELECT * FROM search_sessions
    ORDER BY created_at DESC, rowid DESC
    ${limit ? 'LIMIT ?' : ''}
  `;
  return db.prepare(sql).all(...(limit ? [limit] : [])).map(mapSearchSession);
}

function upsertVideo(db, input = {}) {
  const awemeId = String(input.awemeId || input.aweme_id || '').trim();
  if (!awemeId) throw new Error('awemeId is required');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO videos (
      aweme_id, account_id, search_session_id, source, is_mine, desc, author_name, author_id, url, raw,
      publish_time, liked, commented, created_at, updated_at
    ) VALUES (
      @awemeId, @accountId, @searchSessionId, @source, @isMine, @desc, @authorName, @authorId, @url, @raw,
      @publishTime, @liked, @commented, @createdAt, @updatedAt
    )
    ON CONFLICT(aweme_id) DO UPDATE SET
      account_id = COALESCE(excluded.account_id, videos.account_id),
      search_session_id = COALESCE(videos.search_session_id, excluded.search_session_id),
      source = excluded.source,
      is_mine = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE videos.is_mine END,
      desc = COALESCE(NULLIF(excluded.desc, ''), videos.desc),
      author_name = COALESCE(NULLIF(excluded.author_name, ''), videos.author_name),
      author_id = COALESCE(NULLIF(excluded.author_id, ''), videos.author_id),
      url = COALESCE(NULLIF(excluded.url, ''), videos.url),
      raw = excluded.raw,
      publish_time = COALESCE(excluded.publish_time, videos.publish_time),
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
    publishTime: normalizePublishTime(input.publishTime ?? input.publish_time),
    liked: bool(input.liked),
    commented: bool(input.commented),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getVideo(db, awemeId);
}

function linkSearchSessionVideo(db, input = {}) {
  const searchSessionId = String(input.searchSessionId || '').trim();
  const awemeId = String(input.awemeId || input.aweme_id || '').trim();
  if (!searchSessionId) throw new Error('searchSessionId is required');
  if (!awemeId) throw new Error('awemeId is required');
  db.prepare(`
    INSERT INTO search_session_videos (
      search_session_id, aweme_id, rank_index, was_known, created_at
    ) VALUES (
      @searchSessionId, @awemeId, @rankIndex, @wasKnown, @createdAt
    )
    ON CONFLICT(search_session_id, aweme_id) DO UPDATE SET
      rank_index = MIN(search_session_videos.rank_index, excluded.rank_index),
      was_known = CASE WHEN search_session_videos.was_known = 1 THEN 1 ELSE excluded.was_known END
  `).run({
    searchSessionId,
    awemeId,
    rankIndex: Math.max(0, Number(input.rankIndex || 0)),
    wasKnown: bool(input.wasKnown),
    createdAt: nowIso(),
  });
}

function getVideo(db, awemeId) {
  return mapVideo(db.prepare('SELECT * FROM videos WHERE aweme_id = ?').get(awemeId));
}

function listVideos(db, filters = {}) {
  if (filters.searchSessionId) {
    return db.prepare(`
      SELECT videos.*
      FROM videos
      LEFT JOIN search_session_videos
        ON search_session_videos.aweme_id = videos.aweme_id
       AND search_session_videos.search_session_id = ?
      WHERE search_session_videos.search_session_id IS NOT NULL
         OR videos.search_session_id = ?
      ORDER BY COALESCE(search_session_videos.rank_index, 999999), videos.updated_at DESC
    `)
      .all(filters.searchSessionId, filters.searchSessionId)
      .map(mapVideo);
  }
  if (filters.isMine !== undefined && filters.accountId) {
    return db.prepare(`
      SELECT * FROM videos
      WHERE account_id = ? AND is_mine = ?
      ORDER BY
        CASE WHEN publish_time IS NULL THEN 1 ELSE 0 END,
        publish_time DESC,
        CASE
          WHEN aweme_id NOT GLOB '*[^0-9]*' THEN LENGTH(aweme_id)
          ELSE 0
        END DESC,
        aweme_id DESC
    `)
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
      cid, aweme_id, account_id, user_name, user_id, text, digg_count, replied, reply_cid,
      parent_cid, root_cid, depth, is_own, deleted, deleted_at, raw, created_at, updated_at
    ) VALUES (
      @cid, @awemeId, @accountId, @userName, @userId, @text, @diggCount, @replied, @replyCid,
      @parentCid, @rootCid, @depth, @isOwn, @deleted, @deletedAt, @raw, @createdAt, @updatedAt
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
      parent_cid = COALESCE(excluded.parent_cid, comments.parent_cid),
      root_cid = COALESCE(excluded.root_cid, comments.root_cid),
      depth = excluded.depth,
      is_own = CASE WHEN excluded.is_own = 1 THEN 1 ELSE comments.is_own END,
      deleted = CASE WHEN comments.deleted = 1 THEN 1 ELSE excluded.deleted END,
      deleted_at = COALESCE(comments.deleted_at, excluded.deleted_at),
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
    parentCid: input.parentCid || null,
    rootCid: input.rootCid || input.parentCid || null,
    depth: Math.max(0, Number(input.depth || 0)),
    isOwn: bool(input.isOwn),
    deleted: bool(input.deleted),
    deletedAt: input.deletedAt || null,
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
  const clauses = [];
  const params = [];
  if (filters.awemeId) {
    clauses.push('aweme_id = ?');
    params.push(String(filters.awemeId));
  }
  if (filters.accountId) {
    clauses.push('account_id = ?');
    params.push(String(filters.accountId));
  }
  if (filters.deleted !== undefined) {
    clauses.push('deleted = ?');
    params.push(bool(filters.deleted));
  }
  const query = String(filters.query || '').trim();
  if (query) {
    clauses.push("(user_name LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')");
    const escaped = query.replace(/[\\%_]/g, (value) => `\\${value}`);
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  const limit = Math.max(1, Math.min(Number(filters.limit || (filters.awemeId ? 5000 : 300)), 5000));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM comments
    ${where}
    ORDER BY CASE WHEN parent_cid IS NULL THEN cid ELSE root_cid END,
      depth ASC, COALESCE(digg_count, 0) DESC, updated_at DESC
    LIMIT ?
  `).all(...params, limit).map(mapComment);
}

function markCommentReplied(db, cid, replyCid) {
  db.prepare('UPDATE comments SET replied = 1, reply_cid = ?, updated_at = ? WHERE cid = ?')
    .run(replyCid || null, nowIso(), cid);
  return getComment(db, cid);
}

function markCommentDeleted(db, cid) {
  const timestamp = nowIso();
  db.prepare('UPDATE comments SET deleted = 1, deleted_at = ?, updated_at = ? WHERE cid = ?')
    .run(timestamp, timestamp, cid);
  return getComment(db, cid);
}

function createKnowledgeEntry(db, input = {}) {
  const id = input.id || idWithPrefix('know');
  const timestamp = nowIso();
  const content = normalizeKnowledgeContent(input.content);
  const sourceType = String(input.sourceType || 'manual').trim().toLowerCase() || 'manual';
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO knowledge_entries (
        id, title, content, tags, enabled, category, source_type, source_name,
        source_size, content_hash, version, imported_at, created_at, updated_at
      ) VALUES (
        @id, @title, @content, @tags, @enabled, @category, @sourceType, @sourceName,
        @sourceSize, @contentHash, 1, @importedAt, @createdAt, @updatedAt
      )
    `).run({
      id,
      title: String(input.title || '').trim() || '未命名知识',
      content,
      tags: String(input.tags || '').trim(),
      enabled: bool(input.enabled !== false),
      category: String(input.category || '未分类').trim() || '未分类',
      sourceType,
      sourceName: String(input.sourceName || '').trim(),
      sourceSize: Math.max(0, Math.floor(Number(input.sourceSize) || Buffer.byteLength(content, 'utf8'))),
      contentHash: computeKnowledgeHash(content),
      importedAt: sourceType === 'manual' ? null : timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    rebuildKnowledgeChunks(db, id, content);
  });
  create();
  return getKnowledgeEntry(db, id);
}

function getKnowledgeEntry(db, id) {
  return mapKnowledge(db.prepare(`
    SELECT knowledge_entries.*,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE knowledge_id = knowledge_entries.id) AS chunk_count
    FROM knowledge_entries
    WHERE knowledge_entries.id = ?
  `).get(id));
}

function listKnowledgeEntries(db, filters = {}) {
  const rows = filters.enabledOnly
    ? db.prepare(`SELECT knowledge_entries.*,
        (SELECT COUNT(*) FROM knowledge_chunks WHERE knowledge_id = knowledge_entries.id) AS chunk_count
      FROM knowledge_entries WHERE enabled = 1 ORDER BY updated_at DESC`).all()
    : db.prepare(`SELECT knowledge_entries.*,
        (SELECT COUNT(*) FROM knowledge_chunks WHERE knowledge_id = knowledge_entries.id) AS chunk_count
      FROM knowledge_entries ORDER BY updated_at DESC`).all();
  return rows.map(mapKnowledge);
}

function splitKnowledgeTags(value) {
  return String(value || '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function queryKnowledgeEntries(db, query = {}) {
  const clauses = [];
  const params = [];
  const keyword = String(query.q || '').trim();
  if (keyword) {
    const pattern = `%${keyword}%`;
    clauses.push(`(
      knowledge_entries.title LIKE ? OR knowledge_entries.content LIKE ? OR
      knowledge_entries.tags LIKE ? OR knowledge_entries.source_name LIKE ?
    )`);
    params.push(pattern, pattern, pattern, pattern);
  }
  if (query.status === 'enabled') clauses.push('knowledge_entries.enabled = 1');
  if (query.status === 'disabled') clauses.push('knowledge_entries.enabled = 0');
  if (String(query.category || '').trim()) {
    clauses.push('knowledge_entries.category = ?');
    params.push(String(query.category).trim());
  }
  if (String(query.tag || '').trim()) {
    clauses.push('knowledge_entries.tags LIKE ?');
    params.push(`%${String(query.tag).trim()}%`);
  }
  if (String(query.sourceType || '').trim()) {
    clauses.push('knowledge_entries.source_type = ?');
    params.push(String(query.sourceType).trim().toLowerCase());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortColumns = {
    updatedAt: 'knowledge_entries.updated_at',
    createdAt: 'knowledge_entries.created_at',
    title: 'knowledge_entries.title',
  };
  const sort = sortColumns[query.sort] || sortColumns.updatedAt;
  const order = String(query.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.max(1, Math.min(50, Math.floor(Number(query.pageSize) || 20)));
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_entries ${where}`).get(...params).count || 0);
  const rows = db.prepare(`
    SELECT knowledge_entries.*,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE knowledge_id = knowledge_entries.id) AS chunk_count
    FROM knowledge_entries
    ${where}
    ORDER BY ${sort} ${order}, knowledge_entries.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  const all = db.prepare('SELECT category, tags, source_type FROM knowledge_entries').all();
  return {
    items: rows.map(mapKnowledge),
    total,
    page,
    pageSize,
    facets: {
      categories: [...new Set(all.map((row) => row.category).filter(Boolean))].sort(),
      tags: [...new Set(all.flatMap((row) => splitKnowledgeTags(row.tags)))].sort(),
      sourceTypes: [...new Set(all.map((row) => row.source_type).filter(Boolean))].sort(),
    },
  };
}

function findKnowledgeByHash(db, contentOrHash) {
  const value = String(contentOrHash || '');
  const hash = /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : computeKnowledgeHash(value);
  return mapKnowledge(db.prepare(`
    SELECT knowledge_entries.*,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE knowledge_id = knowledge_entries.id) AS chunk_count
    FROM knowledge_entries WHERE content_hash = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(hash));
}

function bulkUpdateKnowledgeEntries(db, input = {}) {
  const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(String).map((id) => id.trim()).filter(Boolean))];
  const action = String(input.action || '').trim();
  if (!ids.length) return { changed: 0, ids: [] };
  if (!['enable', 'disable', 'delete'].includes(action)) {
    throw new Error('unsupported knowledge bulk action');
  }
  const placeholders = ids.map(() => '?').join(',');
  let changed = 0;
  const run = db.transaction(() => {
    if (action === 'delete') {
      changed = db.prepare(`DELETE FROM knowledge_entries WHERE id IN (${placeholders})`).run(...ids).changes;
      return;
    }
    const enabled = action === 'enable' ? 1 : 0;
    changed = db.prepare(`
      UPDATE knowledge_entries SET enabled = ?, updated_at = ? WHERE id IN (${placeholders})
    `).run(enabled, nowIso(), ...ids).changes;
  });
  run();
  return { changed, ids };
}

function knowledgeQueryTerms(value) {
  const text = String(value || '').toLowerCase();
  const tokens = text.match(/[\p{L}\p{N}]{2,}/gu) || [];
  const terms = new Set();
  for (const token of tokens) {
    terms.add(token);
    const chinese = token.match(/[\p{Script=Han}]+/gu)?.join('') || '';
    if (chinese.length > 2) {
      for (let index = 0; index < chinese.length - 1; index += 1) {
        terms.add(chinese.slice(index, index + 2));
      }
    }
  }
  return [...terms].slice(0, 40);
}

function findRelevantKnowledge(db, text, options = {}) {
  const limit = Math.max(1, Math.min(30, Math.floor(Number(options.limit) || 12)));
  const maxChars = Math.max(500, Math.min(30000, Math.floor(Number(options.maxChars) || 10000)));
  const terms = knowledgeQueryTerms(text);
  const rows = db.prepare(`
    SELECT knowledge_chunks.id AS chunk_id, knowledge_chunks.content AS chunk_content,
      knowledge_entries.*
    FROM knowledge_chunks
    JOIN knowledge_entries ON knowledge_entries.id = knowledge_chunks.knowledge_id
    WHERE knowledge_entries.enabled = 1
    ORDER BY knowledge_entries.updated_at DESC, knowledge_chunks.chunk_index ASC
  `).all();
  const scored = rows.map((row) => {
    const title = String(row.title || '').toLowerCase();
    const tags = String(row.tags || '').toLowerCase();
    const category = String(row.category || '').toLowerCase();
    const content = String(row.chunk_content || '').toLowerCase();
    const score = terms.reduce((sum, term) => sum
      + (title.includes(term) ? 8 : 0)
      + (tags.includes(term) ? 6 : 0)
      + (category.includes(term) ? 4 : 0)
      + (content.includes(term) ? 2 : 0), 0);
    return { row, score };
  }).sort((a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)));
  const selected = [];
  let usedChars = 0;
  for (const { row, score } of scored) {
    if (terms.length && score === 0) continue;
    if (selected.length >= limit) break;
    const content = String(row.chunk_content || '');
    if (usedChars && usedChars + content.length > maxChars) continue;
    selected.push({
      id: row.id,
      chunkId: row.chunk_id,
      title: row.title,
      content,
      tags: row.tags,
      category: row.category,
      enabled: true,
      score,
    });
    usedChars += content.length;
  }
  return selected;
}

function updateKnowledgeEntry(db, id, patch = {}) {
  const existing = getKnowledgeEntry(db, id);
  if (!existing) return null;
  const content = patch.content !== undefined ? normalizeKnowledgeContent(patch.content) : existing.content;
  const title = patch.title !== undefined ? String(patch.title).trim() || existing.title : existing.title;
  const tags = patch.tags !== undefined ? String(patch.tags).trim() : existing.tags;
  const category = patch.category !== undefined
    ? String(patch.category).trim() || '未分类'
    : existing.category;
  const contentChanged = content !== existing.content;
  const metadataChanged = title !== existing.title || tags !== existing.tags || category !== existing.category;
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE knowledge_entries
      SET title = @title,
          content = @content,
          tags = @tags,
          enabled = @enabled,
          category = @category,
          source_type = @sourceType,
          source_name = @sourceName,
          source_size = @sourceSize,
          content_hash = @contentHash,
          version = @version,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      title,
      content,
      tags,
      enabled: patch.enabled !== undefined ? bool(patch.enabled) : bool(existing.enabled),
      category,
      sourceType: patch.sourceType !== undefined ? String(patch.sourceType).trim().toLowerCase() || 'manual' : existing.sourceType,
      sourceName: patch.sourceName !== undefined ? String(patch.sourceName).trim() : existing.sourceName,
      sourceSize: patch.sourceSize !== undefined
        ? Math.max(0, Math.floor(Number(patch.sourceSize) || 0))
        : (contentChanged ? Buffer.byteLength(content, 'utf8') : existing.sourceSize),
      contentHash: computeKnowledgeHash(content),
      version: contentChanged || metadataChanged ? existing.version + 1 : existing.version,
      updatedAt: nowIso(),
    });
    if (contentChanged) rebuildKnowledgeChunks(db, id, content);
  });
  update();
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
    return db.prepare('SELECT * FROM reply_drafts WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(filters.accountId, Math.max(1, Math.min(Number(filters.limit || 1000), 5000)))
      .map(mapReplyDraft);
  }
  return db.prepare('SELECT * FROM reply_drafts ORDER BY updated_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(filters.limit || 300), 5000)))
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
  bulkUpdateKnowledgeEntries,
  computeKnowledgeHash,
  createKnowledgeEntry,
  createSearchSession,
  deleteKnowledgeEntry,
  findKnowledgeByHash,
  findRelevantKnowledge,
  getComment,
  getKnowledgeEntry,
  getReplyDraft,
  getReplyDraftByComment,
  getSearchSession,
  getVideo,
  listComments,
  listKnowledgeEntries,
  listReplyDrafts,
  listSearchSessions,
  listVideos,
  normalizePublishTime,
  queryKnowledgeEntries,
  rebuildKnowledgeChunks,
  linkSearchSessionVideo,
  markCommentReplied,
  markCommentDeleted,
  markVideoAction,
  updateKnowledgeEntry,
  updateReplyDraft,
  updateSearchSession,
  upsertComment,
  upsertReplyDraft,
  upsertVideo,
  videoExists,
  splitKnowledgeContent,
};
