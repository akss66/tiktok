#!/usr/bin/env node

const { createDesktopApiServer } = require('./lib/desktop/api-server');

const host = process.env.DESKTOP_BACKEND_HOST || '127.0.0.1';
const port = Number(process.env.DESKTOP_BACKEND_PORT || 19522);
const storageDir = process.env.DOUYIN_DESKTOP_STORAGE_DIR;

const server = createDesktopApiServer({ storageDir });

server.listen(port, host, () => {
  console.error(`[desktop-backend] ready http://${host}:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
