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
