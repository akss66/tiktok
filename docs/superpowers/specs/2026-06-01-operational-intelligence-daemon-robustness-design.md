# 抖音评论 CLI — 运营智能层 & Daemon 健壮性 设计文档

> **日期**: 2026-06-01
> **状态**: Draft
> **范围**: 两大能力方向 — 运营智能（LLM 驱动）+ Daemon 健壮性（自愈）

---

## 1. 背景与动机

当前 `douyin-comment-cli` 是一个"能操作但不能思考"的工具：

- **运营智能缺失**：评论拉回来后全靠人工判断，策略文件是静态模板，没有数据闭环
- **Daemon 脆弱**：CDP 连接断了就死，用户切个页面就丢 bridge，PID 文件残留导致启动失败

本次设计为工具补齐"大脑"（智能分析决策）和"韧性"（自愈恢复）。

---

## 2. 设计目标

| # | 目标 | 衡量标准 |
|---|------|---------|
| G1 | 评论分析从人工判断变为 LLM 驱动 | `analyze` 命令输出情感/分类/优先级 |
| G2 | 回复决策从静态模板变为数据驱动 | `suggest` 命令基于分析结果生成回复建议 |
| G3 | 运营数据可视化 | `dashboard` 命令生成本地 HTML 仪表盘 |
| G4 | Daemon 断线后自动恢复 | 指数退避重连，最多 5 次，恢复后无缝继续 |
| G5 | 页面导航实时感知 | CDP 事件驱动，页面离开自动暂停，回来自动恢复 |
| G6 | PID 管理健壮 | 启动时检测僵尸 PID 并清理 |

---

## 3. 运营智能层

### 3.1 LLM 分析引擎

#### 架构

```
评论数据（get 命令输出）
        │
        ▼
  llm.js 封装层
  ├── 批量分组（每批 20-30 条）
  ├── 构建 prompt（注入策略风格）
  ├── 调用 LLM API
  ├── 解析结构化 JSON 响应
  └── 结果缓存（按 cid 去重）
        │
        ▼
  logs/analysis/<aweme_id>-<ts>.json
```

#### LLM 调用封装 (`lib/llm.js`)

```javascript
// 核心接口
class LLMClient {
  constructor(config) {
    this.apiKey = config.apiKey;       // 环境变量或配置文件
    this.baseUrl = config.baseUrl;     // 支持自定义 endpoint
    this.model = config.model;         // 默认模型
    this.maxRetries = 3;
  }

  // 批量分析评论
  async analyzeComments(comments, strategy) { ... }

  // 生成回复建议
  async suggestReplies(comments, strategy, userProfile) { ... }
}
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| API 协议 | OpenAI-compatible | 兼容大多数 LLM 服务商（OpenAI/DeepSeek/通义等） |
| 批量策略 | 每批 20-30 条 | 平衡 token 消耗与调用次数 |
| 缓存粒度 | 按 `cid` 缓存 | 增量分析时不重复调用 |
| 超时处理 | 60 秒超时 + 3 次重试 | LLM 响应不稳定，需要容错 |

#### Prompt 模板

**评论分析 Prompt**：
```
你是抖音评论分析师。根据以下策略风格和评论列表，返回 JSON 数组。

策略风格：
{reply-strategy.md 的"回复风格"和"跳过"部分}

对每条评论返回：
- cid: 评论ID（原样返回）
- sentiment: "positive" | "negative" | "neutral"
- category: "question" | "praise" | "complaint" | "suggestion" | "spam" | "other"
- priority: 1-5（5=必须回复，1=可忽略）
- summary: 一句话中文摘要
- suggested_reply: 建议回复内容（根据策略风格），不需要回复则为 null

评论列表：
{JSON.stringify(batch)}

严格返回 JSON 数组，不要其他文字。
```

**回复生成 Prompt**：
```
你是抖音账号运营助手。根据以下信息为评论生成回复。

策略风格：{strategy}
用户画像（如有）：{profile}
视频上下文：{video_desc}

需要回复的评论：
{comments}

为每条评论生成回复，返回 JSON 数组：
- cid: 评论ID
- reply: 回复内容（15-80字，符合策略风格）

