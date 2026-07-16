const fs = require('fs');
const path = require('path');

const batch = require('./batch');
const dmLeads = require('./dm-leads');
const operationLease = require('./operation-lease');
const workspace = require('./workspace');
const events = require('./events');
const desktopSettings = require('./settings');
const {
  collectSearchVideos,
  createBridgeClient,
  ensureBridgeClientOnline,
  resolveAwemeIdInput,
  runDeleteCommentTask,
  runLikeTask,
  runPublishTask,
} = require('./task-runner');
const { SITE, escapeExpression } = require('../commands/helpers');
const { LLMClient } = require('../llm');

const SEARCH_PAGE_SIZE = 20;
const MAX_SEARCH_TARGET = 500;
const DEFAULT_BATCH_ITEM_DELAY_MS = 3000;
const DEFAULT_BATCH_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 240000;
const DEFAULT_REPLY_DELAY_MIN_MS = 45000;
const DEFAULT_REPLY_DELAY_MAX_MS = 90000;
const DEFAULT_DELETE_DELAY_MIN_MS = 20000;
const DEFAULT_DELETE_DELAY_MAX_MS = 40000;
const DEFAULT_DM_DELAY_MIN_MS = 60000;
const DEFAULT_DM_DELAY_MAX_MS = 120000;
const DEFAULT_COMMENT_PAGE_DELAY_MIN_MS = 1500;
const DEFAULT_COMMENT_PAGE_DELAY_MAX_MS = 3000;
const DEFAULT_COMMENT_VIDEO_DELAY_MIN_MS = 4000;
const DEFAULT_COMMENT_VIDEO_DELAY_MAX_MS = 8000;
const DEFAULT_WRITE_LEASE_TTL_MS = 120000;
const DEFAULT_WRITE_LEASE_POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWriteBatchJobType(type) {
  return ['like', 'comment', 'delete-comment', 'reply-comments', 'dm-send'].includes(type);
}

async function waitForWriteLease(db, owner, options = {}) {
  const lease = await operationLease.waitForWriteLease(db, owner, {
    ...options,
    ttlMs: Number(options.writeLeaseTtlMs || DEFAULT_WRITE_LEASE_TTL_MS),
    pollMs: Math.max(50, Number(options.writeLeasePollMs || DEFAULT_WRITE_LEASE_POLL_MS)),
    sleepFn: options.sleepFn || sleep,
  });
  return lease?.acquired ? lease : null;
}

async function withWriteLease(db, owner, action, options = {}) {
  return operationLease.withWriteLease(db, owner, action, {
    ...options,
    ttlMs: Number(options.writeLeaseTtlMs || DEFAULT_WRITE_LEASE_TTL_MS),
    heartbeatMs: options.writeLeaseHeartbeatMs,
    pollMs: Math.max(50, Number(options.writeLeasePollMs || DEFAULT_WRITE_LEASE_POLL_MS)),
    sleepFn: options.sleepFn || sleep,
  });
}

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
    publishTime: workspace.normalizePublishTime(
      aweme.create_time ?? aweme.createTime ?? aweme.publish_time ?? aweme.publishTime,
    ),
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

function buildSearchError(keyword, message) {
  const detail = String(message || 'unknown error').trim();
  if (detail.startsWith('底层抖音搜索接口')) return detail;
  if (detail.includes('fetch failed')) {
    return `底层抖音搜索接口对关键词「${keyword}」返回 fetch failed。请先在右侧浏览器手动搜索同一关键词，确认页面能正常返回结果。`;
  }
  if (detail.includes('timeout') || detail.includes('超时')) {
    return `底层抖音搜索接口对关键词「${keyword}」响应超时。已停止继续分页，请稍后重试或换关键词。`;
  }
  return `底层抖音搜索接口对关键词「${keyword}」执行失败：${detail}`;
}

async function resolveExternalVideo(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const rawInput = String(input.input || input.url || input.awemeId || '').trim();
  if (!rawInput) throw new Error('请粘贴抖音分享链接、分享文案或数字作品 ID');
  const bridgeClient = options.bridgeClient || createBridgeClient();
  const awemeId = await resolveAwemeIdInput(rawInput, bridgeClient, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return workspace.upsertVideo(db, {
    awemeId,
    accountId: input.accountId,
    source: 'external-link',
    isMine: false,
    url: `https://www.douyin.com/video/${awemeId}`,
    raw: { input: rawInput },
  });
}

function normalizeComment(row, awemeId, accountId, context = {}) {
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
    parentCid: context.parentCid || null,
    rootCid: context.rootCid || null,
    depth: Number(context.depth || 0),
    isOwn: Boolean(context.ownerId && String(user.uid || user.sec_uid || row?.uid || '') === String(context.ownerId)),
    raw: { ...row, reply_comment: undefined, reply_comments: undefined, replies: undefined, children: undefined },
  };
}

function extractCommentRows(value, awemeId, accountId, ownerId = '') {
  const rows = [value?.comments, value?.comment_list, value?.data, value?.items]
    .find(Array.isArray) || [];
  const flattened = [];
  for (const row of rows) {
    const root = normalizeComment(row, awemeId, accountId, { ownerId });
    if (!root) continue;
    flattened.push(root);
    const replies = [row?.reply_comment, row?.reply_comments, row?.replies, row?.children]
      .find(Array.isArray) || [];
    for (const reply of replies) {
      const child = normalizeComment(reply, awemeId, accountId, {
        ownerId,
        parentCid: root.cid,
        rootCid: root.cid,
        depth: 1,
      });
      if (child) flattened.push(child);
    }
  }
  return flattened;
}

function buildCompactMyPostsExpression(cursor, count) {
  return `window.__bridge.myPosts(${cursor}, ${count}).then(function(result) {
    var rows = result && (result.aweme_list || result.awemeList || result.data || result.items || result.list);
    rows = Array.isArray(rows) ? rows : [];
    return {
      items: rows.map(function(row) {
        var aweme = row && (row.aweme_info || row.aweme || row);
        if (!aweme) return null;
        var awemeId = aweme.aweme_id || aweme.awemeId || aweme.id || '';
        if (!awemeId) return null;
        var author = aweme.author || aweme.author_user_info || {};
        return {
          aweme_id: String(awemeId),
          desc: String(aweme.desc || aweme.title || '').slice(0, 2000),
          create_time: aweme.create_time !== undefined ? aweme.create_time :
            (aweme.createTime !== undefined ? aweme.createTime :
              (aweme.publish_time !== undefined ? aweme.publish_time : aweme.publishTime)),
          author: {
            nickname: String(author.nickname || author.name || '').slice(0, 200),
            uid: String(author.uid || '').slice(0, 256),
            sec_uid: String(author.sec_uid || author.secUid || '').slice(0, 256)
          }
        };
      }).filter(function(row) { return Boolean(row); }),
      has_more: result && (result.has_more !== undefined ? result.has_more : result.hasMore),
      next_cursor: result && (result.max_cursor !== undefined ? result.max_cursor :
        (result.maxCursor !== undefined ? result.maxCursor :
          (result.next_cursor !== undefined ? result.next_cursor : result.nextCursor)))
    };
  })`;
}

