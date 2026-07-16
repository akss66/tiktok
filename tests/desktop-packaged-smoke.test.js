const path = require('path');

const {
  buildSmokeEnvironment,
  getSmokePaths,
  isSmokeReady,
} = require('../desktop/scripts/packaged-smoke');

describe('packaged Electron smoke harness', () => {
  it('isolates Electron and Windows application data and clears Electron run-as-node', () => {
    const smokeRoot = path.resolve('C:/temp/vulcan-smoke-1');
    const paths = getSmokePaths(smokeRoot);
    const environment = buildSmokeEnvironment({
      ELECTRON_RUN_AS_NODE: '1',
      APPDATA: 'C:/Users/example/AppData/Roaming',
      LOCALAPPDATA: 'C:/Users/example/AppData/Local',
      KEEP_ME: 'yes',
    }, paths);

    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(environment.KEEP_ME).toBe('yes');
    expect(environment.APPDATA).toBe(paths.appDataDir);
    expect(environment.LOCALAPPDATA).toBe(paths.localAppDataDir);
    expect(environment.VULCAN_USER_DATA_DIR).toBe(paths.userDataDir);
    expect(environment.VULCAN_PACKAGED_SMOKE_EXIT_FILE).toBe(paths.exitRequestPath);
    expect(paths.mainLogPath).toBe(path.join(paths.userDataDir, 'logs', 'main.log'));
  });

  it('requires both packaged startup logging and a healthy backend', () => {
    expect(isSmokeReady('', { ok: true })).toBe(false);
    expect(isSmokeReady('[now] app ready packaged=true', { ok: false })).toBe(false);
    expect(isSmokeReady('[now] app ready packaged=false', { ok: true })).toBe(false);
    expect(isSmokeReady('[now] app ready packaged=true', { ok: true })).toBe(true);
  });
});