严格返回 JSON 数组。
```

#### 缓存设计

```
logs/
├── analysis/
│   ├── <aweme_id>-<timestamp>.json    ← 单次分析结果
│   └── cache.json                      ← cid → 分析结果的索引
```

`cache.json` 结构：
```json
{
  "7646065507817734949": {
    "sentiment": "positive",
    "category": "praise",
    "priority": 3,
    "analyzed_at": "2026-06-01T10:00:00Z"
  }
}
```

### 3.2 用户画像系统

#### 数据结构 (`logs/profiles.json`)

```json
{
  "version": "1.0",
  "profiles": {
    "uid_123456": {
      "nickname": "用户A",
      "avatar": "https://...",
      "first_seen": "2026-05-31T21:00:00Z",
      "last_seen": "2026-06-01T10:30:00Z",
      "stats": {
        "total_comments": 8,
        "total_replies_received": 3,
        "avg_sentiment": 0.75,
        "most_active_video": "aweme_xxx"
      },
      "tags": ["active_fan", "questioner"],
      "interactions": [
        {
          "aweme_id": "7629735841874726179",
          "type": "comment",
          "sentiment": "positive",
          "category": "question",
          "time": "2026-06-01T10:00:00Z"
        },
        {
          "aweme_id": "7629735841874726179",
          "type": "replied_to",
          "time": "2026-06-01T10:05:00Z"
        }
      ]
    }
  }
}
```

#### 标签自动推断规则

| 标签 | 条件 |
|------|------|
| `active_fan` | 评论次数 ≥ 3 且 avg_sentiment > 0.5 |
| `questioner` | category 为 "question" 的比例 > 50% |
| `critic` | avg_sentiment < 0.3 |
| `high_value` | 评论长度均值 > 30 字 且 非 spam |
| `newcomer` | first_seen 在最近 7 天内 |

#### 画像更新时机

- 每次 `get` 拉取评论后，自动更新涉及用户的画像
- 每次 `analyze` 完成后，用情感/分类数据更新画像
- 每次 `post` 回复后，记录回复关系

### 3.3 本地 HTML 仪表盘

#### 技术方案

- **模板引擎**：纯字符串模板（无需额外依赖）
- **图表库**：Chart.js（CDN 引入）
- **词云**：wordcloud2.js（CDN 引入）
- **输出**：单个自包含 HTML 文件，嵌入所有数据

#### 仪表盘布局

```
┌──────────────────────────────────────────────────┐
│  抖音评论运营仪表盘                    2026-06-01  │
├──────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────┐  ┌──────────────┐               │
│  │ 评论总数: 342 │  │ 待回复: 12   │               │
│  │ 今日新增: 28  │  │ 已回复: 156  │               │
│  └──────────────┘  └──────────────┘               │
│                                                    │
│  ┌──────────────────┐  ┌──────────────────┐       │
│  │ 情感分布饼图      │  │ 评论趋势折线图    │       │
│  │ 正面 65%         │  │ (过去7天)         │       │
│  │ 中性 25%         │  │                   │       │
│  │ 负面 10%         │  │                   │       │
│  └──────────────────┘  └──────────────────┘       │
│                                                    │
│  ┌──────────────────┐  ┌──────────────────┐       │
│  │ 热门关键词词云    │  │ 活跃用户 Top 10   │       │
│  │                  │  │ 1. 用户A (8条)    │       │
│  │                  │  │ 2. 用户B (5条)    │       │
│  └──────────────────┘  └──────────────────┘       │
│                                                    │
│  ┌──────────────────────────────────────────┐     │
│  │ 🔴 高优先级待回复评论                      │     │
│  │ 1. [negative] "这个产品太难用了" - 用户C   │     │
│  │ 2. [question] "请问怎么设置？" - 用户D    │     │
│  └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

#### 数据聚合逻辑

```javascript
// dashboard.js 核心流程
function generateDashboard(options) {
  // 1. 读取数据源
  const audit = loadAudit();
  const analysis = loadAnalysis(options.videoId);
  const profiles = loadProfiles();

  // 2. 聚合统计
  const stats = {
    totalComments: ...,
    sentimentDistribution: ...,
    dailyTrend: ...,
    topKeywords: ...,
    topUsers: ...,
    highPriorityComments: ...
  };

  // 3. 渲染 HTML
  const html = renderTemplate(stats);

  // 4. 写入文件
  const outputPath = `logs/dashboard-${timestamp}.html`;
  fs.writeFileSync(outputPath, html);

  // 5. 自动打开浏览器
  exec(`start "" "${outputPath}"`);
}
```

