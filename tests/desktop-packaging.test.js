const fs = require('fs');
const path = require('path');

const viteConfig = require('../desktop/vite.config');
const desktopPackage = require('../desktop/package.json');
const vitestConfig = require('../vitest.config');
const backendHistory = require('../lib/desktop/dm-history');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

describe('desktop packaging', () => {
  it('uses relative asset paths so the packaged renderer loads from file://', () => {
    expect(viteConfig.base).toBe('./');
  });

  it('always creates a desktop shortcut in the Windows installer', () => {
    expect(desktopPackage.build.nsis.createDesktopShortcut).toBe('always');
    expect(desktopPackage.build.nsis.createStartMenuShortcut).toBe(true);
  });

  it('declares every runtime file that must be present in the packaged backend', () => {
    const prepareBackend = read('desktop/scripts/prepare-backend.js');
    const requiredFiles = [
      'desktop-backend.js',
      'lib/desktop/dm-history.js',
      'lib/desktop/dm-inbox.js',
      'lib/desktop/dm-leads.js',
      'lib/desktop/dm-reply-workflow.js',
      'lib/desktop/dm-work-queue.js',
      'lib/desktop/operation-lease.js',
      'scripts/douyin.user.js',
      'node/node.exe',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/ws/package.json',
    ];

    for (const relativePath of requiredFiles) {
      expect(prepareBackend).toContain(`'${relativePath}'`);
    }
    expect(desktopPackage.build.extraResources).toContainEqual(expect.objectContaining({
      from: 'backend',
      to: 'backend',
    }));
  });

  it('keeps DM history normalization resolvable inside the packaged Electron app', () => {
    const electronHistory = require('../desktop/electron/dm-history');
    const monitorSource = read('desktop/electron/dm-monitor.js');
    const sample = {
      supported: true,
      messages: [{ conversation_id: 'conversation-1', content: 'hello' }],
      next_cursor: null,
      has_more: false,
    };

    expect(require.resolve('../desktop/electron/dm-history').split(path.sep).join('/')).toContain(
      'desktop/electron/dm-history.js',
    );
    expect(electronHistory.normalizeHistoryPage(sample)).toEqual(backendHistory.normalizeHistoryPage(sample));
    expect(monitorSource).toContain("require('./dm-history')");
    expect(monitorSource).not.toContain("require('../../lib/desktop/dm-history')");
    expect(desktopPackage.build.files).toContain('electron/**/*');
  });

  it('installs startup diagnostics before package-sensitive Electron modules load', () => {
    const mainSource = read('desktop/electron/main.js');
    const monitorRequireIndex = mainSource.indexOf("require('./dm-monitor')");

    expect(monitorRequireIndex).toBeGreaterThan(0);
    expect(mainSource.indexOf("process.on('uncaughtException'")).toBeLessThan(monitorRequireIndex);
    expect(mainSource.indexOf('writeMainLog(`startup module load failed:')).toBeLessThan(monitorRequireIndex);
  });

  it('exposes a repeatable packaged smoke command', () => {
    const mainSource = read('desktop/electron/main.js');

    expect(desktopPackage.scripts['smoke:packaged']).toBe('node scripts/packaged-smoke.js');
    expect(mainSource).toContain('VULCAN_PACKAGED_SMOKE_EXIT_FILE');
    expect(mainSource).toContain('fs.watchFile');
    expect(mainSource).toContain('app.quit()');
  });

  it('does not collect immutable SDD baselines as Vitest suites', () => {
    expect(vitestConfig.test.exclude).toContain('.superpowers/**');
  });

  it('waits for the bundled backend process and closes all BrowserViews during shutdown', () => {
    const localBackend = read('desktop/electron/local-backend.js');
    const browserTabs = read('desktop/electron/browser-tabs.js');

    expect(localBackend).toContain('async function stop()');
    expect(localBackend).toContain('await waitForChildExit');
    expect(browserTabs).toContain('async function shutdown(mainWindow)');
    expect(browserTabs).toContain('clearAccountPartition');
    expect(browserTabs).toContain('shutdown,');
  });
});
