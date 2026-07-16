const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const { openDesktopDb } = require('./db');
const accounts = require('./accounts');
const tasks = require('./tasks');
const events = require('./events');
const { runTask } = require('./task-runner');
const settings = require('./settings');
const batch = require('./batch');
const dmInbox = require('./dm-inbox');
const dmLeads = require('./dm-leads');
const dmWorkQueue = require('./dm-work-queue');
const dmReplyWorkflow = require('./dm-reply-workflow');
const operationLeases = require('./operation-lease');
const workspace = require('./workspace');
const workflows = require('./mvp-workflows');
const { LLMClient } = require('../llm');

const DESKTOP_BACKEND_VERSION = process.env.VULCAN_VERSION || '1.1.1';

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://127.0.0.1:5174',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
  });
}

function parsePath(pathname) {
  return pathname.split('/').filter(Boolean);
}

function ensureObjectBody(body, label = 'body') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error(`${label} must be a JSON object`), { statusCode: 400 });
  }
  return body;
}

function requireAccountId(value) {
  const accountId = String(value || '').trim();
  if (!accountId) {
    throw Object.assign(new Error('accountId is required'), { statusCode: 400 });
  }
  return accountId;
}

function requireAccount(db, value) {
  const accountId = requireAccountId(value);
  const account = accounts.getAccount(db, accountId);
  if (!account) {
    throw Object.assign(new Error('account not found'), { statusCode: 404 });
  }
  return account;
}

function requireConversationRowId(value) {
  const conversationId = String(value || '').trim();
  if (!conversationId) {
    throw Object.assign(new Error('conversationId is required'), { statusCode: 400 });
  }
  if (!/^dmc_[0-9a-fA-F-]{36}$/.test(conversationId)) {
    throw Object.assign(new Error('conversationId must be a local conversation row id'), { statusCode: 400 });
  }
  return conversationId;
}

function requireConversation(db, value) {
  const conversationId = requireConversationRowId(value);
  const conversation = dmInbox.getConversation(db, conversationId);
  if (!conversation) {
    throw Object.assign(new Error('conversation not found'), { statusCode: 404 });
  }
  return conversation;
}

function requireConversationForAccount(db, accountValue, conversationValue) {
  const account = requireAccount(db, accountValue);
  const conversation = requireConversation(db, conversationValue);
  if (conversation.accountId !== account.id) {
    throw Object.assign(new Error('conversation not found'), { statusCode: 404 });
  }
  return conversation;
}

function readLimit(value, { defaultValue, min = 1, max = 100 } = {}) {
  if (value === null || value === undefined || value === '') return defaultValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw Object.assign(new Error('limit must be a number'), { statusCode: 400 });
  }
  return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function readOffset(value, { defaultValue = 0, min = 0, max = 10_000 } = {}) {
  if (value === null || value === undefined || value === '') return defaultValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw Object.assign(new Error('offset must be a number'), { statusCode: 400 });
  }
  return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function readBefore(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw Object.assign(new Error('before must be a number'), { statusCode: 400 });
  }
  return Math.trunc(numeric);
}

function sanitizeDmMessage(message) {
  const { raw, ...safeMessage } = message;
  return safeMessage;
}

function sanitizeInsertedDmNotification(message) {
  return {
    id: message.id,
    accountId: message.accountId,
    conversationId: message.conversationId,
    peerName: message.peerName || '',
    content: message.content,
    direction: message.direction,
    messageType: message.messageType,
  };
}

function toDmOutboundMessageDto(message) {
  if (!message) return null;
  return {
    id: message.id,
    accountId: message.accountId,
    conversationId: message.conversationId,
    direction: message.direction,
    status: message.status,
    content: message.content,
    timestamp: message.timestamp,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function toDmWorkItemDto(workItem) {
  if (!workItem) return null;
  return {
    id: workItem.id,
    accountId: workItem.accountId,
    conversationId: workItem.conversationId,
    messageId: workItem.messageId,
    type: workItem.type,
    status: workItem.status,
    error: workItem.error,
    attemptCount: workItem.attemptCount,
    maxAttempts: workItem.maxAttempts,
    nextRunAt: workItem.nextRunAt,
    executionStartedAt: workItem.executionStartedAt,
    completedAt: workItem.completedAt,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  };
}

function toDmWorkerWorkItemDto(workItem) {
  if (!workItem) return null;
  return {
    ...toDmWorkItemDto(workItem),
    claimToken: workItem.claimToken,
  };
}

function requireExactString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${name} must be a non-empty string`), { statusCode: 400 });
  }
  return value.trim();
}

function runLeaseValidation(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof TypeError) error.statusCode = 400;
    throw error;
  }
}

function normalizeReplyModeOverrideForApi(value) {
  try {
    return dmInbox.normalizeReplyModeOverride(value);
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

function requireLoopback(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  const allowed = address === '127.0.0.1'
    || address === '::1'
    || address.startsWith('::ffff:127.');
  const hasBrowserOrigin = typeof req.headers?.origin === 'string' && req.headers.origin.trim() !== '';
  if (!allowed || hasBrowserOrigin) {
    throw Object.assign(new Error('This endpoint is available only from the local application'), { statusCode: 403 });
  }
}

function requireManualReplyBody(body) {
  ensureObjectBody(body);
  const allowed = new Set(['accountId', 'text', 'mode', 'sourceDraftId']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown reply fields: ${unknown.join(', ')}`), { statusCode: 400 });
  }
  if (body.mode !== 'manual') {
    throw Object.assign(new Error('mode must be manual'), { statusCode: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw Object.assign(new Error('text is required'), { statusCode: 400 });
  if (text.length > 500) {
    throw Object.assign(new Error('text cannot exceed 500 characters'), { statusCode: 400 });
  }
  return text;
}

async function handleAccounts(db, req, res, parts) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, accounts.listAccounts(db));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) {
      sendJson(res, 400, { ok: false, error: 'name is required' });
      return true;
    }
    sendJson(res, 201, accounts.createAccount(db, body));
    return true;
  }

  if (parts.length === 3) {
    const id = parts[2];
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const account = accounts.updateAccount(db, id, body);
      sendJson(res, account ? 200 : 404, account || { ok: false, error: 'account not found' });
      return true;
    }
    if (req.method === 'DELETE') {
      const deleted = accounts.deleteAccount(db, id);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: 'account not found' });
      return true;
    }
  }

  if (parts.length === 4 && parts[3] === 'cancel-dm-work' && req.method === 'POST') {
    requireLoopback(req);
    const account = accounts.getAccount(db, parts[2]);
    if (!account) {
      sendJson(res, 404, { ok: false, error: 'account not found' });
      return true;
    }
    const cancelled = dmWorkQueue.cancelPendingAccountWork(db, account.id);
    sendJson(res, 200, { ok: true, cancelled });
    return true;
  }

  return false;
}

