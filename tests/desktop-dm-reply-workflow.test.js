const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const { createDesktopApiServer } = require('../lib/desktop/api-server');
const accounts = require('../lib/desktop/accounts');
const inbox = require('../lib/desktop/dm-inbox');
const dmLeads = require('../lib/desktop/dm-leads');
const queue = require('../lib/desktop/dm-work-queue');
const workspace = require('../lib/desktop/workspace');
const {
  analyzeIncomingMessage,
  buildDmConversationContext,
  normalizeDmReplyDecision,
} = require('../lib/desktop/dm-reply-workflow');
const { createDmWorker } = require('../desktop/electron/dm-worker');

describe('knowledge-grounded DM reply workflow', () => {
  let dir;
  let db;
  let account;
  let conversation;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-dm-reply-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A', status: 'enabled' });
    inbox.ingestMessages(db, {
      accountId: account.id,
      messages: Array.from({ length: 25 }, (_, index) => ({
        conversation_id: 'platform-conversation-1',
        index: String(index + 1),
        sender: 'peer-1',
        peer_name: '客户A',
        content: index === 24 ? '怎么收费？' : `历史消息 ${index + 1}`,
        timestamp: 1_000 + index,
      })),
    });
    conversation = inbox.getConversationByPlatformId(db, account.id, 'platform-conversation-1');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addKnowledge(id = 'knowledge-price') {
    return workspace.createKnowledgeEntry(db, {
      id, title: '收费说明', content: '根据需求范围评估后报价。', enabled: true,
    });
  }

  function enqueueAnalysis(key = crypto.randomUUID()) {
    const source = inbox.listMessages(db, conversation.id).at(-1);
    queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      messageId: source.id, dedupeKey: key, payload: { sourceMessageId: source.id },
    });
    return queue.claimNextWork(db, `worker-${key}`, Date.now(), { types: ['analyze'] });
  }

  function decision(overrides = {}) {
    return {
      intent: 'price', intentLevel: 'high', knowledgeRefs: ['knowledge-price'], confidence: 0.95,
      reply: '您好，费用需要根据具体需求范围评估。', allowAutomatic: true,
      reason: '明确询价且知识库有依据', sensitiveCategory: 'none', ...overrides,
    };
  }

  function options(mode, response, overrides = {}) {
    return {
      storageDir: dir,
      strategyRoot: path.join(__dirname, '..'),
      llmClient: { analyzeDmConversation: async () => response },
      dmSettings: {
        reply_mode: mode, auto_reply_frequency: 'once', knowledge_confidence: 0.85,
        auto_delay_min_ms: 60_000, auto_delay_max_ms: 180_000,
      },
      random: () => 0.5,
      now: () => 10_000,
      ...overrides,
    };
  }

  it('builds a bounded, stable and secret-free context from the newest 20 messages', () => {
    addKnowledge();
    inbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{
        conversation_id: 'platform-conversation-1',
        index: 'media-26',
        sender: 'peer-1',
        content: '{"image_uri":"must-not-reach-llm"}',
        message_type: 'image',
        timestamp: 9_999,
      }],
    });
    workspace.upsertVideo(db, { awemeId: 'source-video', accountId: account.id, source: 'search' });
    workspace.upsertComment(db, {
      cid: 'source-comment', awemeId: 'source-video', accountId: account.id,
      userId: 'peer-1', userName: '客户A', text: '公开评论里的收费咨询',
    });
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'source-video' });
    db.prepare('UPDATE dm_leads SET conversation_id=?, intent_level=?, reason=? WHERE account_id=?')
      .run('platform-conversation-1', 'high', '明确询价', account.id);
    const context = buildDmConversationContext(db, enqueueAnalysis('context'), {
      strategyRoot: path.join(__dirname, '..'),
    });
    expect(context.messages).toHaveLength(20);
    expect(context.messages[0].content).toBe('历史消息 6');
    expect(context.messages.at(-1).content).toBe('怎么收费？');
    expect(JSON.stringify(context.messages)).not.toContain('must-not-reach-llm');
    expect(context.sourceComment).toBe('公开评论里的收费咨询');
    expect(context.lead).toMatchObject({ intentLevel: 'high', reason: '明确询价' });
    expect(context.knowledge).toEqual([expect.objectContaining({ id: 'knowledge-price' })]);
    expect(JSON.stringify(context)).not.toMatch(/raw|cookie|ticket|api[_-]?key|platform-conversation/i);
    expect(context.strategyMarkdown).toMatch(/评论|规则|运营/);
  });

  it('still selects the true newest 20 messages when a conversation exceeds 5000 rows', () => {
    inbox.ingestMessages(db, {
      accountId: account.id,
      messages: Array.from({ length: 5_001 }, (_, index) => ({
        conversation_id: 'platform-conversation-1',
        index: String(index + 26),
        sender: 'peer-1',
        content: `超长历史 ${index + 26}`,
        timestamp: 2_000 + index,
      })),
    });
    const context = buildDmConversationContext(db, enqueueAnalysis('large-context'), {
      strategyRoot: path.join(__dirname, '..'),
    });
    expect(context.messages).toHaveLength(20);
    expect(context.messages[0].content).toBe('超长历史 5007');
    expect(context.messages.at(-1).content).toBe('超长历史 5026');
  });

  it.each([
    ['manual', decision(), 'draft'],
    ['tiered', decision(), 'send_auto'],
    ['tiered', decision({ knowledgeRefs: [] }), 'draft'],
    ['tiered', decision({ confidence: 0.70 }), 'draft'],
    ['tiered', decision({ sensitiveCategory: 'unclear_price' }), 'draft'],
    ['automatic', decision({ intent: 'greeting', knowledgeRefs: [], confidence: 0.70 }), 'send_auto'],
    ['automatic', decision({ sensitiveCategory: 'unclear_price', allowAutomatic: false }), 'send_auto'],
  ])('applies %s mode safely and returns %s', async (mode, modelDecision, expected) => {
    if (modelDecision.knowledgeRefs.length) addKnowledge();
    const result = await analyzeIncomingMessage(db, enqueueAnalysis(`${mode}-${expected}-${Math.random()}`), options(mode, modelDecision));
    expect(result.action).toBe(expected);
    expect(queue.getWork(db, result.analysisWork.id).status).toBe('success');
    expect(inbox.getReplyDraftByConversation(db, conversation.id)).toMatchObject({
      status: expected === 'send_auto' ? 'queued' : 'needs_review',
    });
  });

  it.each(['complaint', 'refund', 'unclear_price', 'conflict', 'medical', 'legal', 'financial', 'unknown_fact'])(
    'allows knowledge-grounded %s decisions in full automatic mode',
    async (sensitiveCategory) => {
      addKnowledge();
      const result = await analyzeIncomingMessage(
        db, enqueueAnalysis(`sensitive-${sensitiveCategory}`),
        options('automatic', decision({ sensitiveCategory })),
      );
      expect(result.action).toBe('send_auto');
    },
  );

  it.each([
    decision({ reply: '' }),
    decision({ knowledgeRefs: ['missing-knowledge'] }),
  ])('keeps hard safety failures in manual review even in full automatic mode', async (modelDecision) => {
    addKnowledge();
    const result = await analyzeIncomingMessage(
      db, enqueueAnalysis(`hard-safety-${crypto.randomUUID()}`),
      options('automatic', modelDecision),
    );
    expect(result.action).toBe('draft');
  });

  it('rejects stale and disabled knowledge references and clamps untrusted model output', () => {
    addKnowledge();
    workspace.createKnowledgeEntry(db, { id: 'disabled', title: '旧知识', content: '旧内容', enabled: false });
    const normalized = normalizeDmReplyDecision({
      ...decision(), knowledgeRefs: ['knowledge-price', 'disabled', 'missing'], confidence: 5,
      reply: 'x'.repeat(800), reason: 'y'.repeat(800),
    }, { knowledgeIds: new Set(['knowledge-price']) });
    expect(normalized.knowledgeRefs).toEqual(['knowledge-price']);
    expect(normalized.invalidKnowledgeRefs).toEqual(['disabled', 'missing']);
    expect(normalized.confidence).toBe(1);
    expect(normalized.reply).toHaveLength(500);
    expect(normalized.reason).toHaveLength(500);
    expect(normalized.forceManualReasons).toContain('knowledge_reference_invalid');
  });

  it.each([
    '加我微信 abc123 立刻购买',
    '详情请看 https://spam.example',
    '保证稳赚，百分百有效',
    '联系电话 13800138000',
  ])('never auto-sends potentially harassing or inducive text: %s', async (reply) => {
    addKnowledge();
    const result = await analyzeIncomingMessage(
      db, enqueueAnalysis(`unsafe-${crypto.randomUUID()}`),
      options('automatic', decision({ reply })),
    );
    expect(result.action).toBe('draft');
    expect(result.reason).toMatch(/人工|安全/);
  });

  it('atomically allows only one automatic reply across concurrent analyses', async () => {
    addKnowledge();
    const source = inbox.listMessages(db, conversation.id).at(-1);
    const works = ['auto-first', 'auto-second'].map((dedupeKey, index) => queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      messageId: source.id, dedupeKey, payload: { sourceMessageId: source.id },
    }));
    const expiry = new Date(Date.now() + 60_000).toISOString();
    works.forEach((work, index) => {
      const claimToken = crypto.randomBytes(32).toString('hex');
      const claimTokenHash = crypto.createHash('sha256').update(claimToken).digest('hex');
      db.prepare(`
        UPDATE dm_work_items
        SET status='running', worker_id=?, claim_token=?, claim_token_hash=?, lease_expires_at=?
        WHERE id=?
      `).run(`concurrent-worker-${index}`, claimToken, claimTokenHash, expiry, work.id);
    });

    const results = await Promise.all(works.map((work) => analyzeIncomingMessage(
      db, queue.getWork(db, work.id), options('tiered', decision()),
    )));

    expect(results.map((item) => item.action).sort()).toEqual(['draft', 'send_auto']);
    expect(results.find((item) => item.action === 'draft').reason).toMatch(/已经自动回复过一次/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(1);
  });

  it('queues one automatic reply for every new inbound text in always mode', async () => {
    addKnowledge();
    const alwaysSettings = {
      reply_mode: 'tiered',
      auto_reply_frequency: 'always',
      knowledge_confidence: 0.85,
      auto_delay_min_ms: 60_000,
      auto_delay_max_ms: 180_000,
    };

    const first = await analyzeIncomingMessage(
      db,
      enqueueAnalysis('always-first'),
      options('tiered', decision({ reply: '第一次自动回复' }), { dmSettings: alwaysSettings }),
    );
    const ingested = inbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{
        conversation_id: 'platform-conversation-1',
        index: '26',
        sender: 'peer-1',
        peer_name: '客户A',
        content: '还有一个问题',
        timestamp: 2_000,
      }],
    });
    const secondSource = ingested.insertedMessages[0];
    const enqueueSecondSource = (key) => {
      queue.enqueueWork(db, {
        type: 'analyze',
        accountId: account.id,
        conversationId: conversation.id,
        messageId: secondSource.id,
        dedupeKey: key,
        payload: { sourceMessageId: secondSource.id },
      });
      return queue.claimNextWork(db, `worker-${key}`, Date.now(), { types: ['analyze'] });
    };
    const second = await analyzeIncomingMessage(
      db,
      enqueueSecondSource('always-second'),
      options('tiered', decision({ reply: '第二次自动回复' }), { dmSettings: alwaysSettings }),
    );
    const duplicate = await analyzeIncomingMessage(
      db,
      enqueueSecondSource('always-second-duplicate'),
      options('tiered', decision({ reply: '不应重复发送' }), { dmSettings: alwaysSettings }),
    );

    expect(first.action).toBe('send_auto');
    expect(second.action).toBe('send_auto');
    expect(duplicate.action).toBe('send_auto');
    expect(duplicate.reason).toMatch(/已在发送队列/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(2);
  });

  it('persists needs_review and completes analysis when the LLM fails without leaking its error', async () => {
    const result = await analyzeIncomingMessage(db, enqueueAnalysis('llm-failure'), options('tiered', null, {
      llmClient: { analyzeDmConversation: async () => { throw new Error('secret upstream details'); } },
    }));
    expect(result).toMatchObject({ action: 'draft' });
    expect(result.reason).toMatch(/AI.*失败|人工/);
    expect(result.reason).not.toContain('secret upstream details');
    expect(queue.getWork(db, result.analysisWork.id)).toMatchObject({ status: 'success', error: null });
    expect(inbox.getReplyDraftByConversation(db, conversation.id)).toMatchObject({ status: 'needs_review' });
  });

  it('uses deterministic inclusive random delay bounds', async () => {
    addKnowledge();
    const minimum = await analyzeIncomingMessage(db, enqueueAnalysis('delay-min'), options('tiered', decision(), { random: () => 0 }));
    expect(minimum.autoWork.nextRunAt).toBe(new Date(70_000).toISOString());
    inbox.reauthorizeAutoReply(db, conversation.id);
    const maximum = await analyzeIncomingMessage(db, enqueueAnalysis('delay-max'), options('tiered', decision(), { random: () => 1 }));
    expect(maximum.autoWork.nextRunAt).toBe(new Date(190_000).toISOString());
  });

  it('exposes an idempotent, guarded and sanitized analysis API', async () => {
    addKnowledge();
    const work = enqueueAnalysis('api-analysis');
    const server = createDesktopApiServer({
      db,
      storageDir: dir,
      workflowOptions: options('manual', decision()),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const send = () => fetch(`${baseUrl}/api/dm/work-items/${work.id}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: work.workerId, claimToken: work.claimToken }),
      });
      const firstResponse = await send();
      const first = await firstResponse.json();
      expect(firstResponse.status).toBe(200);
      expect(first).toMatchObject({ action: 'draft', workItem: { status: 'success' } });
      expect(JSON.stringify(first)).not.toMatch(/raw|payload|result|prompt|api[_-]?key|ticket|conversationKey/i);

      const repeatedResponse = await send();
      const repeated = await repeatedResponse.json();
      expect(repeatedResponse.status).toBe(200);
      expect(repeated).toEqual(first);

      const pending = queue.enqueueWork(db, {
        type: 'analyze', accountId: account.id, conversationId: conversation.id,
        dedupeKey: 'not-claimed', payload: {},
      });
      const rejected = await fetch(`${baseUrl}/api/dm/work-items/${pending.id}/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'wrong-worker', claimToken: 'wrong-claim-token' }),
      });
      expect(rejected.status).toBe(409);
      expect(JSON.stringify(await rejected.json())).not.toMatch(/prompt|api[_-]?key|secret/i);

      const committingToken = crypto.randomBytes(32).toString('hex');
      const committingTokenHash = crypto.createHash('sha256').update(committingToken).digest('hex');
      db.prepare(`
        UPDATE dm_work_items
        SET status='committing', worker_id=?, claim_token=?, claim_token_hash=?, lease_expires_at=?
        WHERE id=?
      `).run(
        'commit-worker', committingToken, committingTokenHash,
        new Date(Date.now() + 60_000).toISOString(), pending.id,
      );
      const committing = await fetch(`${baseUrl}/api/dm/work-items/${pending.id}/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'commit-worker', claimToken: committingToken }),
      });
      expect(committing.status).toBe(409);
      expect(await committing.json()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/committing.*retry/i),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('commits only one winner when the same analysis is posted concurrently', async () => {
    addKnowledge();
    const work = enqueueAnalysis('api-concurrent-winner');
    const waiters = [];
    let calls = 0;
    const replies = ['winner-A', 'winner-B'];
    const concurrentOptions = options('tiered', null, {
      llmClient: {
        analyzeDmConversation: async () => {
          const index = calls++;
          await new Promise((resolve) => {
            waiters.push(resolve);
            if (waiters.length === 2) waiters.splice(0).forEach((release) => release());
          });
          return decision({ reply: replies[index], reason: `reason-${index}` });
        },
      },
    });
    const server = createDesktopApiServer({ db, storageDir: dir, workflowOptions: concurrentOptions });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const send = () => fetch(`${baseUrl}/api/dm/work-items/${work.id}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: work.workerId, claimToken: work.claimToken }),
    });

    try {
      const responses = await Promise.all([send(), send()]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(calls).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);

      const persistedWork = queue.getWork(db, work.id);
      const draft = inbox.getReplyDraftByConversation(db, conversation.id);
      const outbound = db.prepare(`
        SELECT id, content FROM dm_messages
        WHERE conversation_row_id = ? AND direction = 'outbound'
      `).all(conversation.id);
      const autoWorks = db.prepare(`
        SELECT id, message_id, payload FROM dm_work_items
        WHERE conversation_row_id = ? AND type = 'send_auto'
      `).all(conversation.id);

      expect(persistedWork).toMatchObject({
        status: 'success',
        result: { action: 'send_auto', draftId: draft.id, autoWorkId: autoWorks[0].id },
      });
      expect(replies).toContain(draft.content);
      expect(outbound).toEqual([{ id: autoWorks[0].message_id, content: draft.content }]);
      expect(JSON.parse(autoWorks[0].payload).text).toBe(draft.content);
      expect(bodies[0]).toMatchObject({
        action: 'send_auto',
        draft: { id: draft.id, content: draft.content },
        autoWorkItem: { id: autoWorks[0].id },
      });
      expect(inbox.getConversation(db, conversation.id).autoReplyAuthorized).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('discards a late successful model result after a failed analysis wins the commit', async () => {
    addKnowledge();
    const work = enqueueAnalysis('api-concurrent-failure-winner');
    const waiters = [];
    let calls = 0;
    const concurrentOptions = options('tiered', null, {
      llmClient: {
        analyzeDmConversation: async () => {
          const index = calls++;
          await new Promise((resolve) => {
            waiters.push(resolve);
            if (waiters.length === 2) waiters.splice(0).forEach((release) => release());
          });
          if (index === 0) throw new Error('winner upstream failure');
          await new Promise((resolve) => setTimeout(resolve, 40));
          return decision({ reply: 'late-success-must-be-discarded' });
        },
      },
    });
    const server = createDesktopApiServer({ db, storageDir: dir, workflowOptions: concurrentOptions });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const send = () => fetch(`${baseUrl}/api/dm/work-items/${work.id}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: work.workerId, claimToken: work.claimToken }),
    });

    try {
      const responses = await Promise.all([send(), send()]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(calls).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({ action: 'draft', workItem: { status: 'success' } });
      expect(bodies[0].draft).toMatchObject({ content: '', status: 'needs_review' });
      expect(queue.getWork(db, work.id).result).toMatchObject({ action: 'draft' });
      expect(inbox.getReplyDraftByConversation(db, conversation.id)).toMatchObject({
        content: '', status: 'needs_review',
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM dm_messages WHERE direction='outbound'").get().count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(0);
      expect(inbox.getConversation(db, conversation.id).autoReplyAuthorized).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects a stale analysis result after claim ownership moves to another worker', async () => {
    addKnowledge();
    const work = enqueueAnalysis('api-stale-owner');
    let releaseModel;
    let modelStarted;
    const started = new Promise((resolve) => { modelStarted = resolve; });
    const staleOptions = options('tiered', null, {
      llmClient: {
        analyzeDmConversation: async () => {
          modelStarted();
          await new Promise((resolve) => { releaseModel = resolve; });
          return decision({ reply: 'stale-owner-result' });
        },
      },
    });
    const server = createDesktopApiServer({ db, storageDir: dir, workflowOptions: staleOptions });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const responsePromise = fetch(`${baseUrl}/api/dm/work-items/${work.id}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: work.workerId, claimToken: work.claimToken }),
      });
      await started;
      const replacementToken = crypto.randomBytes(32).toString('hex');
      const replacementHash = crypto.createHash('sha256').update(replacementToken).digest('hex');
      db.prepare(`
        UPDATE dm_work_items
        SET worker_id=?, claim_token=?, claim_token_hash=?, lease_expires_at=?
        WHERE id=? AND status='running'
      `).run(
        'replacement-worker', replacementToken, replacementHash,
        new Date(Date.now() + 60_000).toISOString(), work.id,
      );
      releaseModel();

      const response = await responsePromise;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/claim/i),
      });
      expect(queue.getWork(db, work.id)).toMatchObject({
        status: 'running', workerId: 'replacement-worker', result: {},
      });
      expect(inbox.getReplyDraftByConversation(db, conversation.id)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS count FROM dm_messages WHERE direction='outbound'").get().count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(0);
      expect(inbox.getConversation(db, conversation.id).autoReplyAuthorized).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects an old direct analysis claim after the same worker reclaims and commits', async () => {
    addKnowledge();
    const source = inbox.listMessages(db, conversation.id).at(-1);
    queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      messageId: source.id, dedupeKey: 'direct-same-worker-reclaim', payload: { sourceMessageId: source.id },
    });
    const oldClaim = queue.claimNextWork(db, 'same-analysis-worker', 1_000, { types: ['analyze'] });
    let releaseOldModel;
    let oldModelStarted;
    const started = new Promise((resolve) => { oldModelStarted = resolve; });
    const oldRequest = analyzeIncomingMessage(db, oldClaim, options('tiered', null, {
      llmClient: {
        analyzeDmConversation: async () => {
          oldModelStarted();
          await new Promise((resolve) => { releaseOldModel = resolve; });
          return decision({ reply: 'stale-direct-result' });
        },
      },
    }));

    await started;
    expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
    const freshClaim = queue.claimNextWork(db, 'same-analysis-worker', 62_000, { types: ['analyze'] });
    expect(freshClaim.claimToken).not.toBe(oldClaim.claimToken);
    const winner = await analyzeIncomingMessage(
      db,
      freshClaim,
      options('tiered', decision({ reply: 'fresh-direct-winner' })),
    );
    releaseOldModel();

    await expect(oldRequest).rejects.toMatchObject({ statusCode: 409 });
    expect(winner).toMatchObject({ action: 'send_auto', draft: { content: 'fresh-direct-winner' } });
    expect(queue.getWork(db, oldClaim.id)).toMatchObject({
      status: 'success',
      result: { action: 'send_auto', draftId: winner.draft.id, autoWorkId: winner.autoWork.id },
    });
    expect(inbox.getReplyDraftByConversation(db, conversation.id).content).toBe('fresh-direct-winner');
    expect(db.prepare("SELECT content FROM dm_messages WHERE direction='outbound'").all())
      .toEqual([{ content: 'fresh-direct-winner' }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(1);
    expect(inbox.getConversation(db, conversation.id).autoReplyAuthorized).toBe(false);
  });

  it('rejects an old HTTP analysis claim after the same worker reclaims with a new token', async () => {
    addKnowledge();
    const source = inbox.listMessages(db, conversation.id).at(-1);
    queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      messageId: source.id, dedupeKey: 'http-same-worker-reclaim', payload: { sourceMessageId: source.id },
    });
    const oldClaim = queue.claimNextWork(db, 'same-http-worker', 1_000, { types: ['analyze'] });
    let releaseOldModel;
    let oldModelStarted;
    let modelCalls = 0;
    const started = new Promise((resolve) => { oldModelStarted = resolve; });
    const server = createDesktopApiServer({
      db,
      storageDir: dir,
      workflowOptions: options('tiered', null, {
        llmClient: {
          analyzeDmConversation: async () => {
            const call = modelCalls++;
            if (call === 0) {
              oldModelStarted();
              await new Promise((resolve) => { releaseOldModel = resolve; });
              return decision({ reply: 'stale-http-result' });
            }
            return decision({ reply: 'fresh-http-winner' });
          },
        },
      }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const analyze = (claim) => fetch(`${baseUrl}/api/dm/work-items/${claim.id}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'same-http-worker', claimToken: claim.claimToken }),
    });

    try {
      const oldResponsePromise = analyze(oldClaim);
      await started;
      expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
      const claimResponse = await fetch(`${baseUrl}/api/dm/work-items/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'same-http-worker', types: ['analyze'] }),
      });
      const freshClaim = (await claimResponse.json()).workItem;
      expect(claimResponse.status).toBe(200);
      expect(freshClaim.claimToken).toMatch(/^[a-f0-9]{64}$/);
      expect(freshClaim.claimToken).not.toBe(oldClaim.claimToken);

      const winnerResponse = await analyze(freshClaim);
      const winner = await winnerResponse.json();
      expect(winnerResponse.status).toBe(200);
      expect(winner).toMatchObject({
        action: 'send_auto',
        draft: { content: 'fresh-http-winner' },
        workItem: { status: 'success' },
      });
      expect(JSON.stringify(winner)).not.toMatch(/claimToken|claim_token|claimTokenHash/i);

      releaseOldModel();
      const oldResponse = await oldResponsePromise;
      const oldBody = await oldResponse.json();
      expect(oldResponse.status).toBe(409);
      expect(oldBody).toMatchObject({ ok: false, error: expect.stringMatching(/claim/i) });
      expect(JSON.stringify(oldBody)).not.toContain(oldClaim.claimToken);
      expect(JSON.stringify(oldBody)).not.toContain(freshClaim.claimToken);
      expect(modelCalls).toBe(2);

      expect(queue.getWork(db, oldClaim.id)).toMatchObject({
        status: 'success',
        result: {
          action: 'send_auto',
          draftId: winner.draft.id,
          autoWorkId: winner.autoWorkItem.id,
        },
      });
      expect(inbox.getReplyDraftByConversation(db, conversation.id).content).toBe('fresh-http-winner');
      expect(db.prepare("SELECT content FROM dm_messages WHERE direction='outbound'").all())
        .toEqual([{ content: 'fresh-http-winner' }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM dm_work_items WHERE type='send_auto'").get().count).toBe(1);
      expect(inbox.getConversation(db, conversation.id).autoReplyAuthorized).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('worker claims manual sends before analysis and analyzes without acquiring a write lease', async () => {
    const calls = [];
    const claimed = [
      { id: 'manual-1', type: 'send_manual', accountId: account.id, claimToken: 'manual-claim-token' },
      { id: 'analysis-1', type: 'analyze', accountId: account.id, claimToken: 'analysis-claim-token' },
    ];
    const worker = createDmWorker({
      backendRequest: async (pathname, request = {}) => {
        calls.push(pathname);
        if (pathname.endsWith('/claim')) {
          expect(JSON.parse(request.body).types).toEqual(['send_manual', 'send_auto', 'analyze']);
          return { workItem: claimed.shift() || null };
        }
        if (pathname === '/api/dm/work-items/analysis-1/analyze') {
          expect(JSON.parse(request.body)).toMatchObject({ claimToken: 'analysis-claim-token' });
          return { workItem: { status: 'success' } };
        }
        if (pathname === '/api/dm/work-items/manual-1/execution-context') {
          expect(JSON.parse(request.body)).toMatchObject({ claimToken: 'manual-claim-token' });
          throw new Error('stop before send');
        }
        if (pathname === '/api/dm/work-items/manual-1/fail') {
          expect(JSON.parse(request.body)).toMatchObject({ claimToken: 'manual-claim-token' });
          return { workItem: { status: 'failed' } };
        }
        throw new Error(`unexpected ${pathname}`);
      },
      getAccount: async () => account,
      getMainWindow: () => ({ isDestroyed: () => false }),
      ensureBackgroundAccountView: async () => ({ ok: true }),
      executeInAccountView: async () => ({ status_code: 0 }),
      logger: { warn() {}, error() {} },
    });
    await worker.runOnce();
    await worker.runOnce();
    expect(calls).toContain('/api/dm/work-items/analysis-1/analyze');
    expect(calls.filter((value) => value.includes('write-lease'))).toHaveLength(0);
  });
});
