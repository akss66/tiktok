#!/usr/bin/env node
// server.js — Bridge Server 入口

const http = require('http');
const fs = require('fs');
const path = require('path');

const { ConnectionRegistry } = require('./lib/server/registry');
const { WebSocketHub } = require('./lib/server/ws-hub');
const { Router } = require('./lib/server/router');

// 加载配置
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 初始化组件
const registry = new ConnectionRegistry();
const wsHub = new WebSocketHub({
  registry,
  port: config.bridge.port,
  host: config.bridge.host,
  heartbeatInterval: config.bridge.heartbeatInterval,
  heartbeatTimeout: config.bridge.heartbeatTimeout,
  heartbeatMaxFailures: config.bridge.heartbeatMaxFailures,
});
const router = new Router({
  registry,
  wsHub,
  requestTimeout: config.bridge.requestTimeout || 30000,
});

// 创建 HTTP Server
const httpServer = http.createServer((req, res) => {
  router.handle(req, res);
});

// 将 WebSocket attach 到 HTTP Server（共用端口）
wsHub.attach(httpServer);

// 启动监听
const bridgeHost = config.bridge.host;
const bridgePort = config.bridge.port;
httpServer.listen(bridgePort, bridgeHost, () => {
  console.error(`[server] Bridge Server ready — http://${bridgeHost}:${bridgePort}`);
  console.error(`[server] Health:  http://${bridgeHost}:${bridgePort}/api/health`);
  console.error(`[server] Status:  http://${bridgeHost}:${bridgePort}/api/status`);
  console.error(`[server] WebSocket: ws://${bridgeHost}:${bridgePort}/ws`);
  console.error('[server] Waiting for Tampermonkey scripts to connect...');
});

// 优雅退出
async function shutdown() {
  console.error('\n[server] Shutting down...');
  httpServer.close();
  await wsHub.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