async function handleTasks(db, req, res, parts, url, taskRunner) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, tasks.listTasks(db, { accountId: url.searchParams.get('accountId') || undefined }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    if (!body.accountId || !body.type) {
      sendJson(res, 400, { ok: false, error: 'accountId and type are required' });
      return true;
    }
    sendJson(res, 201, tasks.createTask(db, body));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'run') {
    const task = tasks.getTask(db, parts[2]);
    if (!task) {
      sendJson(res, 404, { ok: false, error: 'task not found' });
      return true;
    }
    const updated = await taskRunner(db, task.id);
    sendJson(res, 200, updated);
    return true;
  }

  return false;
}

function handleEvents(db, req, res, parts, url) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, events.listEvents(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      taskId: url.searchParams.get('taskId') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }
  return false;
}

async function handleSearchSessions(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, workspace.listSearchSessions(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    const result = await workflows.runSearchSession(db, body, workflowOptions);
    sendJson(res, 201, result);
    return true;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'results') {
    sendJson(res, 200, workspace.listVideos(db, { searchSessionId: parts[2] }));
    return true;
  }

  return false;
}

async function handleBatchJobs(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, batch.listBatchJobs(db, {
      accountId: url.searchParams.get('accountId') || undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    const job = Array.isArray(body.commentIds)
      ? workflows.createBatchFromComments(db, body)
      : workflows.createBatchFromVideos(db, body);
    if (body.runNow) {
      sendJson(res, 201, await workflows.runBatchJob(db, job.id, workflowOptions));
    } else {
      sendJson(res, 201, job);
    }
    return true;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'items') {
    sendJson(res, 200, batch.listBatchItems(db, parts[2]));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'run') {
    sendJson(res, 200, await workflows.runBatchJob(db, parts[2], workflowOptions));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'pause') {
    sendJson(res, 200, workflows.pauseBatchJob(db, parts[2]));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
    sendJson(res, 200, workflows.cancelBatchJob(db, parts[2]));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'resume') {
    sendJson(res, 200, await workflows.resumeBatchJob(db, parts[2], workflowOptions));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'retry-failed') {
    workflows.resetFailedBatchItems(db, parts[2]);
    sendJson(res, 200, await workflows.runBatchJob(db, parts[2], workflowOptions));
    return true;
  }

  return false;
}

async function handleCommentSyncJobs(db, req, res, parts, workflowOptions) {
  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    const job = workflows.createCommentSyncJob(db, body);
    sendJson(res, 201, body.runNow
      ? await workflows.runBatchJob(db, job.id, workflowOptions)
      : job);
    return true;
  }
  return false;
}

async function handleVideos(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, workspace.listVideos(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      isMine: url.searchParams.get('isMine') === '' ? undefined : (
        url.searchParams.has('isMine') ? url.searchParams.get('isMine') === 'true' : undefined
      ),
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'comments-sync') {
    const body = await readBody(req);
    sendJson(res, 200, await workflows.syncComments(db, {
      ...body,
      awemeId: decodeURIComponent(parts[2]),
    }, workflowOptions));
    return true;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'comments') {
    sendJson(res, 200, workspace.listComments(db, { awemeId: decodeURIComponent(parts[2]) }));
    return true;
  }

  return false;
}

async function handleExternalVideos(db, req, res, parts, workflowOptions) {
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'resolve') {
    const body = await readBody(req);
    sendJson(res, 201, await workflows.resolveExternalVideo(db, body, workflowOptions));
    return true;
  }
  return false;
}

