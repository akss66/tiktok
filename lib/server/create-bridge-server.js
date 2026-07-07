const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ConnectionRegistry } = require('./registry');
const { WebSocketHub } = require('./ws-hub');
const { Router } = require('./router');

function readBridgeConfig(options = {}) {
  const configPath = options.configPath || path.join(process.cwd(), 'config.json');
  let config;

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (!options.fallbackConfig) throw error;
    config = JSON.parse(JSON.stringify(options.fallbackConfig));
  }

  if (!config.bridge) config.bridge = {};
  if (config.bridge.token === undefined) config.bridge.token = '';

  if (options.autoGenerateToken && !config.bridge.token) {
    config.bridge.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  return { config, configPath };
}

function createBridgeServer(options = {}) {
  const { config } = readBridgeConfig(options);
  const bridge = config.bridge;

  const registry = new ConnectionRegistry();
  const wsHub = new WebSocketHub({
    registry,
    port: bridge.port,
    host: bridge.host,
    heartbeatInterval: bridge.heartbeatInterval,
    heartbeatTimeout: bridge.heartbeatTimeout,
    heartbeatMaxFailures: bridge.heartbeatMaxFailures,
  });
  const router = new Router({
    registry,
    wsHub,
    requestTimeout: bridge.requestTimeout || 30000,
    token: bridge.token,
  });

  const httpServer = http.createServer((req, res) => {
    router.handle(req, res);
  });
  wsHub.attach(httpServer);

  async function stop() {
    await new Promise((resolve) => httpServer.close(resolve));
    await wsHub.stop();
  }

  return {
    config,
    httpServer,
    stop,
  };
}

module.exports = {
  createBridgeServer,
  readBridgeConfig,
};
