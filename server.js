#!/usr/bin/env node

const path = require('path');
const { createBridgeServer } = require('./lib/server/create-bridge-server');

const configPath = path.join(__dirname, 'config.json');
let bridgeServer;

try {
  bridgeServer = createBridgeServer({
    configPath,
    autoGenerateToken: true,
  });
} catch (error) {
  console.error('[server] 未找到 config.json，请先复制 config.example.json 并填写配置：');
  console.error('[server]   cp config.example.json config.json');
  process.exit(1);
}

const config = bridgeServer.config;
const bridgeHost = config.bridge.host;
const bridgePort = config.bridge.port;

bridgeServer.httpServer.listen(bridgePort, bridgeHost, () => {
  console.error(`[server] Bridge Server ready - http://${bridgeHost}:${bridgePort}`);
  console.error(`[server] Health:  http://${bridgeHost}:${bridgePort}/api/health`);
  console.error(`[server] Status:  http://${bridgeHost}:${bridgePort}/api/status`);
  console.error(`[server] WebSocket: ws://${bridgeHost}:${bridgePort}/ws`);
  console.error('[server] Waiting for browser bridge scripts to connect...');
});

async function shutdown() {
  console.error('\n[server] Shutting down...');
  await bridgeServer.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
