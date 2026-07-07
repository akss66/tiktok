#!/usr/bin/env node

const { createDesktopApiServer } = require('./lib/desktop/api-server');
const { createBridgeServer } = require('./lib/server/create-bridge-server');

const host = process.env.DESKTOP_BACKEND_HOST || '127.0.0.1';
const port = Number(process.env.DESKTOP_BACKEND_PORT || 19522);
const storageDir = process.env.DOUYIN_DESKTOP_STORAGE_DIR;
const bridgeHost = process.env.DESKTOP_BRIDGE_HOST || '127.0.0.1';
const bridgePort = Number(process.env.DESKTOP_BRIDGE_PORT || 19422);

const server = createDesktopApiServer({ storageDir });
const bridgeServer = createBridgeServer({
  autoGenerateToken: false,
  fallbackConfig: {
    bridge: {
      host: bridgeHost,
      port: bridgePort,
      token: '',
      heartbeatInterval: 30000,
      heartbeatTimeout: 10000,
      heartbeatMaxFailures: 3,
      requestTimeout: 30000,
    },
  },
});

server.listen(port, host, () => {
  console.error(`[desktop-backend] ready http://${host}:${port}`);
});
bridgeServer.httpServer.listen(bridgePort, bridgeHost, () => {
  console.error(`[desktop-backend] bridge ready http://${bridgeHost}:${bridgePort}`);
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await bridgeServer.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
