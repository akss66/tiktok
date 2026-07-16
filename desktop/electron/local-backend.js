const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';

function getBackendRoot(app) {
  if (process.env.DOUYIN_DESKTOP_REPO_ROOT) return process.env.DOUYIN_DESKTOP_REPO_ROOT;
  if (app.isPackaged) {
    const resourceBackendRoot = path.join(process.resourcesPath, 'backend');
    if (fs.existsSync(resourceBackendRoot)) return resourceBackendRoot;
    const unpackedBackendRoot = path.join(process.resourcesPath, 'app.asar.unpacked', 'backend');
    if (fs.existsSync(unpackedBackendRoot)) return unpackedBackendRoot;
    return path.join(app.getAppPath(), 'backend');
  }
  return path.resolve(__dirname, '..', '..');
}

function getBackendCommand(app, backendRoot) {
  if (app.isPackaged) {
    const bundledNode = path.join(backendRoot, 'node', 'node.exe');
    if (fs.existsSync(bundledNode)) {
      return {
        command: bundledNode,
        args: [path.join(backendRoot, 'desktop-backend.js')],
        env: {},
      };
    }
    return {
      command: process.execPath,
      args: [path.join(backendRoot, 'desktop-backend.js')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
  }
  return {
    command: 'node',
    args: [path.join(backendRoot, 'desktop-backend.js')],
    env: {},
  };
}

let child = null;

function waitForChildExit(target, timeoutMs) {
  if (!target || target.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeListener('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    target.once('close', onClose);
  });
}

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

  const backendRoot = getBackendRoot(app);
  const backendCommand = getBackendCommand(app, backendRoot);

  const spawnedChild = spawn(backendCommand.command, backendCommand.args, {
    cwd: backendRoot,
    env: {
      ...process.env,
      ...backendCommand.env,
      DOUYIN_DESKTOP_STORAGE_DIR: path.join(userDataPath, 'storage'),
      DESKTOP_BACKEND_HOST: '127.0.0.1',
      DESKTOP_BACKEND_PORT: '19522',
      DESKTOP_BRIDGE_HOST: '127.0.0.1',
      DESKTOP_BRIDGE_PORT: '19422',
      VULCAN_VERSION: app.getVersion(),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = spawnedChild;

  spawnedChild.stdout.pipe(logStream);
  spawnedChild.stderr.pipe(logStream);
  spawnedChild.on('exit', () => {
    if (child === spawnedChild) child = null;
    logStream.end();
  });
  spawnedChild.on('error', (error) => {
    logStream.write(`\n[start error] ${error.message}\n`);
  });

  const ok = await waitForHealthy();
  return ok
    ? { ok: true, mode: 'local', message: '本地后端已启动', logPath }
    : { ok: false, mode: 'local', message: `本地后端启动超时，日志：${logPath}`, logPath };
}

async function stop() {
  if (!child) return { ok: true, message: '本地后端未运行' };
  const target = child;
  target.kill('SIGTERM');
  if (!await waitForChildExit(target, 10_000)) {
    target.kill('SIGKILL');
    if (!await waitForChildExit(target, 2_000)) {
      throw new Error(`本地后端进程未在超时内退出 (pid=${target.pid || 'unknown'})`);
    }
  }
  if (child === target) child = null;
  return { ok: true, message: '本地后端已停止' };
}

module.exports = {
  ensureStarted,
  isHealthy,
  stop,
};
