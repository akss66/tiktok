const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeKnowledgeHash, normalizePublishTime, rebuildKnowledgeChunks } = require('./workspace');

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function backfillVideoPublishTimes(db) {
  const rows = db.prepare(`
    SELECT aweme_id, raw FROM videos
    WHERE is_mine = 1 AND publish_time IS NULL
  `).all();
  const update = db.prepare('UPDATE videos SET publish_time = ? WHERE aweme_id = ?');
  const backfill = db.transaction(() => {
    for (const row of rows) {
      let raw;
      try {
        raw = JSON.parse(row.raw || '{}');
      } catch {
        continue;
      }
      const aweme = raw?.aweme_info || raw?.aweme || raw;
      const publishTime = normalizePublishTime(
        aweme?.create_time ?? aweme?.createTime ?? aweme?.publish_time ?? aweme?.publishTime,
      );
      if (publishTime !== null) update.run(publishTime, row.aweme_id);
    }
  });
  backfill();
}

function repairLegacyDmDeliveryStates(db) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE dm_messages
    SET status = 'accepted', updated_at = ?
    WHERE direction = 'outbound'
      AND status = 'sent'
      AND message_key LIKE 'outbound:%'
  `).run(timestamp);

  const drafts = db.prepare(`
    SELECT id, conversation_row_id, content, status
    FROM dm_reply_drafts
    WHERE status IN ('queued', 'accepted')
  `).all();
  const listWork = db.prepare(`
    SELECT dm_work_items.status, dm_work_items.payload, dm_messages.status AS message_status
    FROM dm_work_items
    LEFT JOIN dm_messages ON dm_messages.id = dm_work_items.message_id
    WHERE dm_work_items.conversation_row_id = ?
      AND dm_work_items.type IN ('send_manual', 'send_auto')
    ORDER BY dm_work_items.created_at DESC
  `);
  const updateDraft = db.prepare(`
    UPDATE dm_reply_drafts SET status = ?, updated_at = ? WHERE id = ?
  `);
  for (const draft of drafts) {
    const work = listWork.all(draft.conversation_row_id).find((item) => {
      try {
        const payload = JSON.parse(item.payload || '{}');
        return payload.sourceDraftId === draft.id || payload.text === draft.content;
      } catch {
        return false;
      }
    });
    if (!work) continue;
    let nextStatus = draft.status;
    if (work.status === 'cancelled' || work.message_status === 'cancelled') nextStatus = 'cancelled';
    else if (work.message_status === 'sent') nextStatus = 'sent';
    else if (work.message_status === 'accepted') nextStatus = 'accepted';
    else if (work.status === 'failed' || work.status === 'needs_confirmation') nextStatus = 'needs_review';
    else if (work.status === 'pending' || work.status === 'running') nextStatus = 'queued';
    if (nextStatus !== draft.status) updateDraft.run(nextStatus, timestamp, draft.id);
  }
}

function backfillKnowledgeMetadata(db) {
  const rows = db.prepare(`
    SELECT id, content, content_hash
    FROM knowledge_entries
  `).all();
  const updateHash = db.prepare(`
    UPDATE knowledge_entries SET content_hash = ? WHERE id = ?
  `);
  const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_id = ?');
  const backfill = db.transaction(() => {
    for (const row of rows) {
      if (!row.content_hash) updateHash.run(computeKnowledgeHash(row.content), row.id);
      if (chunkCount.get(row.id).count === 0) rebuildKnowledgeChunks(db, row.id, row.content);
    }
  });
  backfill();
}

function openDesktopDb(options = {}) {
  const storageDir = options.storageDir || process.env.DOUYIN_DESKTOP_STORAGE_DIR || path.join(process.cwd(), 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  const db = new Database(path.join(storageDir, 'desktop.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL UNIQUE,
      proxy_config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'login_required',
      last_seen_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS event_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      task_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_logs_account_id ON event_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_event_logs_task_id ON event_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at);

    CREATE TABLE IF NOT EXISTS search_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      target_count INTEGER NOT NULL DEFAULT 100,
      actual_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      exclude_known INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_sessions_account_id ON search_sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_search_sessions_status ON search_sessions(status);

    CREATE TABLE IF NOT EXISTS videos (
      aweme_id TEXT PRIMARY KEY,
      account_id TEXT,
      search_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'search',
      is_mine INTEGER NOT NULL DEFAULT 0,
      desc TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      author_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      raw TEXT NOT NULL DEFAULT '{}',
      publish_time INTEGER,
      liked INTEGER NOT NULL DEFAULT 0,
      commented INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (search_session_id) REFERENCES search_sessions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_videos_account_id ON videos(account_id);
    CREATE INDEX IF NOT EXISTS idx_videos_search_session_id ON videos(search_session_id);
    CREATE INDEX IF NOT EXISTS idx_videos_is_mine ON videos(is_mine);

    CREATE TABLE IF NOT EXISTS search_session_videos (
      search_session_id TEXT NOT NULL,
      aweme_id TEXT NOT NULL,
      rank_index INTEGER NOT NULL DEFAULT 0,
      was_known INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (search_session_id, aweme_id),
      FOREIGN KEY (search_session_id) REFERENCES search_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_session_videos_aweme_id ON search_session_videos(aweme_id);

    CREATE TABLE IF NOT EXISTS comments (
      cid TEXT PRIMARY KEY,
      aweme_id TEXT NOT NULL,
      account_id TEXT,
      user_name TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      digg_count INTEGER,
      replied INTEGER NOT NULL DEFAULT 0,
      reply_cid TEXT,
      raw TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_comments_aweme_id ON comments(aweme_id);
    CREATE INDEX IF NOT EXISTS idx_comments_account_id ON comments(account_id);
    CREATE INDEX IF NOT EXISTS idx_comments_replied ON comments(replied);

    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL DEFAULT '{}',
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_batch_jobs_account_id ON batch_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);

    CREATE TABLE IF NOT EXISTS batch_items (
      id TEXT PRIMARY KEY,
      batch_job_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      aweme_id TEXT,
      comment_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (batch_job_id) REFERENCES batch_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE SET NULL,
      FOREIGN KEY (comment_id) REFERENCES comments(cid) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batch_items_job_id ON batch_items(batch_job_id);
    CREATE INDEX IF NOT EXISTS idx_batch_items_status ON batch_items(status);

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_enabled ON knowledge_entries(enabled);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (knowledge_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE,
      UNIQUE (knowledge_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_knowledge_id ON knowledge_chunks(knowledge_id);

    CREATE TABLE IF NOT EXISTS reply_drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      aweme_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      intent_level TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      draft_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      knowledge_refs TEXT NOT NULL DEFAULT '[]',
      raw TEXT NOT NULL DEFAULT '{}',
      published_cid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(cid) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_drafts_comment_id ON reply_drafts(comment_id);
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_account_id ON reply_drafts(account_id);
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_status ON reply_drafts(status);

    CREATE TABLE IF NOT EXISTS dm_leads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      comment_id TEXT,
      aweme_id TEXT,
      comment_text TEXT NOT NULL DEFAULT '',
      intent_level TEXT NOT NULL DEFAULT 'unreviewed',
      reason TEXT NOT NULL DEFAULT '',
      draft_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      conversation_id TEXT,
      message_id TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(cid) ON DELETE SET NULL,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE SET NULL,
      UNIQUE (account_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_leads_account_id ON dm_leads(account_id);
    CREATE INDEX IF NOT EXISTS idx_dm_leads_status ON dm_leads(status);
    CREATE INDEX IF NOT EXISTS idx_dm_leads_intent ON dm_leads(intent_level);

    CREATE TABLE IF NOT EXISTS dm_lead_sources (
      lead_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      aweme_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (lead_id, comment_id),
      FOREIGN KEY (lead_id) REFERENCES dm_leads(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(cid) ON DELETE CASCADE,
      FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dm_lead_sources_lead_id ON dm_lead_sources(lead_id);
    CREATE INDEX IF NOT EXISTS idx_dm_lead_sources_aweme_id ON dm_lead_sources(aweme_id);

    CREATE TABLE IF NOT EXISTS dm_monitor_states (
      account_id TEXT PRIMARY KEY,
      platform_user_id TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      setting_source TEXT NOT NULL DEFAULT 'inherited',
      reply_mode_override TEXT,
      history_status TEXT NOT NULL DEFAULT 'realtime_only',
      history_incomplete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dm_conversations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      peer_id TEXT NOT NULL DEFAULT '',
      peer_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      last_message_id TEXT,
      last_message_key TEXT,
      last_message_text TEXT NOT NULL DEFAULT '',
      last_message_at INTEGER,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_read_at TEXT,
      auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
      auto_reply_authorized INTEGER NOT NULL DEFAULT 1,
      auto_reply_consumed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      UNIQUE (account_id, conversation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_conversations_account_id ON dm_conversations(account_id);
    CREATE INDEX IF NOT EXISTS idx_dm_conversations_last_message_at ON dm_conversations(last_message_at DESC);

    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      conversation_row_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_key TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT 'text',
      direction TEXT NOT NULL DEFAULT 'inbound',
      status TEXT NOT NULL DEFAULT 'received',
      content TEXT NOT NULL DEFAULT '',
      timestamp_ms INTEGER NOT NULL,
      raw TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_row_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      UNIQUE (account_id, conversation_id, message_key)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation_row_id ON dm_messages(conversation_row_id);
    CREATE INDEX IF NOT EXISTS idx_dm_messages_account_id ON dm_messages(account_id);
    CREATE INDEX IF NOT EXISTS idx_dm_messages_timestamp_ms ON dm_messages(timestamp_ms);

    CREATE TABLE IF NOT EXISTS dm_reply_drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      conversation_row_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_row_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      UNIQUE (conversation_row_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_reply_drafts_account_id ON dm_reply_drafts(account_id);

    CREATE TABLE IF NOT EXISTS dm_work_items (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      conversation_row_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'auto_reply',
      type TEXT NOT NULL DEFAULT 'send_auto' CHECK (type IN ('analyze', 'send_manual', 'send_auto', 'history_sync')),
      dedupe_key TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 6,
      next_run_at TEXT,
      worker_id TEXT,
      claim_token TEXT,
      claim_token_hash TEXT,
      lease_expires_at TEXT,
      execution_started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_row_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
      UNIQUE (conversation_row_id, kind, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_dm_work_items_account_id ON dm_work_items(account_id);
    CREATE INDEX IF NOT EXISTS idx_dm_work_items_conversation_row_id ON dm_work_items(conversation_row_id);

    CREATE TABLE IF NOT EXISTS operation_leases (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operation_leases_expiry ON operation_leases(lease_expires_at);
  `);

  ensureColumn(db, 'comments', 'parent_cid', 'TEXT');
  ensureColumn(db, 'comments', 'root_cid', 'TEXT');
  ensureColumn(db, 'comments', 'depth', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'comments', 'is_own', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'comments', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'comments', 'deleted_at', 'TEXT');
  ensureColumn(db, 'batch_jobs', 'current_item_id', 'TEXT');
  ensureColumn(db, 'batch_jobs', 'progress_message', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'batch_jobs', 'next_run_at', 'TEXT');
  ensureColumn(db, 'videos', 'publish_time', 'INTEGER');
  ensureColumn(db, 'knowledge_entries', 'category', "TEXT NOT NULL DEFAULT '未分类'");
  ensureColumn(db, 'knowledge_entries', 'source_type', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'knowledge_entries', 'source_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'knowledge_entries', 'source_size', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'knowledge_entries', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'knowledge_entries', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'knowledge_entries', 'imported_at', 'TEXT');
  ensureColumn(db, 'dm_conversations', 'reply_mode_override', 'TEXT');
  ensureColumn(db, 'dm_messages', 'status', "TEXT NOT NULL DEFAULT 'received'");
  ensureColumn(db, 'dm_work_items', 'type', "TEXT NOT NULL DEFAULT 'send_auto'");
  ensureColumn(db, 'dm_work_items', 'result', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'dm_work_items', 'error', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'dm_work_items', 'max_attempts', 'INTEGER NOT NULL DEFAULT 6');
  ensureColumn(db, 'dm_work_items', 'next_run_at', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'worker_id', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'claim_token', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'claim_token_hash', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'execution_started_at', 'TEXT');
  ensureColumn(db, 'dm_work_items', 'completed_at', 'TEXT');
  ensureColumn(db, 'dm_monitor_states', 'enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'dm_monitor_states', 'platform_user_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'dm_monitor_states', 'setting_source', "TEXT NOT NULL DEFAULT 'inherited'");
  ensureColumn(db, 'dm_monitor_states', 'reply_mode_override', 'TEXT');
  ensureColumn(db, 'dm_monitor_states', 'history_status', "TEXT NOT NULL DEFAULT 'realtime_only'");
  ensureColumn(db, 'dm_monitor_states', 'history_incomplete_reason', 'TEXT');
  backfillVideoPublishTimes(db);
  backfillKnowledgeMetadata(db);

  db.prepare(`
    UPDATE dm_work_items
    SET type = CASE
      WHEN kind = 'auto_reply' THEN 'send_auto'
      ELSE COALESCE(NULLIF(kind, ''), 'send_auto')
    END
    WHERE type IS NULL OR type = ''
  `).run();

  db.prepare(`
    UPDATE dm_messages
    SET status = CASE WHEN direction = 'outbound' THEN 'sent' ELSE 'received' END
    WHERE status IS NULL OR status = '' OR (status = 'received' AND direction = 'outbound')
  `).run();

  repairLegacyDmDeliveryStates(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_parent_cid ON comments(parent_cid);
    CREATE INDEX IF NOT EXISTS idx_comments_deleted ON comments(deleted);
    CREATE INDEX IF NOT EXISTS idx_videos_publish_time ON videos(publish_time);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_content_hash ON knowledge_entries(content_hash);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_category ON knowledge_entries(category);
    CREATE INDEX IF NOT EXISTS idx_dm_work_items_status_next_run_at ON dm_work_items(status, next_run_at);
  `);

  return db;
}

module.exports = { openDesktopDb };
