# Douyin Desktop Docker MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建第一版本地桌面控制台：Electron 内置账号浏览器标签页，Docker 后端健康检查，账号 CRUD，任务列表，日志查看，并跑通一个 `search` 任务。

**Architecture:** 保持现有 CLI/Bridge 代码不被大改；新增一个本地后端 API 层供桌面端调用。Electron 只负责 UI、Docker 生命周期、账号浏览器 Profile 和脚本注入；业务任务由后端执行。第一版 Docker 只承载后端服务，浏览器留在 Electron 内置 Chromium 中。

**Tech Stack:** Node.js 22 LTS、better-sqlite3、原生 Node HTTP server、Vitest、Docker Compose、Electron、React、Vite。

## Global Constraints

- 第一版不做中心化团队服务器。
- 第一版不做团队共享数据库。
- 第一版不做拖拽式工作流编辑器。
- 不做平台风控绕过、隐身指纹伪装、Canvas/WebGL/Audio 指纹欺骗或反检测规避。
- 不做自动注册账号。
- 每个同事的数据保存在自己的电脑上。
- 每个账号使用独立浏览器 Profile 保存登录态。
- Docker 后端健康检查接口只暴露在本机 localhost。
- 优先复用现有 `server.js`、`lib/client/bridge-client.js`、`lib/commands/*`。
- 当前根项目仍保留 CLI；桌面应用放在 `desktop/` 子目录，避免破坏 CLI 使用方式。

---

## 文件结构

新增或修改的主要文件：

- `desktop-backend.js`：本地后端 API 入口，负责启动 API server，并复用 Bridge/任务模块。
- `lib/desktop/db.js`：SQLite 连接、schema 初始化、测试环境 storage 重定向。
- `lib/desktop/accounts.js`：账号数据访问层。
- `lib/desktop/tasks.js`：任务数据访问层和任务状态流转。
- `lib/desktop/events.js`：事件日志数据访问层。
- `lib/desktop/api-server.js`：原生 Node HTTP API 路由。
- `lib/desktop/task-runner.js`：执行第一版任务类型 `search`。
- `tests/desktop-db.test.js`：账号、任务、事件日志持久化测试。
- `tests/desktop-api.test.js`：后端 API 测试。
- `Dockerfile.desktop-backend`：Docker 后端镜像。
- `docker-compose.desktop.yml`：本地 compose 文件。
- `desktop/package.json`：桌面端独立 package。
- `desktop/electron/main.js`：Electron 主进程。
- `desktop/electron/preload.js`：安全 IPC 暴露层。
- `desktop/electron/docker.js`：Docker 生命周期控制器。
- `desktop/electron/profiles.js`：账号 Profile/partition 管理。
- `desktop/electron/browser-tabs.js`：内置浏览器标签页创建和 Bridge 注入。
- `desktop/renderer/index.html`：Vite 入口 HTML。
- `desktop/renderer/src/main.jsx`：React 入口。
- `desktop/renderer/src/App.jsx`：应用壳。
- `desktop/renderer/src/api.js`：renderer 调用 preload API 的客户端。
- `desktop/renderer/src/styles.css`：运营控制台样式。
- `desktop/renderer/src/components/AccountsPage.jsx`：账号管理页。
- `desktop/renderer/src/components/TasksPage.jsx`：任务管理页。
- `desktop/renderer/src/components/LogsPage.jsx`：日志查看页。
- `desktop/renderer/src/components/SettingsPage.jsx`：设置/健康检查页。
- `desktop/README.md`：Windows 开发运行说明。

---

## Task 1: 后端 SQLite 数据层

**Files:**
- Create: `lib/desktop/db.js`
- Create: `lib/desktop/accounts.js`
- Create: `lib/desktop/tasks.js`
- Create: `lib/desktop/events.js`
- Create: `tests/desktop-db.test.js`

**Interfaces:**
- Produces: `openDesktopDb(options?: { storageDir?: string }): Database`
- Produces: `createAccount(db, input): Account`
- Produces: `listAccounts(db): Account[]`
- Produces: `updateAccount(db, id, patch): Account`
- Produces: `deleteAccount(db, id): boolean`
- Produces: `createTask(db, input): Task`
- Produces: `updateTaskStatus(db, id, status, patch): Task`
- Produces: `listTasks(db, filters?: { accountId?: string }): Task[]`
- Produces: `appendEvent(db, input): EventLog`
- Produces: `listEvents(db, filters?: { accountId?: string; taskId?: string; limit?: number }): EventLog[]`

