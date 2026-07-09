const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesktopApiServer } = require('../lib/desktop/api-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe('desktop api', () => {
  let dir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-desktop-api-'));
    server = createDesktopApiServer({ storageDir: dir });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns health status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'desktop-backend' });
  });

  it('creates and lists accounts', async () => {
    const create = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A', group: '测试组' }),
    });
    expect(create.status).toBe(201);
    const account = await create.json();
    expect(account.name).toBe('账号A');

    const list = await fetch(`${baseUrl}/api/accounts`);
    expect(await list.json()).toHaveLength(1);
  });

  it('creates a pending search task', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A' }),
    })).json();

    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '美食', count: 3 },
      }),
    });

    expect(create.status).toBe(201);
    const task = await create.json();
    expect(task.status).toBe('pending');
    expect(task.type).toBe('search');
  });

  it('runs a task through the configured runner', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createDesktopApiServer({
      storageDir: dir,
      taskRunner: async (db, taskId) => {
        const taskStore = require('../lib/desktop/tasks');
        return taskStore.updateTaskStatus(db, taskId, 'success', {
          resultSummary: { count: 1 },
          finishedAt: new Date().toISOString(),
        });
      },
    });
    baseUrl = await listen(server);

    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A' }),
    })).json();
    const task = await (await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '美食', count: 3 },
      }),
    })).json();

    const run = await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: 'POST' });
    expect(run.status).toBe(200);
    const result = await run.json();
    expect(result.status).toBe('success');
    expect(result.resultSummary.count).toBe(1);
  });

  it('creates search sessions, batch jobs, knowledge entries, and reply drafts through API', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createDesktopApiServer({
      storageDir: dir,
      workflowOptions: {
        bridgeClient: {
          call: async ({ expression }) => {
            if (expression.includes('window.__bridge.search')) {
              return {
                ok: true,
                value: {
                  data: [
                    { aweme_info: { aweme_id: '9001', desc: 'geo 1', author: { nickname: '作者A' } } },
                    { aweme_info: { aweme_id: '9002', desc: 'geo 2', author: { nickname: '作者B' } } },
                  ],
                },
              };
            }
            return { ok: true, value: { status_code: 0, comment: { cid: 'reply_api', text: '可以聊聊' } } };
          },
        },
        llmClient: {
          generateReplyDrafts: async () => [{
            cid: 'api_cmt',
            category: '价格咨询',
            intentLevel: '高',
            reason: '询问收费',
            reply: '可以，先看看你的需求',
            knowledgeRefs: [],
          }],
        },
      },
    });
    baseUrl = await listen(server);

    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A' }),
    })).json();

    const search = await fetch(`${baseUrl}/api/search-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, keyword: 'geo', count: 2 }),
    });
    expect(search.status).toBe(201);
    const searchBody = await search.json();
    expect(searchBody.results).toHaveLength(2);

    const batch = await fetch(`${baseUrl}/api/batch-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'comment',
        awemeIds: ['9001'],
        commentText: '可以聊聊',
      }),
    });
    expect(batch.status).toBe(201);
    expect((await batch.json()).totalCount).toBe(1);

    const knowledge = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '收费', content: '按需求报价' }),
    });
    expect(knowledge.status).toBe(201);

    const workspace = require('../lib/desktop/workspace');
    const dbPath = require('better-sqlite3');
    const db = new dbPath(path.join(dir, 'desktop.db'));
    workspace.upsertComment(db, {
      cid: 'api_cmt',
      awemeId: '9001',
      accountId: account.id,
      text: '怎么收费？',
    });
    db.close();

    const drafts = await fetch(`${baseUrl}/api/comments/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, commentIds: ['api_cmt'] }),
    });
    expect(drafts.status).toBe(200);
    const draft = (await drafts.json())[0];
    expect(draft.intentLevel).toBe('高');

    const approve = await fetch(`${baseUrl}/api/reply-drafts/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftText: draft.draftText }),
    });
    expect(approve.status).toBe(200);
  });
});