function buildCompactCommentsExpression(awemeId, cursor, count) {
  return `window.__bridge.getComments('${escapeExpression(awemeId)}', ${cursor}, ${count}).then(function(result) {
    var rows = result && (result.comments || result.comment_list || result.data || result.items);
    rows = Array.isArray(rows) ? rows : [];
    return {
      comments: rows.map(function(row) {
        if (!row) return null;
        var cid = row.cid || row.comment_id || row.id || '';
        if (!cid) return null;
        var user = row.user || row.author || {};
        return {
          cid: String(cid),
          text: String(row.text || row.content || '').slice(0, 5000),
          digg_count: row.digg_count !== undefined ? row.digg_count : row.diggCount,
          reply_comment_total: row.reply_comment_total !== undefined ? row.reply_comment_total :
            (row.reply_count !== undefined ? row.reply_count : 0),
          user: {
            nickname: String(user.nickname || user.name || row.user_name || '').slice(0, 200),
            uid: String(user.uid || row.uid || '').slice(0, 256),
            sec_uid: String(user.sec_uid || user.secUid || '').slice(0, 256)
          },
          reply_comment: (Array.isArray(row.reply_comment) ? row.reply_comment :
            (Array.isArray(row.reply_comments) ? row.reply_comments :
              (Array.isArray(row.replies) ? row.replies : []))).slice(0, 50).map(function(reply) {
            if (!reply) return null;
            var replyCid = reply.cid || reply.comment_id || reply.id || '';
            if (!replyCid) return null;
            var replyUser = reply.user || reply.author || {};
            return {
              cid: String(replyCid),
              text: String(reply.text || reply.content || '').slice(0, 5000),
              digg_count: reply.digg_count !== undefined ? reply.digg_count : reply.diggCount,
              user: {
                nickname: String(replyUser.nickname || replyUser.name || reply.user_name || '').slice(0, 200),
                uid: String(replyUser.uid || reply.uid || '').slice(0, 256),
                sec_uid: String(replyUser.sec_uid || replyUser.secUid || '').slice(0, 256)
              }
            };
          }).filter(function(reply) { return Boolean(reply); })
        };
      }).filter(function(row) { return Boolean(row); }),
      has_more: result && (result.has_more !== undefined ? result.has_more : result.hasMore),
      next_cursor: result && (result.cursor !== undefined ? result.cursor :
        (result.next_cursor !== undefined ? result.next_cursor : result.nextCursor))
    };
  })`;
}

function buildCompactRepliesExpression(commentId, awemeId, cursor, count) {
  return `window.__bridge.replies('${escapeExpression(commentId)}', '${escapeExpression(awemeId)}', ${cursor}, ${count}).then(function(result) {
    var rows = result && (result.comments || result.comment_list || result.data || result.items);
    rows = Array.isArray(rows) ? rows : [];
    return {
      comments: rows.map(function(row) {
        if (!row) return null;
        var cid = row.cid || row.comment_id || row.id || '';
        if (!cid) return null;
        var user = row.user || row.author || {};
        return {
          cid: String(cid),
          text: String(row.text || row.content || '').slice(0, 5000),
          digg_count: row.digg_count !== undefined ? row.digg_count : row.diggCount,
          user: {
            nickname: String(user.nickname || user.name || row.user_name || '').slice(0, 200),
            uid: String(user.uid || row.uid || '').slice(0, 256),
            sec_uid: String(user.sec_uid || user.secUid || '').slice(0, 256)
          }
        };
      }).filter(function(row) { return Boolean(row); }),
      has_more: result && (result.has_more !== undefined ? result.has_more : result.hasMore),
      next_cursor: result && (result.cursor !== undefined ? result.cursor :
        (result.next_cursor !== undefined ? result.next_cursor : result.nextCursor))
    };
  })`;
}

function extractReplyRows(value, awemeId, accountId, rootCid, ownerId = '') {
  const rows = [value?.comments, value?.comment_list, value?.data, value?.items]
    .find(Array.isArray) || [];
  return rows.map((row) => normalizeComment(row, awemeId, accountId, {
    ownerId,
    parentCid: rootCid,
    rootCid,
    depth: 1,
  })).filter(Boolean);
}

function taskLike(accountId, awemeId, action = 'like') {
  return { accountId, input: { awemeId, action } };
}

