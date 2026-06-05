# Bridge Framework — 油猴 + WebSocket 浏览器自动化框架

> 替代 CDP 方案：油猴脚本注入目标页面，WebSocket 长连接本地 Server，HTTP API 供 CLI/Agent 调用。
> 状态：设计确认，待实现。

---

## 1. 动机

### CDP 方案的痛点

| 痛点 | 详情 |
|------|------|
| 浏览器绑定 | 仅 Chrome，且必须开启 `chrome://inspect/#remote-debugging` |
| 人工确认 | 首次连接弹"允许调试"对话框，打断自动化流程 |
| 连接脆弱 | 页面导航→paused、CDP attach 断开需重连、心跳超时 |
| 部署复杂 | daemon 生命周期管理（PID 锁、指数退避重连、超时退出） |
| 状态无持久化 | daemon 内存态，重启丢失 |

### Bridge 方案优势

- **零人工确认** — 油猴脚本随页面自动注入，无需任何点击
- **全浏览器支持** — Chrome/Firefox/Edge，只要有 Tampermonkey
- **自动重连** — 页面刷新/关闭重开，脚本自动注入+建连
- **Server 端状态** — 连接历史、操作日志、cookies 摘要可持久化
- **可扩展** — 新站点仅需一个 `.user.js` 文件

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                     CLI / Agent SDK                       │
│  $ bridge-cli douyin search "关键词"                       │
│  $ bridge-cli douyin get <aweme_id> --all                 │
│  $ bridge-cli bilibili get <bv_id>                        │
│  $ bridge-cli zhihu answers <q_id>                        │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP POST /api/call
                       ▼
┌──────────────────────────────────────────────────────────┐
│               Bridge Server (localhost:19422)              │
│                                                            │
│  ┌─────────────┐  ┌──────────────────────────────────┐    │
│  │  HTTP API   │  │       WebSocket Hub               │    │
│  │  POST /call │  │   connection pool + heartbeat      │    │
│  │  GET /status│  │   reconnection handling            │    │
│  │  GET /health│  │                                    │    │
│  └─────────────┘  └──────────────┬───────────────────┘    │
│                                   │                        │
│  ┌────────────────────────────────┴──────────────────┐    │
│  │         Connection Registry (内存 + 可持久化)       │    │
│  │  douyin.com    → [{id,ws,url,title,alive}, ...]    │    │
│  │  bilibili.com  → [{id,ws,url,title,alive}, ...]    │    │
│  │  zhihu.com     → [{id,ws,url,title,alive}]          │    │
│  │  github.com    → [{id,ws,url,title,alive}]          │    │
│  └───────────────────────────────────────────────────┘    │
└──────────────────────┬───────────────────────────────────┘
                       │ WebSocket (persistent, auto-reconnect)
         ┌─────────────┼─────────────┬──────────────┐
         ▼             ▼             ▼              ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌──────────┐
    │ Tamper-  │ │ Tamper-  │ │ Tamper-  │  │ Tamper-  │
    │ monkey   │ │ monkey   │ │ monkey   │  │ monkey   │
    │ douyin   │ │ douyin   │ │ bilibili │  │ zhihu    │
    │ Tab 1    │ │ Tab 2    │ │ Tab 1    │  │ Tab 1    │
    └──────────┘ └──────────┘ └──────────┘  └──────────┘
```

---

## 3. 项目结构

```
bridge-framework/
├── server.js              # Bridge Server 入口
├── cli.js                 # 通用 CLI 入口
├── scripts/               # 油猴脚本库
│   ├── douyin.user.js     # 抖音（内置 bridge API）
│   ├── bilibili.user.js   # B站
│   ├── zhihu.user.js      # 知乎
│   ├── github.user.js     # GitHub
│   └── _template.user.js  # 站点脚本模板（供 `bridge-cli init <site>` 使用）
├── lib/
│   ├── server/
│   │   ├── ws-hub.js      # WebSocket Server 初始化 + 连接池
│   │   ├── registry.js    # 连接注册表（site→connections 映射）
│   │   └── router.js      # HTTP API 路由（/call, /status, /health）
│   ├── client/
│   │   └── bridge-client.js  # HTTP 客户端封装（CLI / Agent SDK 共用）
│   └── shared/
│       ├── protocol.js    # 消息类型常量 + schema
│       └── serialize.js   # 安全 JSON 序列化（循环引用/DOM/函数处理）
├── config.json             # Server 配置（端口、超时、日志）
├── package.json
└── README.md
```

---

## 4. 通信协议

### 4.1 HTTP API（CLI → Server）

```
POST /api/call
Content-Type: application/json