- [ ] **Step 1: Write failing persistence tests**

Create `tests/desktop-db.test.js`:

```js
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const tasks = require('../lib/desktop/tasks');
const events = require('../lib/desktop/events');

describe('desktop db', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-desktop-db-'));
    db = openDesktopDb({ storageDir: dir });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates, updates, lists, and deletes accounts', () => {
    const account = accounts.createAccount(db, {
      name: '账号A',
      group: '默认分组',
      proxyConfig: { mode: 'none' },
      notes: '测试账号',
    });

    expect(account.id).toMatch(/^acct_/);
    expect(account.profileKey).toBe(account.id);
    expect(account.status).toBe('login_required');

    const updated = accounts.updateAccount(db, account.id, {
      status: 'online',
      notes: '已登录',
    });
    expect(updated.status).toBe('online');
    expect(updated.notes).toBe('已登录');

    expect(accounts.listAccounts(db)).toHaveLength(1);
    expect(accounts.deleteAccount(db, account.id)).toBe(true);
    expect(accounts.listAccounts(db)).toHaveLength(0);
  });

  it('creates tasks and records status transitions', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '美食', count: 3 },
    });

    expect(task.status).toBe('pending');
    expect(task.input.keyword).toBe('美食');

    const running = tasks.updateTaskStatus(db, task.id, 'running', {
      resultSummary: { step: 'bridge_call' },
    });
    expect(running.status).toBe('running');

    const rows = tasks.listTasks(db, { accountId: account.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].resultSummary.step).toBe('bridge_call');
  });

  it('appends and lists event logs', () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '穿搭' },
    });

    events.appendEvent(db, {
      accountId: account.id,
      taskId: task.id,
      level: 'info',
      message: '任务已创建',
      metadata: { type: 'search' },
    });

    const logs = events.listEvents(db, { taskId: task.id, limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('任务已创建');
    expect(logs[0].metadata.type).toBe('search');
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-db.test.js`

Expected: FAIL with missing modules under `lib/desktop/*`.

- [ ] **Step 3: Implement database connection and schema**

Create `lib/desktop/db.js`:

```js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDesktopDb(options = {}) {
  const storageDir = options.storageDir || process.env.DOUYIN_DESKTOP_STORAGE_DIR || path.join(process.cwd(), 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  const db = new Database(path.join(storageDir, 'desktop.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL UNIQUE,
      proxy_config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'login_required',
      last_seen_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS event_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      task_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_logs_account_id ON event_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_event_logs_task_id ON event_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at);
  `);

  return db;
}

module.exports = { openDesktopDb };
```

- [ ] **Step 4: Implement account/task/event stores**

Use `crypto.randomUUID()` IDs with prefixes. Store JSON fields as strings and parse them on return. Export the exact functions from the Interfaces block.

- [ ] **Step 5: Run tests**

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-db.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/desktop/db.js lib/desktop/accounts.js lib/desktop/tasks.js lib/desktop/events.js tests/desktop-db.test.js
git commit -m "feat: add desktop persistence layer"
```

---

## Task 2: 本地后端 HTTP API

**Files:**
- Create: `lib/desktop/api-server.js`
- Create: `desktop-backend.js`
- Create: `tests/desktop-api.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 stores.
- Produces: `createDesktopApiServer(options): http.Server`
- Produces endpoints:
  - `GET /api/health`
  - `GET /api/accounts`
  - `POST /api/accounts`
  - `PATCH /api/accounts/:id`
  - `DELETE /api/accounts/:id`
  - `GET /api/tasks`
  - `POST /api/tasks`
  - `GET /api/events`

- [ ] **Step 1: Write failing API tests**

Create `tests/desktop-api.test.js` with `fetch` against a random local port:

```js
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesktopApiServer } = require('../lib/desktop/api-server');

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

  it('returns health status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'desktop-backend' });
  });

  it('creates and lists accounts', async () => {
    const create = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A', group: '测试组' }),
    });
    expect(create.status).toBe(201);
    const account = await create.json();
    expect(account.name).toBe('账号A');

    const list = await fetch(`${baseUrl}/api/accounts`);
    expect(await list.json()).toHaveLength(1);
  });

  it('creates a pending search task', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A' }),
    })).json();

    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '美食', count: 3 },
      }),
    });

    expect(create.status).toBe(201);
    const task = await create.json();
    expect(task.status).toBe('pending');
    expect(task.type).toBe('search');
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-api.test.js`

Expected: FAIL with missing `createDesktopApiServer`.

- [ ] **Step 3: Implement API server**

Create `lib/desktop/api-server.js` using `http.createServer`. Implement JSON parsing, JSON response helpers, route matching, and 404/405/400 responses. Do not add Express for the MVP.

- [ ] **Step 4: Add backend entry script**

Create `desktop-backend.js`:

```js
#!/usr/bin/env node

