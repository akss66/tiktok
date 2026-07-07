const path = require('path');
const { BridgeClient } = require('../client/bridge-client');
const { SITE, escapeExpression } = require('../commands/helpers');
const tasks = require('./tasks');
const events = require('./events');

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
    let resultSummary;

    if (task.type === 'search') {
      resultSummary = await runSearchTask(db, task, bridgeClient);
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

module.exports = { runTask };