Request:
{
  "site": "douyin.com",           // 必填：站点标识
  "expression": "window.__bridge.getComments('7629...', 0, 20)",
  "awaitPromise": true,           // 默认 true
  "connIndex": 0,                 // 可选：同站多连接时指定索引
  "timeout": 30000                // 可选：覆盖默认超时
}

Response (200):
{
  "ok": true,
  "value": { ... },               // eval 返回值（safeSerialize 后）
  "duration": 1234,               // 毫秒
  "connection": "conn-uuid-1"     // 实际使用的连接 ID
}

Response (503):
{
  "ok": false,
  "error": "No connection for site 'douyin.com'"
}
```

```
GET /api/status
→ 200:
{
  "ok": true,
  "connections": {
    "douyin.com": [
      {
        "id": "conn-uuid-1",
        "url": "https://www.douyin.com/video/7629735841874726179",
        "title": "抖音视频标题...",
        "connectedAt": "2026-07-11T10:00:00Z",
        "lastActivity": "2026-07-11T10:05:00Z",
        "alive": true
      }
    ],
    "bilibili.com": [ ... ]
  },
  "totalConnections": 5,
  "uptime": 3600
}
```

```
GET /api/health
→ 200: { "ok": true, "uptime": 3600, "version": "1.0.0" }
```

### 4.2 WebSocket 协议（脚本 ↔ Server）

所有消息为 JSON 文本帧。

```
Client → Server:

  hello（握手）:
  {
    "type": "hello",
    "site": "douyin.com",
    "url": "https://www.douyin.com/video/7629...",
    "title": "页面标题",
    "userAgent": "Mozilla/5.0 ..."
  }

  result（eval 结果）:
  {
    "type": "result",
    "id": "msg-uuid-1",
    "value": { ... },       // 成功时
    "error": "message"      // 失败时（二选一）
  }

  pong（心跳响应）:
  { "type": "pong" }


Server → Client:

  eval（执行指令）:
  {
    "type": "eval",
    "id": "msg-uuid-1",
    "expression": "window.__bridge.getComments(...)",
    "awaitPromise": true
  }

  ping（心跳探测）:
  { "type": "ping" }

  bye（主动断开）:
  { "type": "bye", "reason": "server_shutdown" }
```

### 4.3 心跳机制

- Server 每 30s 发送 `ping`
- 客户端 10s 内未回复 `pong` → 标记连接失效
- 客户端连续 3 次 ping 无响应 → 主动断开
- 客户端 WebSocket `onclose` → 2s 后自动重连

---

## 5. 油猴脚本设计

### 5.1 通用模板 (`scripts/_template.user.js`)

```javascript
// ==UserScript==
// @name         Bridge: {{SITE_NAME}}
// @namespace    bridge-framework
// @match        {{URL_PATTERN}}
// @grant        none
// ==/UserScript==

