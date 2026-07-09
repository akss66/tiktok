const http = require('http');
const { URL } = require('url');

const { openDesktopDb } = require('./db');
const accounts = require('./accounts');
const tasks = require('./tasks');
const events = require('./events');
const { runTask } = require('./task-runner');
const settings = require('./settings');
const batch = require('./batch');
const workspace = require('./workspace');
const workflows = require('./mvp-workflows');

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
    const job = workflows.createBatchFromVideos(db, body);
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

async function handleKnowledge(db, req, res, parts) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, workspace.listKnowledgeEntries(db));
    return true;
  }

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readBody(req);
    sendJson(res, 201, workspace.createKnowledgeEntry(db, body));
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

async function handleSettings(req, res, parts, storageDir) {
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
  return false;
}

function createDesktopApiServer(options = {}) {
  const db = options.db || openDesktopDb({ storageDir: options.storageDir });
  const taskRunner = options.taskRunner || runTask;
  const workflowOptions = options.workflowOptions || {};
  const storageDir = options.storageDir;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = parsePath(url.pathname);

    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'desktop-backend', version: '0.1.0' });
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

      if (parts[0] === 'api' && parts[1] === 'settings' && await handleSettings(req, res, parts, storageDir)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'search-sessions' && await handleSearchSessions(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'batch-jobs' && await handleBatchJobs(db, req, res, parts, url, workflowOptions)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'videos' && await handleVideos(db, req, res, parts, url, workflowOptions)) {
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

      if (parts[0] === 'api' && parts[1] === 'knowledge' && await handleKnowledge(db, req, res, parts)) {
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
