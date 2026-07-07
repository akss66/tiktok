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
  `);

  return db;
}

module.exports = { openDesktopDb };