(function() {
  const CONFIG = {
    server: 'ws://127.0.0.1:19422/ws',
    site: '{{SITE_KEY}}',          // 路由 key
    reconnectDelay: 2000,
    pingTimeout: 10000,
  };

  let ws = null;
  let connected = false;
  let reconnectTimer = null;

  // ── 连接管理 ──
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(reconnectTimer);
    ws = new WebSocket(CONFIG.server);

    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({
        type: 'hello',
        site: CONFIG.site,
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'eval':  handleEval(msg); break;
          case 'ping':  ws.send(JSON.stringify({ type: 'pong' })); break;
          case 'bye':   gracefulClose(); break;
        }
      } catch (err) {
        // 忽略无法解析的消息
      }
    };

    ws.onclose = () => {
      connected = false;
      reconnectTimer = setTimeout(connect, CONFIG.reconnectDelay);
    };

    ws.onerror = () => {
      ws.close();  // 触发 onclose → 重连
    };
  }

  // ── Eval 处理 ──
  async function handleEval(msg) {
    try {
      // 使用 Function 构造器在页面全局作用域执行
      const fn = new Function(`return (${msg.expression})`);
      let result = fn.call(window);

      if (msg.awaitPromise !== false) {
        result = await Promise.resolve(result);
      }

      ws.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        value: safeSerialize(result),
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        error: err.message || String(err),
      }));
    }
  }

  // ── 安全序列化 ──
  // undefined 会被 JSON.stringify 丢弃，需转为 null；
  // 包装一层以保证 JSON.parse 始终拿到有效 JSON。
  function safeSerialize(value) {
    const seen = new WeakSet();
    const sanitized = value === undefined ? null : value;
    return JSON.parse(JSON.stringify(sanitized, (key, val) => {
      if (typeof val === 'function')  return '[Function]';
      if (val instanceof Node)       return `[${val.nodeName}]`;
      if (val instanceof Window)     return '[Window]';
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val))           return '[Circular]';
        seen.add(val);
      }
      return val;
    }));
  }

  // ── 优雅关闭 ──
  function gracefulClose() {
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null;  // 防止触发重连
      ws.close();
    }
    connected = false;
  }

  // ── 启动 ──
  connect();

  // ── 监听 URL 变化（SPA 导航），上报新 URL ──
  // 采用 history pushState/replaceState 拦截 + popstate 监听，
  // 避免 MutationObserver 全文档轮询的性能开销。
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (connected) {
        ws.send(JSON.stringify({
          type: 'hello',
          site: CONFIG.site,
          url: location.href,
          title: document.title,
          userAgent: navigator.userAgent,
        }));
      }
    }
  }
  const _pushState = history.pushState;
  const _replaceState = history.replaceState;
  history.pushState = function(...args) { _pushState.apply(this, args); checkUrlChange(); };
  history.replaceState = function(...args) { _replaceState.apply(this, args); checkUrlChange(); };
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════
  // 站点特定 Bridge API（在此区域添加）
  // ═══════════════════════════════════════════

  // window.__bridge = {
  //   // 在此定义站点 API 方法
  // };
})();
```

### 5.2 抖音脚本示例 (`scripts/douyin.user.js`)

在模板基础上，`{{SITE_NAME}}` = "Douyin"，`{{URL_PATTERN}}` = `*://*.douyin.com/*`，`{{SITE_KEY}}` = `douyin.com`，并添加 bridge API：

```javascript
// ═══════ 站点特定 Bridge API ═══════

window.__bridge = {
  _q() {
    return {
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      pc_client_type: '1', pc_libra_divert: 'Windows',
      update_version_code: '170400', version_code: '170400',
      version_name: '17.4.0', cookie_enabled: 'true',
      screen_width: String(screen.width), screen_height: String(screen.height),
      browser_language: 'zh-CN', browser_platform: 'Win32',
      browser_name: 'Chrome', browser_online: 'true',
      platform: 'PC', cpu_core_num: String(navigator.hardwareConcurrency || 8),
    };
  },

  async getComments(awemeId, cursor = 0, count = 20) {
    const p = new URLSearchParams(Object.assign(this._q(), {
      aweme_id: awemeId, cursor, count, item_type: '0',
      pc_img_format: 'webp', cut_version: '1',
    }));
    const r = await fetch('/aweme/v1/web/comment/list/?' + p, { credentials: 'include' });
    return r.json();
  },

  async replies(cid, awemeId, cursor = 0, count = 10) {
    const p = new URLSearchParams(Object.assign(this._q(), {
      aweme_id: awemeId, comment_id: cid, cursor, count,
      item_type: '0', pc_img_format: 'webp', cut_version: '1',
    }));
    const r = await fetch('/aweme/v1/web/comment/list/reply/?' + p, { credentials: 'include' });
    return r.json();
  },

  async myPosts(cursor = 0, count = 18) {
    const info = await (await fetch('/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web', { credentials: 'include' })).json();
    const secUid = (info.user || {}).sec_uid || '';
    const p = new URLSearchParams(Object.assign(this._q(), {
      sec_user_id: secUid, max_cursor: cursor, count,
      locate_query: 'false', show_live_replay_strategy: '1',
      need_time_list: '1', time_list_query: '0', whale_cut_token: '',
      cut_version: '1', publish_video_strategy_type: '2', from_user_page: '0',
    }));
    const r = await fetch('/aweme/v1/web/aweme/post/?' + p, { credentials: 'include' });
    return r.json();
  },

  async search(keyword, offset = 0, count = 10) {
    const p = new URLSearchParams(Object.assign(this._q(), {
      keyword, offset, count, search_channel: 'aweme_general',
      search_source: 'normal_search', query_correct_type: '1',
      is_filter_search: '0', need_filter_settings: '0', list_type: 'single',
    }));
    const r = await fetch('/aweme/v1/web/general/search/single/?' + p, { credentials: 'include' });
    return r.json();
  },

  async publish(awemeId, text, replyId, replyToReplyId, mentions) {
    const extras = mentions ? JSON.stringify(mentions) : '[]';
    const body = new URLSearchParams({
      aweme_id: awemeId, text, item_type: '0', app_name: 'aweme',
      enter_from: 'others_homepage', previous_page: 'others_homepage',
      comment_send_celltime: '3000', comment_video_celltime: '2000',
      one_level_comment_rank: '-1', paste_edit_method: 'non_paste',
      text_extra: extras,
    });
    if (replyId) { body.set('reply_id', replyId); body.set('comment_id', replyId); }
    if (replyToReplyId) body.set('reply_to_reply_id', replyToReplyId);
    const q = new URLSearchParams(Object.assign(this._q(), {
      app_name: 'aweme', enter_from: 'others_homepage',
      previous_page: 'others_homepage', aweme_id: awemeId, item_type: '0',
    }));
    const r = await fetch('/aweme/v1/web/comment/publish/?' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'include',
    });
    return r.json();
  },
};
```

