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

## 验证

运行后端、桌面壳和账号浏览器 Profile 的基础检查：

```powershell
# 仓库根目录
.\.tools\node-v22.23.1-win-x64\npm.cmd test -- tests/desktop-db.test.js tests/desktop-api.test.js tests/desktop-task-runner.test.js

# desktop 目录
npm run test:profiles
```

`test:profiles` 会用 Electron 按同一个本地数据目录启动两次，验证账号 A 的浏览器分区能持久化 cookie，账号 B 的浏览器分区读不到账号 A 的 cookie。

## 使用流程

1. 在账号页创建账号。
2. 点击“打开浏览器”。
3. 在内置浏览器里登录抖音。
4. 在任务页创建 `search` 任务。
5. 点击“运行”并在日志页查看结果。

设置页里的“浏览器连接数”大于 0 时，说明至少有一个内置账号浏览器已经连上 Bridge Server；运行 `search` 任务前应先确认这里不是 0。

## 注意

- 第一版每个同事本机独立运行，数据不会自动同步。
- 浏览器 Profile 用于账号隔离和登录态持久化。
- 不提供指纹伪装或平台检测绕过能力。