function taskPublish(accountId, awemeId, text, replyToCommentId = null) {
  return { accountId, input: { awemeId, text, replyToCommentId } };
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
      itemDelayMs: Math.max(1000, Number(input.itemDelayMs || DEFAULT_BATCH_ITEM_DELAY_MS)),
      concurrency: 1,
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

function createBatchFromComments(db, input = {}) {
  const commentIds = Array.isArray(input.commentIds) ? [...new Set(input.commentIds.map(String).filter(Boolean))] : [];
  if (!input.accountId) throw new Error('accountId is required');
  if (!input.awemeId) throw new Error('awemeId is required');
  if (!['analyze-comments', 'reply-comments', 'delete-comment'].includes(input.type)) {
    throw new Error(`不支持的评论批量任务类型：${input.type || 'empty'}`);
  }
  if (!commentIds.length) throw new Error('commentIds is required');
  const video = workspace.getVideo(db, input.awemeId);
  if (!video || !video.isMine || video.accountId !== input.accountId) {
    throw new Error('只能管理当前账号自己发布作品的评论区');
  }

  const comments = commentIds.map((cid) => workspace.getComment(db, cid));
  if (comments.some((comment) => !comment || comment.awemeId !== input.awemeId || comment.accountId !== input.accountId)) {
    throw new Error('所选评论不属于当前账号的这个作品');
  }
  if (input.type === 'delete-comment' && comments.some((comment) => comment.deleted)) {
    throw new Error('所选评论中包含已删除评论');
  }

  const delayDefaults = input.type === 'delete-comment'
    ? [DEFAULT_DELETE_DELAY_MIN_MS, DEFAULT_DELETE_DELAY_MAX_MS]
    : [DEFAULT_REPLY_DELAY_MIN_MS, DEFAULT_REPLY_DELAY_MAX_MS];
  const minDelayMs = Math.max(delayDefaults[0], Number(input.minDelayMs || delayDefaults[0]));
  const maxDelayMs = Math.max(minDelayMs, Number(input.maxDelayMs || delayDefaults[1]));
  return batch.createBatchJob(db, {
    accountId: input.accountId,
    type: input.type,
    input: {
      awemeId: input.awemeId,
      minDelayMs,
      maxDelayMs,
      concurrency: 1,
      maxRetries: input.maxRetries ?? 3,
      retryBaseDelayMs: Math.max(60000, Number(input.retryBaseDelayMs || 60000)),
    },
    items: comments.map((comment) => {
      const draft = input.type === 'reply-comments'
        ? workspace.getReplyDraftByComment(db, comment.cid)
        : null;
      return {
        awemeId: input.awemeId,
        commentId: comment.cid,
        input: {
          commentId: comment.cid,
          draftId: draft?.id || null,
        },
      };
    }),
  });
}

function createDmSendJob(db, input = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const leadIds = Array.isArray(input.leadIds)
    ? [...new Set(input.leadIds.map(String).filter(Boolean))]
    : [];
  if (!leadIds.length) throw new Error('leadIds is required');
  const leads = leadIds.map((id) => dmLeads.getLead(db, id));
  if (leads.some((lead) => !lead || lead.accountId !== input.accountId)) {
    throw new Error('所选私信线索不属于当前账号');
  }
  for (const lead of leads) dmLeads.assertSendable(lead);
  const minDelayMs = Math.max(DEFAULT_DM_DELAY_MIN_MS, Number(input.minDelayMs || DEFAULT_DM_DELAY_MIN_MS));
  const maxDelayMs = Math.max(minDelayMs, Number(input.maxDelayMs || DEFAULT_DM_DELAY_MAX_MS));
  return batch.createBatchJob(db, {
    accountId: input.accountId,
    type: 'dm-send',
    input: {
      minDelayMs,
      maxDelayMs,
      concurrency: 1,
      maxRetries: Math.max(0, Math.min(3, Number(input.maxRetries ?? 2))),
      retryBaseDelayMs: Math.max(120000, Number(input.retryBaseDelayMs || 120000)),
    },
    items: leads.map((lead) => ({
      awemeId: lead.awemeId,
      commentId: lead.commentId,
      input: {
        leadId: lead.id,
        userId: lead.userId,
        text: lead.draftText,
      },
    })),
  });
}

function createCommentSyncJob(db, input = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const awemeIds = Array.isArray(input.awemeIds)
    ? [...new Set(input.awemeIds.map(String).map((id) => id.trim()).filter(Boolean))]
    : [];
  if (!awemeIds.length) throw new Error('请至少选择一个外部视频');
  const videos = awemeIds.map((awemeId) => workspace.getVideo(db, awemeId));
  if (videos.some((video) => !video || video.accountId !== input.accountId)) {
    throw new Error('所选外部视频不属于当前账号');
  }
  const targetCount = Math.max(1, Math.min(5000, Number(input.targetCount || input.count || 200)));
  return batch.createBatchJob(db, {
    accountId: input.accountId,
    type: 'comment-sync',
    input: {
      targetCount,
      fetchedComments: 0,
      savedComments: 0,
      duplicateComments: 0,
      processedVideos: 0,
      pageDelayMinMs: DEFAULT_COMMENT_PAGE_DELAY_MIN_MS,
      pageDelayMaxMs: DEFAULT_COMMENT_PAGE_DELAY_MAX_MS,
      minDelayMs: DEFAULT_COMMENT_VIDEO_DELAY_MIN_MS,
      maxDelayMs: DEFAULT_COMMENT_VIDEO_DELAY_MAX_MS,
      maxRetries: Math.max(0, Math.min(3, Number(input.maxRetries ?? 2))),
      retryBaseDelayMs: Math.max(15000, Number(input.retryBaseDelayMs || 15000)),
      concurrency: 1,
    },
    items: awemeIds.map((awemeId) => ({ awemeId, input: { awemeId } })),
  });
}

function buildDmSendExpression(userId, text) {
  return `(function(){
    if(!window.__bridge || typeof window.__bridge.createConversation !== 'function' || typeof window.__bridge.sendDM !== 'function'){
      throw new Error('私信 Bridge API 未准备好');
    }
    return window.__bridge.createConversation('${escapeExpression(userId)}').then(function(conversation){
      if(!conversation || !conversation.conversation_id){throw new Error('无法创建私信会话');}
      var conversationKey=[conversation.conversation_id,conversation.conversation_short_id||'0',conversation.ticket||''].join('|');
      return window.__bridge.sendDM(conversationKey,'${escapeExpression(text)}').then(function(result){
        return {
          status_code:Number(result&&result.status_code||0),
          conversation_id:String(conversation.conversation_id),
          message_id:String(result&&(result.message_id||result.server_message_id||result.client_message_id)||'')
        };
      });
    });
  })()`;
}

async function runDmSendTask(lead, bridgeClient) {
  dmLeads.assertSendable(lead);
  const response = await bridgeClient.call({
    site: SITE,
    expression: buildDmSendExpression(lead.userId, lead.draftText),
    awaitPromise: true,
    timeout: 60000,
  });
  if (!response.ok) throw new Error(response.error || '私信发送失败');
  const value = response.value || {};
  if (value.status_code !== undefined && Number(value.status_code) !== 0) {
    throw new Error(`私信发送失败：status_code=${value.status_code}`);
  }
  return {
    status: 'sent',
    conversationId: String(value.conversation_id || ''),
    messageId: String(value.message_id || ''),
  };
}

async function runSearchSession(db, input = {}, options = {}) {
  const keyword = String(input.keyword || '').trim();
  if (!input.accountId) throw new Error('accountId is required');
  if (!keyword) throw new Error('keyword is required');

  const targetCount = Math.max(1, Math.min(Number(input.count || input.targetCount || 10), MAX_SEARCH_TARGET));
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
    const searchResult = await collectSearchVideos(bridgeClient, {
      keyword,
      count: targetCount,
      offset: Math.max(0, Number(input.offset || 0)),
      shouldInclude: (video) => (
        !session.excludeKnown || !workspace.videoExists(db, video.awemeId)
      ),
    });
    const collected = [];
    for (const video of searchResult.items) {
      const wasKnown = workspace.videoExists(db, video.awemeId);
      const saved = workspace.upsertVideo(db, {
        ...video,
        accountId: input.accountId,
        searchSessionId: session.id,
        source: 'search',
      });
      workspace.linkSearchSessionVideo(db, {
        searchSessionId: session.id,
        awemeId: saved.awemeId,
        rankIndex: collected.length,
        wasKnown,
      });
      collected.push(saved);
    }

    const warning = searchResult.warning
      ? buildSearchError(keyword, searchResult.warning)
      : null;
    const fetchedCount = searchResult.fetchedCount;
    const duplicateInPageCount = searchResult.duplicateCount;
    const skippedKnownCount = searchResult.skippedCount;
    const requestedPages = searchResult.requestedPages;
    const noProgressPages = searchResult.noProgressPages;
    const stoppedReason = searchResult.stoppedReason;

    const updated = workspace.updateSearchSession(db, session.id, {
      status: 'success',
      actualCount: collected.length,
      error: warning,
    });
    events.appendEvent(db, {
      accountId: input.accountId,
      level: 'info',
      message: '搜索获客完成',
      metadata: {
        keyword,
        targetCount,
        actualCount: collected.length,
        fetchedCount,
        skippedKnownCount,
        duplicateInPageCount,
        requestedPages,
        noProgressPages,
        stoppedReason,
        warning,
      },
    });
    return {
      session: updated,
      results: collected,
      summary: {
        keyword,
        requested: targetCount,
        fetched: fetchedCount,
        saved: collected.length,
        skippedKnown: skippedKnownCount,
        duplicateInPage: duplicateInPageCount,
        requestedPages,
        noProgressPages,
        stoppedReason,
        excludeKnown: session.excludeKnown,
        warning,
      },
    };
  } catch (error) {
    const readableError = buildSearchError(keyword, error.message);
    workspace.updateSearchSession(db, session.id, {
      status: 'failed',
      actualCount: workspace.listVideos(db, { searchSessionId: session.id }).length,
      error: readableError,
    });
    events.appendEvent(db, {
      accountId: input.accountId,
      level: 'error',
      message: '搜索获客失败',
      metadata: { keyword, error: readableError, rawError: error.message },
    });
    throw new Error(readableError);
  }
}

