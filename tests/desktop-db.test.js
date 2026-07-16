const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const tasks = require('../lib/desktop/tasks');
const events = require('../lib/desktop/events');
const batch = require('../lib/desktop/batch');
const workspace = require('../lib/desktop/workspace');

describe('desktop db', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-desktop-db-'));
    db = openDesktopDb({ storageDir: dir });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates, updates, lists, and deletes accounts', () => {
    const account = accounts.createAccount(db, {
      name: '账号A',
      group: '默认分组',
      proxyConfig: { mode: 'none' },
      notes: '测试账号',
    });

    expect(account.id).toMatch(/^acct_/);
    expect(account.profileKey).toBe(account.id);
    expect(account.status).toBe('login_required');

    const updated = accounts.updateAccount(db, account.id, {
      status: 'online',
      notes: '已登录',
    });
    expect(updated.status).toBe('online');
    expect(updated.notes).toBe('已登录');

    expect(accounts.listAccounts(db)).toHaveLength(1);
    expect(accounts.deleteAccount(db, account.id)).toBe(true);
    expect(accounts.listAccounts(db)).toHaveLength(0);
  });

  it('creates tasks and records status transitions', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '美食', count: 3 },
    });

    expect(task.status).toBe('pending');
    expect(task.input.keyword).toBe('美食');

    const running = tasks.updateTaskStatus(db, task.id, 'running', {
      resultSummary: { step: 'bridge_call' },
    });
    expect(running.status).toBe('running');

    const rows = tasks.listTasks(db, { accountId: account.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].resultSummary.step).toBe('bridge_call');
  });

  it('appends and lists event logs', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '穿搭' },
    });

    events.appendEvent(db, {
      accountId: account.id,
      taskId: task.id,
      level: 'info',
      message: '任务已创建',
      metadata: { type: 'search' },
    });

    const logs = events.listEvents(db, { taskId: task.id, limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('任务已创建');
    expect(logs[0].metadata.type).toBe('search');
  });

  it('stores maintainable knowledge metadata and rebuilds searchable chunks', () => {
    const content = [
      `GEO 服务说明 ${'内容'.repeat(500)}`,
      `收费说明 ${'需求评估'.repeat(260)}`,
    ].join('\n\n');
    const created = workspace.createKnowledgeEntry(db, {
      title: 'GEO 服务说明',
      category: '服务说明',
      tags: 'GEO,获客',
      content,
      sourceType: 'markdown',
      sourceName: '01-GEO服务说明.md',
      sourceSize: Buffer.byteLength(content),
    });

    expect(created).toMatchObject({
      title: 'GEO 服务说明',
      category: '服务说明',
      sourceType: 'markdown',
      sourceName: '01-GEO服务说明.md',
      version: 1,
    });
    expect(created.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.chunkCount).toBeGreaterThan(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_id = ?').get(created.id).count)
      .toBe(created.chunkCount);

    const updated = workspace.updateKnowledgeEntry(db, created.id, {
      content: '更新后的 GEO 服务内容。根据实际需求评估。',
    });
    expect(updated.version).toBe(2);
    expect(updated.contentHash).not.toBe(created.contentHash);
    expect(updated.chunkCount).toBe(1);

    const unchanged = workspace.updateKnowledgeEntry(db, created.id, {
      title: updated.title,
      category: updated.category,
      tags: updated.tags,
      content: updated.content,
    });
    expect(unchanged.version).toBe(2);

    expect(workspace.deleteKnowledgeEntry(db, created.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_id = ?').get(created.id).count)
      .toBe(0);
  });

  it('retrieves relevant Chinese knowledge chunks from natural questions', () => {
    const pricing = workspace.createKnowledgeEntry(db, {
      title: 'GEO 收费说明',
      category: '常见问题',
      tags: '收费,报价',
      content: '收费需要结合行业、现有内容、目标范围和交付内容进行人工评估。',
    });
    workspace.createKnowledgeEntry(db, {
      title: '账号登录说明',
      category: '系统帮助',
      content: '账号浏览器用于保存登录状态。',
    });

    const relevant = workspace.findRelevantKnowledge(db, '请问你们的 GEO 服务怎么收费？');

    expect(relevant).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pricing.id, title: 'GEO 收费说明' }),
    ]));
    expect(relevant.some((item) => item.title === '账号登录说明')).toBe(false);
  });

  it('recovers interrupted batch jobs as paused without losing completed items', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    workspace.upsertVideo(db, { awemeId: '8001', accountId: account.id });
    workspace.upsertVideo(db, { awemeId: '8002', accountId: account.id });
    const job = batch.createBatchJob(db, {
      accountId: account.id,
      type: 'like',
      items: [{ awemeId: '8001' }, { awemeId: '8002' }],
    });
    const items = batch.listBatchItems(db, job.id);
    batch.updateBatchItemStatus(db, items[0].id, 'success');
    batch.updateBatchItemStatus(db, items[1].id, 'running');
    batch.updateBatchJobStatus(db, job.id, 'running');

    expect(batch.recoverInterruptedBatchJobs(db)).toBe(1);
    expect(batch.getBatchJob(db, job.id).status).toBe('paused');
    expect(batch.listBatchItems(db, job.id).map((item) => item.status)).toEqual(['success', 'pending']);
  });

  it('limits visible search history to the most recent three sessions', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const created = Array.from({ length: 5 }, (_, index) => workspace.createSearchSession(db, {
      id: `search_${index + 1}`,
      accountId: account.id,
      keyword: `关键词${index + 1}`,
      count: 10,
    }));

    const visible = workspace.listSearchSessions(db, { accountId: account.id, limit: 3 });
    expect(visible).toHaveLength(3);
    expect(visible.map((session) => session.id)).toEqual(created.slice(-3).reverse().map((session) => session.id));
  });

  it('orders my videos by publish time instead of the last synchronization time', () => {
    const account = accounts.createAccount(db, { name: 'Account A' });
    workspace.upsertVideo(db, {
      awemeId: '7261596136765394176',
      accountId: account.id,
      isMine: true,
      publishTime: 1720000000000,
    });
    workspace.upsertVideo(db, {
      awemeId: '7248475670723005736',
      accountId: account.id,
      isMine: true,
      publishTime: 1710000000000,
    });
    workspace.upsertVideo(db, {
      awemeId: '7236715558283037967',
      accountId: account.id,
      isMine: true,
    });
    db.prepare('UPDATE videos SET updated_at = ? WHERE aweme_id = ?')
      .run('2099-01-01T00:00:00.000Z', '7248475670723005736');

    expect(workspace.listVideos(db, { accountId: account.id, isMine: true }).map((video) => video.awemeId))
      .toEqual(['7261596136765394176', '7248475670723005736', '7236715558283037967']);
    expect(workspace.getVideo(db, '7261596136765394176').publishTime).toBe(1720000000000);
  });

  it('adds and backfills publish time when opening an existing desktop database', () => {
    db.close();
    const databasePath = path.join(dir, 'desktop.db');
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE videos (
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
        updated_at TEXT NOT NULL
      );
      INSERT INTO videos (
        aweme_id, source, is_mine, raw, created_at, updated_at
      ) VALUES (
        'legacy_video', 'my', 1, '{"create_time":1710000000}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacyDb.close();

    db = openDesktopDb({ storageDir: dir });

    const columns = db.prepare('PRAGMA table_info(videos)').all().map((column) => column.name);
    expect(columns).toContain('publish_time');
    expect(workspace.getVideo(db, 'legacy_video').publishTime).toBe(1710000000000);
  });

  it('adds claim token columns without losing legacy DM work rows', () => {
    db.close();
    const databasePath = path.join(dir, 'desktop.db');
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE dm_work_items (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_row_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'analyze',
        type TEXT NOT NULL DEFAULT 'analyze',
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
        lease_expires_at TEXT,
        execution_started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_row_id, kind, dedupe_key)
      );
      INSERT INTO dm_work_items (
        id, account_id, conversation_row_id, kind, type, dedupe_key,
        status, payload, result, created_at, updated_at
      ) VALUES (
        'legacy-work', 'legacy-account', 'legacy-conversation', 'analyze', 'analyze',
        'legacy-dedupe', 'pending', '{}', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacyDb.close();

    db = openDesktopDb({ storageDir: dir });

    const columns = db.prepare('PRAGMA table_info(dm_work_items)').all().map((column) => column.name);
    expect(columns).toContain('claim_token');
    expect(columns).toContain('claim_token_hash');
    expect(db.prepare('SELECT id, status, claim_token, claim_token_hash FROM dm_work_items WHERE id=?')
      .get('legacy-work')).toEqual({
      id: 'legacy-work', status: 'pending', claim_token: null, claim_token_hash: null,
    });
  });
});
