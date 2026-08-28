# Vulcan 抖音控制台

Vulcan 是一款面向 Windows 的抖音运营桌面产品。它把账号会话、内容搜索、线索整理、批量任务、评论处理、AI 草稿和本地知识库集中在一个可视化工作台中，并用人工确认控制真正影响账号的动作。

当前版本：**v1.1.1** · Windows x64 · Electron 桌面应用

## 下载安装

前往 [GitHub Releases](https://github.com/akss66/tiktok/releases/tag/v1.1.1) 下载：

```text
Vulcan.-1.1.1-Setup.exe
```

安装程序支持选择安装目录，并创建桌面与开始菜单快捷方式。当前安装包尚未配置 Windows 代码签名，因此系统可能显示“未知发布者”；请只从本仓库 Release 页面下载并核对版本号。

## 核心能力

- **多账号工作区**：为每个账号维护独立浏览器会话与本地配置，降低上下文串用风险。
- **内嵌浏览器**：在应用内完成登录、页面访问与状态确认，不要求用户在多个工具之间切换。
- **搜索与线索**：按关键词检索内容、整理潜在线索，并将结果送入后续任务。
- **批量任务中心**：统一查看任务进度，支持暂停、继续、取消、失败重试与诊断。
- **作品与评论**：同步本人作品和评论，进行筛选、分析、草稿生成与人工确认。
- **私信任务**：将私信相关工作纳入同一任务模型，保留过程状态与失败原因。
- **本地知识库**：沉淀产品、品牌和回复素材，为 AI 草稿提供可复用上下文。
- **本地优先存储**：账号、任务、评论与知识数据保存在本机 SQLite 中。

## 产品架构

```text
React 工作台
    ↓ Electron IPC
本地 Node.js 后端 / SQLite
    ↓ WebSocket
Bridge Server
    ↓
Electron BrowserView 账号会话
    ↓ 页面 Bridge
抖音网页接口
```

桌面安装包内置前端和本地后端。应用通过 Electron 管理账号窗口与 IPC，本地服务负责任务、数据和 Bridge 通信，页面 Bridge 只在已登录的账号会话中工作。

## 从源码运行

前置条件：Node.js 20+、npm，以及可用于登录抖音的 Windows 环境。

```powershell
# 根目录依赖与测试
npm.cmd ci
npm.cmd test

# 桌面端依赖与开发运行
Set-Location desktop
npm.cmd ci
npm.cmd run start
```

## 构建 Windows 安装包

```powershell
Set-Location desktop
npm.cmd run dist
npm.cmd run smoke:packaged
```

安装包输出到 `desktop/installer-final-package/`。构建流程会先编译 React 界面、准备随包后端，再由 electron-builder 生成 NSIS x64 安装程序。

## 质量验证

- 根目录使用 Vitest 覆盖任务、存储、Bridge 与业务逻辑。
- 桌面端构建验证 React/Vite 产物。
- `smoke:packaged` 对打包后的应用执行启动冒烟检查。
- GitHub Actions 在 `main` 分支和拉取请求上运行自动检查。

## 使用边界

Vulcan 是运营辅助工具，不承诺规避平台规则或风控。请使用有授权的账号与内容，遵守抖音服务条款、隐私规则和合理频率限制。涉及发布、回复或私信等外部动作时，应在界面中核对目标与内容并保留人工确认。

## License

[MIT](LICENSE)