async function handleMyVideos(db, req, res, parts, workflowOptions) {
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'sync') {
    const body = await readBody(req);
    sendJson(res, 200, await workflows.syncMyVideos(db, body, workflowOptions));
    return true;
  }
  return false;
}

async function handleComments(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, workspace.listComments(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      awemeId: url.searchParams.get('awemeId') || undefined,
      query: url.searchParams.get('query') || undefined,
      deleted: url.searchParams.has('deleted') ? url.searchParams.get('deleted') === 'true' : undefined,
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'analyze') {
    const body = await readBody(req);
    sendJson(res, 200, await workflows.analyzeComments(db, body, workflowOptions));
    return true;
  }

  return false;
}

async function handleReplyDrafts(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, workspace.listReplyDrafts(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }

  if (parts.length === 4 && parts[3] === 'approve' && req.method === 'POST') {
    const body = await readBody(req);
    const draft = workspace.updateReplyDraft(db, parts[2], {
      draftText: body.draftText,
      status: 'approved',
    });
    sendJson(res, draft ? 200 : 404, draft || { ok: false, error: 'reply draft not found' });
    return true;
  }

  if (parts.length === 4 && parts[3] === 'publish' && req.method === 'POST') {
    sendJson(res, 200, await workflows.publishReplyDraft(db, parts[2], workflowOptions));
    return true;
  }

  return false;
}

async function handleDmLeads(db, req, res, parts, url, workflowOptions) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, dmLeads.listLeads(db, {
      accountId: url.searchParams.get('accountId') || undefined,
      query: url.searchParams.get('query') || undefined,
      intentLevel: url.searchParams.get('intentLevel') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'sync') {
    const body = await readBody(req);
    sendJson(res, 200, dmLeads.syncLeadsFromComments(db, body));
    return true;
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'analyze') {
    const body = await readBody(req);
    sendJson(res, 200, await workflows.analyzeDmLeads(db, body, workflowOptions));
    return true;
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'send-job') {
    const body = await readBody(req);
    const job = workflows.createDmSendJob(db, body);
    sendJson(res, 201, body.runNow
      ? await workflows.runBatchJob(db, job.id, workflowOptions)
      : job);
    return true;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'sources') {
    const lead = dmLeads.getLead(db, parts[2]);
    sendJson(res, lead ? 200 : 404, lead
      ? dmLeads.listLeadSources(db, parts[2])
      : { ok: false, error: 'dm lead not found' });
    return true;
  }

  if (req.method === 'PATCH' && parts.length === 3) {
    const body = await readBody(req);
    const lead = dmLeads.updateLead(db, parts[2], {
      draftText: body.draftText,
      status: body.status,
    });
    sendJson(res, lead ? 200 : 404, lead || { ok: false, error: 'dm lead not found' });
    return true;
  }

  return false;
}

function enqueueAnalyzeWork(db, insertedMessages = []) {
  let queued = 0;
  for (const message of insertedMessages) {
    if (
      message.direction !== 'inbound'
      || !dmWorkQueue.isAnalyzableTextMessageType(message.messageType)
      || !String(message.content || '').trim()
    ) continue;
    dmWorkQueue.enqueueWork(db, {
      type: 'analyze',
      accountId: message.accountId,
      conversationId: message.conversationId,
      messageId: message.id,
      dedupeKey: `source-message:${message.id}`,
      payload: {
        sourceMessageId: message.id,
        sourceConversationId: message.conversationId,
        platformConversationId: message.platformConversationId,
        messageKey: message.messageKey,
      },
    });
    queued += 1;
  }
  return queued;
}

function latestAnalyzableInboundMessage(db, conversationId) {
  return db.prepare(`
    SELECT id, message_key AS messageKey, content
    FROM dm_messages
    WHERE conversation_row_id = ?
      AND direction = 'inbound'
      AND LOWER(TRIM(CAST(message_type AS TEXT))) IN ('text', '7')
      AND TRIM(content) <> ''
    ORDER BY timestamp_ms DESC, created_at DESC, rowid DESC
    LIMIT 1
  `).get(conversationId) || null;
}

