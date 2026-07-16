const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDesktopApiServer } = require('../lib/desktop/api-server');
const accounts = require('../lib/desktop/accounts');
const dmInbox = require('../lib/desktop/dm-inbox');
const dmLeads = require('../lib/desktop/dm-leads');
const dmWorkQueue = require('../lib/desktop/dm-work-queue');
const workspace = require('../lib/desktop/workspace');

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

  function openDb() {
    const db = new Database(path.join(dir, 'desktop.db'));
    db.pragma('foreign_keys = ON');
    return db;
  }

  it('returns health status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'desktop-backend' });
  });

  it('recovers interrupted DM work before the restarted backend reports healthy', async () => {
    const db = openDb();
    const account = accounts.createAccount(db, { name: 'Recovery account' });
    dmInbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{ conversation_id: 'recover-conv', index: '1', sender: 'peer', content: 'hello', timestamp: 1000 }],
    });
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'recover-conv');
    const work = dmWorkQueue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      dedupeKey: 'recover-before-health', payload: {},
    });
    dmWorkQueue.claimNextWork(db, 'crashed-worker', Date.now() - 120_000, { leaseMs: 30_000 });
    db.close();

    await new Promise((resolve) => server.close(resolve));
    server = createDesktopApiServer({ storageDir: dir });
    baseUrl = await listen(server);
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);

    const recoveredDb = openDb();
    expect(dmWorkQueue.getWork(recoveredDb, work.id)).toMatchObject({
      status: 'pending',
      workerId: null,
      claimToken: null,
    });
    recoveredDb.close();
  });

  it('cancels unexecuted DM work for an account without deleting the account record', async () => {
    const db = openDb();
    const account = accounts.createAccount(db, { name: 'Delete preparation account' });
    dmInbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{ conversation_id: 'delete-conv', index: '1', sender: 'peer', content: 'hello', timestamp: 1000 }],
    });
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'delete-conv');
    const work = dmWorkQueue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: conversation.id,
      dedupeKey: 'cancel-before-account-delete', payload: {},
    });
    db.close();

    const response = await fetch(`${baseUrl}/api/accounts/${account.id}/cancel-dm-work`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cancelled: 1 });

    const verifiedDb = openDb();
    expect(accounts.getAccount(verifiedDb, account.id)).not.toBeNull();
    expect(dmWorkQueue.getWork(verifiedDb, work.id).status).toBe('cancelled');
    verifiedDb.close();
  });

  it('updates reply defaults and tests an unsaved LLM configuration without exposing the key', async () => {
    await new Promise((resolve) => server.close(resolve));
    const tested = [];
    server = createDesktopApiServer({
      storageDir: dir,
      llmTester: async (config) => {
        tested.push(config);
        return { ok: true, model: config.model, latencyMs: 18, response: 'OK' };
      },
    });
    baseUrl = await listen(server);

    await fetch(`${baseUrl}/api/settings/llm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'secret-key', model: 'saved-model' }),
    });

    const replyUpdate = await fetch(`${baseUrl}/api/settings/reply`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_threshold: 'high', require_knowledge: false, max_draft_chars: 80 }),
    });
    expect(replyUpdate.status).toBe(200);
    expect(await replyUpdate.json()).toEqual({
      intent_threshold: 'high',
      require_knowledge: false,
      max_draft_chars: 80,
    });

    const testResponse = await fetch(`${baseUrl}/api/settings/llm/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unsaved-model', base_url: 'https://example.test/v1' }),
    });
    const result = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(result).toEqual({ ok: true, model: 'unsaved-model', latencyMs: 18, response: 'OK' });
    expect(JSON.stringify(result)).not.toContain('secret-key');
    expect(tested[0]).toMatchObject({
      api_key: 'secret-key',
      model: 'unsaved-model',
      base_url: 'https://example.test/v1',
    });
  });

  it('reads and patches DM settings without leaking secrets or overwriting other setting groups', async () => {
    const desktopSettings = require('../lib/desktop/settings');

    await fetch(`${baseUrl}/api/settings/llm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'secret-key', model: 'saved-model' }),
    });
    await fetch(`${baseUrl}/api/settings/reply`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_threshold: 'high', require_knowledge: false, max_draft_chars: 80 }),
    });

    const initial = await fetch(`${baseUrl}/api/settings/dm`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      reply_mode: 'manual',
      auto_reply_frequency: 'once',
      knowledge_confidence: 0.85,
      auto_delay_min_ms: 15000,
      auto_delay_max_ms: 45000,
      monitor_after_login: false,
      notifications_enabled: true,
      notification_preview: true,
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    const patch = await fetch(`${baseUrl}/api/settings/dm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reply_mode: 'automatic',
        auto_reply_frequency: 'always',
        knowledge_confidence: 0.4,
        auto_delay_min_ms: 240000,
        auto_delay_max_ms: 1000,
        monitor_after_login: true,
        notifications_enabled: false,
        notification_preview: false,
        quiet_hours_start: '9:3',
        quiet_hours_end: '20:45',
        llm: { api_key: 'should-not-change' },
        reply: { intent_threshold: 'medium' },
        api_key: 'should-not-change',
      }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched).toEqual({
      reply_mode: 'automatic',
      auto_reply_frequency: 'always',
      knowledge_confidence: 0.5,
      auto_delay_min_ms: 100000,
      auto_delay_max_ms: 100000,
      monitor_after_login: true,
      notifications_enabled: false,
      notification_preview: false,
      quiet_hours_start: '09:03',
      quiet_hours_end: '20:45',
    });
    expect(JSON.stringify(patched)).not.toContain('secret-key');

    const invalidPatch = await fetch(`${baseUrl}/api/settings/dm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reply_mode: 'invalid',
        quiet_hours_start: '99:00',
        quiet_hours_end: 'bad',
        model: 'ignored',
      }),
    });
    expect(invalidPatch.status).toBe(200);
    expect(await invalidPatch.json()).toEqual(patched);

    const reread = await fetch(`${baseUrl}/api/settings/dm`);
    expect(reread.status).toBe(200);
    expect(await reread.json()).toEqual(patched);

    const clearedStart = await fetch(`${baseUrl}/api/settings/dm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quiet_hours_start: '',
      }),
    });
    expect(clearedStart.status).toBe(200);
    expect(await clearedStart.json()).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    const halfConfigAttempt = await fetch(`${baseUrl}/api/settings/dm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quiet_hours_end: '21:00',
      }),
    });
    expect(halfConfigAttempt.status).toBe(200);
    const finalDm = await halfConfigAttempt.json();
    expect(finalDm).toMatchObject({
      quiet_hours_start: '',
      quiet_hours_end: '',
    });

    const llm = await (await fetch(`${baseUrl}/api/settings/llm`)).json();
    expect(llm).toMatchObject({
      model: 'saved-model',
      has_api_key: true,
    });
    expect(JSON.stringify(llm)).not.toContain('secret-key');

    const reply = await (await fetch(`${baseUrl}/api/settings/reply`)).json();
    expect(reply).toEqual({
      intent_threshold: 'high',
      require_knowledge: false,
      max_draft_chars: 80,
    });

    expect(desktopSettings.readSettings({ storageDir: dir })).toMatchObject({
      llm: {
        api_key: 'secret-key',
        model: 'saved-model',
      },
      reply: {
        intent_threshold: 'high',
        require_knowledge: false,
        max_draft_chars: 80,
      },
      dm: finalDm,
    });
  });

  it('creates and lists accounts', async () => {
    const create = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A', group: '娴嬭瘯缁?' }),
    });
    expect(create.status).toBe(201);
    const account = await create.json();
    expect(account.name).toBe('璐﹀彿A');

    const list = await fetch(`${baseUrl}/api/accounts`);
    expect(await list.json()).toHaveLength(1);
  });

  it('creates a pending search task', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();

    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '缇庨', count: 3 },
      }),
    });

    expect(create.status).toBe(201);
    const task = await create.json();
    expect(task.status).toBe('pending');
    expect(task.type).toBe('search');
  });

  it('searches own-video comments by nickname or content and creates a serial delete job', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();
    const workspace = require('../lib/desktop/workspace');
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'desktop.db'));
    workspace.upsertVideo(db, { awemeId: 'own_video', accountId: account.id, isMine: true });
    workspace.upsertComment(db, { cid: 'remove_1', awemeId: 'own_video', accountId: account.id, userName: '骞垮憡瀹㈡埛', text: '鑱旂郴鎴?' });
    workspace.upsertComment(db, { cid: 'remove_2', awemeId: 'own_video', accountId: account.id, userName: '鏅€氱敤鎴?', text: '骞垮憡鍐呭' });
    workspace.upsertComment(db, { cid: 'keep_1', awemeId: 'own_video', accountId: account.id, userName: '鏅€氱敤鎴?', text: '姝ｅ父璇勮' });
    db.close();

    const search = await fetch(`${baseUrl}/api/comments?accountId=${account.id}&awemeId=own_video&query=骞垮憡&deleted=false`);
    const matches = await search.json();
    expect(matches.map((comment) => comment.cid).sort()).toEqual(['remove_1', 'remove_2']);

    const create = await fetch(`${baseUrl}/api/batch-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        awemeId: 'own_video',
        type: 'delete-comment',
        commentIds: matches.map((comment) => comment.cid),
      }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ type: 'delete-comment', totalCount: 2, status: 'pending' });
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
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();
    const task = await (await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '缇庨', count: 3 },
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
                    { aweme_info: { aweme_id: '9001', desc: 'geo 1', author: { nickname: '浣滆€匒' } } },
                    { aweme_info: { aweme_id: '9002', desc: 'geo 2', author: { nickname: '浣滆€匓' } } },
                  ],
                },
              };
            }
            return { ok: true, value: { status_code: 0, comment: { cid: 'reply_api', text: '鍙互鑱婅亰' } } };
          },
        },
        llmClient: {
          generateReplyDrafts: async () => [{
            cid: 'api_cmt',
            category: '浠锋牸鍜ㄨ',
            intentLevel: '楂?',
            reason: '璇㈤棶鏀惰垂',
            reply: '鍙互锛屽厛鐪嬬湅浣犵殑闇€姹?',
            knowledgeRefs: ['鏀惰垂'],
          }],
        },
      },
    });
    baseUrl = await listen(server);

    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();

    const search = await fetch(`${baseUrl}/api/search-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, keyword: 'geo', count: 2 }),
    });
    expect(search.status).toBe(201);
    const searchBody = await search.json();
    expect(searchBody.results).toHaveLength(2);

    const externalVideo = await fetch(`${baseUrl}/api/external-videos/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, input: '7411111111111111111' }),
    });
    expect(externalVideo.status).toBe(201);
    expect(await externalVideo.json()).toMatchObject({
      awemeId: '7411111111111111111', accountId: account.id, source: 'external-link',
    });

    const batch = await fetch(`${baseUrl}/api/batch-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'comment',
        awemeIds: ['9001'],
        commentText: '鍙互鑱婅亰',
      }),
    });
    expect(batch.status).toBe(201);
    expect((await batch.json()).totalCount).toBe(1);

    const knowledge = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '鏀惰垂', content: '鎸夐渶姹傛姤浠?' }),
    });
    expect(knowledge.status).toBe(201);

    const workspace = require('../lib/desktop/workspace');
    const dbPath = require('better-sqlite3');
    const db = new dbPath(path.join(dir, 'desktop.db'));
    workspace.upsertComment(db, {
      cid: 'api_cmt',
      awemeId: '9001',
      accountId: account.id,
      text: '鎬庝箞鏀惰垂锛?',
    });
    db.close();

    const drafts = await fetch(`${baseUrl}/api/comments/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, commentIds: ['api_cmt'] }),
    });
    expect(drafts.status).toBe(200);
    const draft = (await drafts.json())[0];
    expect(draft.intentLevel).toBe('楂?');

    const approve = await fetch(`${baseUrl}/api/reply-drafts/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftText: draft.draftText }),
    });
    expect(approve.status).toBe(200);
  });

  it('returns compact my-video and comment synchronization summaries', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createDesktopApiServer({
      storageDir: dir,
      workflowOptions: {
        bridgeClient: {
          call: async ({ expression }) => {
            if (expression.includes('window.__bridge.myPosts')) {
              return {
                ok: true,
                value: {
                  items: [{ aweme_id: 'mine_api', desc: '鎴戠殑浣滃搧', author: { nickname: '璐﹀彿A' } }],
                  has_more: false,
                  next_cursor: 0,
                },
              };
            }
            if (expression.includes('window.__bridge.getComments')) {
              return {
                ok: true,
                value: {
                  comments: [{ cid: 'comment_api', text: '浣滃搧涓嶉敊', user: { nickname: '鐢ㄦ埛A' } }],
                  has_more: false,
                  next_cursor: 0,
                },
              };
            }
            return { ok: false, error: 'unexpected expression' };
          },
        },
      },
    });
    baseUrl = await listen(server);

    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();

    const videosResponse = await fetch(`${baseUrl}/api/my-videos/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, count: 200 }),
    });
    const videos = await videosResponse.json();
    expect(videosResponse.status).toBe(200);
    expect(videos.items).toHaveLength(1);
    expect(videos.summary).toMatchObject({ requested: 200, saved: 1, pages: 1, stoppedReason: 'complete' });

    const commentsResponse = await fetch(`${baseUrl}/api/videos/mine_api/comments-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, count: 300 }),
    });
    const comments = await commentsResponse.json();
    expect(commentsResponse.status).toBe(200);
    expect(comments.items).toHaveLength(1);
    expect(comments.summary).toMatchObject({ requested: 300, saved: 1, pages: 1, stoppedReason: 'complete' });
  });

  it('controls pending batch jobs through pause and cancel endpoints', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '璐﹀彿A' }),
    })).json();
    const Workspace = require('../lib/desktop/workspace');
    const Database = require('better-sqlite3');
    const controlDb = new Database(path.join(dir, 'desktop.db'));
    Workspace.upsertVideo(controlDb, { awemeId: '9101', accountId: account.id });
    Workspace.upsertVideo(controlDb, { awemeId: '9102', accountId: account.id });
    controlDb.close();
    const created = await (await fetch(`${baseUrl}/api/batch-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'like',
        awemeIds: ['9101', '9102'],
      }),
    })).json();

    const paused = await (await fetch(`${baseUrl}/api/batch-jobs/${created.id}/pause`, { method: 'POST' })).json();
    expect(paused.job.status).toBe('paused');

    const cancelled = await (await fetch(`${baseUrl}/api/batch-jobs/${created.id}/cancel`, { method: 'POST' })).json();
    expect(cancelled.job.status).toBe('cancelled');
    expect(cancelled.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('creates, reviews, filters, and queues DM leads through the API', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '绉佷俊璐﹀彿' }),
    })).json();
    const Workspace = require('../lib/desktop/workspace');
    const Database = require('better-sqlite3');
    const dmDb = new Database(path.join(dir, 'desktop.db'));
    dmDb.pragma('foreign_keys = ON');
    Workspace.upsertVideo(dmDb, { awemeId: 'external-api', accountId: account.id, source: 'search' });
    Workspace.upsertComment(dmDb, {
      cid: 'dm-comment-api', awemeId: 'external-api', accountId: account.id,
      userId: 'dm-user-api', userName: '鍜ㄨ瀹㈡埛', text: '杩欎釜鏈嶅姟鎬庝箞鏀惰垂锛?',
    });
    dmDb.close();

    const synced = await (await fetch(`${baseUrl}/api/dm-leads/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, awemeId: 'external-api' }),
    })).json();
    expect(synced.created).toBe(1);

    const leads = await (await fetch(`${baseUrl}/api/dm-leads?accountId=${account.id}&query=${encodeURIComponent('鏀惰垂')}`)).json();
    expect(leads).toHaveLength(1);
    const sources = await (await fetch(`${baseUrl}/api/dm-leads/${leads[0].id}/sources`)).json();
    expect(sources).toHaveLength(1);
    expect(sources[0].commentId).toBe('dm-comment-api');

    const approved = await (await fetch(`${baseUrl}/api/dm-leads/${leads[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftText: '浣犲ソ锛屽彲浠ュ厛娌熼€氫竴涓嬮渶姹傘€?', status: 'approved' }),
    })).json();
    expect(approved.status).toBe('approved');

    const response = await fetch(`${baseUrl}/api/dm-leads/send-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, leadIds: [approved.id] }),
    });
    const job = await response.json();
    expect(response.status).toBe(201);
    expect(job).toMatchObject({ type: 'dm-send', totalCount: 1, status: 'pending' });
  });

  it('creates a persistent multi-video comment sync job through the API', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '閲囬泦璐﹀彿' }),
    })).json();
    const Workspace = require('../lib/desktop/workspace');
    const Database = require('better-sqlite3');
    const syncDb = new Database(path.join(dir, 'desktop.db'));
    syncDb.pragma('foreign_keys = ON');
    Workspace.upsertVideo(syncDb, { awemeId: 'sync-video-1', accountId: account.id, source: 'search' });
    Workspace.upsertVideo(syncDb, { awemeId: 'sync-video-2', accountId: account.id, source: 'search' });
    syncDb.close();

    const response = await fetch(`${baseUrl}/api/comment-sync-jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id, awemeIds: ['sync-video-1', 'sync-video-2'], targetCount: 300,
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      type: 'comment-sync', totalCount: 2, status: 'pending',
      input: { targetCount: 300, concurrency: 1 },
    });
  });

  it('manages DM monitor states and inbox APIs without leaking raw message data', async () => {
    const firstAccount = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '缁変椒淇?A' }),
    })).json();
    const secondAccount = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '缁変椒淇?B' }),
    })).json();

    const updatedMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cursor: 'cursor-1',
        status: 'running',
        lastError: 'timeout',
        historyStatus: 'realtime_only',
        historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
      }),
    });
    expect(updatedMonitor.status).toBe(200);
    expect(await updatedMonitor.json()).toMatchObject({
      accountId: firstAccount.id,
      cursor: 'cursor-1',
      status: 'running',
      lastError: 'timeout',
      historyStatus: 'realtime_only',
      historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
    });

    const explicitMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        settingSource: 'explicit',
        replyModeOverride: 'automatic',
      }),
    });
    expect(explicitMonitor.status).toBe(200);
    expect(await explicitMonitor.json()).toMatchObject({
      accountId: firstAccount.id,
      enabled: true,
      settingSource: 'explicit',
      replyModeOverride: 'automatic',
    });

    const inheritedMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: null,
        settingSource: 'inherited',
        replyModeOverride: null,
      }),
    });
    expect(inheritedMonitor.status).toBe(200);
    expect(await inheritedMonitor.json()).toMatchObject({
      accountId: firstAccount.id,
      enabled: false,
      settingSource: 'inherited',
      replyModeOverride: null,
    });

    const invalidExplicitMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: null,
        settingSource: 'explicit',
        replyModeOverride: null,
      }),
    });
    expect(invalidExplicitMonitor.status).toBe(400);

    const monitorStates = await fetch(`${baseUrl}/api/dm/monitor-states`);
    expect(monitorStates.status).toBe(200);
    expect(await monitorStates.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: firstAccount.id,
        cursor: 'cursor-1',
        status: 'running',
        lastError: 'timeout',
        historyStatus: 'realtime_only',
      }),
      expect.objectContaining({
        accountId: secondAccount.id,
        cursor: '',
        status: 'idle',
        lastError: null,
      }),
    ]));

    const singleState = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`);
    expect(singleState.status).toBe(200);
    expect(await singleState.json()).toMatchObject({
      accountId: firstAccount.id,
      cursor: 'cursor-1',
      status: 'running',
      historyStatus: 'realtime_only',
    });

    const unverifiedComplete = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyStatus: 'complete' }),
    });
    expect(unverifiedComplete.status).toBe(400);

    const firstIngest = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: firstAccount.id,
        selfPlatformId: 'acct-self',
        messages: [
          {
            conversation_id: 'c1',
            index: '1',
            sender: 'user-1',
            content: '缁楊兛绔撮弶鈩冩瀮閺?',
            timestamp: 1000,
            conversation_name: '瀵姳绗?',
          },
          {
            conversation_id: 'c1',
            index: '2',
            sender: 'user-1',
            content: '[image]',
            message_type: 'image',
            timestamp: 2000,
            conversation_name: '瀵姳绗?',
          },
          {
            conversation_id: 'c1',
            index: '3',
            sender: 'acct-self',
            content: '瀹告彃娲栨径?',
            timestamp: 3000,
            conversation_name: '瀵姳绗?',
            isOutgoing: true,
          },
          {
            conversation_id: 'c2',
            index: '1',
            sender: 'user-2',
            content: '閹簼绠為弨鎯板瀭閿?',
            timestamp: 4000,
            conversation_name: '閺夊骸娲?',
          },
          {
            conversation_id: 'c1',
            index: 'native-7',
            sender: 'user-1',
            content: 'native websocket text',
            message_type: 7,
            timestamp: 3500,
            conversation_name: '瀵姳绗?',
          },
        ],
      }),
    });
    expect(firstIngest.status).toBe(201);
    const firstIngestBody = await firstIngest.json();
    expect(firstIngestBody).toMatchObject({
      inserted: 5,
      duplicates: 0,
    });
    const firstInsertedMessages = firstIngestBody.insertedMessages;
    expect(firstInsertedMessages).toHaveLength(5);
    expect(firstInsertedMessages.map((message) => ({
      accountId: message.accountId,
      direction: message.direction,
      messageType: message.messageType,
    }))).toEqual([
      { accountId: firstAccount.id, direction: 'inbound', messageType: 'text' },
      { accountId: firstAccount.id, direction: 'inbound', messageType: 'image' },
      { accountId: firstAccount.id, direction: 'outbound', messageType: 'text' },
      { accountId: firstAccount.id, direction: 'inbound', messageType: 'text' },
      { accountId: firstAccount.id, direction: 'inbound', messageType: '7' },
    ]);
    expect(firstInsertedMessages.every((message) => message.id && message.conversationId)).toBe(true);
    expect(firstInsertedMessages.every((message) => typeof message.peerName === 'string')).toBe(true);
    expect(firstInsertedMessages.every((message) => typeof message.content === 'string')).toBe(true);
    expect(JSON.stringify(firstInsertedMessages)).not.toContain('"raw"');

    const monitorWithIdentity = await fetch(`${baseUrl}/api/dm/monitor-states/${firstAccount.id}`);
    expect(await monitorWithIdentity.json()).toMatchObject({ platformUserId: 'acct-self' });

    const invalidIdentityIngest = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, selfPlatformId: { uid: 'bad' }, messages: [] }),
    });
    expect(invalidIdentityIngest.status).toBe(400);

    const db = openDb();
    const queuedAnalyze = db.prepare(`
      SELECT type, dedupe_key AS dedupeKey, message_id AS messageId, payload
      FROM dm_work_items
      WHERE type = 'analyze'
      ORDER BY created_at ASC, id ASC
    `).all();
    expect(queuedAnalyze).toHaveLength(3);
    expect(queuedAnalyze[0].dedupeKey).toContain('source-message:');
    expect(queuedAnalyze[1].dedupeKey).toContain('source-message:');
    expect(new Set(queuedAnalyze.map((item) => item.dedupeKey)).size).toBe(3);

    const pageOneResponse = await fetch(`${baseUrl}/api/dm/conversations?accountId=${firstAccount.id}&limit=1&offset=0`);
    expect(pageOneResponse.status).toBe(200);
    const pageOne = await pageOneResponse.json();
    expect(pageOne).toHaveLength(1);
    expect(pageOne[0]).toMatchObject({
      accountId: firstAccount.id,
      conversationId: 'c2',
      unreadCount: 1,
      status: 'open',
      lastMessageText: '閹簼绠為弨鎯板瀭閿?',
      replyModeOverride: null,
    });
    expect(pageOne[0].lastMessageAt).toBe(4000);
    expect(pageOne[0]).not.toHaveProperty('lastMessageKey');

    const pageTwoResponse = await fetch(`${baseUrl}/api/dm/conversations?accountId=${firstAccount.id}&limit=1&offset=1`);
    expect(pageTwoResponse.status).toBe(200);
    const pageTwo = await pageTwoResponse.json();
    expect(pageTwo).toHaveLength(1);
    expect(pageTwo[0]).toMatchObject({
      accountId: firstAccount.id,
      conversationId: 'c1',
      unreadCount: 3,
      lastMessageText: 'native websocket text',
    });

    const exactConversationResponse = await fetch(
      `${baseUrl}/api/dm/conversations/${pageOne[0].id}?accountId=${firstAccount.id}`,
    );
    expect(exactConversationResponse.status).toBe(200);
    expect(await exactConversationResponse.json()).toMatchObject({
      id: pageOne[0].id,
      accountId: firstAccount.id,
      conversationId: 'c2',
    });

    const crossAccountConversationResponse = await fetch(
      `${baseUrl}/api/dm/conversations/${pageOne[0].id}?accountId=${secondAccount.id}`,
    );
    expect(crossAccountConversationResponse.status).toBe(404);

    const queryResponse = await fetch(`${baseUrl}/api/dm/conversations?accountId=${firstAccount.id}&query=${encodeURIComponent('瀵姳绗?')}`);
    expect(queryResponse.status).toBe(200);
    const queryMatches = await queryResponse.json();
    expect(queryMatches).toHaveLength(1);
    expect(queryMatches[0].conversationId).toBe('c1');

    const conversation = dmInbox.getConversationByPlatformId(db, firstAccount.id, 'c1');
    const draft = dmInbox.upsertReplyDraft(db, {
      conversationRowId: conversation.id,
      accountId: firstAccount.id,
      content: '閸ョ偛顦查懡澶岊焾',
      status: 'approved',
      meta: { source: 'analysis' },
    });
    dmInbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'lock-auth' });
    db.close();

    const historyResponse = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}/messages?accountId=${firstAccount.id}&before=3000&limit=2`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json();
    expect(history.map((item) => item.content)).toEqual(['缁楊兛绔撮弶鈩冩瀮閺?', '[image]']);
    expect(history[0]).toMatchObject({
      accountId: firstAccount.id,
      conversationId: conversation.id,
      platformConversationId: 'c1',
      direction: 'inbound',
      messageType: 'text',
      peerName: '瀵姳绗?',
    });
    expect(history[0]).not.toHaveProperty('raw');

    const conversationPatch = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, status: 'closed', replyModeOverride: 'manual' }),
    });
    expect(conversationPatch.status).toBe(200);
    expect(await conversationPatch.json()).toMatchObject({
      id: conversation.id,
      accountId: firstAccount.id,
      status: 'closed',
      replyModeOverride: 'manual',
    });

    const automaticPatch = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, replyModeOverride: 'automatic' }),
    });
    expect(automaticPatch.status).toBe(200);
    expect(await automaticPatch.json()).toMatchObject({
      id: conversation.id,
      replyModeOverride: 'automatic',
    });

    const tieredPatch = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, replyModeOverride: 'tiered' }),
    });
    expect(tieredPatch.status).toBe(200);
    expect(await tieredPatch.json()).toMatchObject({
      id: conversation.id,
      replyModeOverride: 'tiered',
    });

    const clearedOverride = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, replyModeOverride: null }),
    });
    expect(clearedOverride.status).toBe(200);
    expect(await clearedOverride.json()).toMatchObject({
      id: conversation.id,
      replyModeOverride: null,
    });

    const readResponse = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id }),
    });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      id: conversation.id,
      unreadCount: 0,
    });

    const reauthorizeResponse = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}/reauthorize-auto-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id }),
    });
    expect(reauthorizeResponse.status).toBe(200);
    expect(await reauthorizeResponse.json()).toMatchObject({
      id: conversation.id,
      autoReplyAuthorized: true,
    });

    const draftResponse = await fetch(`${baseUrl}/api/dm/drafts?accountId=${firstAccount.id}&conversationId=${conversation.id}`);
    expect(draftResponse.status).toBe(200);
    expect(await draftResponse.json()).toMatchObject({
      id: draft.id,
      accountId: firstAccount.id,
      conversationRowId: conversation.id,
      content: '閸ョ偛顦查懡澶岊焾',
      status: 'approved',
      meta: { source: 'analysis' },
    });

    const analysisResponse = await fetch(
      `${baseUrl}/api/dm/conversations/${conversation.id}/analysis?accountId=${firstAccount.id}`,
    );
    expect(analysisResponse.status).toBe(200);
    expect(await analysisResponse.json()).toMatchObject({
      workItem: {
        accountId: firstAccount.id,
        conversationId: conversation.id,
        type: 'analyze',
      },
      draft: {
        id: draft.id,
        accountId: firstAccount.id,
        conversationId: conversation.id,
        content: '閸ョ偛顦查懡澶岊焾',
        status: 'approved',
      },
      knowledge: [],
    });

    const reanalyzeResponse = await fetch(
      `${baseUrl}/api/dm/conversations/${conversation.id}/reanalyze`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: firstAccount.id }),
      },
    );
    expect(reanalyzeResponse.status).toBe(201);
    expect(await reanalyzeResponse.json()).toMatchObject({
      accountId: firstAccount.id,
      conversationId: conversation.id,
      type: 'analyze',
      status: 'pending',
    });

    const duplicateIngest = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: firstAccount.id,
        messages: [
          {
            conversation_id: 'c1',
            index: '1',
            sender: 'user-1',
            content: '缁楊兛绔撮弶鈩冩瀮閺?',
            timestamp: 1000,
            conversation_name: '瀵姳绗?',
          },
        ],
      }),
    });
    expect(duplicateIngest.status).toBe(201);
    expect(await duplicateIngest.json()).toMatchObject({ inserted: 0, duplicates: 1, insertedMessages: [] });

    const mixedIngest = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: firstAccount.id,
        messages: [
          {
            conversation_id: 'c1',
            index: '2',
            sender: 'user-1',
            content: '[image]',
            message_type: 'image',
            timestamp: 2000,
            conversation_name: '鐎殿喚濮崇粭?',
          },
          {
            conversation_id: 'c1',
            index: '4',
            sender: 'user-1',
            content: 'new inbound',
            timestamp: 5000,
            conversation_name: '鐎殿喚濮崇粭?',
          },
        ],
      }),
    });
    expect(mixedIngest.status).toBe(201);
    expect(await mixedIngest.json()).toMatchObject({
      inserted: 1,
      duplicates: 1,
      insertedMessages: [
        {
          accountId: firstAccount.id,
          content: 'new inbound',
          direction: 'inbound',
          messageType: 'text',
          peerName: '瀵姳绗?',
        },
      ],
    });

    const recheckDb = openDb();
    const analyzeCount = recheckDb.prepare('SELECT COUNT(*) AS count FROM dm_work_items WHERE type = ?').get('analyze').count;
    recheckDb.close();
    expect(analyzeCount).toBe(5);

    const secondAccountConversations = await fetch(`${baseUrl}/api/dm/conversations?accountId=${secondAccount.id}&limit=5`);
    expect(secondAccountConversations.status).toBe(200);
    expect(await secondAccountConversations.json()).toEqual([]);
  });

  it('rejects invalid DM API input and not found records with the specified status codes', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '缁変椒淇婇弽鈥抽〒' }),
    })).json();

    const missingAccount = await fetch(`${baseUrl}/api/dm/conversations`);
    expect(missingAccount.status).toBe(400);
    expect(await missingAccount.json()).toMatchObject({ ok: false, error: expect.stringContaining('accountId') });

    const missingIngestAccount = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(missingIngestAccount.status).toBe(400);
    expect(await missingIngestAccount.json()).toMatchObject({ ok: false, error: expect.stringContaining('accountId') });

    const nonArrayMessages = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, messages: { bad: true } }),
    });
    expect(nonArrayMessages.status).toBe(400);
    expect(await nonArrayMessages.json()).toMatchObject({ ok: false, error: expect.stringContaining('messages') });

    const tooManyMessages = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        messages: Array.from({ length: 201 }, (_, index) => ({
          conversation_id: `conv-${index}`,
          index: String(index),
          sender: `user-${index}`,
          content: 'overflow',
          timestamp: index + 1,
        })),
      }),
    });
    expect(tooManyMessages.status).toBe(413);
    expect(await tooManyMessages.json()).toMatchObject({ ok: false, error: expect.stringContaining('200') });

    const invalidMessage = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        messages: [{ sender: 'user-1', content: 'missing conversation id', timestamp: 1 }],
      }),
    });
    expect(invalidMessage.status).toBe(400);
    expect(await invalidMessage.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('conversation_id'),
    });

    const unknownAccount = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_00000000-0000-4000-8000-000000000000',
        messages: [],
      }),
    });
    expect(unknownAccount.status).toBe(404);

    const seeded = await fetch(`${baseUrl}/api/dm/messages/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        messages: [{
          conversation_id: 'seed',
          index: '1',
          sender: 'user-seed',
          content: 'seed',
          timestamp: 1,
        }],
      }),
    });
    expect(seeded.status).toBe(201);

    const db = openDb();
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'seed');
    db.close();
    const missingConversationId = 'dmc_00000000-0000-4000-8000-000000000000';

    const invalidConversationPatch = await fetch(`${baseUrl}/api/dm/conversations/not-a-local-id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, status: 'closed' }),
    });
    expect(invalidConversationPatch.status).toBe(400);

    const invalidMessagesPath = await fetch(`${baseUrl}/api/dm/conversations/not-a-local-id/messages?accountId=${account.id}`);
    expect(invalidMessagesPath.status).toBe(400);

    const invalidReadPath = await fetch(`${baseUrl}/api/dm/conversations/not-a-local-id/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: account.id }),
    });
    expect(invalidReadPath.status).toBe(400);

    const invalidReauthorizePath = await fetch(`${baseUrl}/api/dm/conversations/not-a-local-id/reauthorize-auto-reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: account.id }),
    });
    expect(invalidReauthorizePath.status).toBe(400);

    const invalidDraftPath = await fetch(`${baseUrl}/api/dm/drafts?accountId=${account.id}&conversationId=seed`);
    expect(invalidDraftPath.status).toBe(400);

    const unknownConversation = await fetch(`${baseUrl}/api/dm/conversations/${missingConversationId}/messages?accountId=${account.id}`);
    expect(unknownConversation.status).toBe(404);

    const unknownConversationPatch = await fetch(`${baseUrl}/api/dm/conversations/${missingConversationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, status: 'closed' }),
    });
    expect(unknownConversationPatch.status).toBe(404);

    const unknownDraft = await fetch(`${baseUrl}/api/dm/drafts?accountId=${account.id}&conversationId=${missingConversationId}`);
    expect(unknownDraft.status).toBe(404);

    const invalidConversationFields = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, status: 'closed', peerName: 'should-fail' }),
    });
    expect(invalidConversationFields.status).toBe(400);
    expect(await invalidConversationFields.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('peerName'),
    });

    const invalidReplyModeOverride = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, replyModeOverride: 'robot' }),
    });
    expect(invalidReplyModeOverride.status).toBe(400);
    expect(await invalidReplyModeOverride.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('replyModeOverride'),
    });

    const spacedReplyModeOverride = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, replyModeOverride: ' manual ' }),
    });
    expect(spacedReplyModeOverride.status).toBe(400);
    expect(await spacedReplyModeOverride.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('replyModeOverride'),
    });

    const newlineReplyModeOverride = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, replyModeOverride: 'manual\n' }),
    });
    expect(newlineReplyModeOverride.status).toBe(400);
    expect(await newlineReplyModeOverride.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('replyModeOverride'),
    });

    const emptyReplyModeOverride = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, replyModeOverride: '' }),
    });
    expect(emptyReplyModeOverride.status).toBe(400);
    expect(await emptyReplyModeOverride.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('replyModeOverride'),
    });

    const invalidReplyModeOverrideType = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, replyModeOverride: true }),
    });
    expect(invalidReplyModeOverrideType.status).toBe(400);
    expect(await invalidReplyModeOverrideType.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('replyModeOverride'),
    });

    const verifyDb = openDb();
    expect(dmInbox.getConversation(verifyDb, conversation.id).replyModeOverride).toBeNull();
    verifyDb.close();

    const unknownMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/acct_00000000-0000-4000-8000-000000000000`);
    expect(unknownMonitor.status).toBe(404);

    const patchUnknownMonitor = await fetch(`${baseUrl}/api/dm/monitor-states/acct_00000000-0000-4000-8000-000000000000`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(patchUnknownMonitor.status).toBe(404);

    const unknownAccountConversations = await fetch(`${baseUrl}/api/dm/conversations?accountId=acct_00000000-0000-4000-8000-000000000000`);
    expect(unknownAccountConversations.status).toBe(404);
  });

  it('queries, deduplicates, and bulk manages knowledge documents', async () => {
    const create = async (input) => (await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })).json();
    const price = await create({
      title: 'GEO 收费说明', category: '常见问题', tags: 'GEO,收费',
      content: 'GEO 服务根据目标、现状和交付范围评估报价。',
      sourceType: 'markdown', sourceName: '03-常见问题回复.md', enabled: true,
    });
    const disabled = await create({
      title: '旧版收费', category: '常见问题', tags: '收费',
      content: '这是一条停用资料。', enabled: false,
    });
    await create({
      title: 'GEO 服务范围', category: '服务说明', tags: 'GEO',
      content: '提供诊断和内容策略建议。', enabled: true,
    });

    const legacyList = await (await fetch(`${baseUrl}/api/knowledge`)).json();
    expect(Array.isArray(legacyList)).toBe(true);

    const queried = await (await fetch(
      `${baseUrl}/api/knowledge?q=${encodeURIComponent('收费')}&status=enabled&category=${encodeURIComponent('常见问题')}&sort=title&order=asc&page=1&pageSize=10`,
    )).json();
    expect(queried).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(queried.items[0]).toMatchObject({ id: price.id, chunkCount: 1, sourceType: 'markdown' });
    expect(queried.facets.categories).toContain('常见问题');
    expect(queried.facets.tags).toContain('GEO');

    const duplicate = await fetch(`${baseUrl}/api/knowledge/check-duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: price.content }),
    });
    expect(await duplicate.json()).toMatchObject({ duplicate: true, entry: { id: price.id } });

    const disabledResult = await fetch(`${baseUrl}/api/knowledge/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [price.id], action: 'disable' }),
    });
    expect(await disabledResult.json()).toMatchObject({ changed: 1 });

    const deletedResult = await fetch(`${baseUrl}/api/knowledge/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [disabled.id], action: 'delete' }),
    });
    expect(await deletedResult.json()).toMatchObject({ changed: 1 });
  });

  it('returns a safely cropped source comment in list and exact conversation DTOs', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '来源评论账号' }),
    })).json();
    const db = openDb();
    workspace.upsertVideo(db, { awemeId: 'source-video', accountId: account.id, source: 'search' });
    workspace.upsertComment(db, {
      cid: 'source-comment',
      awemeId: 'source-video',
      accountId: account.id,
      userId: 'source-user',
      userName: '来源用户',
      text: `来源评论${'长'.repeat(1200)}`,
      raw: { secret: 'source-raw-secret' },
    });
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'source-video' });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    dmLeads.markLeadSent(db, lead.id, { conversationId: 'source-api-conversation' });
    dmInbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{
        conversation_id: 'source-api-conversation',
        index: '1',
        sender: 'source-user',
        content: '私信消息',
        timestamp: 1000,
      }],
    });
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'source-api-conversation');
    db.close();

    const listResponse = await fetch(`${baseUrl}/api/dm/conversations?accountId=${account.id}`);
    const list = await listResponse.json();
    const exactResponse = await fetch(`${baseUrl}/api/dm/conversations/${conversation.id}?accountId=${account.id}`);
    const exact = await exactResponse.json();

    expect(listResponse.status).toBe(200);
    expect(exactResponse.status).toBe(200);
    expect(list[0].sourceComment).toBe(exact.sourceComment);
    expect(exact.sourceComment.startsWith('来源评论')).toBe(true);
    expect(exact.sourceComment.length).toBeLessThanOrEqual(500);
    expect(exact).not.toHaveProperty('raw');
    expect(JSON.stringify(exact)).not.toContain('source-raw-secret');
  });

  it('deletes only local DM data and rejects unsafe or active-send deletion requests', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Local delete account' }),
    })).json();
    const otherAccount = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Other local delete account' }),
    })).json();
    const db = openDb();
    dmInbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{ conversation_id: 'api-local-delete', index: '1', sender: 'peer', content: 'hello', timestamp: 1000 }],
    });
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'api-local-delete');
    const outbound = dmInbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'queued reply',
      timestamp: 2000,
    });
    const work = dmWorkQueue.enqueueWork(db, {
      type: 'send_manual',
      accountId: account.id,
      conversationId: conversation.id,
      messageId: outbound.message.id,
      dedupeKey: 'api-delete-active-send',
      payload: { text: 'queued reply' },
    });
    db.close();
    const endpoint = `${baseUrl}/api/dm/conversations/${conversation.id}`;

    const crossAccount = await fetch(`${endpoint}?accountId=${otherAccount.id}`, { method: 'DELETE' });
    expect(crossAccount.status).toBe(404);

    const browserOrigin = await fetch(`${endpoint}?accountId=${account.id}`, {
      method: 'DELETE',
      headers: { origin: 'https://example.test' },
    });
    expect(browserOrigin.status).toBe(403);

    const activeSend = await fetch(`${endpoint}?accountId=${account.id}`, { method: 'DELETE' });
    expect(activeSend.status).toBe(409);
    expect(await activeSend.json()).toMatchObject({ ok: false, error: expect.stringContaining('sending') });

    const releaseDb = openDb();
    releaseDb.prepare("UPDATE dm_work_items SET status = 'success' WHERE id = ?").run(work.id);
    releaseDb.close();
    const deleted = await fetch(`${endpoint}?accountId=${account.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: conversation.id, deleted: true });

    const verifyDb = openDb();
    expect(dmInbox.getConversation(verifyDb, conversation.id)).toBeNull();
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM dm_messages WHERE conversation_row_id = ?').get(conversation.id).count).toBe(0);
    verifyDb.close();
  });

  it('rejects every conversation-scoped DM route when accountId does not own the conversation', async () => {
    const postJson = (pathname, body, method = 'POST') => fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const accountA = await (await postJson('/api/accounts', { name: '账号 A', status: 'enabled' })).json();
    const accountB = await (await postJson('/api/accounts', { name: '账号 B', status: 'enabled' })).json();
    await postJson('/api/dm/messages/ingest', {
      accountId: accountA.id,
      messages: [{
        conversation_id: 'owned-by-a',
        index: '1',
        sender: 'peer-a',
        content: '只属于 A 的消息',
        timestamp: 1000,
      }],
    });

    const seedDb = openDb();
    const conversation = dmInbox.getConversationByPlatformId(seedDb, accountA.id, 'owned-by-a');
    dmInbox.upsertReplyDraft(seedDb, {
      accountId: accountA.id,
      conversationRowId: conversation.id,
      content: 'A 的草稿',
      status: 'draft',
    });
    seedDb.prepare(`
      UPDATE dm_conversations
      SET auto_reply_authorized = 0, status = 'open'
      WHERE id = ?
    `).run(conversation.id);
    const before = {
      conversation: seedDb.prepare(`
        SELECT status, unread_count, auto_reply_authorized, updated_at
        FROM dm_conversations WHERE id = ?
      `).get(conversation.id),
      messages: seedDb.prepare('SELECT COUNT(*) AS count FROM dm_messages').get().count,
      drafts: seedDb.prepare('SELECT COUNT(*) AS count FROM dm_reply_drafts').get().count,
      workItems: seedDb.prepare('SELECT COUNT(*) AS count FROM dm_work_items').get().count,
    };
    seedDb.close();

    const encodedConversationId = encodeURIComponent(conversation.id);
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/dm/conversations/${encodedConversationId}?accountId=${encodeURIComponent(accountB.id)}`),
      fetch(`${baseUrl}/api/dm/conversations/${encodedConversationId}/messages?accountId=${encodeURIComponent(accountB.id)}`),
      postJson(`/api/dm/conversations/${encodedConversationId}`, {
        accountId: accountB.id,
        status: 'closed',
      }, 'PATCH'),
      postJson(`/api/dm/conversations/${encodedConversationId}/read`, { accountId: accountB.id }),
      postJson(`/api/dm/conversations/${encodedConversationId}/reauthorize-auto-reply`, { accountId: accountB.id }),
      fetch(`${baseUrl}/api/dm/drafts?accountId=${encodeURIComponent(accountB.id)}&conversationId=${encodedConversationId}`),
      postJson(`/api/dm/conversations/${encodedConversationId}/replies`, {
        accountId: accountB.id,
        text: '不允许排队',
        mode: 'manual',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({ ok: false, error: 'conversation not found' });
    }

    const verifyDb = openDb();
    expect(verifyDb.prepare(`
      SELECT status, unread_count, auto_reply_authorized, updated_at
      FROM dm_conversations WHERE id = ?
    `).get(conversation.id)).toEqual(before.conversation);
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM dm_messages').get().count).toBe(before.messages);
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM dm_reply_drafts').get().count).toBe(before.drafts);
    expect(verifyDb.prepare('SELECT COUNT(*) AS count FROM dm_work_items').get().count).toBe(before.workItems);
    verifyDb.close();
  });

  it('enforces DM send execution ordering and returns only whitelisted reply and work DTOs', async () => {
    const postJson = (pathname, body) => fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const account = await (await postJson('/api/accounts', { name: 'DTO account', status: 'enabled' })).json();
    await postJson('/api/dm/messages/ingest', {
      accountId: account.id,
      messages: [{
        conversation_id: 'dto-conversation',
        conversation_short_id: 'dto-short-secret',
        ticket: 'dto-ticket-secret',
        index: '1',
        sender: 'dto-peer',
        content: 'inbound message',
        timestamp: 1000,
      }],
    });
    const db = openDb();
    const conversation = dmInbox.getConversationByPlatformId(db, account.id, 'dto-conversation');
    const sourceDraft = dmInbox.upsertReplyDraft(db, {
      accountId: account.id,
      conversationRowId: conversation.id,
      content: 'AI draft',
      status: 'needs_review',
      meta: { intent: 'greeting' },
    });
    db.close();

    const replyResponse = await postJson(`/api/dm/conversations/${conversation.id}/replies`, {
      accountId: account.id,
      text: 'manual reply',
      mode: 'manual',
      sourceDraftId: sourceDraft.id,
    });
    const reply = await replyResponse.json();
    expect(replyResponse.status).toBe(201);
    expect(Object.keys(reply.message).sort()).toEqual([
      'accountId', 'content', 'conversationId', 'createdAt', 'direction', 'id',
      'status', 'timestamp', 'updatedAt',
    ]);
    expect(Object.keys(reply.workItem).sort()).toEqual([
      'accountId', 'attemptCount', 'completedAt', 'conversationId', 'createdAt', 'error',
      'executionStartedAt', 'id', 'maxAttempts', 'messageId', 'nextRunAt', 'status',
      'type', 'updatedAt',
    ]);
    expect(JSON.stringify(reply)).not.toMatch(/raw|payload|result|conversationKey|dto-ticket-secret|dto-short-secret/i);
    const queuedDraftDb = openDb();
    expect(queuedDraftDb.prepare('SELECT content, status FROM dm_reply_drafts WHERE id = ?').get(sourceDraft.id))
      .toEqual({ content: 'manual reply', status: 'queued' });
    queuedDraftDb.close();

    const rendererClaimResponse = await fetch(`${baseUrl}/api/dm/work-items/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5174',
      },
      body: JSON.stringify({ workerId: 'renderer-must-not-claim', types: ['send_manual'] }),
    });
    expect(rendererClaimResponse.status).toBe(403);
    expect(JSON.stringify(await rendererClaimResponse.json())).not.toMatch(/claimToken|claim_token/i);

    const claimResponse = await postJson('/api/dm/work-items/claim', {
      workerId: 'dto-worker',
      types: ['send_manual'],
    });
    const claim = await claimResponse.json();
    expect(claimResponse.status).toBe(200);
    expect(Object.keys(claim.workItem).sort()).toEqual([
      ...Object.keys(reply.workItem), 'claimToken',
    ].sort());
    expect(claim.workItem.claimToken).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(claim)).not.toMatch(/payload|result|conversationKey|workerId|leaseExpiresAt|claimTokenHash|dto-ticket-secret/i);

    const missingToken = await postJson(`/api/dm/work-items/${reply.workItem.id}/start-execution`, {
      workerId: 'dto-worker',
    });
    expect(missingToken.status).toBe(400);
    expect(JSON.stringify(await missingToken.json())).not.toContain(claim.workItem.claimToken);

    const wrongToken = await postJson(`/api/dm/work-items/${reply.workItem.id}/fail`, {
      workerId: 'dto-worker',
      claimToken: 'not-the-current-token',
      error: 'must not apply',
      retryable: false,
    });
    expect(wrongToken.status).toBe(409);
    const wrongTokenBody = await wrongToken.json();
    expect(wrongTokenBody.error).toMatch(/claim/i);
    expect(JSON.stringify(wrongTokenBody)).not.toContain(claim.workItem.claimToken);

    const prematureComplete = await postJson(`/api/dm/work-items/${reply.workItem.id}/complete`, {
      workerId: 'dto-worker',
      claimToken: claim.workItem.claimToken,
      result: { message_id: 'must-not-apply' },
    });
    expect(prematureComplete.status).toBe(409);
    expect(await prematureComplete.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/execution.*not.*started/i),
    });
    const unchangedDb = openDb();
    expect(unchangedDb.prepare('SELECT status, result FROM dm_work_items WHERE id = ?').get(reply.workItem.id))
      .toEqual({ status: 'running', result: '{}' });
    expect(unchangedDb.prepare('SELECT status FROM dm_messages WHERE id = ?').get(reply.message.id))
      .toEqual({ status: 'pending' });
    unchangedDb.close();

    await postJson(`/api/dm/work-items/${reply.workItem.id}/start-execution`, {
      workerId: 'dto-worker',
      claimToken: claim.workItem.claimToken,
    });
    const completeResponse = await postJson(`/api/dm/work-items/${reply.workItem.id}/complete`, {
      workerId: 'dto-worker',
      claimToken: claim.workItem.claimToken,
      result: { message_id: 'sent-message', internal_bridge_result: 'must-not-leak' },
    });
    const completed = await completeResponse.json();
    expect(completeResponse.status).toBe(200);
    expect(completed.workItem.status).toBe('success');
    expect(completed.message.status).toBe('accepted');
    expect(JSON.stringify(completed)).not.toMatch(/payload|result|raw|internal_bridge_result|workerId|leaseExpiresAt/i);
    const sentDraftDb = openDb();
    expect(sentDraftDb.prepare('SELECT content, status FROM dm_reply_drafts WHERE id = ?').get(sourceDraft.id))
      .toEqual({ content: 'manual reply', status: 'accepted' });
    sentDraftDb.close();

    const duplicateComplete = await postJson(`/api/dm/work-items/${reply.workItem.id}/complete`, {
      workerId: 'dto-worker',
      claimToken: claim.workItem.claimToken,
      result: { message_id: 'duplicate-must-not-apply' },
    });
    expect(duplicateComplete.status).toBe(200);
    expect((await duplicateComplete.json()).workItem.status).toBe('success');

    const failedReply = await (await postJson(`/api/dm/conversations/${conversation.id}/replies`, {
      accountId: account.id,
      text: 'second manual reply',
      mode: 'manual',
    })).json();
    const failedClaim = await (await postJson('/api/dm/work-items/claim', {
      workerId: 'dto-worker-2', types: ['send_manual'],
    })).json();
    const failResponse = await postJson(`/api/dm/work-items/${failedReply.workItem.id}/fail`, {
      workerId: 'dto-worker-2',
      claimToken: failedClaim.workItem.claimToken,
      error: 'account requires login',
      retryable: false,
    });
    const failed = await failResponse.json();
    expect(failResponse.status).toBe(200);
    expect(failed.workItem).toMatchObject({ status: 'failed', error: 'account requires login' });
    expect(failed.message.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toMatch(/payload|result|raw|workerId|leaseExpiresAt/i);
  });

  it('returns 400 for invalid write lease owner, token, and ttl values', async () => {
    const postLease = (action, body) => fetch(`${baseUrl}/api/operations/write-lease/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    for (const body of [
      { owner: 123, ttlMs: 60_000 },
      { owner: 'writer', ttlMs: '60000' },
      { owner: 'writer', ttlMs: Number.NaN },
      { owner: 'writer', ttlMs: 0 },
      { owner: 'writer', ttlMs: -1 },
      { owner: 'writer', ttlMs: 49 },
      { owner: 'writer', ttlMs: 600_001 },
      { owner: 'writer', ttlMs: 1.5 },
    ]) {
      const response = await postLease('acquire', body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/owner|ttlMs/i);
    }

    const acquiredResponse = await postLease('acquire', { owner: 'writer', ttlMs: 60_000 });
    const acquired = await acquiredResponse.json();
    expect(acquiredResponse.status).toBe(200);
    expect(acquired.acquired).toBe(true);

    for (const body of [
      { token: 123, ttlMs: 60_000 },
      { token: acquired.token, ttlMs: '60000' },
      { token: acquired.token, ttlMs: 0 },
      { token: acquired.token, ttlMs: 600_001 },
    ]) {
      const response = await postLease('renew', body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/token|ttlMs/i);
    }

    const invalidRelease = await postLease('release', { token: 123 });
    expect(invalidRelease.status).toBe(400);
  });
});
