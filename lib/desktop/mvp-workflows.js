const fs = require('fs');
const path = require('path');

const batch = require('./batch');
const workspace = require('./workspace');
const events = require('./events');
const {
  createBridgeClient,
  ensureBridgeClientOnline,
  runLikeTask,
  runPublishTask,
} = require('./task-runner');
const { SITE, escapeExpression } = require('../commands/helpers');
const { LLMClient } = require('../llm');

const SEARCH_PAGE_SIZE = 20;
const MAX_SEARCH_TARGET = 500;

function normalizeAweme(row) {
  const aweme = row?.aweme_info || row?.aweme || row;
  const awemeId = String(aweme?.aweme_id || aweme?.awemeId || aweme?.id || '').trim();
  if (!awemeId) return null;
  const author = aweme.author || aweme.author_user_info || {};
  return {
    awemeId,
    desc: String(aweme.desc || aweme.title || ''),
    authorName: String(author.nickname || author.name || ''),
    authorId: String(author.uid || author.sec_uid || author.secUid || ''),
    url: `https://www.douyin.com/video/${awemeId}`,
    raw: aweme,
  };
}

function extractAwemeRows(value) {
  const candidates = [
    value?.data,
    value?.aweme_list,
    value?.awemeList,
    value?.items,
    value?.list,
  ];
  const rows = candidates.find(Array.isArray) || [];
  return rows.map(normalizeAweme).filter(Boolean);
}

function normalizeComment(row, awemeId, accountId) {
  const user = row?.user || row?.author || {};
  const cid = String(row?.cid || row?.comment_id || row?.id || '').trim();
  if (!cid) return null;
  return {
    cid,
    awemeId,
    accountId,
    userName: String(user.nickname || user.name || row?.user_name || ''),
    userId: String(user.uid || user.sec_uid || row?.uid || ''),
    text: String(row?.text || row?.content || ''),
    diggCount: row?.digg_count ?? row?.diggCount ?? null,
    raw: row,
  };
}

function extractCommentRows(value, awemeId, accountId) {
  const rows = [value?.comments, value?.comment_list, value?.data, value?.items]
    .find(Array.isArray) || [];
  return rows.map((row) => normalizeComment(row, awemeId, accountId)).filter(Boolean);
}

function taskLike(accountId, awemeId, action = 'like') {
  return { accountId, input: { awemeId, action } };
}

function taskPublish(accountId, awemeId, text, replyToCommentId = null) {
  return { accountId, input: { awemeId, text, replyToCommentId } };
}

async function runSearchSession(db, input = {}, options = {}) {
  const keyword = String(input.keyword || '').trim();
  if (!input.accountId) throw new Error('accountId is required');
  if (!keyword) throw new Error('keyword is required');

  const targetCount = Math.max(1, Math.min(Number(input.count || input.targetCount || 100), MAX_SEARCH_TARGET));
  const session = workspace.createSearchSession(db, {
    accountId: input.accountId,
    keyword,
    count: targetCount,
    excludeKnown: input.excludeKnown !== false,
    status: 'running',
  });
  const bridgeClient = options.bridgeClient || createBridgeClient();

  try {
    await ensureBridgeClientOnline(bridgeClient);
    const collected = [];
    const seen = new Set();
    let offset = Math.max(0, Number(input.offset || 0));
    let emptyPages = 0;
    const maxPages = 120;

    for (let page = 0; page < maxPages && collected.length < targetCount; page += 1) {
      const expression = `window.__bridge.search('${escapeExpression(keyword)}', ${offset}, ${SEARCH_PAGE_SIZE})`;
      const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 60000 });
      if (!response.ok) throw new Error(response.error || '搜索失败');
      const rows = extractAwemeRows(response.value);
      if (!rows.length) emptyPages += 1;
      if (emptyPages >= 3) break;

      for (const video of rows) {
        if (seen.has(video.awemeId)) continue;
        seen.add(video.awemeId);
        if (session.excludeKnown && workspace.videoExists(db, video.awemeId)) continue;
        const saved = workspace.upsertVideo(db, {
          ...video,
          accountId: input.accountId,
          searchSessionId: session.id,
          source: 'search',
        });
        collected.push(saved);
        if (collected.length >= targetCount) break;
      }
      offset += SEARCH_PAGE_SIZE;
    }

    const updated = workspace.updateSearchSession(db, session.id, {
      status: 'success',
      actualCount: collected.length,
      error: null,
    });
    events.appendEvent(db, {
      accountId: input.accountId,
      level: 'info',
      message: '搜索获客完成',
      metadata: { keyword, targetCount, actualCount: collected.length },
    });
    return { session: updated, results: collected };
  } catch (error) {
    workspace.updateSearchSession(db, session.id, {
      status: 'failed',
      actualCount: workspace.listVideos(db, { searchSessionId: session.id }).length,
      error: error.message,
    });
    events.appendEvent(db, {
      accountId: input.accountId,
      level: 'error',
      message: '搜索获客失败',
      metadata: { keyword, error: error.message },
    });
    throw error;
  }
}

