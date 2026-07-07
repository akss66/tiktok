# Douyin Desktop Docker Design

## Status
Draft for user review

## Date
2026-07-07

## Context
The current project is a Node.js CLI for Douyin operations. It runs as three separate pieces:

- `cli.js` for command execution.
- `server.js` as the local Bridge Server.
- `scripts/douyin.user.js` installed in a logged-in browser page.

The target product is a desktop application that can be shared with coworkers. Each coworker should run an independent local copy on their own Windows machine, with separate accounts, browser sessions, storage, and task history. The first version should resemble a matrix-operation management console: accounts, tasks, logs, settings, and dashboards.

The selected direction is:

**Electron desktop app + Docker backend + embedded Chromium browser tabs + local independent data per coworker.**

## Goals

- Provide a Windows desktop application that coworkers can install and use without touching the CLI.
- Keep each coworker's data local to their machine.
- Embed account browser tabs inside the desktop app.
- Store each account's login state in an isolated browser profile.
- Run backend services in Docker for consistent runtime behavior.
- Reuse the existing Bridge Server and command modules where practical.
- Replace manual Tampermonkey setup with application-managed script injection.
- Provide a first useful console: account management, task management, logs, configuration, and basic dashboards.

## Non-Goals

- No centralized team server in the first version.
- No shared team database in the first version.
- No drag-and-drop workflow editor in the first version.
- No platform detection bypass, stealth fingerprint spoofing, canvas/WebGL/audio spoofing, or anti-detection evasion.
- No automatic account registration.

The embedded browser may support ordinary configuration such as isolated profiles, proxy settings, user-agent selection, viewport size, and persistent sessions. These are treated as browser/session management features, not fingerprint evasion features.

## Users

### Operator
Runs the desktop application on their own computer. Creates accounts, logs into Douyin inside embedded browser tabs, starts tasks, and reviews logs.

### Maintainer
Builds and distributes the installer and Docker image. Troubleshoots local runs through app logs and container logs.

## Recommended Architecture

```text
Windows workstation
+-- Electron desktop app
|   +-- React management UI
|   +-- Account browser tabs
|   +-- Electron main process
|   |   +-- Docker lifecycle controller
|   |   +-- Browser profile manager
|   |   +-- IPC/API bridge
|   +-- Local app data
|       +-- browser-profiles/
|       +-- app-settings.json
|       +-- logs/
+-- Docker backend
    +-- Node API service
    +-- Bridge Server
    +-- Task runner
    +-- SQLite database
    +-- mounted data volume
```

## Component Boundaries

### Electron Main Process

Responsibilities:

- Start, stop, and health-check the Docker backend.
- Manage embedded browser tabs and per-account browser partitions/profiles.
- Inject the Douyin bridge script into the account browser page.
- Expose safe IPC methods to the React renderer.
- Store local app settings outside the repo in the user's app data directory.

It should not contain business logic for Douyin tasks. Task logic belongs in the backend so it can be tested and evolved independently.

### React Renderer

Responsibilities:

- Account list and account detail pages.
- Task creation, task list, and task detail pages.
- Log viewer.
- Settings UI.
- Dashboard pages.
- Embedded browser tab shell and navigation controls.

The UI should behave like an operations console, not a marketing website. It should prioritize dense, scannable tables, clear statuses, and predictable actions.

### Docker Backend

Responsibilities:

- Provide local HTTP APIs for the desktop app.
- Run the existing Bridge Server.
- Run task execution and scheduling.
- Persist operational data in SQLite.
- Expose health/status endpoints.

The backend should not own the embedded browser process. Browser UI remains in Electron for better local desktop experience.

### Embedded Browser

Responsibilities:

- Let the operator log into Douyin inside the app.
- Maintain one isolated browser profile per account.
- Host the injected bridge script for account-bound operations.
- Surface connection status back to the app.

Each account should map to a stable browser storage partition/profile. Closing the app must not delete login state.

## Data Model Draft

### Account

- `id`
- `name`
- `group`
- `profileKey`
- `proxyConfig`
- `status`
- `lastSeenAt`
- `notes`
- `createdAt`
- `updatedAt`

### Task

- `id`
- `accountId`
- `type`
- `status`
- `input`
- `resultSummary`
- `startedAt`
- `finishedAt`
- `createdAt`
- `updatedAt`
- `error`

Initial task types:

- Search videos by keyword.
- Fetch comments for a video.
- Generate reply suggestions.
- Post approved replies.
- Download video/audio.
- Refresh account status.

### Event Log

- `id`
- `accountId`
- `taskId`
- `level`
- `message`
- `metadata`
- `createdAt`

## Data Flow

### Login

1. Operator creates an account in the desktop UI.
2. Electron allocates a browser profile for the account.
3. Operator opens the embedded browser tab.
4. Browser navigates to Douyin.
5. Operator logs in manually.
6. Electron injects the bridge script after the page is ready.
7. Backend health/status shows the account bridge connection as online.

### Task Execution

1. Operator creates a task in the UI.
2. React sends the task request to the local backend API.
3. Backend stores the task in SQLite.
4. Task runner executes the task.
5. Task runner calls Bridge Server.
6. Bridge Server communicates with the injected browser bridge for that account.
7. Results and logs are persisted.
8. UI updates task status and result summary.

## Docker Strategy

First version should use Docker Compose with one backend service:

- Node runtime pinned to a version compatible with `better-sqlite3`.
- App source or built backend copied into the image.
- Data volume mounted for SQLite, downloads, and logs.
- Health endpoint exposed on localhost only.

The desktop app should check for Docker availability on startup. If Docker is missing or not running, the app should show a clear setup screen instead of failing silently.

## Distribution Strategy

First version distribution:

- Windows installer for the Electron app.
- Docker image built from this repository.
- Docker Compose file bundled or generated by the app.

Each coworker installs the desktop app locally. Their data remains on their machine.

## Error Handling

- Docker missing: show setup state with Docker installation guidance.
- Docker backend unhealthy: show backend status and recent container logs.
- Account browser offline: show account disconnected status and a reconnect action.
- Douyin login expired: mark account as login required.
- Bridge token mismatch: rotate/sync token through backend and reinject bridge script.
- Task failure: persist error message and structured failure reason.
- Port conflict: choose a free local port or show a resolvable conflict message.

## Testing Strategy

- Unit tests for backend task creation, status transitions, and account persistence.
- Integration tests for backend health and Bridge Server API.
- Electron smoke test for app launch and settings loading.
- Browser profile test proving two accounts use separate storage partitions.
- Manual test for Douyin login because it depends on external site behavior.

## First Milestone

The first implementation milestone should deliver:

- Electron app shell with React UI.
- Docker backend health check.
- Account CRUD.
- Embedded browser tab per account.
- Per-account browser profile persistence.
- Bridge script injection from the app.
- Task list with one working task type, preferably `my` or `search`.
- Log viewer.
- Windows development run instructions.

## Open Decisions

- Whether browser profiles should use Electron `partition` names or explicit `userData`-scoped directories.
- Whether the backend API should be a new service or an extension of the existing `server.js`.
- Whether Docker image distribution should be local build first or registry pull first.
- Which UI framework to use for tables/forms, if any.

## Decision Summary

Use Electron for the desktop app because it provides Chromium embedding and Windows packaging in one stack. Use Docker only for backend services because putting the interactive browser inside Docker would require noVNC and would degrade the operator experience. Keep each coworker fully local in the first version to avoid central account/data governance before the product workflow is stable.