const { createDesktopApiServer } = require('./lib/desktop/api-server');

const host = process.env.DESKTOP_BACKEND_HOST || '127.0.0.1';
const port = Number(process.env.DESKTOP_BACKEND_PORT || 19522);
const storageDir = process.env.DOUYIN_DESKTOP_STORAGE_DIR;

const server = createDesktopApiServer({ storageDir });

server.listen(port, host, () => {
  console.error(`[desktop-backend] ready http://${host}:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

Modify `package.json` scripts:

```json
{
  "desktop:backend": "node desktop-backend.js"
}
```

- [ ] **Step 5: Run tests and smoke server**

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-api.test.js`

Expected: PASS.

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd run desktop:backend`

Expected: prints `[desktop-backend] ready http://127.0.0.1:19522`.

- [ ] **Step 6: Commit**

```bash
git add lib/desktop/api-server.js desktop-backend.js tests/desktop-api.test.js package.json
git commit -m "feat: add desktop backend api"
```

---

## Task 3: Docker 后端封装

**Files:**
- Create: `Dockerfile.desktop-backend`
- Create: `docker-compose.desktop.yml`
- Create: `.dockerignore`
- Modify: `desktop/README.md` later if Task 3 is implemented after Task 8; otherwise create a temporary root note in this task.

**Interfaces:**
- Consumes: `desktop-backend.js`.
- Produces: Docker service `douyin-desktop-backend` on `127.0.0.1:19522`.

- [ ] **Step 1: Write Dockerfile**

Create `Dockerfile.desktop-backend`:

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY cli.js server.js desktop-backend.js config.example.json ./
COPY lib ./lib
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DESKTOP_BACKEND_HOST=0.0.0.0
ENV DESKTOP_BACKEND_PORT=19522
ENV DOUYIN_DESKTOP_STORAGE_DIR=/data

EXPOSE 19522

CMD ["node", "desktop-backend.js"]
```

- [ ] **Step 2: Write Docker Compose file**

Create `docker-compose.desktop.yml`:

```yaml
services:
  douyin-desktop-backend:
    build:
      context: .
      dockerfile: Dockerfile.desktop-backend
    container_name: douyin-desktop-backend
    ports:
      - "127.0.0.1:19522:19522"
    volumes:
      - douyin-desktop-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:19522/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  douyin-desktop-data:
```

- [ ] **Step 3: Write `.dockerignore`**

Create `.dockerignore`:

```text
.git
.tools
node_modules
desktop/node_modules
storage
logs
downloads
*.log
*.pid
```

- [ ] **Step 4: Build and run compose**

Run: `docker compose -f docker-compose.desktop.yml build`

Expected: image builds with Node 22 and `better-sqlite3` installs successfully.

Run: `docker compose -f docker-compose.desktop.yml up -d`

Expected: service starts.

Run: `Invoke-RestMethod http://127.0.0.1:19522/api/health`

Expected: JSON includes `ok: true`.

- [ ] **Step 5: Stop compose**

Run: `docker compose -f docker-compose.desktop.yml down`

Expected: container stops; named volume remains.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.desktop-backend docker-compose.desktop.yml .dockerignore
git commit -m "feat: package desktop backend with docker"
```

---

## Task 4: Electron 桌面项目骨架

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/electron/main.js`
- Create: `desktop/electron/preload.js`
- Create: `desktop/renderer/index.html`
- Create: `desktop/renderer/src/main.jsx`
- Create: `desktop/renderer/src/App.jsx`
- Create: `desktop/renderer/src/styles.css`
- Create: `desktop/renderer/src/api.js`

**Interfaces:**
- Produces: `window.douyinDesktop.getBackendHealth(): Promise<object>`
- Produces: `window.douyinDesktop.listAccounts(): Promise<Account[]>`
- Produces: `window.douyinDesktop.createAccount(input): Promise<Account>`
- Produces: `window.douyinDesktop.listTasks(): Promise<Task[]>`
- Produces: `window.douyinDesktop.createTask(input): Promise<Task>`
- Produces: `window.douyinDesktop.listEvents(filters): Promise<EventLog[]>`

- [ ] **Step 1: Create desktop package**

Create `desktop/package.json`:

```json
{
  "name": "douyin-desktop",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "main": "electron/main.js",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "electron": "electron .",
    "start": "concurrently \"npm run dev\" \"wait-on http://127.0.0.1:5173 && electron .\""
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "electron": "^33.0.0",
    "concurrently": "^9.1.0",
    "wait-on": "^8.0.1"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create Electron main/preload**

`desktop/electron/main.js` creates `BrowserWindow`, loads `http://127.0.0.1:5173` in dev, and registers IPC handlers that call backend API at `http://127.0.0.1:19522`.

`desktop/electron/preload.js` exposes only the methods listed in Interfaces through `contextBridge.exposeInMainWorld`.

- [ ] **Step 3: Create React shell**

Build a simple left-nav operations console with pages: `accounts`, `tasks`, `logs`, `settings`. Use CSS grid/flex, compact tables, and no marketing hero.

- [ ] **Step 4: Install desktop dependencies**

Run from `desktop/`: `npm.cmd install`

Expected: `desktop/package-lock.json` and `desktop/node_modules` created.

- [ ] **Step 5: Launch desktop dev shell**

Run from `desktop/`: `npm.cmd run start`

Expected: Electron window opens and shows the shell. If backend is not running, Settings page shows backend offline instead of crashing.

- [ ] **Step 6: Commit**

```bash
git add desktop/package.json desktop/package-lock.json desktop/electron desktop/renderer
git commit -m "feat: scaffold electron desktop shell"
```

---

## Task 5: Electron Docker 生命周期控制

**Files:**
- Create: `desktop/electron/docker.js`
- Modify: `desktop/electron/main.js`
- Modify: `desktop/electron/preload.js`
- Modify: `desktop/renderer/src/api.js`
- Modify: `desktop/renderer/src/components/SettingsPage.jsx`

**Interfaces:**
- Produces: `getDockerStatus(): Promise<{ available: boolean; running: boolean; backendHealthy: boolean; message: string }>`
- Produces: `startBackend(): Promise<{ ok: boolean; message: string }>`
- Produces: `stopBackend(): Promise<{ ok: boolean; message: string }>`

- [ ] **Step 1: Implement Docker command wrapper**

Create `desktop/electron/docker.js` using `child_process.spawn` with no shell string interpolation. Commands:

```js
const DOCKER_COMPOSE_FILE = 'docker-compose.desktop.yml';
```

Methods:

- `docker --version`
- `docker compose -f docker-compose.desktop.yml ps --format json`
- `docker compose -f docker-compose.desktop.yml up -d`
- `docker compose -f docker-compose.desktop.yml down`

- [ ] **Step 2: Wire IPC handlers**

Expose `getDockerStatus`, `startBackend`, and `stopBackend` from preload.

- [ ] **Step 3: Add Settings controls**

Settings page shows:

- Docker availability.
- Backend health.
- “启动后端” button.
- “停止后端” button.
- Latest status message.

- [ ] **Step 4: Manual verification**

Run from `desktop/`: `npm.cmd run start`

Expected:

- With Docker Desktop stopped: UI says Docker unavailable or not running.
- With Docker Desktop running: clicking start runs compose.
- Health check turns green after backend starts.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/docker.js desktop/electron/main.js desktop/electron/preload.js desktop/renderer/src
git commit -m "feat: manage docker backend from desktop app"
```

---

## Task 6: 账号管理 UI 和 API 集成

**Files:**
- Create: `desktop/renderer/src/components/AccountsPage.jsx`
- Modify: `desktop/renderer/src/App.jsx`
- Modify: `desktop/renderer/src/api.js`

**Interfaces:**
- Consumes: backend endpoints `GET /api/accounts`, `POST /api/accounts`, `PATCH /api/accounts/:id`, `DELETE /api/accounts/:id`.
- Produces UI actions: create account, edit notes/group/status, delete account.

- [ ] **Step 1: Build account API client**

In `desktop/renderer/src/api.js`, add:

```js
export async function listAccounts() {
  return window.douyinDesktop.listAccounts();
}

export async function createAccount(input) {
  return window.douyinDesktop.createAccount(input);
}
```

- [ ] **Step 2: Build account page**

Create a dense table with columns:

- 名称
- 分组
- 状态
- Profile
- 最近在线
- 备注
- 操作

Include a compact create form at the top with name/group/notes.

- [ ] **Step 3: Wire page into app shell**

Accounts nav item should load `AccountsPage`.

- [ ] **Step 4: Manual verification**

Start backend and desktop. Create an account named `账号A`. Refresh the Electron window.

Expected: `账号A` still appears.

- [ ] **Step 5: Commit**

```bash
git add desktop/renderer/src/components/AccountsPage.jsx desktop/renderer/src/App.jsx desktop/renderer/src/api.js
git commit -m "feat: add account management ui"
```

---

## Task 7: 内置浏览器标签页和 Profile 持久化

**Files:**
- Create: `desktop/electron/profiles.js`
- Create: `desktop/electron/browser-tabs.js`
- Modify: `desktop/electron/main.js`
- Modify: `desktop/electron/preload.js`
- Modify: `desktop/renderer/src/components/AccountsPage.jsx`

**Interfaces:**
- Produces: `openAccountBrowser(account: { id: string; profileKey: string }): Promise<{ ok: boolean }>`
- Produces: one Electron `BrowserView` or `WebContentsView` per opened account.

- [ ] **Step 1: Implement profile helper**

Create `desktop/electron/profiles.js`:

```js
function partitionForAccount(account) {
  return `persist:douyin-account-${account.profileKey || account.id}`;
}

module.exports = { partitionForAccount };
```

- [ ] **Step 2: Implement browser tab manager**

Create `desktop/electron/browser-tabs.js` with:

- `openAccountBrowser(mainWindow, account)`
- Browser partition from `partitionForAccount(account)`.
- Load URL `https://www.douyin.com/`.
- Inject bridge script after `did-finish-load` using `webContents.executeJavaScript`.
- Read script content from root `scripts/douyin.user.js` initially.

- [ ] **Step 3: Add IPC and UI button**

Accounts table adds “打开浏览器” button. Button calls `window.douyinDesktop.openAccountBrowser(account)`.

- [ ] **Step 4: Manual verification**

Open `账号A` browser, log in manually, close app, reopen app, open `账号A` again.

Expected: login state remains if Douyin session is still valid.

- [ ] **Step 5: Profile isolation verification**

Create `账号B`, open browser, confirm it does not share `账号A` session.

Expected: `账号B` requires separate login.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron/profiles.js desktop/electron/browser-tabs.js desktop/electron/main.js desktop/electron/preload.js desktop/renderer/src/components/AccountsPage.jsx
git commit -m "feat: add embedded account browser tabs"
```

---

## Task 8: Search 任务执行链路

**Files:**
- Create: `lib/desktop/task-runner.js`
- Modify: `lib/desktop/api-server.js`
- Modify: `desktop/renderer/src/components/TasksPage.jsx`
- Modify: `desktop/renderer/src/App.jsx`
- Modify: `desktop/renderer/src/api.js`
- Create: `tests/desktop-task-runner.test.js`

**Interfaces:**
- Consumes: task store from Task 1.
- Consumes: existing `BridgeClient` from `lib/client/bridge-client.js`.
- Produces: `runTask(db, taskId, options?: { bridgeClient?: object }): Promise<Task>`
- Produces: `POST /api/tasks/:id/run`

- [ ] **Step 1: Write task-runner test with fake bridge**

Create `tests/desktop-task-runner.test.js`:

```js
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const tasks = require('../lib/desktop/tasks');
const { runTask } = require('../lib/desktop/task-runner');

describe('desktop task runner', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-task-runner-'));
    db = openDesktopDb({ storageDir: dir });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a search task through bridge client', async () => {
    const account = accounts.createAccount(db, { name: '账号A' });
    const task = tasks.createTask(db, {
      accountId: account.id,
      type: 'search',
      input: { keyword: '美食', count: 2 },
    });

    const fakeBridge = {
      call: async ({ expression }) => ({
        ok: true,
        value: {
          data: [
            { aweme_info: { aweme_id: '1', desc: '美食视频1' } },
            { aweme_info: { aweme_id: '2', desc: '美食视频2' } },
          ],
          expression,
        },
      }),
    };

    const result = await runTask(db, task.id, { bridgeClient: fakeBridge });
    expect(result.status).toBe('success');
    expect(result.resultSummary.count).toBe(2);
  });
});
```

- [ ] **Step 2: Implement `runTask`**

For MVP, support only `type === 'search'`. Mark unsupported types as `failed` with `error: "Unsupported task type: <type>"`.

- [ ] **Step 3: Add run endpoint**

Add `POST /api/tasks/:id/run` to `api-server.js`. It should call `runTask`, return the updated task, and persist event logs.

- [ ] **Step 4: Build Tasks UI**

Create task form:

- Account select.
- Type select with `search`.
- Keyword input.
- Count input.

Task table columns:

- 类型
- 账号
- 状态
- 输入
- 结果
- 创建时间
- 操作

Add “运行” button for pending/failed tasks.

- [ ] **Step 5: Run tests**

Run: `.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-task-runner.test.js tests/desktop-api.test.js`

Expected: PASS.

- [ ] **Step 6: Manual verification**

With backend, Bridge Server, and an online account browser open, create a `search` task and run it.

Expected: task changes from `pending` to `running` to `success`, and result summary shows count.

- [ ] **Step 7: Commit**

```bash
git add lib/desktop/task-runner.js lib/desktop/api-server.js desktop/renderer/src
git add tests/desktop-task-runner.test.js
git commit -m "feat: run search tasks from desktop"
```

---

## Task 9: 日志查看和 Windows 开发说明

**Files:**
- Create: `desktop/renderer/src/components/LogsPage.jsx`
- Create: `desktop/renderer/src/components/SettingsPage.jsx` if not created in Task 5
- Create: `desktop/README.md`
- Modify: `desktop/renderer/src/App.jsx`
- Modify: `desktop/renderer/src/api.js`

**Interfaces:**
- Consumes: `GET /api/events`
- Produces: coworker/operator runbook for local development.

- [ ] **Step 1: Build Logs page**

Display event logs with columns:

- 时间
- 等级
- 账号
- 任务
- 消息
- 元数据

Add refresh button and limit selector `50/100/200`.

- [ ] **Step 2: Build Settings health summary**

Settings page shows:

- Backend API URL.
- Docker status.
- Backend health.
- Local data location.
- App version.

- [ ] **Step 3: Write desktop README**

Create `desktop/README.md`:

```md
# Douyin Desktop

