const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';
const REPO_ROOT = process.env.DOUYIN_DESKTOP_REPO_ROOT || path.resolve(__dirname, '..', '..');

let child = null;

async function isHealthy() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureStarted(app) {
  if (await isHealthy()) {
    return { ok: true, mode: 'existing', message: '后端已在线' };
  }
  if (process.env.DOUYIN_DESKTOP_DISABLE_LOCAL_BACKEND === '1') {
    return { ok: false, mode: 'disabled', message: '本地后端自动启动已禁用' };
  }

  const userDataPath = app.getPath('userData');
  const logDir = path.join(userDataPath, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'desktop-backend.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  child = spawn('node', [path.join(REPO_ROOT, 'desktop-backend.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DOUYIN_DESKTOP_STORAGE_DIR: path.join(userDataPath, 'storage'),
      DESKTOP_BACKEND_HOST: '127.0.0.1',
      DESKTOP_BACKEND_PORT: '19522',
      DESKTOP_BRIDGE_HOST: '127.0.0.1',
      DESKTOP_BRIDGE_PORT: '19422',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on('exit', () => {
    child = null;
    logStream.end();
  });
  child.on('error', (error) => {
    logStream.write(`\n[start error] ${error.message}\n`);
  });

  const ok = await waitForHealthy();
  return ok
    ? { ok: true, mode: 'local', message: '本地后端已启动', logPath }
    : { ok: false, mode: 'local', message: `本地后端启动超时，日志：${logPath}`, logPath };
}

function stop() {
  if (!child) return { ok: true, message: '本地后端未运行' };
  child.kill();
  child = null;
  return { ok: true, message: '本地后端已停止' };
}

module.exports = {
  ensureStarted,
  isHealthy,
  stop,
};