async function runBatchJob(db, jobId, options = {}) {
  const job = batch.getBatchJob(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  if (job.status === 'running') throw new Error('批量任务正在执行，请勿重复启动');
  if (job.status === 'cancelled') {
    return { job, items: batch.listBatchItems(db, job.id) };
  }
  const otherRunningJob = batch.listBatchJobs(db)
    .find((item) => item.id !== job.id && ['running', 'pause_requested', 'cancel_requested'].includes(item.status));
  if (otherRunningJob) {
    throw new Error(`已有其他批量任务正在执行：${otherRunningJob.id}。请等待完成或先暂停后再启动。`);
  }
  batch.updateBatchJobStatus(db, job.id, 'running', {
    error: null,
    progressMessage: '正在准备任务',
    nextRunAt: null,
  });
  const bridgeClient = options.bridgeClient || createBridgeClient();
  try {
    if (job.type !== 'analyze-comments') await ensureBridgeClientOnline(bridgeClient);
  } catch (error) {
    batch.updateBatchJobStatus(db, job.id, 'pending', {
      error: error.message,
      progressMessage: '等待浏览器连接后重试',
      nextRunAt: null,
    });
    throw error;
  }

  const items = batch.listBatchItems(db, job.id).filter((item) => item.status === 'pending');
  const itemDelayMs = Math.max(1000, Number(options.itemDelayMs || job.input.itemDelayMs || DEFAULT_BATCH_ITEM_DELAY_MS));
  const maxRetries = Math.max(0, Math.min(5, Number(options.maxRetries ?? job.input.maxRetries ?? DEFAULT_BATCH_MAX_RETRIES)));
  const retryBaseDelayMs = Math.max(500, Number(options.retryBaseDelayMs || job.input.retryBaseDelayMs || DEFAULT_RETRY_BASE_DELAY_MS));
  const sleepFn = options.sleepFn || sleep;
  const randomFn = options.randomFn || Math.random;
  const minDelayMs = Math.max(0, Number(job.input.minDelayMs ?? itemDelayMs));
  const maxDelayMs = Math.max(minDelayMs, Number(job.input.maxDelayMs ?? minDelayMs));

  const currentResult = () => ({
    job: batch.getBatchJob(db, job.id),
    items: batch.listBatchItems(db, job.id),
  });

  const applyControlState = () => {
    const current = batch.getBatchJob(db, job.id);
    if (current?.status === 'pause_requested') {
      batch.markBatchJobPaused(db, job.id);
      return 'paused';
    }
    if (current?.status === 'cancel_requested') {
      batch.markBatchJobCancelled(db, job.id);
      return 'cancelled';
    }
    if (current?.status === 'paused' || current?.status === 'cancelled') return current.status;
    return '';
  };

  const waitWithControl = async (delayMs) => {
    batch.updateBatchJobProgress(db, job.id, {
      progressMessage: '等待下一项执行',
      nextRunAt: new Date(Date.now() + delayMs).toISOString(),
    });
    if (options.sleepFn) {
      await sleepFn(delayMs);
      const control = applyControlState();
      batch.updateBatchJobProgress(db, job.id, { progressMessage: '', nextRunAt: null });
      return control;
    }
    let remaining = delayMs;
    while (remaining > 0) {
      const control = applyControlState();
      if (control) return control;
      const step = Math.min(250, remaining);
      await sleepFn(step);
      remaining -= step;
    }
    const control = applyControlState();
    batch.updateBatchJobProgress(db, job.id, { progressMessage: '', nextRunAt: null });
    return control;
  };

  const isRetryable = (error) => /fetch failed|network|timeout|timed out|ECONN|429|too frequent|系统繁忙|访问频繁/i
    .test(String(error?.message || error || ''));

  if (job.type === 'comment-sync') {
    let fetchedComments = Number(job.input.fetchedComments || 0);
    let savedComments = Number(job.input.savedComments || 0);
    let duplicateComments = Number(job.input.duplicateComments || 0);
    let processedVideos = Number(job.input.processedVideos || 0);
    let consecutiveFailures = 0;
    const targetCount = Math.max(1, Math.min(5000, Number(job.input.targetCount || 200)));
    const pageDelayMinMs = Math.max(DEFAULT_COMMENT_PAGE_DELAY_MIN_MS, Number(job.input.pageDelayMinMs || 0));
    const pageDelayMaxMs = Math.max(pageDelayMinMs, Number(job.input.pageDelayMaxMs || pageDelayMinMs));
    const persistProgress = (patch = {}) => {
      batch.updateBatchJobInput(db, job.id, {
        fetchedComments,
        savedComments,
        duplicateComments,
        processedVideos,
      });
      batch.updateBatchJobProgress(db, job.id, patch);
    };

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (applyControlState()) return currentResult();
      if (savedComments >= targetCount) {
        for (const remaining of items.slice(index)) {
          batch.updateBatchItemStatus(db, remaining.id, 'skipped', {
            result: { reason: '已达到评论目标' }, error: null,
          });
        }
        break;
      }

      batch.updateBatchItemStatus(db, item.id, 'running', { error: null });
      persistProgress({
        currentItemId: item.id,
        progressMessage: `正在采集第 ${processedVideos + 1}/${job.totalCount} 个视频的评论`,
        nextRunAt: null,
      });

      let completed = false;
      for (let attempt = 0; attempt <= maxRetries && !completed; attempt += 1) {
        const baseFetched = fetchedComments;
        const baseSaved = savedComments;
        const baseDuplicates = duplicateComments;
        try {
          const result = await syncComments(db, {
            accountId: job.accountId,
            awemeId: item.awemeId,
            count: targetCount - savedComments,
          }, {
            ...options,
            bridgeClient,
            skipEnsure: true,
            pageDelayMinMs,
            pageDelayMaxMs,
            shouldStop: () => Boolean(applyControlState()),
            onProgress: (summary) => {
              persistProgress({
                currentItemId: item.id,
                progressMessage: `正在采集视频 ${processedVideos + 1}/${job.totalCount}，评论 ${baseSaved + Number(summary.saved || 0)}/${targetCount}`,
              });
            },
          });
          fetchedComments = baseFetched + Number(result.summary.fetched || 0);
          savedComments = baseSaved + Number(result.summary.saved || 0);
          duplicateComments = baseDuplicates + Number(result.summary.duplicates || 0);
          if (result.summary.stoppedReason === 'interrupted') {
            const controlledJob = batch.getBatchJob(db, job.id);
            if (controlledJob?.status !== 'cancelled') {
              batch.updateBatchItemStatus(db, item.id, 'pending', { result: result.summary, error: null });
            }
            persistProgress({
              currentItemId: null,
              progressMessage: controlledJob?.status === 'cancelled' ? '评论采集已取消' : '评论采集已暂停',
              nextRunAt: null,
            });
            return currentResult();
          }
          dmLeads.syncLeadsFromComments(db, { accountId: job.accountId, awemeId: item.awemeId });
          processedVideos += 1;
          batch.updateBatchItemStatus(db, item.id, 'success', { result: result.summary, error: null });
          completed = true;
          consecutiveFailures = 0;
        } catch (error) {
          fetchedComments = baseFetched;
          savedComments = baseSaved;
          duplicateComments = baseDuplicates;
          if (attempt < maxRetries && isRetryable(error)) {
            const retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryBaseDelayMs * (2 ** attempt));
            batch.updateBatchItemStatus(db, item.id, 'running', {
              result: { retrying: true, attempt: attempt + 1, retryDelayMs: retryDelay },
              error: error.message,
            });
            if (await waitWithControl(retryDelay)) return currentResult();
            continue;
          }
          processedVideos += 1;
          consecutiveFailures += 1;
          batch.updateBatchItemStatus(db, item.id, 'failed', {
            result: { attempts: attempt + 1 }, error: error.message,
          });
          completed = true;
        }
      }

      batch.recountBatchJob(db, job.id);
      persistProgress({ currentItemId: null, progressMessage: `已采集评论 ${savedComments}/${targetCount}` });
      if (consecutiveFailures >= 3) {
        batch.markBatchJobPaused(db, job.id);
        persistProgress({ progressMessage: '连续 3 个视频失败，任务已自动暂停', nextRunAt: null });
        return currentResult();
      }
      if (applyControlState()) return currentResult();
      if (index < items.length - 1 && savedComments < targetCount) {
        const delayMs = Math.round(minDelayMs + ((maxDelayMs - minDelayMs) * randomFn()));
        if (await waitWithControl(delayMs)) return currentResult();
      }
    }

    batch.recountBatchJob(db, job.id);
    persistProgress({ currentItemId: null, progressMessage: `评论采集完成，共保存 ${savedComments} 条`, nextRunAt: null });
    return currentResult();
  }

  if (job.type === 'analyze-comments') {
    const analysisBatchSize = Math.max(1, Math.min(20, Number(options.analysisBatchSize || 10)));
    const analysisDelayMs = Math.max(1000, Number(options.analysisDelayMs || 2000));
    for (let offset = 0; offset < items.length; offset += analysisBatchSize) {
      if (applyControlState()) return currentResult();
      const group = items.slice(offset, offset + analysisBatchSize);
      for (const item of group) batch.updateBatchItemStatus(db, item.id, 'running', { error: null });
      batch.updateBatchJobProgress(db, job.id, {
        currentItemId: group[0]?.id || null,
        progressMessage: `正在理解第 ${offset + 1}-${offset + group.length}/${items.length} 条评论`,
        nextRunAt: null,
      });
      try {
        const drafts = await analyzeComments(db, {
          accountId: job.accountId,
          commentIds: group.map((item) => item.commentId),
        }, options);
        const draftByComment = new Map(drafts.map((draft) => [draft.commentId, draft]));
        for (const item of group) {
          const draft = draftByComment.get(item.commentId);
          const comment = workspace.getComment(db, item.commentId);
          if (draft) {
            batch.updateBatchItemStatus(db, item.id, 'success', {
              result: {
                draftId: draft.id,
                category: draft.category,
                intentLevel: draft.intentLevel,
                status: draft.status,
              },
              error: null,
            });
          } else if (comment?.replied || comment?.deleted || comment?.isOwn) {
            batch.updateBatchItemStatus(db, item.id, 'skipped', {
              result: { reason: '自己的回复、已回复或已删除评论无需分析' },
              error: null,
            });
          } else {
            batch.updateBatchItemStatus(db, item.id, 'failed', {
              error: 'LLM 未返回这条评论的分析结果',
            });
          }
        }
      } catch (error) {
        for (const item of group) {
          batch.updateBatchItemStatus(db, item.id, 'failed', { error: error.message });
        }
      }
      batch.recountBatchJob(db, job.id);
      if (offset + group.length < items.length && await waitWithControl(analysisDelayMs)) {
        return currentResult();
      }
    }
    batch.recountBatchJob(db, job.id);
    batch.updateBatchJobProgress(db, job.id, {
      currentItemId: null,
      progressMessage: '评论理解完成',
      nextRunAt: null,
    });
    return currentResult();
  }

  let consecutiveFailures = 0;
  const runWriteAction = async (index, item, attempt, action) => {
    if (!isWriteBatchJobType(job.type)) return { controlled: false, value: await action() };
    const lease = await waitForWriteLease(db, `batch:${job.id}:${item.id}:attempt:${attempt + 1}`, {
      ...options,
      sleepFn,
      shouldStop: () => Boolean(applyControlState()),
      onWait: () => {
        batch.updateBatchJobProgress(db, job.id, {
          currentItemId: item.id,
          progressMessage: `等待全局写租约后继续处理第 ${index + 1}/${items.length} 项`,
          nextRunAt: null,
        });
      },
    });
    if (!lease) return { controlled: true, value: null };
    return {
      controlled: false,
      value: await operationLease.runWithLeaseHeartbeat(db, lease, `batch:${job.id}:${item.id}:attempt:${attempt + 1}`, action, {
        ...options,
        ttlMs: Number(options.writeLeaseTtlMs || DEFAULT_WRITE_LEASE_TTL_MS),
        heartbeatMs: options.writeLeaseHeartbeatMs,
      }),
    };
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (applyControlState()) return currentResult();
    batch.updateBatchJobProgress(db, job.id, {
      currentItemId: item.id,
      progressMessage: `正在处理第 ${index + 1}/${items.length} 项`,
      nextRunAt: null,
    });
    batch.updateBatchItemStatus(db, item.id, 'running', { error: null });
    let completed = false;
    for (let attempt = 0; attempt <= maxRetries && !completed; attempt += 1) {
      try {
        const video = item.awemeId ? workspace.getVideo(db, item.awemeId) : null;
        if (job.input.skipDone !== false && job.type === 'like' && video?.liked) {
          batch.updateBatchItemStatus(db, item.id, 'skipped', { result: { reason: '已点赞，跳过' } });
          completed = true;
          break;
        }
        if (job.input.skipDone !== false && job.type === 'comment' && video?.commented) {
          batch.updateBatchItemStatus(db, item.id, 'skipped', { result: { reason: '已评论，跳过' } });
          completed = true;
          break;
        }

        let result;
        const execution = await runWriteAction(index, item, attempt, async () => {
          if (job.type === 'like') {
            const next = await runLikeTask(db, taskLike(job.accountId, item.awemeId, item.input.action), bridgeClient);
            workspace.markVideoAction(db, item.awemeId, { liked: next.action === 'like' });
            return next;
          }
          if (job.type === 'comment') {
            const next = await runPublishTask(db, taskPublish(job.accountId, item.awemeId, item.input.text), bridgeClient);
            workspace.markVideoAction(db, item.awemeId, { commented: true });
            return next;
          }
          if (job.type === 'delete-comment') {
            const next = await runDeleteCommentTask(db, {
              accountId: job.accountId,
              input: { commentId: item.commentId },
            }, bridgeClient);
            workspace.markCommentDeleted(db, item.commentId);
            return next;
          }
          if (job.type === 'reply-comments') {
            const draft = workspace.getReplyDraft(db, item.input.draftId);
            if (!draft) throw new Error('回复草稿不存在，请重新分析评论');
            return publishReplyDraft(db, draft.id, { ...options, bridgeClient, skipWriteLease: true });
          }
          if (job.type === 'dm-send') {
            const lead = dmLeads.getLead(db, item.input.leadId);
            if (lead?.status === 'sent') {
              batch.updateBatchItemStatus(db, item.id, 'skipped', { result: { reason: '该用户已经发送过私信' } });
              completed = true;
              return null;
            }
            const next = await runDmSendTask(lead, bridgeClient);
            dmLeads.markLeadSent(db, lead.id, next);
            return next;
          }
          throw new Error(`不支持的批量任务类型：${job.type}`);
        });
        if (execution.controlled) return currentResult();
        if (completed) break;
        result = execution.value;
        if (result === null && job.type === 'dm-send') break;
        batch.updateBatchItemStatus(db, item.id, 'success', {
          result: { ...result, attempts: attempt + 1 },
          error: null,
        });
        completed = true;
      } catch (error) {
        if (attempt < maxRetries && isRetryable(error)) {
          const retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryBaseDelayMs * (2 ** attempt));
          batch.updateBatchItemStatus(db, item.id, 'running', {
            result: { retrying: true, attempt: attempt + 1, retryDelayMs: retryDelay },
            error: error.message,
          });
          if (await waitWithControl(retryDelay)) return currentResult();
          continue;
        }
        batch.updateBatchItemStatus(db, item.id, 'failed', {
          result: { attempts: attempt + 1 },
          error: error.message,
        });
        if (job.type === 'dm-send' && item.input.leadId) {
          dmLeads.markLeadFailed(db, item.input.leadId, error);
        }
        completed = true;
      }
    }
    batch.recountBatchJob(db, job.id);
    const completedItem = batch.getBatchItem(db, item.id);
    if (completedItem?.status === 'failed') consecutiveFailures += 1;
    else if (completedItem?.status === 'success') consecutiveFailures = 0;
    if (consecutiveFailures >= 3) {
      batch.markBatchJobPaused(db, job.id);
      batch.updateBatchJobProgress(db, job.id, {
        currentItemId: null,
        progressMessage: '连续 3 项失败，任务已自动暂停，请检查账号、网络或平台提示',
        nextRunAt: null,
      });
      return currentResult();
    }
    if (applyControlState()) return currentResult();
    if (index < items.length - 1) {
      const delayMs = Math.round(minDelayMs + ((maxDelayMs - minDelayMs) * randomFn()));
      if (await waitWithControl(delayMs)) return currentResult();
    }
  }

  batch.recountBatchJob(db, job.id);
  batch.updateBatchJobProgress(db, job.id, {
    currentItemId: null,
    progressMessage: '任务执行完成',
    nextRunAt: null,
  });
  return currentResult();
}

