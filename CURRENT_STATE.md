# Vulcan 抖音控制台当前状态

日期：2026-07-09

## 当前定位

这个仓库原本是 `douyin-cli`，核心能力是通过抖音页面里的 Bridge 调用搜索、点赞、评论、我的作品、评论区等接口。现在已经在它外面封装了 Electron 桌面应用，目标是做成普通同事也能使用的运营控制台。

当前桌面应用名称是 **Vulcan 抖音控制台**。

## 当前 Git 状态

- 当前检查点提交：`b140966 checkpoint: capture working desktop bridge state`
- 本地 `main` 已经包含桌面 MVP 改造。
- `origin/main` 仍然是原开源仓库方向，和本地桌面分支存在明显分叉；后续如果要合并上游，需要单独做冲突评估。

## 已经验证能工作的链路

当前已经验证过这一条链路可以跑通：

1. Electron 桌面应用启动。
2. 本地后端启动并提供 API。
3. Bridge Server 在线。
4. 账号浏览器打开抖音页面。
5. Electron 注入 `scripts/douyin.user.js` 中的 Bridge 代码。
6. 页面内出现 `window.__bridge`。
7. `GM_xmlhttpRequest` 通过 Electron 代理可用。
8. 直接调用 `window.__bridge.search("你好", 0, 2)` 能拿到抖音返回数据。
9. 通过本地后端 `POST /api/search-sessions` 创建搜索任务，能返回结构化结果。

最后一次手动验证结果：

- Bridge 在线连接：`1`
- 搜索关键字：`你好`
- 请求数量：`2`
- 返回数量：`2`
- 状态：成功

## 当前架构

```text
React UI
  -> Electron IPC
  -> 本地 Node 后端
  -> Bridge Server
  -> Electron BrowserView 中的抖音页面
  -> window.__bridge / GM_xmlhttpRequest
  -> 抖音网页接口
```

这套链路依赖“账号浏览器页面已经打开并完成 Bridge 注入”。如果页面没打开、网络连不上抖音、注入失败，任务会失败并提示 Bridge 未连接。

## 关键文件

- `desktop/electron/main.js`：Electron 主进程、IPC、后端启动、Bridge 调用入口。
- `desktop/electron/browser-tabs.js`：账号浏览器、会话隔离、Bridge 注入、右侧停靠浏览器。
- `desktop/electron/bridge-preload.js`：页面侧代理请求通道。
- `desktop/electron/profiles.js`：账号浏览器 profile/partition 逻辑。
- `scripts/douyin.user.js`：原用户脚本 Bridge 代码，现在被 Electron 编译注入。
- `lib/desktop/api-server.js`：桌面本地 API。
- `lib/desktop/task-runner.js`：任务执行队列。
- `lib/desktop/mvp-workflows.js`：搜索获客、批量任务、我的作品、评论回复相关流程。
- `desktop/renderer/src/App.jsx`：桌面 UI 主入口。
- `desktop/renderer/src/components/`：各页面组件。

## 已做的桌面功能

- 账号管理页。
- 每个账号独立浏览器 profile。
- 打开、隐藏、最小化、关闭账号浏览器。
- 删除账号时重置对应浏览器资料。
- 内置浏览器右侧停靠，不遮住左侧系统操作。
- 拦截 `bytedance:`、`douyin:` 等外部协议跳转，避免弹 Microsoft Store。
- 搜索获客页。
- 批量任务页。
- 我的作品页。
- 评论回复页。
- 知识库页。
- 设置页。
- LLM 配置保存。
- 本地知识库保存。
- 页面注入状态诊断。
- Bridge 连接数诊断。
- 搜索任务可通过真实抖音页面 Bridge 执行。

## 重要风险

1. `desktop/electron/browser-tabs.js` 目前过大，里面混合了浏览器窗口、会话、登录检测、Bridge 注入、代理请求、布局等逻辑，后续维护风险高。
2. 网络环境会影响抖音页面和接口返回。如果当前网络不能稳定访问抖音，桌面任务会失败。
3. 历史失败任务仍会显示在任务列表里，它们不代表当前代码仍然失败。
4. 当前仍未制作 Windows 安装包。
5. 上游 `origin/main` 后续可能继续更新，当前本地桌面改造和上游需要谨慎合并。

## 下一步建议

优先做低风险整理：

1. 先拆分 `browser-tabs.js`，把纯配置、登录检测、用户脚本编译逻辑拆出去。
2. 每拆一步都跑 `node --check`、关键 Vitest、桌面构建。
3. 拆完后再继续做 UI 美化、安装包和团队分发。
4. 不要在 Bridge 稳定前继续叠加大功能，否则很难定位问题。

## 常用验证命令

```powershell
npm.cmd test -- tests/desktop-api.test.js tests/desktop-mvp-workflows.test.js tests/browser-login-detection.test.js tests/desktop-task-runner.test.js tests/task-runner-bridge-status.test.js
```

```powershell
Set-Location desktop
npx.cmd vite build
```

```powershell
node --check desktop\electron\browser-tabs.js
node --check desktop\electron\main.js
```