---

## 6. Server 设计

### 6.1 WebSocket Hub (`lib/server/ws-hub.js`)

```
职责：
- 创建 WebSocket.Server，监听 127.0.0.1:19422
- 处理新连接：验证 hello 消息，注册到 Registry
- 处理断开：从 Registry 移除
- 心跳：每 30s ping，连续 3 次无响应断开
- 消息路由：收到 result → 匹配 pending 请求的 Promise
```

### 6.2 连接注册表 (`lib/server/registry.js`)

```javascript
class ConnectionRegistry {
  // site → connections[]
  // connections[]: { id, ws, site, url, title, userAgent, connectedAt, lastActivity }

  register(site, conn)      // 添加连接
  unregister(connId)         // 移除连接
  get(site, index = 0)       // 获取连接（默认第一个 alive）
  getAll(site)               // 获取某站所有连接
  list()                     // 返回完整 status 数据
  broadcast(site, msg)       // 向某站所有连接广播
}
```

### 6.3 HTTP Router (`lib/server/router.js`)

```
POST /api/call:
  1. 解析 body → { site, expression, awaitPromise, connIndex, timeout }
  2. registry.get(site, connIndex) → 获取连接
  3. 若无连接 → 503 { ok: false, error: "No connection for site '...'" }
  4. 生成 msgId（uuid）
  5. ws.send({ type: "eval", id: msgId, expression, awaitPromise })
  6. 注册 pending Promise（带 timeout）
  7. 收到 result → resolve + 返回给 HTTP 客户端
  8. 超时 → 503 { ok: false, error: "Request timeout" }

GET /api/status:
  → registry.list()

GET /api/health:
  → { ok: true, uptime, version }
```

### 6.4 配置 (`config.json`)

```json
{
  "host": "127.0.0.1",
  "port": 19422,
  "heartbeatInterval": 30000,
  "heartbeatTimeout": 10000,
  "heartbeatMaxFailures": 3,
  "requestTimeout": 30000,
  "logLevel": "info"
}
```

---

## 7. CLI 设计

### 7.1 通用命令

```bash
# Server 管理
bridge-server                           # 前台启动 Server
bridge-server --daemon                   # 后台启动

# 查看状态
bridge-cli status                        # 所有站点连接状态
bridge-cli status --site douyin.com      # 单个站点详情

# 初始化新站点脚本
bridge-cli init <site>                   # 从 template 生成 .user.js
bridge-cli init bilibili                 # → scripts/bilibili.user.js

# 通用 eval
bridge-cli exec <site> "<expression>"
bridge-cli exec douyin "document.title"
bridge-cli exec douyin "window.__bridge.search('关键词', 0, 10)"

# 站点别名命令（CLI 内部映射到 expression）
bridge-cli douyin search "关键词"
bridge-cli douyin get <aweme_id> [--all] [--depth 1] [--pages 5]
bridge-cli douyin post <aweme_id> "评论内容" [--reply-to <cid>]
bridge-cli douyin my [--count 30]
bridge-cli douyin replies <cid> <aweme_id>
bridge-cli bilibili get <bv_id>
bridge-cli zhihu answers <question_id>
```

