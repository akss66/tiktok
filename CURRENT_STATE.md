# Vulcan 抖音控制台当前状态

日期：2026-07-14

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
4. Windows NSIS 安装包已生成，但真实安装、快捷方式启动和双账号抖音私信链路仍需人工验收。
5. 上游 `origin/main` 后续可能继续更新，当前本地桌面改造和上游需要谨慎合并。

## 下一步建议

优先做低风险整理：

1. 先拆分 `browser-tabs.js`，把纯配置、登录检测、用户脚本编译逻辑拆出去。
2. 每拆一步都跑 `node --check`、关键 Vitest、桌面构建。
3. 拆完后再继续做 UI 美化、安装包和团队分发。
4. 不要在 Bridge 稳定前继续叠加大功能，否则很难定位问题。

## 0.1.2 发布候选改动

- 搜索、高级任务共用同一套精简分页采集逻辑，单次最多支持 500 条。
- “我的作品”和评论同步在页面内压缩抖音返回对象，避免大对象穿过 Bridge 导致请求体超限。
- 作品与评论同步增加分页摘要、去重和无进展停止条件，界面支持作品与评论分页浏览。
- 批量任务保持单并发，支持暂停、继续、取消、仅重试失败项和网络错误指数退避。
- 应用重启后，中断的批量任务恢复为“已暂停”，已完成子任务不会重复执行。
- Bridge 注入改为防抖恢复，页面刷新、跳转和浏览器隐藏后会自动重新建立任务连接。
- 搜索结果每页显示 50 条，跨页选择状态保留，500 条结果不会一次性渲染。
- 全局页面层级、反馈状态、按钮、表格、分页及停靠浏览器布局完成统一优化。
- AI 评论回复闭环本轮未改动，不作为 0.1.2 验收范围。

## 0.1.3 停靠浏览器改进

- 内置浏览器新增紧凑、均衡、宽屏三档停靠宽度。
- Electron BrowserView 与左侧 React 系统使用同一份实际宽度，避免覆盖系统内容。
- 浏览器在较窄停靠宽度下自动缩放页面，保证抖音主要操作区域可见。
- Windows 安装器设置为始终创建桌面快捷方式。

## 评论管理闭环（开发中）

- “评论回复”升级为“评论管理”，仅管理当前账号自己发布作品的评论区。
- 评论同步保存一级评论与二级回复上下文，单个作品最多同步 5000 条并分页展示。
- LLM 按最多 10 条一批串行理解评论，保存高/中/低/忽略等全部分析结果。
- 高、中意向评论基于启用的本地知识库生成草稿，必须人工审核后才能进入发布队列。
- 评论清理支持同时按用户昵称和评论内容检索，并支持全选、反选、逐条选择和批量删除。
- 评论分析、回复、删除统一进入单并发队列；不同批量任务不能同时运行。
- 回复间隔 45–90 秒，删除间隔 20–40 秒；网络错误按 60/120/240 秒退避。
- 连续 3 项失败自动暂停，页面显示进度、当前步骤、成功/失败/跳过数量和下次执行倒计时。

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

## 0.1.3 Task 13 恢复与安装包状态

- 本地后端在监听健康端点前恢复中断的 DM 工作；Electron 在后端健康后只启动一个 DM worker，再恢复已启用账号的 monitor。
- 私信通知深链会等待 renderer `did-finish-load` 后发送，不再在页面尚未 ready 时丢失导航。
- `before-quit` 首次阻止退出并等待 monitor、worker、全部 BrowserView/后台资源和本地后端按序停止，再执行最终退出。
- 删除账号会等待监听停止、worker 静默、未执行 DM 工作取消、账号 view 销毁、partition 清理，最后才删除账号记录；失败会指出具体阶段。
- Vitest 正式配置排除 `.superpowers/**`，`npm.cmd test` 当前为 30 个文件、400 个测试全部通过。
- backend prepare 会校验 DM 模块、userscript、独立 Node、`better-sqlite3` native binary 和 `ws` 是否齐全。
- 最新安装包：`C:\Users\AKSSINA\Desktop\tiktok\desktop\installer-final-package\Vulcan抖音控制台-0.1.3-Setup.exe`。
- Electron monitor 的历史消息归一化已移入 `desktop/electron/dm-history.js`，新 `app.asar` 可直接解析，不再跨到 packaged 状态不存在的仓库根 `lib`。
- `main.js` 在本地模块加载前启用启动日志和未捕获异常记录，顶层加载失败会写入明确的 `startup module load failed`。
- 新增可重复 `npm run smoke:packaged`：隔离 userData/APPDATA，清除 `ELECTRON_RUN_AS_NODE`，等待 `packaged=true` 与 19522 health 后通过 `app.quit()` 完成可等待退出。
- 本轮新 `win-unpacked\Vulcan.exe` packaged smoke 已通过，退出码 0；退出后无残留 Vulcan 进程，19522/19422 均释放。
- 真实安装后桌面/开始菜单快捷方式实际创建与启动仍为人工验收项。
- 真实抖音双账号、Windows 通知点击、自动回复限额、刷新/断网恢复和删除后 Cookie/storage 隔离均未伪造通过，必须使用测试账号与可控网络人工验收。

## 1.1.1 发布状态

- 桌面应用、页脚和内置后端版本统一升级为 `1.1.1`。
- Windows NSIS 安装包继续创建桌面快捷方式和开始菜单快捷方式。
- 全量 Vitest `461/461`、Vite 生产构建和 packaged smoke 均已通过。
- 安装包：`desktop/installer-final-package/Vulcan抖音控制台-1.1.1-Setup.exe`，SHA-256：`E49997AA82D4A4BA7762ADFFA338F56B3020383C285095114402F27259279140`。
- 安装包尚未配置商业代码签名证书，Windows 可能显示“未知发布者”；真实抖音网络与账号行为仍由人工验收。
