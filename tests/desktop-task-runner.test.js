const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const tasks = require('../lib/desktop/tasks');
const { runTask } = require('../lib/desktop/task-runner');

describe('desktop task runner', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-task-runner-'));
    db = openDesktopDb({ storageDir: dir });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a search task through bridge client', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '美食', count: 2 },
    });

    const fakeBridge = {
      call: async ({ expression }) => ({
        ok: true,
        value: {
          data: [
            { aweme_info: { aweme_id: '1', desc: '美食视频1' } },
            { aweme_info: { aweme_id: '2', desc: '美食视频2' } },
          ],
          expression,
        },
      }),
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.count).toBe(2);
  });
});