---

## 4. Daemon 健壮性

### 4.1 状态机设计

```
                    ┌─────────────────────┐
                    │      STARTING       │
                    └──────────┬──────────┘
                               │ 连接成功 + bridge 注入
                               ▼
┌──────────────┐        ┌─────────────┐        ┌──────────────┐
│   PAUSED     │◄───────│   RUNNING   │───────►│  RECOVERING  │
│ (页面离开)    │        │  (正常工作)  │        │  (重连中)     │
└──────┬───────┘        └──────┬──────┘        └──────┬───────┘
       │                       │                       │
       │ 页面回来               │ 连接断开              │ 重连成功
       ▼                       ▼                       ▼
┌──────────────┐        ┌─────────────┐        ┌─────────────┐
│  RECOVERING  │        │  RECOVERING │        │   RUNNING   │
└──────────────┘        └─────────────┘        └─────────────┘
                               │
                               │ 重连失败（超过最大重试）
                               ▼
                        ┌─────────────┐
                        │    DEAD     │
                        │ (优雅退出)   │
                        └─────────────┘
```

### 4.2 指数退避重连

```javascript
class ReconnectManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.initialDelay = options.initialDelay || 1000;   // 1 秒
    this.maxDelay = options.maxDelay || 30000;           // 30 秒
    this.backoffFactor = options.backoffFactor || 2;
    this.retryCount = 0;
  }

  async attemptReconnect(connectFn) {
    while (this.retryCount < this.maxRetries) {
      const delay = Math.min(
        this.initialDelay * Math.pow(this.backoffFactor, this.retryCount),
        this.maxDelay
      );

      console.error(`[daemon] Reconnect attempt ${this.retryCount + 1}/${this.maxRetries} in ${delay}ms...`);
      await sleep(delay);

      try {
        const result = await connectFn();
        this.retryCount = 0;  // 成功，重置计数
        return result;
      } catch (e) {
        this.retryCount++;
        console.error(`[daemon] Reconnect failed: ${e.message}`);
      }
    }

    throw new Error(`Failed to reconnect after ${this.maxRetries} attempts`);
  }

  reset() {
    this.retryCount = 0;
  }
}
```

### 4.3 事件驱动页面感知

```javascript
class PageMonitor {
  constructor(cdpWs, sessionId) {
    this.ws = cdpWs;
    this.sessionId = sessionId;
    this.state = 'running';  // running | paused | recovering
    this.onStateChange = null;
  }

  async start() {
    // 启用页面事件监听
    await cdp(this.ws, 'Page.enable', {}, this.sessionId);

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      // 页面导航事件
      if (msg.method === 'Page.frameNavigated' && msg.params.frame) {
        this.handleNavigation(msg.params.frame.url);
      }

      // 目标销毁事件（页面关闭）
      if (msg.method === 'Target.targetDestroyed') {
        this.handleTargetDestroyed(msg.params.targetId);
      }
    });
  }

  handleNavigation(url) {
    if (!url.includes('douyin.com') && this.state === 'running') {
      this.state = 'paused';
      console.error('[daemon] Page navigated away from Douyin, pausing operations');
      if (this.onStateChange) this.onStateChange('paused', { url });
    } else if (url.includes('douyin.com') && this.state === 'paused') {
      this.state = 'recovering';
      console.error('[daemon] Returned to Douyin, recovering...');
      if (this.onStateChange) this.onStateChange('recovering', { url });
    }
  }

  async verifyBridge() {
    try {
      const res = await cdp(this.ws, 'Runtime.evaluate', {
        expression: 'typeof window.__dy === "object"',
        returnByValue: true
      }, this.sessionId);
      return res.result?.value === true;
    } catch {
      return false;
    }
  }
}
```

### 4.4 心跳检测