async function resumeBatchJob(db, jobId, options = {}) {
  const job = batch.prepareBatchJobResume(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  return runBatchJob(db, jobId, options);
}

function pauseBatchJob(db, jobId) {
  const job = batch.requestBatchJobPause(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  return { job, items: batch.listBatchItems(db, jobId) };
}

function cancelBatchJob(db, jobId) {
  const job = batch.requestBatchJobCancel(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  const current = job.status === 'cancel_requested' ? job : batch.markBatchJobCancelled(db, jobId);
  return { job: current, items: batch.listBatchItems(db, jobId) };
}

function resetFailedBatchItems(db, jobId) {
  const job = batch.resetFailedBatchItems(db, jobId);
  if (!job) throw new Error(`Batch job not found: ${jobId}`);
  return { job, items: batch.listBatchItems(db, jobId) };
}

async function syncMyVideos(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const targetCount = Math.max(1, Math.min(Number(input.count || 100), 500));
  const bridgeClient = options.bridgeClient || createBridgeClient();
  await ensureBridgeClientOnline(bridgeClient);

  const saved = [];
  const seen = new Set();
  let cursor = 0;
  let pages = 0;
  let fetched = 0;
  let duplicates = 0;
  let stoppedReason = 'page_limit';
  for (let page = 0; page < 50 && saved.length < targetCount; page += 1) {
    const expression = buildCompactMyPostsExpression(
      cursor,
      Math.min(SEARCH_PAGE_SIZE, targetCount - saved.length),
    );
    const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 60000 });
    if (!response.ok) throw new Error(response.error || '获取我的作品失败');
    pages += 1;
    const rows = extractAwemeRows(response.value);
    fetched += rows.length;
    for (const video of rows) {
      if (seen.has(video.awemeId)) {
        duplicates += 1;
        continue;
      }
      seen.add(video.awemeId);
      saved.push(workspace.upsertVideo(db, {
        ...video,
        accountId: input.accountId,
        source: 'my',
        isMine: true,
      }));
      if (saved.length >= targetCount) break;
    }
    if (saved.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }
    const nextCursor = Number(
      response.value?.next_cursor
      ?? response.value?.max_cursor
      ?? response.value?.maxCursor
      ?? response.value?.nextCursor
      ?? 0,
    );
    const hasMore = response.value?.has_more ?? response.value?.hasMore;
    if (!rows.length) {
      stoppedReason = 'empty_page';
      break;
    }
    if (!hasMore) {
      stoppedReason = 'complete';
      break;
    }
    if (nextCursor === cursor) {
      stoppedReason = 'no_progress';
      break;
    }
    cursor = nextCursor;
  }
  return {
    items: workspace.listVideos(db, { accountId: input.accountId, isMine: true }),
    summary: {
      requested: targetCount,
      fetched,
      saved: saved.length,
      duplicates,
      pages,
      nextCursor: cursor,
      stoppedReason,
    },
  };
}

async function syncComments(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  if (!input.awemeId) throw new Error('awemeId is required');
  const targetCount = Math.max(1, Math.min(Number(input.count || 500), 5000));
  const bridgeClient = options.bridgeClient || createBridgeClient();
  if (!options.skipEnsure) await ensureBridgeClientOnline(bridgeClient);

  const saved = [];
  const video = workspace.getVideo(db, input.awemeId);
  const seen = new Set();
  let cursor = 0;
  let pages = 0;
  let fetched = 0;
  let duplicates = 0;
  let stoppedReason = 'page_limit';
  let requestCount = 0;
  const pageDelayMinMs = Math.max(0, Number(options.pageDelayMinMs || 0));
  const pageDelayMaxMs = Math.max(pageDelayMinMs, Number(options.pageDelayMaxMs || pageDelayMinMs));
  const sleepFn = options.sleepFn || sleep;
  const randomFn = options.randomFn || Math.random;
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const reportProgress = () => options.onProgress?.({
    requested: targetCount,
    fetched,
    saved: saved.length,
    duplicates,
    pages,
    nextCursor: cursor,
    stoppedReason,
  });
  const requestBridge = async (expression) => {
    if (shouldStop()) {
      stoppedReason = 'interrupted';
      return null;
    }
    if (requestCount > 0 && pageDelayMaxMs > 0) {
      const delayMs = Math.round(pageDelayMinMs + ((pageDelayMaxMs - pageDelayMinMs) * randomFn()));
      await sleepFn(delayMs);
      if (shouldStop()) {
        stoppedReason = 'interrupted';
        return null;
      }
    }
    requestCount += 1;
    return bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 60000 });
  };
  const saveRows = (rows) => {
    for (const comment of rows) {
      if (seen.has(comment.cid)) {
        duplicates += 1;
        continue;
      }
      seen.add(comment.cid);
      saved.push(workspace.upsertComment(db, comment));
      if (saved.length >= targetCount) break;
    }
    reportProgress();
  };
  for (let page = 0; page < 100 && saved.length < targetCount; page += 1) {
    const expression = buildCompactCommentsExpression(
      input.awemeId,
      cursor,
      Math.min(50, targetCount - saved.length),
    );
    const response = await requestBridge(expression);
    if (!response) break;
    if (!response.ok) throw new Error(response.error || '获取评论失败');
    pages += 1;
    const rows = extractCommentRows(response.value, input.awemeId, input.accountId, video?.authorId || '');
    fetched += rows.length;
    saveRows(rows);
    const roots = [response.value?.comments, response.value?.comment_list, response.value?.data, response.value?.items]
      .find(Array.isArray) || [];
    for (const root of roots) {
      if (saved.length >= targetCount) break;
      const rootCid = String(root?.cid || root?.comment_id || root?.id || '').trim();
      const inlineReplies = [root?.reply_comment, root?.reply_comments, root?.replies, root?.children]
        .find(Array.isArray) || [];
      const replyTotal = Number(root?.reply_comment_total ?? root?.reply_count ?? inlineReplies.length);
      if (!rootCid || replyTotal <= inlineReplies.length) continue;
      let replyCursor = 0;
      for (let replyPage = 0; replyPage < 20 && saved.length < targetCount; replyPage += 1) {
        const replyResponse = await requestBridge(
          buildCompactRepliesExpression(rootCid, input.awemeId, replyCursor, Math.min(50, targetCount - saved.length)),
        );
        if (!replyResponse) break;
        if (!replyResponse.ok) throw new Error(replyResponse.error || `获取评论 ${rootCid} 的回复失败`);
        pages += 1;
        const replyRows = extractReplyRows(
          replyResponse.value,
          input.awemeId,
          input.accountId,
          rootCid,
          video?.authorId || '',
        );
        fetched += replyRows.length;
        saveRows(replyRows);
        const nextReplyCursor = Number(replyResponse.value?.next_cursor ?? replyResponse.value?.cursor ?? 0);
        const replyHasMore = replyResponse.value?.has_more ?? replyResponse.value?.hasMore;
        if (!replyRows.length || !replyHasMore || nextReplyCursor === replyCursor) break;
        replyCursor = nextReplyCursor;
      }
      if (stoppedReason === 'interrupted') break;
    }
    if (stoppedReason === 'interrupted') break;
    if (saved.length >= targetCount) {
      stoppedReason = 'target_reached';
      break;
    }
    const nextCursor = Number(response.value?.next_cursor ?? response.value?.cursor ?? response.value?.nextCursor ?? 0);
    const hasMore = response.value?.has_more ?? response.value?.hasMore;
    if (!rows.length) {
      stoppedReason = 'empty_page';
      break;
    }
    if (!hasMore) {
      stoppedReason = 'complete';
      break;
    }
    if (nextCursor === cursor) {
      stoppedReason = 'no_progress';
      break;
    }
    cursor = nextCursor;
  }
  return {
    items: saved,
    summary: {
      requested: targetCount,
      fetched,
      saved: saved.length,
      duplicates,
      pages,
      nextCursor: cursor,
      stoppedReason,
    },
  };
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

