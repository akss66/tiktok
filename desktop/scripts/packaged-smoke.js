const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const HEALTH_URL = 'http://127.0.0.1:19522/api/health';
const DEFAULT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

function getSmokePaths(smokeRoot) {
  const userDataDir = path.join(smokeRoot, 'user-data');
  return {
    smokeRoot,
    appDataDir: path.join(smokeRoot, 'appdata'),
    localAppDataDir: path.join(smokeRoot, 'localappdata'),
    userDataDir,
    exitRequestPath: path.join(smokeRoot, 'request-graceful-exit'),
    mainLogPath: path.join(userDataDir, 'logs', 'main.log'),
    backendLogPath: path.join(userDataDir, 'logs', 'desktop-backend.log'),
    stdoutPath: path.join(smokeRoot, 'vulcan.stdout.log'),
    stderrPath: path.join(smokeRoot, 'vulcan.stderr.log'),
  };
}

function buildSmokeEnvironment(baseEnvironment, paths) {
  const environment = {
    ...baseEnvironment,
    APPDATA: paths.appDataDir,
    LOCALAPPDATA: paths.localAppDataDir,
    VULCAN_USER_DATA_DIR: paths.userDataDir,
    VULCAN_PACKAGED_SMOKE_EXIT_FILE: paths.exitRequestPath,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function isSmokeReady(mainLog, health) {
  return /app ready packaged=true\b/.test(mainLog) && health?.ok === true;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function tail(value, maxLength = 8_000) {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function requestHealth(timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const request = http.get(HEALTH_URL, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          resolve({ ok: response.statusCode === 200 && value?.ok === true, status: response.statusCode, body: value });
        } catch {
          resolve({ ok: false, status: response.statusCode, body });
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health request timed out')));
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function findLatestPackagedExecutable(desktopRoot) {
  const candidates = [];
  for (const entry of fs.readdirSync(desktopRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const executablePath = path.join(desktopRoot, entry.name, 'win-unpacked', 'Vulcan.exe');
    if (!fs.existsSync(executablePath)) continue;
    candidates.push({ executablePath, modifiedAt: fs.statSync(executablePath).mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!candidates.length) throw new Error(`No win-unpacked\\Vulcan.exe found below ${desktopRoot}`);
  return candidates[0].executablePath;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function terminateSpawnedTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

function diagnostics(paths, child, health) {
  return [
    `smokeRoot=${paths.smokeRoot}`,
    `pid=${child?.pid || 'unknown'} exitCode=${child?.exitCode ?? 'running'} signal=${child?.signalCode || ''}`,
    `health=${JSON.stringify(health || {})}`,
    `main.log:\n${tail(readIfPresent(paths.mainLogPath)) || '(missing)'}`,
    `desktop-backend.log:\n${tail(readIfPresent(paths.backendLogPath)) || '(missing)'}`,
    `stdout:\n${tail(readIfPresent(paths.stdoutPath)) || '(empty)'}`,
    `stderr:\n${tail(readIfPresent(paths.stderrPath)) || '(empty)'}`,
  ].join('\n\n');
}

async function runPackagedSmoke(options = {}) {
  const desktopRoot = path.resolve(options.desktopRoot || path.join(__dirname, '..'));
  const executablePath = path.resolve(options.executablePath || findLatestPackagedExecutable(desktopRoot));
  const timeoutMs = Number(options.timeoutMs || process.env.VULCAN_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-packaged-smoke-'));
  const paths = getSmokePaths(smokeRoot);
  for (const directory of [paths.appDataDir, paths.localAppDataDir, paths.userDataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const occupiedPorts = [];
  for (const port of [19522, 19422]) {
    if (await isPortListening(port)) occupiedPorts.push(port);
  }
  if (occupiedPorts.length) {
    throw new Error(`Packaged smoke aborted because required ports are already in use: ${occupiedPorts.join(', ')}`);
  }

  const stdoutFd = fs.openSync(paths.stdoutPath, 'a');
  const stderrFd = fs.openSync(paths.stderrPath, 'a');
  const child = spawn(executablePath, [`--user-data-dir=${paths.userDataDir}`], {
    cwd: path.dirname(executablePath),
    env: buildSmokeEnvironment(process.env, paths),
    windowsHide: true,
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  let health = { ok: false, error: 'not checked' };

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Vulcan exited before smoke readiness (exitCode=${child.exitCode})`);
      }
      health = await requestHealth();
      if (isSmokeReady(readIfPresent(paths.mainLogPath), health)) break;
      await sleep(250);
    }

    if (!isSmokeReady(readIfPresent(paths.mainLogPath), health)) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for packaged=true and ${HEALTH_URL} ok`);
    }

    fs.writeFileSync(paths.exitRequestPath, new Date().toISOString(), 'utf8');
    if (!await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) {
      throw new Error(`Timed out after ${SHUTDOWN_TIMEOUT_MS}ms waiting for graceful Electron shutdown`);
    }

    const shutdownDeadline = Date.now() + 10_000;
    let openPorts = [];
    do {
      const states = await Promise.all([19522, 19422].map(async (port) => ({
        port,
        listening: await isPortListening(port),
      })));
      openPorts = states.filter((state) => state.listening).map((state) => state.port);
      if (!openPorts.length || Date.now() >= shutdownDeadline) break;
      await sleep(200);
    } while (true);
    if (openPorts.length) {
      throw new Error(`Ports remained open after Electron shutdown: ${openPorts.join(', ')}`);
    }

    return { executablePath, paths, health, exitCode: child.exitCode };
  } catch (error) {
    const detail = diagnostics(paths, child, health);
    terminateSpawnedTree(child);
    throw new Error(`${error.message}\n\n${detail}`);
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

if (require.main === module) {
  runPackagedSmoke({ executablePath: process.argv[2] })
    .then((result) => {
      console.log('PACKAGED_SMOKE_OK');
      console.log(`executable=${result.executablePath}`);
      console.log(`smokeRoot=${result.paths.smokeRoot}`);
      console.log(`mainLog=${result.paths.mainLogPath}`);
      console.log(`health=${HEALTH_URL} ok=true`);
      console.log(`exitCode=${result.exitCode}`);
    })
    .catch((error) => {
      console.error(`PACKAGED_SMOKE_FAILED\n${error.stack || error.message || String(error)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildSmokeEnvironment,
  findLatestPackagedExecutable,
  getSmokePaths,
  isSmokeReady,
  runPackagedSmoke,
};
