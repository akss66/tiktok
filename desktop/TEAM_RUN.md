# Team Run (MVP)

This is the minimum reproducible workflow for teammates (Windows).

## 1) Install deps

```powershell
npm install
cd desktop
npm install
```

## 2) Start Bridge Server

```powershell
cd ..
.\bridge-server.cmd
```

- `bridge-server.cmd` first tries `.\.tools\node-v22.23.1-win-x64\node.exe`
- If not found, it falls back to system `node.exe`
- Equivalent command: `node server.js`

## 3) Start desktop app

```powershell
cd .\desktop
npm run start
```

`npm run start` starts Vite on port `5174` and Electron.

> 如果你机器上设置过 `ELECTRON_RUN_AS_NODE=1`，可能会导致 `app.whenReady` 报错。
> 可执行 `set ELECTRON_RUN_AS_NODE=` 后再启动，或者直接用 `scripts\start-team-mvp.ps1`，它已自动清理该变量。

## 4) Use CLI (optional)

```powershell
cd ..
.\douyin.cmd my
.\douyin.cmd search "xxx"
.\douyin.cmd get <aweme_id> --pages 1 --count 5
```

- `douyin.cmd` is equivalent to `node cli.js ...` and uses the same node fallback logic.

## 5) Desktop smoke test

```powershell
cd .\desktop
npm run test:profiles
```

## 6) Optional one-command start (PowerShell, Windows)

```powershell
cd .\scripts
.\start-team-mvp.ps1 -StartDesktop
```

The script starts `bridge-server.cmd`, waits for `http://127.0.0.1:19522/api/health`, and then launches `npm run start` in `desktop/`.

## 6.5) Real browser loop check (recommended)

- Start desktop app and click **Open Browser** for the target account.
- Log in to Douyin in the embedded browser and keep the page open.
- In Settings page, confirm `真实抖音浏览器` is greater than 0.
- Run a task (`search`/`like`/`publish`/`delete-comment`/`suggest`) and verify task result returns from the embedded browser.
- If the embedded browser is not connected, task execution will fail with: `未检测到在线的抖音内置浏览器...` (expected).

## 6.6) Local mock poller (for quickly verifying automation without real browser)

```powershell
cd C:\Users\AKSSINA\Desktop\tiktok   # repo root
npm run desktop:poll-mock -- --max-runs 20 --verbose
```

This runs a lightweight bridge poll client that:
- registers a poll client to `site = douyin.com` by calling `/api/connect`
- answers queued `search` / `digg` / `publish` / `deleteComment` expressions
- sends results back to bridge via `/api/result`

Use this in parallel with the desktop app to verify the `任务` pages can execute end-to-end:

1. keep `npm run desktop:poll-mock ...` running
2. start backend with `DOUYIN_ALLOW_MOCK_POLL=1` if you want task-runner to accept mock connections
3. create tasks in desktop app and click `执行`
4. you should see status and result fields return immediately

## 7) Notes

- CORS/API base port is `http://127.0.0.1:5174` (desktop API and Vite are aligned).
- In `scripts/douyin.user.js`, `CONFIG.token` is injected automatically from `config.json` at runtime, no manual edit needed.
- `AI 生成回复` depends on `config.json` (`llm.api_key` or `OPENAI_API_KEY`), otherwise suggest tasks will return an error.
- Mock poll clients are for local UI testing only. Real task execution requires an embedded Douyin browser connection.