function createBatchFromVideos(db, input = {}) {
  const awemeIds = Array.isArray(input.awemeIds) ? input.awemeIds.map(String).filter(Boolean) : [];
  if (!input.accountId) throw new Error('accountId is required');
  if (!input.type) throw new Error('type is required');
  if (!awemeIds.length) throw new Error('awemeIds is required');
  if (input.type === 'comment' && !String(input.commentText || '').trim()) {
    throw new Error('commentText is required');
  }

  return batch.createBatchJob(db, {
    accountId: input.accountId,
    type: input.type,
    input: {
      commentText: input.commentText || '',
      likeAction: input.likeAction || 'like',
      skipDone: input.skipDone !== false,
    },
    items: awemeIds.map((awemeId) => ({
      awemeId,
      input: {
        awemeId,
        text: input.commentText || '',
        action: input.likeAction || 'like',
      },
    })),
  });
}

async function runBatchJob(db, jobId, options = {}) {
  const job = batch.getBatchJob(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  const bridgeClient = options.bridgeClient || createBridgeClient();
  await ensureBridgeClientOnline(bridgeClient);
  batch.updateBatchJobStatus(db, job.id, 'running', { error: null });

  const items = batch.listBatchItems(db, job.id);
  for (const item of items) {
    batch.updateBatchItemStatus(db, item.id, 'running', { error: null });
    try {
      const video = item.awemeId ? workspace.getVideo(db, item.awemeId) : null;
      if (job.input.skipDone !== false && job.type === 'like' && video?.liked) {
        batch.updateBatchItemStatus(db, item.id, 'skipped', { result: { reason: '已点赞，跳过' } });
        batch.recountBatchJob(db, job.id);
        continue;
      }
      if (job.input.skipDone !== false && job.type === 'comment' && video?.commented) {
        batch.updateBatchItemStatus(db, item.id, 'skipped', { result: { reason: '已评论，跳过' } });
        batch.recountBatchJob(db, job.id);
        continue;
      }

      let result;
      if (job.type === 'like') {
        result = await runLikeTask(db, taskLike(job.accountId, item.awemeId, item.input.action), bridgeClient);
        workspace.markVideoAction(db, item.awemeId, { liked: result.action === 'like' });
      } else if (job.type === 'comment') {
        result = await runPublishTask(db, taskPublish(job.accountId, item.awemeId, item.input.text), bridgeClient);
        workspace.markVideoAction(db, item.awemeId, { commented: true });
      } else {
        throw new Error(`不支持的批量任务类型：${job.type}`);
      }
      batch.updateBatchItemStatus(db, item.id, 'success', { result, error: null });
    } catch (error) {
      batch.updateBatchItemStatus(db, item.id, 'failed', { error: error.message });
    }
    batch.recountBatchJob(db, job.id);
  }

  return {
    job: batch.getBatchJob(db, job.id),
    items: batch.listBatchItems(db, job.id),
  };
}

async function syncMyVideos(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const targetCount = Math.max(1, Math.min(Number(input.count || 100), 500));
  const bridgeClient = options.bridgeClient || createBridgeClient();
  await ensureBridgeClientOnline(bridgeClient);

  const saved = [];
  let cursor = 0;
  for (let page = 0; page < 50 && saved.length < targetCount; page += 1) {
    const expression = `window.__bridge.myPosts(${cursor}, ${Math.min(SEARCH_PAGE_SIZE, targetCount - saved.length)})`;
    const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 60000 });
    if (!response.ok) throw new Error(response.error || '获取我的作品失败');
    const rows = extractAwemeRows(response.value);
    for (const video of rows) {
      saved.push(workspace.upsertVideo(db, {
        ...video,
        accountId: input.accountId,
        source: 'my',
        isMine: true,
      }));
      if (saved.length >= targetCount) break;
    }
    const nextCursor = Number(response.value?.max_cursor ?? response.value?.maxCursor ?? 0);
    const hasMore = response.value?.has_more ?? response.value?.hasMore;
    if (!rows.length || !hasMore || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return saved;
}

async function syncComments(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  if (!input.awemeId) throw new Error('awemeId is required');
  const targetCount = Math.max(1, Math.min(Number(input.count || 100), 500));
  const bridgeClient = options.bridgeClient || createBridgeClient();
  await ensureBridgeClientOnline(bridgeClient);

  const saved = [];
  let cursor = 0;
  for (let page = 0; page < 50 && saved.length < targetCount; page += 1) {
    const expression = `window.__bridge.getComments('${escapeExpression(input.awemeId)}', ${cursor}, ${Math.min(50, targetCount - saved.length)})`;
    const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 60000 });
    if (!response.ok) throw new Error(response.error || '获取评论失败');
    const rows = extractCommentRows(response.value, input.awemeId, input.accountId);
    for (const comment of rows) {
      saved.push(workspace.upsertComment(db, comment));
      if (saved.length >= targetCount) break;
    }
    const nextCursor = Number(response.value?.cursor ?? response.value?.next_cursor ?? response.value?.nextCursor ?? 0);
    const hasMore = response.value?.has_more ?? response.value?.hasMore;
    if (!rows.length || !hasMore || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return saved;
}

function loadStrategyMarkdown() {
  const names = ['评论风格指南.md', '评论区运营.md', '全局规则.md', 'reply-strategy.md'];
  return names.map((name) => {
    try {
      return `# ${name}\n${fs.readFileSync(path.resolve(process.cwd(), name), 'utf8').slice(0, 5000)}`;
    } catch {
      return '';
    }
  }).filter(Boolean).join('\n\n');
}

async function analyzeComments(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const ids = Array.isArray(input.commentIds) ? input.commentIds : [];
  if (!ids.length) throw new Error('commentIds is required');
  const comments = ids.map((id) => workspace.getComment(db, id)).filter(Boolean).filter((comment) => !comment.replied);
  if (!comments.length) return [];

  const knowledge = workspace.listKnowledgeEntries(db, { enabledOnly: true });
  const strategyMarkdown = loadStrategyMarkdown();
  const llm = options.llmClient || new LLMClient();
  const response = typeof llm.generateReplyDrafts === 'function'
    ? await llm.generateReplyDrafts(comments, { knowledge, strategyMarkdown })
    : await llm.suggestReplies(comments, { style: '自然、简短、基于知识库回复' }, '', { knowledge });

  const drafts = [];
  for (const item of Array.isArray(response) ? response : []) {
    const cid = String(item.cid || item.commentId || '').trim();
    const comment = workspace.getComment(db, cid);
    if (!comment || comment.replied) continue;
    const draftText = String(item.reply || item.draftText || '').trim();
    if (!draftText) continue;
    drafts.push(workspace.upsertReplyDraft(db, {
      accountId: input.accountId,
      awemeId: comment.awemeId,
      commentId: comment.cid,
      category: item.category || '普通互动',
      intentLevel: item.intentLevel || item.intent_level || '中',
      reason: item.reason || '',
      draftText,
      knowledgeRefs: item.knowledgeRefs || item.knowledge_refs || [],
      raw: item,
      status: 'draft',
    }));
  }
  return drafts;
}

async function publishReplyDraft(db, id, options = {}) {
  const draft = workspace.getReplyDraft(db, id);
  if (!draft) throw new Error('回复草稿不存在');
  if (draft.status === 'published') return draft;
  if (draft.status !== 'approved') throw new Error('回复草稿需要先审核，再发布');
  const comment = workspace.getComment(db, draft.commentId);
  if (!comment) throw new Error('原评论不存在');
  if (comment.replied) throw new Error('这条评论已经回复过，不能重复发布');

  const bridgeClient = options.bridgeClient || createBridgeClient();
  await ensureBridgeClientOnline(bridgeClient);
  const result = await runPublishTask(
    db,
    taskPublish(draft.accountId, draft.awemeId, draft.draftText, draft.commentId),
    bridgeClient,
  );
  workspace.markCommentReplied(db, draft.commentId, result.cid);
  return workspace.updateReplyDraft(db, id, {
    status: 'published',
    publishedCid: result.cid,
  });
}

module.exports = {
  MAX_SEARCH_TARGET,
  analyzeComments,
  createBatchFromVideos,
  extractAwemeRows,
  extractCommentRows,
  publishReplyDraft,
  runBatchJob,
  runSearchSession,
  syncComments,
  syncMyVideos,
};