function normalizeDmIntent(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['high', '高', '高意向'].includes(text)) return 'high';
  if (['medium', '中', '中意向'].includes(text)) return 'medium';
  if (['low', '低', '低意向'].includes(text)) return 'low';
  return 'ignore';
}

async function analyzeDmLeads(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const ids = Array.isArray(input.leadIds) ? [...new Set(input.leadIds.map(String).filter(Boolean))] : [];
  if (!ids.length) throw new Error('leadIds is required');
  const leads = ids.map((id) => dmLeads.getLead(db, id)).filter(Boolean);
  if (leads.length !== ids.length || leads.some((lead) => lead.accountId !== input.accountId)) {
    throw new Error('所选私信线索不属于当前账号');
  }
  const strategyMarkdown = loadStrategyMarkdown();
  const replySettings = desktopSettings.getReplySettings({ storageDir: options.storageDir });
  const llm = options.llmClient || new LLMClient();
  if (typeof llm.analyzeDmLeads !== 'function') throw new Error('当前 LLM 客户端不支持私信线索分析');
  const leadsWithSources = leads.map((lead) => ({
    ...lead,
    sources: dmLeads.listLeadSources(db, lead.id),
  }));
  const knowledgeQuery = leadsWithSources.flatMap((lead) => [
    lead.commentText,
    lead.reason,
    ...(lead.sources || []).flatMap((source) => [source.commentText, source.videoDesc]),
  ]).filter(Boolean).join('\n');
  const knowledge = workspace.findRelevantKnowledge(db, knowledgeQuery, {
    limit: 20,
    maxChars: 15_000,
  });
  const response = await llm.analyzeDmLeads(leadsWithSources, { knowledge, strategyMarkdown, replySettings });
  if (!Array.isArray(response)) throw new Error('LLM 私信分析结果不是数组');
  const resultByUser = new Map(response.map((item) => [String(item.userId || item.user_id || ''), item]));
  const updated = [];
  for (const lead of leads) {
    const item = resultByUser.get(lead.userId);
    if (!item) {
      updated.push(dmLeads.updateLead(db, lead.id, {
        status: 'failed',
        lastError: 'LLM 未返回该用户的分析结果',
      }));
      continue;
    }
    const intentLevel = normalizeDmIntent(item.intentLevel || item.intent_level);
    const draftText = ['high', 'medium'].includes(intentLevel)
      ? String(item.draft || item.draftText || item.message || '').trim().slice(0, 300)
      : '';
    updated.push(dmLeads.updateLead(db, lead.id, {
      intentLevel,
      reason: String(item.reason || '').trim().slice(0, 300),
      draftText,
      status: draftText ? 'draft' : 'ignored',
      lastError: null,
    }));
  }
  return updated;
}

