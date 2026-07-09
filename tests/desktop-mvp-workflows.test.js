const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
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
    const fakeBridge = {
      call: async ({ expression }) => {
        const offset = Number(expression.match(/,\s*(\d+),\s*20\)/)?.[1] || 0);
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

    const second = await workflows.runSearchSession(db, {
      accountId: account.id,
      keyword: 'geo',
      count: 10,
    }, { bridgeClient: fakeBridge });
    expect(second.session.actualCount).toBe(10);
    expect(second.results.map((item) => item.awemeId)).toEqual([
      '1025', '1026', '1027', '1028', '1029', '1030', '1031', '1032', '1033', '1034',
    ]);
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
});