```javascript
class HeartbeatMonitor {
  constructor(cdpWs, sessionId, options = {}) {
    this.ws = cdpWs;
    this.sessionId = sessionId;
    this.interval = options.interval || 60000;        // 60 秒
    this.failureThreshold = options.failureThreshold || 3;
    this.consecutiveFailures = 0;
    this.timer = null;
    this.onConnectionLost = null;
  }

  start() {
    this.timer = setInterval(() => this.check(), this.interval);
  }

  async check() {
    try {
      await cdp(this.ws, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
        timeout: 10000
      }, this.sessionId);

      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      console.error(`[daemon] Heartbeat failed (${this.consecutiveFailures}/${this.failureThreshold}): ${e.message}`);

      if (this.consecutiveFailures >= this.failureThreshold) {
        console.error('[daemon] Connection lost, triggering reconnect');
        if (this.onConnectionLost) this.onConnectionLost();
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
```

### 4.5 健壮的 PID 管理

```javascript
const PID_FILE = path.join(__dirname, '.douyin_daemon.pid');

function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const content = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      const oldPid = content.pid;

      // 检查进程是否还活着
      process.kill(oldPid, 0);

      // 进程存在，检查是否是僵尸（启动超过 24 小时无活动）
      const age = Date.now() - (content.started || 0);
      if (age > 24 * 60 * 60 * 1000) {
        console.error(`[daemon] Stale daemon detected (PID ${oldPid}, age ${Math.round(age/3600000)}h), taking over`);
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
        // 等待旧进程退出
        setTimeout(() => {}, 1000);
      } else {
        console.log('Daemon already running.');
        process.exit(0);
      }
    } catch (e) {
      // PID 文件残留，进程已死 → 安全清理
      console.error('[daemon] Cleaning stale PID file');
    }
  }

  const lockData = { pid: process.pid, started: Date.now() };
  fs.writeFileSync(PID_FILE, JSON.stringify(lockData));
}

function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}
```

---

## 5. 新增命令规格

### 5.1 `analyze` — LLM 评论分析

```bash
node cli.js analyze <aweme_id> [--depth 1] [--model <model>] [--force]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `aweme_id` | 必填 | 视频 ID |
| `--depth 0` | 0 | 是否分析嵌套回复 |
| `--model` | 配置文件 | 指定 LLM 模型 |
| `--force` | false | 忽略缓存，重新分析 |

**输出**：
```json
{
  "aweme_id": "7629735841874726179",
  "analyzed": 200,
  "cached": 180,
  "fresh": 20,
  "sentiment": { "positive": 130, "neutral": 50, "negative": 20 },
  "categories": { "question": 30, "praise": 100, "complaint": 15, "other": 55 },
  "high_priority": [
    { "cid": "7646...", "text": "这个功能怎么用？", "priority": 5, "category": "question" }
  ]
}
```

### 5.2 `suggest` — 智能回复建议

```bash
node cli.js suggest <aweme_id> [--count 10] [--min-priority 3] [--auto]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `aweme_id` | 必填 | 视频 ID |
| `--count` | 10 | 建议回复数量上限 |
| `--min-priority` | 3 | 最低优先级（1-5） |
| `--auto` | false | 自动发布回复（跳过确认） |

**行为模式**：

- **默认模式**：只输出建议，用户手动用 `post` 命令发布
- **`--auto` 模式**：生成建议后自动发布，遵循策略限制（每视频最多 30 条、同一用户不重复）

**输出**（默认模式）：
```json
{
  "aweme_id": "7629735841874726179",
  "suggestions": [
    {
      "cid": "7646...",
      "text": "请问这个滤镜在哪里找？",
      "priority": 5,
      "suggested_reply": "在拍摄页面点右边的\"滤镜\"按钮就能找到啦～",
      "confidence": 0.9
    }
  ]
}
```

**输出**（`--auto` 模式）：
```json
{
  "aweme_id": "7629735841874726179",
  "published": 8,
  "skipped": 2,
  "failed": 0,
  "details": [
    { "cid": "7646...", "reply_cid": "7649...", "status": "published" },
    { "cid": "7647...", "status": "skipped", "reason": "already_replied" }
  ]
}
```

### 5.3 `dashboard` — 生成仪表盘

```bash
node cli.js dashboard [--video <aweme_id>] [--days 7] [--open]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--video` | 全部 | 只看指定视频 |
| `--days` | 7 | 时间范围 |
| `--open` | true | 生成后自动打开浏览器 |

**数据降级策略**：