function toDmReplyDraftDto(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    accountId: draft.accountId,
    conversationId: draft.conversationRowId,
    content: draft.content,
    status: draft.status,
    meta: {
      intent: draft.meta?.intent || 'unknown',
      intentLevel: draft.meta?.intentLevel || 'ignore',
      knowledgeRefs: Array.isArray(draft.meta?.knowledgeRefs) ? draft.meta.knowledgeRefs : [],
      confidence: Number(draft.meta?.confidence || 0),
      reason: String(draft.meta?.reason || ''),
      sensitiveCategory: draft.meta?.sensitiveCategory || 'none',
      llmFailed: draft.meta?.llmFailed === true,
    },
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

async function handleDmInbox(db, req, res, parts, url, workflowOptions = {}) {
  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'monitor-states') {
    const states = accounts.listAccounts(db).map((account) => dmInbox.getMonitorState(db, account.id));
    sendJson(res, 200, states);
    return true;
  }

  if (parts.length === 4 && parts[2] === 'monitor-states') {
    const account = requireAccount(db, parts[3]);
    if (req.method === 'GET') {
      sendJson(res, 200, dmInbox.getMonitorState(db, account.id));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = ensureObjectBody(await readBody(req));
      const hasAccountSetting = ['enabled', 'settingSource', 'replyModeOverride']
        .some((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (hasAccountSetting) {
        if (body.settingSource === 'explicit' && typeof body.enabled !== 'boolean') {
          throw Object.assign(new Error('enabled must be a boolean when settingSource is explicit'), { statusCode: 400 });
        }
        if (body.settingSource === 'inherited' && body.enabled !== null) {
          throw Object.assign(new Error('enabled must be null when settingSource is inherited'), { statusCode: 400 });
        }
      }
      if (
        body.historyStatus !== undefined
        && !['realtime_only', 'incomplete'].includes(body.historyStatus)
      ) {
        throw Object.assign(
          new Error('historyStatus cannot be available or complete without verified history support'),
          { statusCode: 400 },
        );
      }
      if (
        body.historyIncompleteReason !== undefined
        && body.historyIncompleteReason !== null
        && typeof body.historyIncompleteReason !== 'string'
      ) {
        throw Object.assign(new Error('historyIncompleteReason must be a string or null'), { statusCode: 400 });
      }
      sendJson(res, 200, dmInbox.updateMonitorState(db, account.id, {
        cursor: body.cursor,
        status: body.status,
        lastError: body.lastError,
        enabled: body.enabled,
        settingSource: body.settingSource,
        replyModeOverride: body.replyModeOverride,
        historyStatus: body.historyStatus,
        historyIncompleteReason: body.historyIncompleteReason,
      }));
      return true;
    }
  }

  if (req.method === 'POST' && parts.length === 4 && parts[2] === 'messages' && parts[3] === 'ingest') {
    const body = ensureObjectBody(await readBody(req));
    const account = requireAccount(db, body.accountId);
    if (!Array.isArray(body.messages)) {
      throw Object.assign(new Error('messages must be an array'), { statusCode: 400 });
    }
    if (body.messages.length > 200) {
      throw Object.assign(new Error('messages cannot exceed 200 items per request'), { statusCode: 413 });
    }
    if (
      body.selfPlatformId !== undefined
      && (typeof body.selfPlatformId !== 'string' || body.selfPlatformId.trim().length > 128)
    ) {
      throw Object.assign(new Error('selfPlatformId must be a string with at most 128 characters'), { statusCode: 400 });
    }
    let result;
    try {
      result = db.transaction(() => {
        const ingested = dmInbox.ingestMessages(db, {
          accountId: account.id,
          selfPlatformId: body.selfPlatformId,
          messages: body.messages,
        });
        const analyzeQueued = enqueueAnalyzeWork(db, ingested.insertedMessages);
        return {
          inserted: ingested.inserted,
          duplicates: ingested.duplicates,
          reconciled: ingested.reconciled,
          analyzeQueued,
          insertedMessages: ingested.insertedMessages.map(sanitizeInsertedDmNotification),
        };
      })();
    } catch (error) {
      if (!error.statusCode) {
        error.statusCode = 400;
      }
      throw error;
    }
    sendJson(res, 201, result);
    return true;
  }

  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'conversations') {
    const account = requireAccount(db, url.searchParams.get('accountId'));
    sendJson(res, 200, dmInbox.listConversations(db, {
      accountId: account.id,
      status: url.searchParams.get('status') || undefined,
      query: url.searchParams.get('query') || undefined,
      limit: readLimit(url.searchParams.get('limit'), { defaultValue: 50, max: 100 }),
      offset: readOffset(url.searchParams.get('offset')),
    }));
    return true;
  }

  if (req.method === 'DELETE' && parts.length === 4 && parts[2] === 'conversations') {
    requireLoopback(req);
    const conversation = requireConversationForAccount(db, url.searchParams.get('accountId'), parts[3]);
    const deleted = dmInbox.deleteConversationLocal(db, conversation.id, conversation.accountId);
    sendJson(res, 200, deleted);
    return true;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[2] === 'conversations') {
    const conversation = requireConversationForAccount(db, url.searchParams.get('accountId'), parts[3]);
    sendJson(res, 200, conversation);
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'messages' && req.method === 'GET') {
    const conversation = requireConversationForAccount(db, url.searchParams.get('accountId'), parts[3]);
    sendJson(res, 200, dmInbox.listMessages(db, conversation.id, {
      before: readBefore(url.searchParams.get('before')),
      limit: readLimit(url.searchParams.get('limit'), { defaultValue: 100, max: 200 }),
    }).map(sanitizeDmMessage));
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'analysis' && req.method === 'GET') {
    const conversation = requireConversationForAccount(db, url.searchParams.get('accountId'), parts[3]);
    const draft = dmInbox.getReplyDraftByConversation(db, conversation.id);
    const knowledgeIds = new Set(
      Array.isArray(draft?.meta?.knowledgeRefs) ? draft.meta.knowledgeRefs : [],
    );
    const knowledge = workspace.listKnowledgeEntries(db)
      .filter((entry) => knowledgeIds.has(entry.id))
      .map((entry) => ({ id: entry.id, title: entry.title }));
    sendJson(res, 200, {
      workItem: toDmWorkItemDto(dmWorkQueue.getLatestAnalysisWork(db, conversation.id)),
      draft: toDmReplyDraftDto(draft),
      knowledge,
    });
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'reanalyze' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const unknown = Object.keys(body).filter((key) => key !== 'accountId');
    if (unknown.length) throw Object.assign(new Error(`Unknown reanalyze fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const conversation = requireConversationForAccount(db, body.accountId, parts[3]);
    const sourceMessage = latestAnalyzableInboundMessage(db, conversation.id);
    if (!sourceMessage) {
      throw Object.assign(new Error('conversation has no inbound text message to analyze'), { statusCode: 409 });
    }
    const workItem = db.transaction(() => {
      dmWorkQueue.cancelPendingAutoReplies(db, conversation.id);
      return dmWorkQueue.enqueueWork(db, {
        type: 'analyze',
        accountId: conversation.accountId,
        conversationId: conversation.id,
        messageId: sourceMessage.id,
        dedupeKey: `manual-reanalysis:${sourceMessage.id}:${crypto.randomUUID()}`,
        payload: {
          sourceMessageId: sourceMessage.id,
          sourceConversationId: conversation.id,
          platformConversationId: conversation.conversationId,
          messageKey: sourceMessage.messageKey,
          manualReanalysis: true,
        },
      });
    })();
    sendJson(res, 201, toDmWorkItemDto(workItem));
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'replies' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const conversation = requireConversationForAccount(db, body.accountId, parts[3]);
    const text = requireManualReplyBody(body);
    const sourceDraftId = String(body.sourceDraftId || '').trim();
    const sourceDraft = sourceDraftId ? dmInbox.getReplyDraftByConversation(db, conversation.id) : null;
    if (sourceDraftId && sourceDraft?.id !== sourceDraftId) {
      throw Object.assign(new Error('reply draft not found for this conversation'), { statusCode: 404 });
    }
    const result = db.transaction(() => {
      dmWorkQueue.cancelPendingAutoReplies(db, conversation.id);
      const pending = dmInbox.createPendingOutboundMessage(db, {
        accountId: conversation.accountId,
        conversationId: conversation.id,
        content: text,
        mode: 'manual',
      });
      const workItem = dmWorkQueue.enqueueWork(db, {
        type: 'send_manual',
        accountId: conversation.accountId,
        conversationId: conversation.id,
        messageId: pending.message.id,
        dedupeKey: `manual-message:${pending.message.id}`,
        payload: {
          messageId: pending.message.id,
          text,
          conversationKey: pending.conversationKey,
          platformConversationId: conversation.conversationId,
          peerId: conversation.peerId,
          sourceDraftId: sourceDraftId || undefined,
        },
      });
      if (sourceDraft) {
        dmInbox.upsertReplyDraft(db, {
          accountId: conversation.accountId,
          conversationRowId: conversation.id,
          content: text,
          status: 'queued',
          meta: {
            ...sourceDraft.meta,
            reviewedAt: new Date().toISOString(),
            manualMessageId: pending.message.id,
          },
        });
      }
      return { message: pending.message, workItem };
    })();
    sendJson(res, 201, {
      message: toDmOutboundMessageDto(result.message),
      workItem: toDmWorkItemDto(result.workItem),
    });
    return true;
  }

  if (parts.length === 4 && parts[2] === 'work-items' && parts[3] === 'claim' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const allowed = new Set(['workerId', 'types']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw Object.assign(new Error(`Unknown claim fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const workerId = String(body.workerId || '').trim();
    if (!workerId) throw Object.assign(new Error('workerId is required'), { statusCode: 400 });
    if (body.types !== undefined && !Array.isArray(body.types)) {
      throw Object.assign(new Error('types must be an array'), { statusCode: 400 });
    }
    let workItem;
    try {
      workItem = dmWorkQueue.claimNextWork(db, workerId, Date.now(), { types: body.types || [] });
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
    sendJson(res, 200, { workItem: toDmWorkerWorkItemDto(workItem) });
    return true;
  }

  if (parts.length === 5 && parts[2] === 'work-items' && parts[4] === 'analyze' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const unknown = Object.keys(body).filter((key) => key !== 'workerId' && key !== 'claimToken');
    if (unknown.length) {
      throw Object.assign(new Error(`Unknown analysis fields: ${unknown.join(', ')}`), { statusCode: 400 });
    }
    const workerId = requireExactString(body.workerId, 'workerId');
    const claimToken = requireExactString(body.claimToken, 'claimToken');
    const workItem = dmWorkQueue.getWork(db, parts[3]);
    if (!workItem) throw Object.assign(new Error('DM analysis work item not found'), { statusCode: 404 });
    if (workItem.type !== 'analyze') {
      throw Object.assign(new Error('DM work item is not an analysis item'), { statusCode: 409 });
    }
    if (workItem.status === 'committing') {
      dmWorkQueue.validateWorkClaim(db, workItem.id, workerId, claimToken, {
        type: 'analyze', statuses: ['committing'],
      });
      throw Object.assign(
        new Error('DM analysis result is currently committing; retry to read the persisted result'),
        { code: 'dm_analysis_committing', statusCode: 409 },
      );
    }
    const claimedWork = dmWorkQueue.validateWorkClaim(db, workItem.id, workerId, claimToken, {
      allowTerminal: true, type: 'analyze', statuses: ['running'],
    });
    const result = await dmReplyWorkflow.analyzeIncomingMessage(
      db,
      { ...claimedWork, workerId, claimToken },
      workflowOptions,
    );
    sendJson(res, 200, {
      action: result.action,
      reason: result.reason,
      workItem: toDmWorkItemDto(result.analysisWork),
      draft: toDmReplyDraftDto(result.draft),
      autoWorkItem: toDmWorkItemDto(result.autoWork),
    });
    return true;
  }

  if (parts.length === 5 && parts[2] === 'work-items' && parts[4] === 'execution-context' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const unknown = Object.keys(body).filter((key) => key !== 'workerId' && key !== 'claimToken');
    if (unknown.length) {
      throw Object.assign(new Error(`Unknown execution context fields: ${unknown.join(', ')}`), { statusCode: 400 });
    }
    const workerId = requireExactString(body.workerId, 'workerId');
    const claimToken = requireExactString(body.claimToken, 'claimToken');
    const workItem = dmWorkQueue.validateWorkClaim(db, parts[3], workerId, claimToken, {
      statuses: ['running'],
    });
    sendJson(res, 200, {
      text: String(workItem.payload?.text || ''),
      conversationKey: String(workItem.payload?.conversationKey || ''),
      peerId: String(workItem.payload?.peerId || ''),
    });
    return true;
  }

  if (parts.length === 5 && parts[2] === 'work-items' && parts[4] === 'complete' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const allowed = new Set(['result', 'workerId', 'claimToken']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw Object.assign(new Error(`Unknown complete fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const workerId = requireExactString(body.workerId, 'workerId');
    const claimToken = requireExactString(body.claimToken, 'claimToken');
    const result = db.transaction(() => {
      const workItem = dmWorkQueue.completeWork(db, parts[3], body.result || {}, { workerId, claimToken });
      const message = workItem.messageId && workItem.status === 'success'
        ? dmInbox.updateOutboundMessageStatus(db, workItem.messageId, 'accepted', workItem.result)
        : (workItem.messageId ? dmInbox.getMessage(db, workItem.messageId) : null);
      const sourceDraftId = String(workItem.payload?.sourceDraftId || '').trim();
      const sourceDraft = sourceDraftId
        ? dmInbox.getReplyDraftByConversation(db, workItem.conversationId)
        : null;
      if (workItem.status === 'success' && sourceDraft?.id === sourceDraftId) {
        dmInbox.upsertReplyDraft(db, {
          accountId: workItem.accountId,
          conversationRowId: workItem.conversationId,
          status: message?.status === 'sent' ? 'sent' : 'accepted',
          meta: message?.status === 'sent'
            ? { ...sourceDraft.meta, sentAt: new Date().toISOString() }
            : sourceDraft.meta,
        });
      }
      return { workItem: toDmWorkItemDto(workItem), message: toDmOutboundMessageDto(message) };
    })();
    sendJson(res, 200, result);
    return true;
  }

  if (parts.length === 5 && parts[2] === 'work-items' && parts[4] === 'start-execution' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const allowed = new Set(['workerId', 'claimToken']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw Object.assign(new Error(`Unknown start fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const workerId = requireExactString(body.workerId, 'workerId');
    const claimToken = requireExactString(body.claimToken, 'claimToken');
    const workItem = dmWorkQueue.markWorkExecutionStarted(
      db, parts[3], workerId, claimToken,
    );
    sendJson(res, 200, { workItem: toDmWorkItemDto(workItem) });
    return true;
  }

  if (parts.length === 5 && parts[2] === 'work-items' && parts[4] === 'fail' && req.method === 'POST') {
    requireLoopback(req);
    const body = ensureObjectBody(await readBody(req));
    const allowed = new Set(['error', 'uncertain', 'retryable', 'deferMs', 'workerId', 'claimToken']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw Object.assign(new Error(`Unknown fail fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const errorMessage = String(body.error || '').trim() || 'DM send failed';
    const workerId = requireExactString(body.workerId, 'workerId');
    const claimToken = requireExactString(body.claimToken, 'claimToken');
    const result = db.transaction(() => {
      const workItem = dmWorkQueue.failWork(db, parts[3], new Error(errorMessage), {
        workerId,
        claimToken,
        uncertain: body.uncertain === true,
        retryable: body.retryable === true,
        deferMs: body.deferMs,
      });
      let message = workItem.messageId ? dmInbox.getMessage(db, workItem.messageId) : null;
      if (workItem.messageId && (workItem.status === 'failed' || workItem.status === 'needs_confirmation')) {
        message = dmInbox.updateOutboundMessageStatus(db, workItem.messageId, workItem.status, {
          error: workItem.error,
        });
      }
      const sourceDraftId = String(workItem.payload?.sourceDraftId || '').trim();
      const sourceDraft = sourceDraftId
        ? dmInbox.getReplyDraftByConversation(db, workItem.conversationId)
        : null;
      if (sourceDraft?.id === sourceDraftId && ['failed', 'needs_confirmation'].includes(workItem.status)) {
        dmInbox.upsertReplyDraft(db, {
          accountId: workItem.accountId,
          conversationRowId: workItem.conversationId,
          status: 'needs_review',
          meta: { ...sourceDraft.meta, sendError: workItem.error },
        });
      }
      return { workItem: toDmWorkItemDto(workItem), message: toDmOutboundMessageDto(message) };
    })();
    sendJson(res, 200, result);
    return true;
  }

  if (parts.length === 4 && parts[2] === 'conversations' && req.method === 'PATCH') {
    const body = ensureObjectBody(await readBody(req));
    const conversation = requireConversationForAccount(db, body.accountId, parts[3]);
    const allowed = new Set(['accountId', 'status', 'replyModeOverride']);
    const unknownFields = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknownFields.length) {
      throw Object.assign(new Error(`Unknown conversation patch fields: ${unknownFields.join(', ')}`), { statusCode: 400 });
    }
    if (!['status', 'replyModeOverride'].some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      throw Object.assign(new Error('At least one conversation patch field is required'), { statusCode: 400 });
    }
    sendJson(res, 200, dmInbox.updateConversation(db, conversation.id, {
      status: body.status === undefined ? undefined : String(body.status),
      replyModeOverride: normalizeReplyModeOverrideForApi(body.replyModeOverride),
    }));
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'read' && req.method === 'POST') {
    const body = ensureObjectBody(await readBody(req));
    const unknown = Object.keys(body).filter((key) => key !== 'accountId');
    if (unknown.length) throw Object.assign(new Error(`Unknown read fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const conversation = requireConversationForAccount(db, body.accountId, parts[3]);
    sendJson(res, 200, dmInbox.markConversationRead(db, conversation.id));
    return true;
  }

  if (parts.length === 5 && parts[2] === 'conversations' && parts[4] === 'reauthorize-auto-reply' && req.method === 'POST') {
    const body = ensureObjectBody(await readBody(req));
    const unknown = Object.keys(body).filter((key) => key !== 'accountId');
    if (unknown.length) throw Object.assign(new Error(`Unknown reauthorize fields: ${unknown.join(', ')}`), { statusCode: 400 });
    const conversation = requireConversationForAccount(db, body.accountId, parts[3]);
    sendJson(res, 200, dmInbox.reauthorizeAutoReply(db, conversation.id));
    return true;
  }

  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'drafts') {
    const conversation = requireConversationForAccount(
      db,
      url.searchParams.get('accountId'),
      url.searchParams.get('conversationId'),
    );
    const draft = dmInbox.getReplyDraftByConversation(db, conversation.id);
    if (!draft) {
      throw Object.assign(new Error('reply draft not found'), { statusCode: 404 });
    }
    sendJson(res, 200, draft);
    return true;
  }

  return false;
}

async function handleOperationLeases(db, req, res, parts) {
  if (parts.length !== 4 || parts[2] !== 'write-lease' || req.method !== 'POST') return false;
  requireLoopback(req);
  const body = ensureObjectBody(await readBody(req));
  const action = parts[3];
  if (action === 'acquire') {
    const unknown = Object.keys(body).filter((key) => key !== 'owner' && key !== 'ttlMs');
    if (unknown.length) throw Object.assign(new Error(`Unknown lease fields: ${unknown.join(', ')}`), { statusCode: 400 });
    sendJson(res, 200, runLeaseValidation(() => operationLeases.acquireWriteLease(db, body.owner, body.ttlMs)));
    return true;
  }
  if (action === 'renew') {
    const unknown = Object.keys(body).filter((key) => key !== 'token' && key !== 'ttlMs');
    if (unknown.length) throw Object.assign(new Error(`Unknown lease fields: ${unknown.join(', ')}`), { statusCode: 400 });
    sendJson(res, 200, runLeaseValidation(() => operationLeases.renewWriteLease(db, body.token, body.ttlMs)));
    return true;
  }
  if (action === 'release') {
    const unknown = Object.keys(body).filter((key) => key !== 'token');
    if (unknown.length) throw Object.assign(new Error(`Unknown lease fields: ${unknown.join(', ')}`), { statusCode: 400 });
    sendJson(res, 200, {
      released: runLeaseValidation(() => operationLeases.releaseWriteLease(db, body.token)),
    });
    return true;
  }
  return false;
}

async function handleKnowledge(db, req, res, parts, url) {
  if (req.method === 'GET' && parts.length === 2) {
    if ([...url.searchParams.keys()].length === 0) {
      sendJson(res, 200, workspace.listKnowledgeEntries(db));
      return true;
    }
    sendJson(res, 200, workspace.queryKnowledgeEntries(db, {
      q: url.searchParams.get('q'),
      status: url.searchParams.get('status'),
      category: url.searchParams.get('category'),
      tag: url.searchParams.get('tag'),
      sourceType: url.searchParams.get('sourceType'),
      sort: url.searchParams.get('sort'),
      order: url.searchParams.get('order'),
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
    }));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    sendJson(res, 201, workspace.createKnowledgeEntry(db, body));
    return true;
  }

  if (parts.length === 3 && parts[2] === 'check-duplicate' && req.method === 'POST') {
    const body = ensureObjectBody(await readBody(req));
    const content = String(body.content || '');
    if (!content.trim()) throw Object.assign(new Error('knowledge content is required'), { statusCode: 400 });
    const entry = workspace.findKnowledgeByHash(db, content);
    sendJson(res, 200, { duplicate: Boolean(entry), entry });
    return true;
  }

  if (parts.length === 3 && parts[2] === 'bulk' && req.method === 'POST') {
    const body = ensureObjectBody(await readBody(req));
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const action = String(body.action || '');
    if (!ids.length) throw Object.assign(new Error('knowledge ids are required'), { statusCode: 400 });
    if (!['enable', 'disable', 'delete'].includes(action)) {
      throw Object.assign(new Error('unsupported knowledge bulk action'), { statusCode: 400 });
    }
    sendJson(res, 200, workspace.bulkUpdateKnowledgeEntries(db, { ids, action }));
    return true;
  }

  if (parts.length === 3 && req.method === 'PATCH') {
    const body = await readBody(req);
    const entry = workspace.updateKnowledgeEntry(db, parts[2], body);
    sendJson(res, entry ? 200 : 404, entry || { ok: false, error: 'knowledge entry not found' });
    return true;
  }

  if (parts.length === 3 && req.method === 'DELETE') {
    const deleted = workspace.deleteKnowledgeEntry(db, parts[2]);
    sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: 'knowledge entry not found' });
    return true;
  }

  return false;
}

function createLlmClientConfig(config) {
  return {
    apiKey: config.api_key,
    baseUrl: config.base_url,
    model: config.model,
    maxTokens: config.max_tokens,
    timeoutMs: config.timeout_ms,
    maxRetries: config.max_retries,
  };
}

async function handleSettings(req, res, parts, storageDir, options = {}) {
  if (parts.length === 4 && parts[2] === 'llm' && parts[3] === 'test' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = settings.getLlmSettings({ storageDir });
    const config = { ...saved, ...settings.sanitizeLlmPatch(body) };
    const tester = options.llmTester || (async (input) => {
      const client = new LLMClient(createLlmClientConfig(input));
      return client.testConnection();
    });
    const result = await tester(config);
    sendJson(res, 200, {
      ok: result?.ok !== false,
      model: String(result?.model || config.model || ''),
      latencyMs: Math.max(0, Number(result?.latencyMs) || 0),
      response: String(result?.response || '').slice(0, 80),
    });
    return true;
  }

  if (parts.length === 3 && parts[2] === 'llm') {
    if (req.method === 'GET') {
      sendJson(res, 200, settings.redactLlmSettings(settings.getLlmSettings({ storageDir })));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const updated = settings.updateLlmSettings(body, { storageDir });
      sendJson(res, 200, settings.redactLlmSettings(updated));
      return true;
    }
  }
  if (parts.length === 3 && parts[2] === 'reply') {
    if (req.method === 'GET') {
      sendJson(res, 200, settings.getReplySettings({ storageDir }));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      sendJson(res, 200, settings.updateReplySettings(body, { storageDir }));
      return true;
    }
  }
  if (parts.length === 3 && parts[2] === 'dm') {
    if (req.method === 'GET') {
      sendJson(res, 200, settings.getDmSettings({ storageDir }));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      sendJson(res, 200, settings.updateDmSettings(body, { storageDir }));
      return true;
    }
  }
  return false;
}

function createDesktopApiServer(options = {}) {
  const db = options.db || openDesktopDb({ storageDir: options.storageDir });
  dmInbox.purgeSystemNotifications(db);
  dmInbox.backfillConversationPeerNames(db);
  if (!options.db || options.recoverInterruptedDmWork === true) {
    dmWorkQueue.recoverInterruptedWork(db);
    dmWorkQueue.enqueueMissingAnalysisWork(db);
  }
  batch.recoverInterruptedBatchJobs(db);
  const taskRunner = options.taskRunner || runTask;
  const storageDir = options.storageDir;
  const workflowOptions = { storageDir, ...(options.workflowOptions || {}) };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = parsePath(url.pathname);

    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'desktop-backend', version: DESKTOP_BACKEND_VERSION });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'accounts' && await handleAccounts(db, req, res, parts)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'tasks' && await handleTasks(db, req, res, parts, url, taskRunner)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'events' && handleEvents(db, req, res, parts, url)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'settings' && await handleSettings(req, res, parts, storageDir, options)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'search-sessions' && await handleSearchSessions(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'batch-jobs' && await handleBatchJobs(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'comment-sync-jobs' && await handleCommentSyncJobs(db, req, res, parts, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'videos' && await handleVideos(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'external-videos' && await handleExternalVideos(db, req, res, parts, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'my-videos' && await handleMyVideos(db, req, res, parts, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'comments' && await handleComments(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'reply-drafts' && await handleReplyDrafts(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'dm' && await handleDmInbox(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'operations' && await handleOperationLeases(db, req, res, parts)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'dm-leads' && await handleDmLeads(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'knowledge' && await handleKnowledge(db, req, res, parts, url)) {
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { ok: false, error: error.message || 'internal error' });
    }
  });

  server.on('close', () => {
    if (!options.db) db.close();
  });

  return server;
}

module.exports = { createDesktopApiServer };
