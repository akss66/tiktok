const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
  `);

  return db;
}

module.exports = { openDesktopDb };
