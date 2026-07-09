const path = require('path');
const { BridgeClient } = require('../client/bridge-client');
const { SITE, escapeExpression } = require('../commands/helpers');
const tasks = require('./tasks');
const events = require('./events');
const { LLMClient } = require('../llm');

function loadBridgeConfig() {
  try {
    const config = require(path.join(process.cwd(), 'config.json'));
    return config.bridge || {};
  } catch {
    return {};
  }
}

function createBridgeClient() {
  const bridge = loadBridgeConfig();
  return new BridgeClient({
    host: bridge.host || '127.0.0.1',
    port: bridge.port || 19422,
    token: bridge.token || '',
  });
}

function isFreshConnection(conn, now = Date.now(), maxIdleMs = 45000) {
  if (!conn || conn.alive === false) return false;
  const last = Date.parse(conn.lastActivity || conn.connectedAt || '');
  if (!Number.isFinite(last)) return Boolean(conn.alive);
  return now - last <= maxIdleMs;
}

function isRealDouyinBrowserConnection(conn) {
  const url = String(conn?.url || '').toLowerCase();
  const title = String(conn?.title || '').toLowerCase();
  const userAgent = String(conn?.userAgent || '').toLowerCase();
  if (userAgent.includes('poll-mock-client')) return false;
  if (title.includes('desktop poll mock')) return false;
  return url.includes('douyin.com');
}

function hasPollClient(status, options = {}) {
  if (!status || !status.ok) return false;
  if (!status.connections || typeof status.connections !== 'object') return false;
  const site = options.site || SITE;
  const now = options.now || Date.now();
  const maxIdleMs = options.maxIdleMs || 45000;
  const allowMock = options.allowMock ?? process.env.DOUYIN_ALLOW_MOCK_POLL === '1';
  const waiters = Number(status.pollWaiters?.[site] || 0);
  if (waiters <= 0) return false;
  const conns = status.connections[site];
  if (!Array.isArray(conns)) return false;
  return conns.some((conn) => (
    isFreshConnection(conn, now, maxIdleMs)
    && (allowMock || isRealDouyinBrowserConnection(conn))
  ));
}

