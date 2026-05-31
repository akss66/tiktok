# REASONIX.md — douyin-comment-cli

## Stack
- **Node.js** — vanilla, no framework; single-file application
- **`ws`** (^8.16.0) — WebSocket client for Chrome DevTools Protocol
- **Chrome DevTools Protocol** — browser automation via `--remote-debugging-port`
- **Target platform**: 抖音 (Douyin) web, Windows (paths reference `C:\Program Files\Google\Chrome\`)

## Layout
- `cli.js` — entry point: daemon lifecycle, bridge injection, command routing
- `lib/daemon.js` — daemon robustness: PID JSON lock, ReconnectManager, PageMonitor, HeartbeatMonitor
- `lib/cdp.js` — CDP WebSocket client wrapper
- `lib/llm.js` — OpenAI-compatible LLM client for comment analysis & reply suggestion
- `lib/commands/` — command modules (future split-out)
- `templates/dashboard.html` — self-contained HTML dashboard template (Chart.js CDN)
- `config.json` — LLM + daemon configuration (optional, has defaults)
- `package.json` — manifest; use `node cli.js` directly, not npm scripts
- `SKILL.md` — agent-facing playbook
- `reply-strategy.md` — strategy template for automated comment reply decisions
- `.douyin_daemon.pid` — runtime PID JSON lock; present only when daemon is alive

## Commands
All commands use `node cli.js` — do NOT use `npm run get/post/reply` (see Watch out for).

| Command | Purpose |
|---------|---------|
| `node cli.js daemon` | Start background daemon (CDP → Chrome) |
| `node cli.js ping` | Daemon health check (expect `pong`) |
| `node cli.js stop` | Graceful daemon shutdown |
| `node cli.js my [--cursor N] [--count N]` | List own videos |
| `node cli.js search <kw> [--offset N] [--count N]` | Search videos |
| `node cli.js get <id> [--pages N\|--all] [--depth N] [--raw]` | Fetch comments |
| `node cli.js replies <cid> <aweme_id>` | Fetch replies to one comment |
| `node cli.js post <id> "<text>" [--reply-to <cid>]` | Publish comment |
| `node cli.js analyze <id>` | LLM analyze comments (sentiment/category/priority) |
| `node cli.js suggest <id> [--auto]` | LLM reply suggestions |
| `node cli.js dashboard [--video <id>]` | Generate HTML dashboard |

## Conventions
- **Single-file architecture** — no `src/`, no modules; all logic lives in `cli.js`
- **Daemon/client split**: daemon holds a persistent CDP WebSocket and exposes an HTTP server (`POST /eval`); CLI commands send `Runtime.evaluate` expressions over HTTP to the daemon
- **Bridge injection**: `window.__dy.*` API functions are defined in a block comment, extracted at runtime via regex, and injected into the page with `Runtime.evaluate`
- **Output format**: clean JSON by default (normalized field subset); pass `--raw` for full API response
- **Arg style**: positional commands + `--flag value` (not `--flag=value`)
- **Daemon port**: hardcoded `19422` on `127.0.0.1`
- **PID file**: `.douyin_daemon.pid` prevents duplicate daemons; deleted on shutdown

## Watch out for
- **Stale npm scripts**: `package.json` scripts reference `douyin_cli.js`, but the file was renamed to `cli.js`. Use `node cli.js <cmd>` directly — `npm run get` will fail.
- **Chrome prerequisites**: browser must be open to `douyin.com` (logged in) with `--remote-debugging-port=9222`. First daemon connection triggers a Chrome "Allow debugging" dialog — user must click once.
- **Daemon auto-expiry**: exits after 20 min of inactivity. Always run `node cli.js stop` when done.
- **Anti-spam**: comment publish returning `status_code=8` means blocked — change content (longer/more natural) and retry.
- **Stale bridge after navigation**: if the user navigates away in Chrome, `window.__dy` is lost. Restart the daemon (`stop` → `daemon`) to re-inject.