| 数据源 | 可用时 | 不可用时 |
|--------|--------|---------|
| audit.json | 正常显示评论趋势 | 显示"暂无操作记录" |
| analysis/*.json | 显示情感分布、分类统计 | 情感/分类图表显示"请先运行 analyze" |
| profiles.json | 显示活跃用户排行 | 用户排行显示"暂无用户数据" |

仪表盘始终可生成，只是部分图表会优雅降级为占位提示。

**输出**：`logs/dashboard-<timestamp>.html`

### 5.4 `profile` — 用户画像

```bash
node cli.js profile <uid>
node cli.js profile --top 20
node cli.js profile --tag active_fan
```

---

## 6. 配置管理

新增 `config.json`（可选，有合理默认值）：

```json
{
  "llm": {
    "api_key": "",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096
  },
  "daemon": {
    "port": 19422,
    "heartbeat_interval": 60000,
    "max_reconnect_attempts": 5,
    "inactive_timeout": 1200000
  },
  "chrome": {
    "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "debugging_port": 9222
  }
}
```

配置优先级：命令行参数 > 环境变量 > config.json > 默认值

---

## 7. 文件结构变更

```
douyin/
├── cli.js                    ← 重构为入口，路由到 lib/ 模块
├── config.json               ← 新增：配置文件（可选）
├── lib/
│   ├── daemon.js             ← daemon 核心（状态机、重连、心跳）
│   ├── bridge.js             ← 桥接脚本（独立文件，不再用注释提取）
│   ├── cdp.js                ← CDP 工具函数
│   ├── commands/
│   │   ├── get.js            ← get 命令
│   │   ├── post.js           ← post 命令
│   │   ├── search.js         ← search 命令
│   │   ├── my.js             ← my 命令
│   │   ├── replies.js        ← replies 命令
│   │   ├── analyze.js        ← 新增：LLM 分析
│   │   ├── suggest.js        ← 新增：回复建议
│   │   ├── dashboard.js      ← 新增：仪表盘生成
│   │   └── profile.js        ← 新增：用户画像
│   ├── llm.js                ← 新增：LLM 调用封装
│   ├── audit.js              ← 审计日志逻辑
│   ├── profiles.js           ← 新增：用户画像管理
│   └── config.js             ← 新增：配置加载
├── templates/
│   └── dashboard.html        ← 新增：仪表盘 HTML 模板
├── reply-strategy.md
├── SKILL.md                  ← 更新：补充新命令文档
├── REASONIX.md               ← 更新：补充架构变更
└── package.json              ← 更新：修正 scripts + 新依赖
```

---

## 8. 依赖变更

```json
{
  "dependencies": {
    "ws": "^8.16.0"
  },
  "devDependencies": {}
}
```

> **注意**：LLM 调用使用原生 `fetch`（Node.js 18+ 内置），不引入额外依赖。
> Chart.js 和 wordcloud2.js 通过 CDN 在 HTML 中引入，不增加 npm 依赖。

---

## 9. 迁移策略

### 阶段一：Daemon 健壮性（不影响现有功能）

1. 重构 PID 管理逻辑
2. 添加指数退避重连
3. 添加页面感知事件监听
4. 添加心跳检测
5. 验证：手动断开/恢复 Chrome，观察 daemon 行为

### 阶段二：运营智能层（新增命令，不改现有命令）

1. 实现 `lib/llm.js` 封装
2. 实现 `analyze` 命令
3. 实现 `suggest` 命令
4. 实现用户画像系统
5. 实现仪表盘生成
6. 更新 `SKILL.md` 文档

### 阶段三：代码质量（可选，不阻塞功能）

1. 拆分 `cli.js` 到 `lib/` 模块
2. 修正 `package.json` scripts
3. 桥接脚本从注释提取改为独立文件

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| LLM API 不可用 | analyze/suggest 命令不可用 | 降级为规则引擎（关键词匹配） |
| LLM 返回格式不稳定 | 解析失败 | 重试 + 正则提取 JSON + 降级 |
| 重连时 Chrome 已关闭 | 所有操作暂停 | 状态机进入 PAUSED，等用户重启 Chrome |
| 仪表盘数据量大 | HTML 文件过大 | 限制时间范围，分页加载 |
| 抖音 API 变更 | 所有命令失效 | Bridge 脚本独立文件，便于快速更新 |