### 7.2 CLI 站点命令映射

CLI 内部维护一个站点命令注册表：

```javascript
const SITE_COMMANDS = {
  'douyin': {
    search:    (kw, opts) => `window.__bridge.search('${kw}', ${opts.offset||0}, ${opts.count||10})`,
    get:       (id, opts) => `window.__bridge.getComments('${id}', 0, ${opts.count||20})`,
    post:      (id, text, opts) => `window.__bridge.publish('${id}', '${text}', ${opts.replyTo||null})`,
    my:        (opts) => `window.__bridge.myPosts(0, ${opts.count||18})`,
    replies:   (cid, awemeId) => `window.__bridge.replies('${cid}', '${awemeId}')`,
  },
  'bilibili': {
    // ...
  },
};
```

---

## 8. 与现有 douyin skill 的迁移路径

### 8.1 当前（CDP 方案）

```
node cli.js daemon                    # 启动 CDP daemon
node cli.js get <id>                  # HTTP → daemon → CDP → Chrome tab
node cli.js search "关键词"
node cli.js post <id> "内容"
node cli.js stop
```

### 8.2 迁移后（Bridge 方案）

```
bridge-server                         # 启动 Bridge Server（一次）
bridge-cli douyin get <id>            # HTTP → Server → WebSocket → 油猴脚本
bridge-cli douyin search "关键词"
bridge-cli douyin post <id> "内容"
```

### 8.3 迁移范围

| 模块 | 操作 |
|------|------|
| `lib/cdp.js` | **删除** — 不再需要 CDP WebSocket 客户端 |
| `lib/daemon.js` | **删除** — 连接管理移到 Server 端 |
| `cli.js` | **重写** — 改为 `bridge-cli` 通用 CLI |
| `lib/llm.js` | **保留** — LLM 分析逻辑不变 |
| `lib/commands/` | **保留** — 命令逻辑迁移到 CLI 命令映射 |
| `reply-strategy.md` | **保留** — 回复策略不变 |
| 审计日志 | **迁移** — 日志格式保持兼容 |
| `scripts/douyin.user.js` | **新增** — 油猴脚本 |

---

## 9. 安全考量

| 风险 | 缓解措施 |
|------|----------|
| eval 执行任意 JS | Server 仅监听 `127.0.0.1`，不暴露到网络 |
| WebSocket 无认证 | 同上，localhost-only；未来可加 token |
| 脚本被恶意页面利用 | 脚本仅连接 localhost，不暴露控制接口给页面 |
| `__bridge` 函数覆盖 | 脚本使用 `Object.defineProperty` 锁定关键方法 |
| 序列化泄露敏感数据 | `safeSerialize` 过滤 DOM/函数，未来可加字段白名单 |

---

## 10. 未来扩展

- **SQLite 持久化** — 连接历史、操作日志入库
- **多用户支持** — token 认证 + 多命名空间
- **脚本自动更新** — Server 提供 `/scripts/douyin.user.js` 下载端点，油猴自动检查更新
- **录制回放** — 记录操作序列，支持回放
- **条件触发** — Server 端监听页面事件（URL 变化、DOM 变化），自动触发操作
- **Dashboard** — Web UI 查看所有连接和操作历史

---

## 11. 实施计划

### Phase 1: 核心框架（最小可用）

1. Server 骨架 — WebSocket + HTTP 双协议，连接注册表
2. 油猴通用模板 — 建连 + eval + 重连 + 心跳
3. CLI 骨架 — `bridge-cli status` + `bridge-cli exec`
4. 抖音脚本 — 完整 `__bridge` API

### Phase 2: 功能完善

5. CLI 站点命令映射（`bridge-cli douyin get/search/post/my`）
6. 审计日志迁移
7. Server daemon 化（后台运行 + PID 锁）

### Phase 3: 扩展

8. 更多站点脚本（B站、知乎、GitHub）
9. SQLite 持久化
10. Dashboard Web UI

---

*创建于 2026-07-11 | 状态：设计确认*
