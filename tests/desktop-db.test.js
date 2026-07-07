const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const tasks = require('../lib/desktop/tasks');
const events = require('../lib/desktop/events');

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
});