## 开发运行

1. 启动 Docker Desktop。
2. 在仓库根目录启动后端：

   ```powershell
   docker compose -f docker-compose.desktop.yml up -d --build
   ```

3. 安装桌面端依赖：

   ```powershell
   cd desktop
   npm install
   ```

4. 启动桌面应用：

   ```powershell
   npm run start
   ```

## 使用流程

1. 在账号页创建账号。
2. 点击“打开浏览器”。
3. 在内置浏览器里登录抖音。
4. 在任务页创建 `search` 任务。
5. 点击“运行”并在日志页查看结果。

## 注意

- 第一版每个同事本机独立运行，数据不会自动同步。
- 浏览器 Profile 用于账号隔离和登录态持久化。
- 不提供指纹伪装或平台检测绕过能力。
```

- [ ] **Step 4: Manual final smoke**

Run:

```powershell
docker compose -f docker-compose.desktop.yml up -d --build
cd desktop
npm run start
```

Expected:

- Settings shows backend healthy.
- Account can be created.
- Account browser can be opened.
- Search task can be created.
- Logs page shows task events.

- [ ] **Step 5: Commit**

```bash
git add desktop/README.md desktop/renderer/src
git commit -m "docs: add desktop runbook and logs page"
```

---

## Self-Review

Spec coverage:

- 桌面应用：Tasks 4-9.
- Docker 后端：Tasks 2-3, 5.
- 内置浏览器标签页：Task 7.
- 每账号独立 Profile：Task 7.
- 账号 CRUD：Tasks 1, 2, 6.
- 任务列表和一个任务类型：Task 8.
- 日志查看：Tasks 1, 2, 9.
- Windows 开发运行说明：Task 9.
- 非目标和安全边界：Global Constraints and `desktop/README.md`.

Known gaps intentionally deferred:

- Windows installer packaging is not included in the MVP implementation plan; it should be a follow-up plan after dev mode is stable.
- Centralized team server is excluded by spec.
- Drag-and-drop workflow editor is excluded by spec.
- Browser fingerprint evasion is excluded by spec.

Placeholder scan:

- No `TBD`, `TODO`, `implement later`, or unspecified “add error handling” steps remain.

Type consistency:

- `Account`, `Task`, and `EventLog` fields match the Chinese design spec.
- `runTask(db, taskId, options)` is introduced in Task 8 before API/UI consumes it.
- Renderer APIs go through `window.douyinDesktop.*`, introduced in Task 4 before page components use them.