async function ensureBridgeClientOnline(bridgeClient) {
  if (!bridgeClient || typeof bridgeClient.status !== 'function') {
    return;
  }
  const deadline = Date.now() + 3500;
  let status = null;
  do {
    status = await bridgeClient.status();
    if (hasPollClient(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error('未检测到在线的抖音内置浏览器，请先打开账号浏览器并保持抖音页面登录在线后再执行任务');
}

function normalizeText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function normalizeOptionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function extractAwemeId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;

  const patterns = [
    /\/video\/(\d{6,})/i,
    /\/note\/(\d{6,})/i,
    /[?&](?:aweme_id|awemeId|modal_id)=(\d{6,})/i,
    /(?:^|[^\d])(\d{16,})(?:[^\d]|$)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function extractDouyinUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const matches = text.match(/https?:\/\/[^\s"'<>，。！？、]+/ig) || [];
  return matches.find(isAllowedDouyinUrl) || '';
}

function isAllowedDouyinUrl(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    return host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
  } catch {
    return false;
  }
}

async function resolveAwemeIdViaHttp(value, options = {}) {
  if (!isAllowedDouyinUrl(value)) return '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetchImpl(value, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const fromFinalUrl = extractAwemeId(response.url || '');
    if (fromFinalUrl) return fromFinalUrl;
    const text = await response.text().catch(() => '');
    return extractAwemeId(text);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAwemeIdInput(value, bridgeClient, options = {}) {
  const text = normalizeText(value, 'awemeId');
  const local = extractAwemeId(text);
  if (local) return local;

  const urlText = extractDouyinUrl(text) || text;

  if (!/^https?:\/\//i.test(urlText)) {
    throw new Error('作品 ID 格式不正确，请填写数字作品 ID 或抖音作品链接');
  }

  if (!isAllowedDouyinUrl(urlText)) {
    throw new Error('只支持抖音作品链接，请填写 douyin.com 链接或数字作品 ID');
  }

  const resolvedByHttp = await resolveAwemeIdViaHttp(urlText, options);
  if (resolvedByHttp) return resolvedByHttp;

  if (!bridgeClient || typeof bridgeClient.call !== 'function') {
    throw new Error('无法解析抖音链接，请填写数字作品 ID');
  }

  const expression = `
    (async function () {
      var raw = '${escapeExpression(urlText)}';
      var patterns = [
        /\\/video\\/(\\d{6,})/i,
        /\\/note\\/(\\d{6,})/i,
        /[?&](?:aweme_id|awemeId|modal_id)=(\\d{6,})/i,
        /(?:^|[^\\d])(\\d{16,})(?:[^\\d]|$)/
      ];
      function pick(s) {
        for (var i = 0; i < patterns.length; i++) {
          var m = String(s || '').match(patterns[i]);
          if (m) return m[1];
        }
        return '';
      }
      var direct = pick(raw);
      if (direct) return direct;
      var response = await fetch(raw, { redirect: 'follow', credentials: 'include' });
      return pick(response.url || '');
    })()
  `;
  const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true, timeout: 45000 });
  if (!response.ok || !response.value) {
    throw new Error('无法从抖音链接解析作品 ID，请打开链接后复制地址栏中的数字作品 ID');
  }
  return String(response.value);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    if (value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes') return true;
    if (value.toLowerCase() === '0' || value.toLowerCase() === 'false' || value.toLowerCase() === 'no') return false;
  }
  return fallback;
}

function summarizeSearchResult(value) {
  const rows = Array.isArray(value?.data) ? value.data : [];
  const items = rows
    .filter((row) => row && row.aweme_info)
    .map((row) => ({
      awemeId: row.aweme_info.aweme_id,
      desc: String(row.aweme_info.desc || '').slice(0, 80),
      author: row.aweme_info.author?.nickname || '',
    }));
  return {
    count: items.length,
    items,
  };
}

async function runSearchTask(db, task, bridgeClient) {
  const keyword = String(task.input.keyword || '').trim();
  const offset = Number(task.input.offset || 0);
  const count = Math.min(Number(task.input.count || 10), 20);

  if (!keyword) {
    throw new Error('search task requires input.keyword');
  }

  const expression = `window.__bridge.search('${escapeExpression(keyword)}', ${offset}, ${count})`;
  const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true });
  if (!response.ok) {
    throw new Error(response.error || 'Bridge search failed');
  }
  return summarizeSearchResult(response.value);
}

async function runLikeTask(db, task, bridgeClient) {
  const awemeId = await resolveAwemeIdInput(task.input.awemeId, bridgeClient);
  const action = task.input.action === 'unlike' ? 'unlike' : 'like';
  const type = action === 'unlike' ? 0 : 1;

  const expression = `window.__bridge.digg('${escapeExpression(awemeId)}', ${type})`;
  const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true });
  if (!response.ok) {
    throw new Error(response.error || 'Bridge digg failed');
  }

  const value = response.value || {};
  const statusCode = value.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(`like failed: status_code=${statusCode}`);
  }

  return {
    action,
    awemeId,
    status_code: statusCode ?? 0,
  };
}

async function runPublishTask(db, task, bridgeClient, publishInput = {}) {
  const awemeId = await resolveAwemeIdInput(publishInput.awemeId || task.input.awemeId, bridgeClient);
  const text = normalizeText(
    publishInput.text || task.input.text || task.input.commentText,
    'text',
  );
  const replyTo = normalizeOptionalText(publishInput.replyToCommentId || publishInput.replyTo || task.input.replyToCommentId || task.input.replyTo || null);
  const rrid = normalizeOptionalText(task.input.replyToReplyId || task.input.replyToReply);
  const mentions = publishInput.mentions || task.input.mentions || 'null';

  const expression = `window.__bridge.publish('${escapeExpression(awemeId)}', '${escapeExpression(text)}', ${replyTo ? `'${escapeExpression(replyTo)}'` : 'null'}, ${rrid ? `'${escapeExpression(rrid)}'` : 'null'}, ${mentions})`;
  const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true });
  if (!response.ok) {
    throw new Error(response.error || 'Bridge publish failed');
  }

  const value = response.value || {};
  const statusCode = value.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    if (statusCode === 5) {
      throw new Error('发布失败：作品 ID 无效或链接未解析成功，请填写真实数字作品 ID，或先在内置浏览器打开该作品后再重试');
    }
    throw new Error(`publish failed: status_code=${statusCode}`);
  }
  if (!value.comment || !value.comment.cid) {
    throw new Error('publish failed: no comment in response');
  }

  return {
    awemeId,
    replyToCommentId: replyTo || null,
    cid: String(value.comment.cid),
    text: value.comment.text || text,
    status_code: statusCode ?? 0,
  };
}

