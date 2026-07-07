const http = require('http');
const { URL } = require('url');

const { openDesktopDb } = require('./db');
const accounts = require('./accounts');
const tasks = require('./tasks');
const events = require('./events');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://127.0.0.1:5173',
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

async function handleTasks(db, req, res, parts, url) {
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

function createDesktopApiServer(options = {}) {
  const db = options.db || openDesktopDb({ storageDir: options.storageDir });

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

      if (parts[0] === 'api' && parts[1] === 'tasks' && await handleTasks(db, req, res, parts, url)) {
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'events' && handleEvents(db, req, res, parts, url)) {
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
