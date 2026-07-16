const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const leases = require('../lib/desktop/operation-lease');
const tasks = require('../lib/desktop/tasks');
const { extractDouyinUrl, resolveAwemeIdInput, runTask } = require('../lib/desktop/task-runner');

describe('desktop task runner', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-task-runner-'));
    db = openDesktopDb({ storageDir: dir });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a search task', async () => {
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
    expect(result.resultSummary.items).toHaveLength(2);
    expect(result.resultSummary.items[0].url).toBe('https://www.douyin.com/video/1');
  });

  it('requests only the needed search page size and compacts the browser payload', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '没事', count: 5 },
    });

    const expressions = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        return {
          ok: true,
          value: {
            data: Array.from({ length: 8 }, (_, index) => ({
              aweme_info: {
                aweme_id: String(8000 + index),
                desc: `搜索结果 ${index}`,
                author: { nickname: `作者 ${index}` },
              },
            })),
          },
        };
      },
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(expressions[0]).toContain(", 0, 5)");
    expect(expressions[0]).toContain('.then(function(result)');
    expect(expressions[0]).toContain('aweme_info');
    expect(result.resultSummary.requested).toBe(5);
    expect(result.resultSummary.count).toBe(5);
    expect(result.resultSummary.items.map((item) => item.awemeId)).toEqual(['8000', '8001', '8002', '8003', '8004']);
  });

  it('stops a search task after repeated pages add no new items', async () => {
    const account = accounts.createAccount(db, { name: 'accountA' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: 'geo', count: 5 },
    });

    let calls = 0;
    const fakeBridge = {
      call: async () => {
        calls += 1;
        return {
          ok: true,
          value: {
            data: Array.from({ length: 20 }, () => ({
              aweme_info: { aweme_id: '9001', desc: 'same video' },
            })),
          },
        };
      },
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.count).toBe(1);
    expect(result.resultSummary.stoppedReason).toBe('no_progress');
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('runs a like task', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'like',
      input: { awemeId: '123', action: 'like' },
    });

    const fakeBridge = {
      call: async ({ expression }) => ({
        ok: true,
        value: {
          status_code: 0,
          expression,
        },
      }),
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.action).toBe('like');
    expect(result.resultSummary.awemeId).toBe('123');
  });

  it('does not call bridge write APIs while the global write lease is held by another task', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'like',
      input: { awemeId: '123', action: 'like' },
    });

    const heldLease = leases.acquireWriteLease(db, 'existing-writer', 60_000);
    expect(heldLease.acquired).toBe(true);

    let bridgeCalls = 0;
    const result = await runTask(db, task.id, {
      bridgeClient: {
        call: async () => {
          bridgeCalls += 1;
          return { ok: true, value: { status_code: 0 } };
        },
      },
      writeLeaseMaxWaitMs: 100,
      writeLeasePollMs: 50,
      sleepFn: async () => {},
    });

    expect(bridgeCalls).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/write lease/i);
  });

  it('runs a publish task', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'publish',
      input: {
        awemeId: '123',
        text: '这是一条测试评论',
        replyToCommentId: '999',
      },
    });

    const fakeBridge = {
      call: async ({ expression }) => ({
        ok: true,
        value: {
          status_code: 0,
          comment: { cid: 'cmt_1', text: '这是一条测试评论' },
          expression,
        },
      }),
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.cid).toBe('cmt_1');
    expect(result.resultSummary.awemeId).toBe('123');
  });

  it('extracts aweme id from a long Douyin URL before publishing', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'publish',
      input: {
        awemeId: 'https://www.douyin.com/video/7388888888888888888?previous_page=app_code_link',
        text: '测试评论',
      },
    });

    let publishExpression = '';
    const fakeBridge = {
      call: async ({ expression }) => {
        publishExpression = expression;
        return {
          ok: true,
          value: {
            status_code: 0,
            comment: { cid: 'cmt_url', text: '测试评论' },
          },
        };
      },
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.awemeId).toBe('7388888888888888888');
    expect(publishExpression).toContain("window.__bridge.publish('7388888888888888888'");
  });

  it('resolves short Douyin links through HTTP redirect before publishing', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'publish',
      input: {
        awemeId: 'https://v.douyin.com/abc123/',
        text: '短链测试',
      },
    });

    vi.stubGlobal('fetch', async () => ({
      url: 'https://www.douyin.com/video/7399999999999999999',
      text: async () => '',
    }));

    const expressions = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        return {
          ok: true,
          value: {
            status_code: 0,
            comment: { cid: 'cmt_short', text: '短链测试' },
          },
        };
      },
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.awemeId).toBe('7399999999999999999');
    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("window.__bridge.publish('7399999999999999999'");
  });

  it('extracts a Douyin short link from share text before resolving', async () => {
    const shareText = '6.69 x@S.Yz hba:/ 11/29 :3pm 听说这也是男人减速带 # 假面骑士 # csm # 高级感 https://v.douyin.com/CW6QHjYo6ms/ 复制此链接，打开Dou音搜索，直接观看视频！';
    expect(extractDouyinUrl(shareText)).toBe('https://v.douyin.com/CW6QHjYo6ms/');

    const resolved = await resolveAwemeIdInput(shareText, null, {
      fetchImpl: async () => ({
        url: 'https://www.douyin.com/video/7311111111111111111',
        text: async () => '',
      }),
    });

    expect(resolved).toBe('7311111111111111111');
  });

  it('falls back to the browser bridge when HTTP short-link resolution fails', async () => {
    const fakeBridge = {
      call: async ({ expression }) => {
        expect(expression).toContain('fetch(raw');
        return { ok: true, value: '7399999999999999999' };
      },
    };
    const resolved = await resolveAwemeIdInput('https://v.douyin.com/abc123/', fakeBridge, {
      fetchImpl: async () => {
        throw new Error('network blocked');
      },
    });

    expect(resolved).toBe('7399999999999999999');
  });

  it('runs a delete-comment task', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'delete-comment',
      input: { commentId: 'cmt_x' },
    });

    const fakeBridge = {
      call: async () => ({
        ok: true,
        value: { status_code: 0 },
      }),
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.commentId).toBe('cmt_x');
  });

  it('releases the global write lease after a write task throws', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'delete-comment',
      input: { commentId: 'cmt_release' },
    });

    const result = await runTask(db, task.id, {
      bridgeClient: {
        call: async () => {
          throw new Error('delete failed');
        },
      },
    });

    expect(result.status).toBe('failed');
    const nextLease = leases.acquireWriteLease(db, 'after-delete-error', 60_000);
    expect(nextLease.acquired).toBe(true);
  });

  it('runs a suggest task and can keep draft', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'suggest',
      input: { sourceText: '很好看' },
    });

    const fakeBridge = { call: async () => ({ ok: true, value: {} }) };
    const fakeLLM = {
      suggestReplies: async () => [{ cid: 'source', reply: '谢谢你，回复得很热情！' }],
    };

    const result = await runTask(db, task.id, {
      bridgeClient: fakeBridge,
      llmClient: fakeLLM,
    });
    expect(result.status).toBe('success');
    expect(result.resultSummary.suggested).toContain('谢谢');
  });

  it('does not auto-publish suggest replies while the global write lease is held', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'suggest',
      input: {
        sourceText: '很好看',
        awemeId: '123',
        replyToCommentId: 'c1',
        autoPublish: true,
      },
    });

    const heldLease = leases.acquireWriteLease(db, 'existing-writer', 60_000);
    expect(heldLease.acquired).toBe(true);

    let bridgeCalls = 0;
    const result = await runTask(db, task.id, {
      bridgeClient: {
        call: async () => {
          bridgeCalls += 1;
          return { ok: true, value: { status_code: 0, comment: { cid: 'cmt_auto' } } };
        },
      },
      llmClient: {
        suggestReplies: async () => [{ cid: 'source', reply: '自动回复内容' }],
      },
      writeLeaseMaxWaitMs: 100,
      writeLeasePollMs: 50,
      sleepFn: async () => {},
    });

    expect(bridgeCalls).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/write lease/i);
  });

  it('keeps draft-only suggest tasks running without the write lease', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'suggest',
      input: { sourceText: '很好看', autoPublish: false },
    });

    const heldLease = leases.acquireWriteLease(db, 'writer-in-progress', 60_000);
    expect(heldLease.acquired).toBe(true);

    const result = await runTask(db, task.id, {
      bridgeClient: { call: async () => ({ ok: true, value: {} }) },
      llmClient: {
        suggestReplies: async () => [{ cid: 'source', reply: '仅草稿回复' }],
      },
    });

    expect(result.status).toBe('success');
    expect(result.resultSummary.autoPublish).toBe(false);
    expect(result.resultSummary.suggested).toContain('草稿');
  });

  it('runs read-only search even when the global write lease is already held', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: 'geo', count: 2 },
    });

    const heldLease = leases.acquireWriteLease(db, 'writer-in-progress', 60_000);
    expect(heldLease.acquired).toBe(true);

    let calls = 0;
    const result = await runTask(db, task.id, {
      bridgeClient: {
        call: async ({ expression }) => {
          calls += 1;
          return {
            ok: true,
            value: {
              data: [
                { aweme_info: { aweme_id: '9101', desc: 'geo 1', author: { nickname: 'a' } } },
                { aweme_info: { aweme_id: '9102', desc: 'geo 2', author: { nickname: 'b' } } },
              ],
              expression,
            },
          };
        },
      },
    });

    expect(calls).toBe(1);
    expect(result.status).toBe('success');
    expect(result.resultSummary.items).toHaveLength(2);
  });
});