async function runDeleteCommentTask(db, task, bridgeClient) {
  const commentId = normalizeText(task.input.commentId || task.input.cid, 'commentId');
  const expression = `window.__bridge.deleteComment('${escapeExpression(commentId)}')`;
  const response = await bridgeClient.call({ site: SITE, expression, awaitPromise: true });
  if (!response.ok) {
    throw new Error(response.error || 'Bridge deleteComment failed');
  }
  const statusCode = response.value?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(`deleteComment failed: status_code=${statusCode}`);
  }
  return { commentId, status_code: statusCode ?? 0 };
}

async function runSuggestTask(db, task, bridgeClient, options = {}) {
  const sourceText = normalizeText(task.input.sourceText || task.input.commentText, 'sourceText');
  const shouldAutoPublish = normalizeBoolean(task.input.autoPublish, false);
  const awemeId = normalizeOptionalText(task.input.awemeId);
  const replyToCommentId = normalizeOptionalText(task.input.replyToCommentId || task.input.replyTo);

  const strategyText = String(task.input.strategy || task.input.tone || '').trim() || null;
  const llm = options.llmClient || new LLMClient();
  const response = await llm.suggestReplies(
    [{ cid: 'source', text: sourceText }],
    strategyText ? { style: strategyText } : {},
    task.input.videoDesc || '',
    {},
    options.persona || null,
  );

  const suggested = Array.isArray(response) ? String(response[0]?.reply || '').trim() : '';
  if (!suggested) {
    throw new Error('AI did not return a valid reply');
  }

  const result = {
    awemeId: awemeId || null,
    replyToCommentId: replyToCommentId || null,
    sourceText,
    suggested,
    autoPublish: shouldAutoPublish,
  };

  if (shouldAutoPublish) {
    if (!awemeId || !replyToCommentId) {
      throw new Error('autoPublish requires awemeId and replyToCommentId');
    }
    const publishResult = await runPublishTask(db, task, bridgeClient, {
      awemeId,
      text: suggested,
      replyToCommentId,
    });
    result.published = {
      cid: publishResult.cid,
      awemeId: publishResult.awemeId,
      replyToCommentId: publishResult.replyToCommentId,
      text: publishResult.text,
    };
  }

  return result;
}

async function runTask(db, taskId, options = {}) {
  const task = tasks.getTask(db, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const startedAt = new Date().toISOString();
  tasks.updateTaskStatus(db, task.id, 'running', { startedAt, error: null });
  events.appendEvent(db, {
    accountId: task.accountId,
    taskId: task.id,
    level: 'info',
    message: '任务开始运行',
    metadata: { type: task.type },
  });

  try {
    const bridgeClient = options.bridgeClient || createBridgeClient();
    const llmClient = options.llmClient;
    let resultSummary;

    await ensureBridgeClientOnline(bridgeClient);

    if (task.type === 'search') {
      resultSummary = await runSearchTask(db, task, bridgeClient);
    } else if (task.type === 'like') {
      resultSummary = await runLikeTask(db, task, bridgeClient);
    } else if (task.type === 'publish') {
      resultSummary = await runPublishTask(db, task, bridgeClient);
    } else if (task.type === 'delete-comment') {
      resultSummary = await runDeleteCommentTask(db, task, bridgeClient);
    } else if (task.type === 'suggest') {
      resultSummary = await runSuggestTask(db, task, bridgeClient, { llmClient: llmClient || options.llmClient });
    } else {
      throw new Error(`Unsupported task type: ${task.type}`);
    }

    const finishedAt = new Date().toISOString();
    const updated = tasks.updateTaskStatus(db, task.id, 'success', {
      resultSummary,
      finishedAt,
      error: null,
    });
    events.appendEvent(db, {
      accountId: task.accountId,
      taskId: task.id,
      level: 'info',
      message: '任务运行成功',
      metadata: resultSummary,
    });
    return updated;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const updated = tasks.updateTaskStatus(db, task.id, 'failed', {
      finishedAt,
      error: error.message,
    });
    events.appendEvent(db, {
      accountId: task.accountId,
      taskId: task.id,
      level: 'error',
      message: '任务运行失败',
      metadata: { error: error.message },
    });
    return updated;
  }
}

module.exports = {
  createBridgeClient,
  ensureBridgeClientOnline,
  extractAwemeId,
  extractDouyinUrl,
  hasPollClient,
  isAllowedDouyinUrl,
  isFreshConnection,
  isRealDouyinBrowserConnection,
  resolveAwemeIdViaHttp,
  resolveAwemeIdInput,
  runDeleteCommentTask,
  runLikeTask,
  runPublishTask,
  runSearchTask,
  runSuggestTask,
  runTask,
};