async function analyzeComments(db, input = {}, options = {}) {
  if (!input.accountId) throw new Error('accountId is required');
  const ids = Array.isArray(input.commentIds) ? input.commentIds : [];
  if (!ids.length) throw new Error('commentIds is required');
  const comments = ids.map((id) => workspace.getComment(db, id))
    .filter(Boolean)
    .filter((comment) => !comment.replied && !comment.deleted && !comment.isOwn)
    .map((comment) => {
      const root = comment.rootCid ? workspace.getComment(db, comment.rootCid) : null;
      return {
        ...comment,
        contextText: root && root.cid !== comment.cid ? root.text : '',
      };
    });
  if (!comments.length) return [];

  const knowledge = workspace.findRelevantKnowledge(db, comments.flatMap((comment) => [
    comment.text,
    comment.contextText,
  ]).filter(Boolean).join('\n'), {
    limit: 20,
    maxChars: 15_000,
  });
  const knownKnowledgeRefs = new Set(knowledge.flatMap((entry) => [entry.id, entry.title])
    .filter(Boolean)
    .map(String));
  const strategyMarkdown = loadStrategyMarkdown();
  const replySettings = desktopSettings.getReplySettings({ storageDir: options.storageDir });
  const llm = options.llmClient || new LLMClient();
  const response = typeof llm.generateReplyDrafts === 'function'
    ? await llm.generateReplyDrafts(comments, { knowledge, strategyMarkdown, replySettings })
    : await llm.suggestReplies(comments, { style: '自然、简短、基于知识库回复' }, '', { knowledge });

  const drafts = [];
  for (const item of Array.isArray(response) ? response : []) {
    const cid = String(item.cid || item.commentId || '').trim();
    const comment = workspace.getComment(db, cid);
    if (!comment || comment.replied) continue;
    const intentLevel = item.intentLevel || item.intent_level || '低';
    const reachesThreshold = intentLevel === '高'
      || (replySettings.intent_threshold !== 'high' && intentLevel === '中');
    const suppliedKnowledgeRefs = Array.isArray(item.knowledgeRefs || item.knowledge_refs)
      ? (item.knowledgeRefs || item.knowledge_refs).map(String)
      : [];
    const knowledgeRefs = suppliedKnowledgeRefs.filter((reference) => knownKnowledgeRefs.has(reference));
    const hasRequiredKnowledge = replySettings.require_knowledge === false || knowledgeRefs.length > 0;
    const shouldReply = reachesThreshold && hasRequiredKnowledge;
    const draftText = shouldReply ? String(item.reply || item.draftText || '').trim() : '';
    const needsEdit = draftText.length > replySettings.max_draft_chars;
    drafts.push(workspace.upsertReplyDraft(db, {
      accountId: input.accountId,
      awemeId: comment.awemeId,
      commentId: comment.cid,
      category: item.category || '普通互动',
      intentLevel,
      reason: item.reason || '',
      draftText,
      knowledgeRefs,
      raw: item,
      status: reachesThreshold
        ? (hasRequiredKnowledge && draftText ? (needsEdit ? 'needs_edit' : 'draft') : 'needs_knowledge')
        : 'ignored',
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
  const result = await withWriteLease(db, `reply-draft:${id}`, async () => {
    await ensureBridgeClientOnline(bridgeClient);
    return runPublishTask(
      db,
      taskPublish(draft.accountId, draft.awemeId, draft.draftText, draft.commentId),
      bridgeClient,
    );
  }, options);
  workspace.markCommentReplied(db, draft.commentId, result.cid);
  return workspace.updateReplyDraft(db, id, {
    status: 'published',
    publishedCid: result.cid,
  });
}

module.exports = {
  MAX_SEARCH_TARGET,
  analyzeDmLeads,
  analyzeComments,
  buildDmSendExpression,
  cancelBatchJob,
  createBatchFromVideos,
  createBatchFromComments,
  createCommentSyncJob,
  createDmSendJob,
  buildCompactCommentsExpression,
  buildCompactRepliesExpression,
  buildCompactMyPostsExpression,
  extractAwemeRows,
  extractCommentRows,
  publishReplyDraft,
  pauseBatchJob,
  resetFailedBatchItems,
  resolveExternalVideo,
  resumeBatchJob,
  runBatchJob,
  runSearchSession,
  syncComments,
  syncMyVideos,
};
