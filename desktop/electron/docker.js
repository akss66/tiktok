const { spawn } = require('child_process');
const path = require('path');

const DOCKER_COMPOSE_FILE = 'docker-compose.desktop.yml';
const BACKEND_URL = process.env.DOUYIN_DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';

function repoRoot() {
  return process.env.DOUYIN_DESKTOP_REPO_ROOT || path.resolve(__dirname, '..', '..');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot(),
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function getBackendHealthy() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function getDockerStatus() {
  const version = await runCommand('docker', ['--version']);
  if (!version.ok) {
    return {
      available: false,
      running: false,
      backendHealthy: false,
      message: version.stderr || 'Docker CLI 不可用',
    };
  }

  const ps = await runCommand('docker', ['compose', '-f', DOCKER_COMPOSE_FILE, 'ps', '--format', 'json']);
  const backendHealthy = await getBackendHealthy();
  const running = ps.ok && ps.stdout.includes('douyin-desktop-backend');

  return {
    available: true,
    running,
    backendHealthy,
    message: ps.ok ? 'Docker 可用' : (ps.stderr || 'Docker Compose 状态不可用'),
  };
}

async function startBackend() {
  const result = await runCommand('docker', ['compose', '-f', DOCKER_COMPOSE_FILE, 'up', '-d']);
  return {
    ok: result.ok,
    message: result.ok ? '后端已启动' : (result.stderr || '后端启动失败'),
  };
}

async function stopBackend() {
  const result = await runCommand('docker', ['compose', '-f', DOCKER_COMPOSE_FILE, 'down']);
  return {
    ok: result.ok,
    message: result.ok ? '后端已停止' : (result.stderr || '后端停止失败'),
  };
}

module.exports = {
  getDockerStatus,
  startBackend,
  stopBackend,
};
