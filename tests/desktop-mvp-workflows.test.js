const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const batch = require('../lib/desktop/batch');
const leases = require('../lib/desktop/operation-lease');
const workspace = require('../lib/desktop/workspace');
const workflows = require('../lib/desktop/mvp-workflows');

describe('desktop mvp workflows', () => {
  let dir;
  let db;
  let account;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-mvp-workflows-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A' });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collects search videos up to 500 and skips known videos on the next run', async () => {
    const expressions = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        const offset = Number(expression.match(/,\s*(\d+),\s*\d+\)/)?.[1] || 0);
        return {
          ok: true,
          value: {
            data: Array.from({ length: 20 }, (_, index) => ({
              aweme_info: {
                aweme_id: String(1000 + offset + index),
                desc: `geo 视频 ${offset + index}`,
                author: { nickname: `作者${index}` },
              },
            })),
          },
        };
      },
    };

    const first = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 25,
    }, { bridgeClient: fakeBridge });
    expect(first.session.actualCount).toBe(25);
    expect(first.results[0].awemeId).toBe('1000');
    expect(expressions[0]).toContain(", 0, 20)");
    expect(expressions[0]).toContain('.then(function(result)');
    expect(expressions[0]).toContain('aweme_info');

    const second = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 10,
    }, { bridgeClient: fakeBridge });
    const secondRunFirstExpression = expressions.find((expression, index) => index > 1 && expression.includes(", 0, 10)"));
    expect(secondRunFirstExpression).toBeTruthy();
    expect(second.session.actualCount).toBe(10);
    expect(second.summary.requested).toBe(10);
    expect(second.summary.saved).toBe(10);
    expect(second.summary.skippedKnown).toBe(25);
    expect(second.results.map((item) => item.awemeId)).toEqual([
      '1025', '1026', '1027', '1028', '1029', '1030', '1031', '1032', '1033', '1034',
    ]);
  });

  it('keeps older search session results when the same video appears in a later session', async () => {
    let callCount = 0;
    const fakeBridge = {
      call: async () => {
        callCount += 1;
        const ids = callCount === 1 ? ['5001', '5002', '5003'] : ['5002', '5004'];
        return {
          ok: true,
          value: {
            data: ids.map((id) => ({
              aweme_info: {
                aweme_id: id,
                desc: `video ${id}`,
                author: { nickname: `author ${id}` },
              },
            })),
          },
        };
      },
    };

    const first = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 3,
      excludeKnown: false,
    }, { bridgeClient: fakeBridge });
    const second = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 2,
      excludeKnown: false,
    }, { bridgeClient: fakeBridge });

    expect(workspace.listVideos(db, { searchSessionId: first.session.id }).map((item) => item.awemeId)).toEqual(['5001', '5002', '5003']);
    expect(workspace.listVideos(db, { searchSessionId: second.session.id }).map((item) => item.awemeId)).toEqual(['5002', '5004']);
  });

  it('stops search pagination after repeated pages add no usable videos', async () => {
    workspace.upsertVideo(db, { awemeId: '6001', accountId: account.id, desc: 'known' });
    let calls = 0;
    const fakeBridge = {
      call: async () => {
        calls += 1;
        return {
          ok: true,
          value: {
            data: [{
              aweme_info: {
                aweme_id: '6001',
                desc: 'known',
                author: { nickname: 'known author' },
              },
            }],
          },
        };
      },
    };

    const result = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 5,
    }, { bridgeClient: fakeBridge });

    expect(result.session.actualCount).toBe(0);
    expect(result.summary.stoppedReason).toBe('no_progress');
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('keeps collected search videos when a later page times out', async () => {
    let calls = 0;
    const fakeBridge = {
      call: async () => {
        calls += 1;
        if (calls === 2) {
          throw new Error('Request timeout');
        }
        return {
          ok: true,
          value: {
            data: Array.from({ length: 3 }, (_, index) => ({
              aweme_info: {
                aweme_id: String(4000 + index),
                desc: `video ${index}`,
                author: { nickname: `author ${index}` },
              },
            })),
          },
        };
      },
    };

    const result = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: '美食',
      count: 5,
    }, { bridgeClient: fakeBridge });

    expect(result.session.status).toBe('success');
    expect(result.session.actualCount).toBe(3);
    expect(result.session.error).toContain('响应超时');
    expect(result.results.map((item) => item.awemeId)).toEqual(['4000', '4001', '4002']);
  });

  it('returns a readable search error when the bridge search endpoint fails before any result', async () => {
    const fakeBridge = {
      call: async () => ({
        ok: false,
        error: 'fetch failed',
      }),
    };

    await expect(workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 5,
    }, { bridgeClient: fakeBridge })).rejects.toThrow('关键词「geo」');

    const sessions = workspace.listSearchSessions(db);
    expect(sessions[0].status).toBe('failed');
    expect(sessions[0].error).toContain('fetch failed');
  });

  it('resolves and stores external videos from ids, links, and share text', async () => {
    const direct = await workflows.resolveExternalVideo(db, {
      accountId: account.id,
      input: '7388888888888888888',
    });
    expect(direct).toMatchObject({
      awemeId: '7388888888888888888', accountId: account.id, source: 'external-link', isMine: false,
    });

    const linked = await workflows.resolveExternalVideo(db, {
      accountId: account.id,
      input: '看看这个 https://www.douyin.com/video/7399999999999999999?from=copy',
    });
    expect(linked.awemeId).toBe('7399999999999999999');

    const short = await workflows.resolveExternalVideo(db, {
      accountId: account.id,
      input: '分享视频 https://v.douyin.com/abc123/ 复制打开抖音',
    }, {
      fetchImpl: async () => ({
        url: 'https://www.douyin.com/video/7400000000000000000',
        text: async () => '',
      }),
    });
    expect(short.awemeId).toBe('7400000000000000000');

    await expect(workflows.resolveExternalVideo(db, {
      accountId: account.id,
      input: '不是抖音作品链接',
    })).rejects.toThrow(/作品 ID|抖音作品链接/);
  });

  it('compacts and paginates my videos before returning them across the bridge', async () => {
    const expressions = [];
    let callCount = 0;
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        callCount += 1;
        return {
          ok: true,
          value: callCount === 1
            ? {
              items: [
                { aweme_id: 'mine_1', desc: '作品一', create_time: 1730000000, author: { nickname: '账号A' } },
                { aweme_id: 'mine_2', desc: '作品二', create_time: 1720000000, author: { nickname: '账号A' } },
              ],
              has_more: true,
              next_cursor: 20,
            }
            : {
              items: [
                { aweme_id: 'mine_2', desc: '重复作品', create_time: 1720000000, author: { nickname: '账号A' } },
                { aweme_id: 'mine_3', desc: '作品三', create_time: 1710000000, author: { nickname: '账号A' } },
              ],
              has_more: false,
              next_cursor: 40,
            },
        };
      },
    };

    const result = await workflows.syncMyVideos(db, {
      accountId: account.id,
      count: 10,
    }, { bridgeClient: fakeBridge });

    expect(result.items.map((item) => item.awemeId)).toEqual(['mine_1', 'mine_2', 'mine_3']);
    expect(result.summary).toMatchObject({ requested: 10, saved: 3, pages: 2, stoppedReason: 'complete' });
    expect(expressions[0]).toContain("window.__bridge.myPosts(0, 10).then(function(result)");
    expect(expressions[0]).toContain('aweme_id: String(awemeId)');
    expect(expressions[0]).not.toBe('window.__bridge.myPosts(0, 10)');
  });

  it('preserves publish time and lists synchronized videos newest first', async () => {
    const fakeBridge = {
      call: async () => ({
        ok: true,
        value: {
          items: [
            { aweme_id: 'publish_old', desc: 'Old', create_time: 1710000000 },
            { aweme_id: 'publish_new', desc: 'New', createTime: 1720000000000 },
          ],
          has_more: false,
          next_cursor: 0,
        },
      }),
    };

    const result = await workflows.syncMyVideos(db, {
      accountId: account.id,
      count: 10,
    }, { bridgeClient: fakeBridge });

    expect(result.items.map((video) => video.publishTime)).toEqual([1720000000000, 1710000000000]);
    expect(workspace.listVideos(db, { accountId: account.id, isMine: true }).map((video) => video.awemeId))
      .toEqual(['publish_new', 'publish_old']);
    expect(workflows.buildCompactMyPostsExpression(0, 10)).toContain('create_time');
  });

  it('compacts comments, deduplicates ids, and stops when pagination makes no progress', async () => {
    workspace.upsertVideo(db, { awemeId: 'mine_1', accountId: account.id, desc: '作品一', isMine: true });
    const expressions = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        return {
          ok: true,
          value: {
            comments: [{
              cid: 'comment_1',
              text: '怎么收费',
              digg_count: 8,
              user: { nickname: '客户', uid: 'user_1' },
            }],
            has_more: true,
            next_cursor: 0,
          },
        };
      },
    };

    const result = await workflows.syncComments(db, {
      accountId: account.id,
      awemeId: 'mine_1',
      count: 100,
    }, { bridgeClient: fakeBridge });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ cid: 'comment_1', text: '怎么收费', userName: '客户' });
    expect(result.items[0].raw.user.avatar_thumb).toBeUndefined();
    expect(result.summary).toMatchObject({ requested: 100, saved: 1, pages: 1, stoppedReason: 'no_progress' });
    expect(expressions[0]).toContain("window.__bridge.getComments('mine_1', 0, 50).then(function(result)");
    expect(expressions[0]).toContain('digg_count');
  });

  it('stores nested replies with their conversation context and supports comment search', async () => {
    workspace.upsertVideo(db, {
      awemeId: 'mine_nested',
      accountId: account.id,
      authorId: 'owner_uid',
      isMine: true,
    });
    const fakeBridge = {
      call: async () => ({
        ok: true,
        value: {
          comments: [{
            cid: 'root_comment',
            text: '怎么收费',
            user: { nickname: '咨询客户', uid: 'customer_uid' },
            reply_comment: [{
              cid: 'child_comment',
              text: '我也想了解',
              user: { nickname: '跟进客户', uid: 'follow_uid' },
            }],
          }],
          has_more: false,
          next_cursor: 0,
        },
      }),
    };

    const result = await workflows.syncComments(db, {
      accountId: account.id,
      awemeId: 'mine_nested',
      count: 100,
    }, { bridgeClient: fakeBridge });

    expect(result.items).toHaveLength(2);
    expect(workspace.getComment(db, 'child_comment')).toMatchObject({
      parentCid: 'root_comment',
      rootCid: 'root_comment',
      depth: 1,
    });
    expect(workspace.listComments(db, { awemeId: 'mine_nested', query: '跟进客户' }))
      .toHaveLength(1);
    expect(workspace.listComments(db, { awemeId: 'mine_nested', query: '收费' })[0].cid)
      .toBe('root_comment');
  });

  it('fetches remaining nested replies sequentially when they are not embedded in the first-level response', async () => {
    workspace.upsertVideo(db, { awemeId: 'mine_replies', accountId: account.id, isMine: true });
    const expressions = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        expressions.push(expression);
        if (expression.includes('window.__bridge.replies')) {
          return {
            ok: true,
            value: {
              comments: [
                { cid: 'reply_1', text: '第一条回复', user: { nickname: '用户1' } },
                { cid: 'reply_2', text: '第二条回复', user: { nickname: '用户2' } },
              ],
              has_more: false,
              next_cursor: 2,
            },
          };
        }
        return {
          ok: true,
          value: {
            comments: [{
              cid: 'root_with_replies',
              text: '一级评论',
              reply_comment_total: 2,
              reply_comment: [],
              user: { nickname: '主评论用户' },
            }],
            has_more: false,
            next_cursor: 0,
          },
        };
      },
    };

    const result = await workflows.syncComments(db, {
      accountId: account.id,
      awemeId: 'mine_replies',
      count: 100,
    }, { bridgeClient: fakeBridge });

    expect(result.items).toHaveLength(3);
    expect(expressions).toHaveLength(2);
    expect(expressions[1]).toContain("window.__bridge.replies('root_with_replies', 'mine_replies', 0, 50)");
    expect(workspace.getComment(db, 'reply_2')).toMatchObject({ parentCid: 'root_with_replies', depth: 1 });
  });

  it('collects comments from multiple videos through one persistent serial job', async () => {
    for (const id of ['external-1', 'external-2', 'external-3']) {
      workspace.upsertVideo(db, { awemeId: id, accountId: account.id, source: 'search' });
    }
    const job = workflows.createCommentSyncJob(db, {
      accountId: account.id,
      awemeIds: ['external-1', 'external-2', 'external-3'],
      targetCount: 3,
    });
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const expressions = [];
    const delays = [];
    const fakeBridge = {
      call: async ({ expression }) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        expressions.push(expression);
        const awemeId = expression.match(/getComments\('([^']+)'/)?.[1];
        await Promise.resolve();
        activeCalls -= 1;
        return {
          ok: true,
          value: {
            comments: [
              { cid: `${awemeId}-a`, text: `${awemeId} 询价`, user: { uid: 'same-user', nickname: '同一客户' } },
              { cid: `${awemeId}-b`, text: `${awemeId} 普通评论`, user: { uid: `${awemeId}-user`, nickname: '其他用户' } },
            ],
            has_more: false,
            next_cursor: 0,
          },
        };
      },
    };

    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: fakeBridge,
      sleepFn: async (ms) => delays.push(ms),
      randomFn: () => 0,
    });

    expect(maxActiveCalls).toBe(1);
    expect(expressions).toHaveLength(2);
    expect(result.job.status).toBe('success');
    expect(result.job.input).toMatchObject({
      targetCount: 3, savedComments: 3, processedVideos: 2,
    });
    expect(result.items.map((item) => item.status)).toEqual(['success', 'success', 'skipped']);
    expect(result.items[2].result.reason).toMatch(/目标/);
    expect(delays.some((ms) => ms >= 4000)).toBe(true);

    const leads = require('../lib/desktop/dm-leads').listLeads(db, { accountId: account.id });
    const sameUser = leads.find((lead) => lead.userId === 'same-user');
    expect(sameUser.sourceCount).toBe(2);
  });

  it('keeps comment sync items cancelled when cancellation arrives between pages', async () => {
    for (const id of ['cancel-sync-1', 'cancel-sync-2']) {
      workspace.upsertVideo(db, { awemeId: id, accountId: account.id, source: 'search' });
    }
    const job = workflows.createCommentSyncJob(db, {
      accountId: account.id, awemeIds: ['cancel-sync-1', 'cancel-sync-2'], targetCount: 10,
    });
    let calls = 0;
    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => {
          calls += 1;
          batch.requestBatchJobCancel(db, job.id);
          return {
            ok: true,
            value: {
              comments: [{ cid: 'cancel-comment', text: '测试取消', user: { uid: 'cancel-user' } }],
              has_more: true,
              next_cursor: 1,
            },
          };
        },
      },
      sleepFn: async () => {},
    });

    expect(calls).toBe(1);
    expect(result.job.status).toBe('cancelled');
    expect(result.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('creates and runs batch comment jobs while marking videos as commented', async () => {
    workspace.upsertVideo(db, { awemeId: '2001', accountId: account.id, desc: '视频1' });
    workspace.upsertVideo(db, { awemeId: '2002', accountId: account.id, desc: '视频2' });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'comment',
      awemeIds: ['2001', '2002'],
      commentText: '想了解一下',
    });

    const fakeBridge = {
      call: async ({ expression }) => ({
        ok: true,
        value: {
          status_code: 0,
          comment: {
            cid: expression.includes('2001') ? 'cmt_2001' : 'cmt_2002',
            text: '想了解一下',
          },
        },
      }),
    };

    const result = await workflows.runBatchJob(db, job.id, { bridgeClient: fakeBridge });
    expect(result.job.status).toBe('success');
    expect(result.job.successCount).toBe(2);
    expect(workspace.getVideo(db, '2001').commented).toBe(true);
  });

  it('waits for the global write lease before executing a write batch item', async () => {
    workspace.upsertVideo(db, { awemeId: '71003', accountId: account.id });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'like',
      awemeIds: ['71003'],
    });

    const heldLease = leases.acquireWriteLease(db, 'external-holder', 60_000);
    expect(heldLease.acquired).toBe(true);

    const sleeps = [];
    let released = false;
    const run = workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => ({ ok: true, value: { status_code: 0 } }),
      },
      sleepFn: async (delay) => {
        sleeps.push(delay);
        if (!released) {
          released = true;
          leases.releaseWriteLease(db, heldLease.token);
        }
      },
    });

    const result = await run;
    expect(sleeps.length).toBeGreaterThan(0);
    expect(result.job.status).toBe('success');
  });

  it('renews the same write lease for a long-running batch write item', async () => {
    workspace.upsertVideo(db, { awemeId: '71004', accountId: account.id });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'like',
      awemeIds: ['71004'],
    });

    const heartbeats = [];
    let releaseBridge;
    const running = workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => new Promise((resolve) => {
          releaseBridge = () => resolve({ ok: true, value: { status_code: 0 } });
        }),
      },
      writeLeaseTtlMs: 90,
      writeLeaseHeartbeatMs: 30,
      onHeartbeat: (lease) => heartbeats.push(lease.leaseExpiresAt),
    });

    await new Promise((resolve) => setTimeout(resolve, 140));
    const blocked = leases.acquireWriteLease(db, 'parallel-writer', 90);
    expect(blocked.acquired).toBe(false);
    expect(heartbeats.length).toBeGreaterThan(0);

    releaseBridge();
    const result = await running;
    expect(result.job.status).toBe('success');
  });

  it('releases the global write lease when a DM send fails', async () => {
    workspace.upsertVideo(db, { awemeId: 'lease-dm-video', accountId: account.id, source: 'search' });
    workspace.upsertComment(db, {
      cid: 'lease-dm-comment',
      awemeId: 'lease-dm-video',
      accountId: account.id,
      userId: 'lease-dm-user',
      userName: '线索用户',
      text: '私信我',
    });
    const dmLeads = require('../lib/desktop/dm-leads');
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'lease-dm-video' });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    dmLeads.updateLead(db, lead.id, { draftText: '你好', status: 'approved' });
    const job = workflows.createDmSendJob(db, {
      accountId: account.id,
      leadIds: [lead.id],
      minDelayMs: 60_000,
      maxDelayMs: 60_000,
    });

    await expect(workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => {
          throw new Error('send failed');
        },
      },
      maxRetries: 0,
    })).resolves.toMatchObject({
      job: { status: 'finished_with_errors' },
    });

    const lease = leases.acquireWriteLease(db, 'after-dm-failure', 60_000);
    expect(lease.acquired).toBe(true);
  });

  it('pauses a running batch job and resumes only its remaining items', async () => {
    workspace.upsertVideo(db, { awemeId: '7101', accountId: account.id });
    workspace.upsertVideo(db, { awemeId: '7102', accountId: account.id });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'like',
      awemeIds: ['7101', '7102'],
      itemDelayMs: 1000,
    });
    let calls = 0;
    const fakeBridge = {
      call: async () => {
        calls += 1;
        if (calls === 1) batch.requestBatchJobPause(db, job.id);
        return { ok: true, value: { status_code: 0 } };
      },
    };

    const paused = await workflows.runBatchJob(db, job.id, {
      bridgeClient: fakeBridge,
      sleepFn: async () => {},
    });
    expect(paused.job.status).toBe('paused');
    expect(paused.items.map((item) => item.status)).toEqual(['success', 'pending']);

    const resumed = await workflows.resumeBatchJob(db, job.id, {
      bridgeClient: fakeBridge,
      sleepFn: async () => {},
    });
    expect(resumed.job.status).toBe('success');
    expect(calls).toBe(2);
  });

  it('cancels pending batch items without executing them', async () => {
    workspace.upsertVideo(db, { awemeId: '7201', accountId: account.id });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'like',
      awemeIds: ['7201'],
    });

    const cancelled = workflows.cancelBatchJob(db, job.id);
    expect(cancelled.job.status).toBe('cancelled');
    expect(cancelled.items[0].status).toBe('cancelled');
  });

  it('retries transient batch failures with backoff and can reset only failed items', async () => {
    workspace.upsertVideo(db, { awemeId: '7301', accountId: account.id });
    workspace.upsertVideo(db, { awemeId: '7302', accountId: account.id });
    const job = workflows.createBatchFromVideos(db, {
      accountId: account.id,
      type: 'like',
      awemeIds: ['7301', '7302'],
    });
    const delays = [];
    let calls = 0;
    const transientBridge = {
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fetch failed');
        if (calls >= 3) throw new Error('status_code=5');
        return { ok: true, value: { status_code: 0 } };
      },
    };

    const first = await workflows.runBatchJob(db, job.id, {
      bridgeClient: transientBridge,
      sleepFn: async (delay) => delays.push(delay),
      maxRetries: 1,
      retryBaseDelayMs: 2000,
    });
    expect(delays).toContain(2000);
    expect(first.job.status).toBe('finished_with_errors');
    expect(first.items.map((item) => item.status)).toEqual(['success', 'failed']);

    const reset = workflows.resetFailedBatchItems(db, job.id);
    expect(reset.items.map((item) => item.status)).toEqual(['success', 'pending']);
  });

  it('generates reply drafts from comments and publishes only after approval', async () => {
    workspace.upsertVideo(db, { awemeId: '3001', accountId: account.id, desc: 'geo 服务' });
    workspace.upsertComment(db, {
      cid: 'cmt_price',
      awemeId: '3001',
      accountId: account.id,
      text: '怎么收费？',
      userName: '潜在客户',
    });
    workspace.createKnowledgeEntry(db, {
      title: 'GEO 服务收费',
      content: '按项目复杂度报价，先沟通需求再给方案。',
      tags: '价格,GEO',
    });

    const drafts = await workflows.analyzeComments(db, {
      accountId: account.id,
      commentIds: ['cmt_price'],
    }, {
      llmClient: {
        generateReplyDrafts: async () => [{
          cid: 'cmt_price',
          category: '价格咨询',
          intentLevel: '高',
          reason: '直接询问收费',
          reply: '可以，先看下你的需求再报价',
          knowledgeRefs: ['GEO 服务收费'],
        }],
      },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('draft');

    workspace.updateReplyDraft(db, drafts[0].id, { status: 'approved' });
    const fakeBridge = {
      call: async () => ({
        ok: true,
        value: { status_code: 0, comment: { cid: 'reply_1', text: drafts[0].draftText } },
      }),
    };
    const published = await workflows.publishReplyDraft(db, drafts[0].id, { bridgeClient: fakeBridge });
    expect(published.status).toBe('published');
    expect(workspace.getComment(db, 'cmt_price').replied).toBe(true);
  });

  it('applies saved reply thresholds, verified knowledge references, and draft length limits', async () => {
    const settings = require('../lib/desktop/settings');
    workspace.upsertVideo(db, { awemeId: 'reply_defaults_video', accountId: account.id, isMine: true });
    for (const [cid, text] of [
      ['medium_without_knowledge', '可以了解一下吗？'],
      ['high_with_fake_reference', '怎么收费？'],
      ['high_with_long_reply', '具体怎么合作？'],
    ]) {
      workspace.upsertComment(db, { cid, awemeId: 'reply_defaults_video', accountId: account.id, text });
    }
    workspace.createKnowledgeEntry(db, {
      title: '合作流程',
      content: '先沟通需求，再确认方案。',
      tags: '合作',
    });
    settings.updateReplySettings({
      intent_threshold: 'high',
      require_knowledge: true,
      max_draft_chars: 40,
    }, { storageDir: dir });

    const drafts = await workflows.analyzeComments(db, {
      accountId: account.id,
      commentIds: ['medium_without_knowledge', 'high_with_fake_reference', 'high_with_long_reply'],
    }, {
      storageDir: dir,
      llmClient: {
        generateReplyDrafts: async (_comments, context) => {
          expect(context.replySettings).toMatchObject({
            intent_threshold: 'high',
            require_knowledge: true,
            max_draft_chars: 40,
          });
          return [
            {
              cid: 'medium_without_knowledge', category: '合作意向', intentLevel: '中',
              reason: '表达了解意愿', reply: '可以，先沟通一下需求', knowledgeRefs: [],
            },
            {
              cid: 'high_with_fake_reference', category: '价格咨询', intentLevel: '高',
              reason: '直接询价', reply: '需要结合需求报价', knowledgeRefs: ['不存在的知识'],
            },
            {
              cid: 'high_with_long_reply', category: '合作意向', intentLevel: '高',
              reason: '明确合作', reply: '这是一段明显超过四十个字的回复草稿，需要完整保留给用户编辑，而不是从中间直接截断导致句子不完整。',
              knowledgeRefs: ['合作流程'],
            },
          ];
        },
      },
    });

    expect(drafts.find((item) => item.commentId === 'medium_without_knowledge')).toMatchObject({
      intentLevel: '中',
      status: 'ignored',
      draftText: '',
    });
    expect(drafts.find((item) => item.commentId === 'high_with_fake_reference')).toMatchObject({
      status: 'needs_knowledge',
      draftText: '',
      knowledgeRefs: [],
    });
    expect(drafts.find((item) => item.commentId === 'high_with_long_reply')).toMatchObject({
      status: 'needs_edit',
      knowledgeRefs: ['合作流程'],
    });
    expect(drafts.find((item) => item.commentId === 'high_with_long_reply').draftText.length).toBeGreaterThan(40);
  });

  it('persists understanding for every analyzed comment even when no reply is needed', async () => {
    workspace.upsertVideo(db, { awemeId: 'analysis_video', accountId: account.id, isMine: true });
    workspace.upsertComment(db, {
      cid: 'intent_comment',
      awemeId: 'analysis_video',
      accountId: account.id,
      text: '怎么收费？',
    });
    workspace.upsertComment(db, {
      cid: 'water_comment',
      awemeId: 'analysis_video',
      accountId: account.id,
      text: '666',
    });

    const drafts = await workflows.analyzeComments(db, {
      accountId: account.id,
      commentIds: ['intent_comment', 'water_comment'],
    }, {
      llmClient: {
        generateReplyDrafts: async () => [
          {
            cid: 'intent_comment', category: '价格咨询', intentLevel: '高',
            reason: '直接询价', reply: '可以先沟通需求再报价', knowledgeRefs: [],
          },
          {
            cid: 'water_comment', category: '无关内容', intentLevel: '忽略',
            reason: '无实质内容', reply: '', knowledgeRefs: [],
          },
        ],
      },
    });

    expect(drafts).toHaveLength(2);
    expect(workspace.getReplyDraftByComment(db, 'water_comment')).toMatchObject({
      intentLevel: '忽略',
      status: 'ignored',
      draftText: '',
    });
  });

  it('analyzes all comments in small sequential batches while tracking item progress', async () => {
    workspace.upsertVideo(db, { awemeId: 'batch_analysis_video', accountId: account.id, isMine: true });
    const commentIds = Array.from({ length: 12 }, (_, index) => `analysis_${index + 1}`);
    for (const cid of commentIds) {
      workspace.upsertComment(db, {
        cid,
        awemeId: 'batch_analysis_video',
        accountId: account.id,
        text: `${cid} 怎么收费`,
      });
    }
    const job = workflows.createBatchFromComments(db, {
      accountId: account.id,
      awemeId: 'batch_analysis_video',
      type: 'analyze-comments',
      commentIds,
    });
    const calls = [];
    const delays = [];
    const result = await workflows.runBatchJob(db, job.id, {
      llmClient: {
        generateReplyDrafts: async (comments) => {
          calls.push(comments.map((comment) => comment.cid));
          return comments.map((comment) => ({
            cid: comment.cid,
            category: '价格咨询',
            intentLevel: '高',
            reason: '询问价格',
            reply: '可以先沟通需求再报价',
            knowledgeRefs: [],
          }));
        },
      },
      sleepFn: async (delay) => delays.push(delay),
      analysisBatchSize: 10,
      analysisDelayMs: 1000,
    });

    expect(calls.map((items) => items.length)).toEqual([10, 2]);
    expect(delays).toEqual([1000]);
    expect(result.job).toMatchObject({ status: 'success', successCount: 12, totalCount: 12 });
  });

  it('does not acquire the write lease for read-only comment sync', async () => {
    workspace.upsertVideo(db, { awemeId: 'read-only-sync-video', accountId: account.id, source: 'search' });
    const heldLease = leases.acquireWriteLease(db, 'write-in-progress', 60_000);
    expect(heldLease.acquired).toBe(true);

    const job = workflows.createCommentSyncJob(db, {
      accountId: account.id,
      awemeIds: ['read-only-sync-video'],
      targetCount: 5,
    });

    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => ({
          ok: true,
          value: {
            comments: [{ cid: 'sync-comment-1', text: '只读拉评', user: { uid: 'sync-user-1' } }],
            has_more: false,
            next_cursor: 0,
          },
        }),
      },
      sleepFn: async () => {},
    });

    expect(result.job.status).toBe('success');
    expect(workspace.getComment(db, 'sync-comment-1')).toBeTruthy();
    expect(leases.acquireWriteLease(db, 'second-writer', 60_000).acquired).toBe(false);
    expect(leases.releaseWriteLease(db, heldLease.token)).toBe(true);
  });

  it('runs selected comment deletions serially with paced waits and marks comments deleted', async () => {
    workspace.upsertVideo(db, { awemeId: 'delete_video', accountId: account.id, isMine: true });
    for (const cid of ['delete_1', 'delete_2']) {
      workspace.upsertComment(db, {
        cid,
        awemeId: 'delete_video',
        accountId: account.id,
        text: `待删除 ${cid}`,
      });
    }
    const job = workflows.createBatchFromComments(db, {
      accountId: account.id,
      awemeId: 'delete_video',
      type: 'delete-comment',
      commentIds: ['delete_1', 'delete_2'],
    });
    const calls = [];
    const delays = [];
    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async ({ expression }) => {
          calls.push(expression);
          return { ok: true, value: { status_code: 0 } };
        },
      },
      sleepFn: async (delay) => delays.push(delay),
      randomFn: () => 0,
    });

    expect(result.job.status).toBe('success');
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([20000]);
    expect(workspace.getComment(db, 'delete_1').deleted).toBe(true);
    expect(workspace.getComment(db, 'delete_2').deleted).toBe(true);
  });

  it('automatically pauses a write job after three consecutive item failures', async () => {
    workspace.upsertVideo(db, { awemeId: 'failure_video', accountId: account.id, isMine: true });
    const commentIds = ['failure_1', 'failure_2', 'failure_3', 'failure_4'];
    for (const cid of commentIds) {
      workspace.upsertComment(db, { cid, awemeId: 'failure_video', accountId: account.id, text: cid });
    }
    const job = workflows.createBatchFromComments(db, {
      accountId: account.id,
      awemeId: 'failure_video',
      type: 'delete-comment',
      commentIds,
      maxRetries: 0,
    });
    let calls = 0;
    const result = await workflows.runBatchJob(db, job.id, {
      bridgeClient: {
        call: async () => {
          calls += 1;
          return { ok: true, value: { status_code: 8 } };
        },
      },
      sleepFn: async () => {},
    });

    expect(calls).toBe(3);
    expect(result.job.status).toBe('paused');
    expect(result.job.progressMessage).toContain('连续 3 项失败');
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'failed', 'failed', 'pending']);
  });

  it('allows only one batch job to run at a time for the same local backend', async () => {
    workspace.upsertVideo(db, { awemeId: '71001', accountId: account.id });
    workspace.upsertVideo(db, { awemeId: '71002', accountId: account.id });
    const firstJob = workflows.createBatchFromVideos(db, {
      accountId: account.id, type: 'like', awemeIds: ['71001'],
    });
    const secondJob = workflows.createBatchFromVideos(db, {
      accountId: account.id, type: 'like', awemeIds: ['71002'],
    });
    let releaseFirst;
    const firstCall = new Promise((resolve) => { releaseFirst = resolve; });
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const running = workflows.runBatchJob(db, firstJob.id, {
      bridgeClient: {
        call: async () => {
          signalStarted();
          await firstCall;
          return { ok: true, value: { status_code: 0 } };
        },
      },
    });
    await started;

    await expect(workflows.runBatchJob(db, secondJob.id, {
      bridgeClient: { call: async () => ({ ok: true, value: { status_code: 0 } }) },
    })).rejects.toThrow('已有其他批量任务正在执行');
    releaseFirst();
    await running;
  });
});
