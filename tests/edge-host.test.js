const path = require('path');

const {
  buildEdgeArgs,
  edgeDebugPortForAccount,
  edgeProfileDir,
  sanitizeProfileKey,
} = require('../desktop/electron/edge-host');

describe('edge host', () => {
  it('builds a stable per-account Edge profile directory', () => {
    const dir = edgeProfileDir('C:\\Users\\me\\AppData\\Roaming\\Vulcan', {
      id: 'acct-1',
      profileKey: 'team/a:geo',
    });

    expect(dir).toBe(path.join('C:\\Users\\me\\AppData\\Roaming\\Vulcan', 'edge-profiles', 'team_a_geo'));
  });

  it('sanitizes profile keys for filesystem use', () => {
    expect(sanitizeProfileKey('账号/一号:geo*')).toBe('______geo_');
  });

  it('uses a deterministic debugging port per account', () => {
    const first = edgeDebugPortForAccount({ id: 'acct-1' });
    const second = edgeDebugPortForAccount({ id: 'acct-1' });
    const other = edgeDebugPortForAccount({ id: 'acct-2' });

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(43000);
    expect(first).toBeLessThan(45000);
    expect(other).not.toBe(first);
  });

  it('builds Edge launch args without stealth or fingerprint spoofing flags', () => {
    const args = buildEdgeArgs({
      port: 43123,
      profileDir: 'C:\\profiles\\acct-1',
      url: 'https://www.douyin.com/jingxuan',
    });

    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=43123');
    expect(args).toContain('--user-data-dir=C:\\profiles\\acct-1');
    expect(args).toContain('https://www.douyin.com/jingxuan');
    expect(args.join(' ')).not.toMatch(/stealth|fingerprint|webdriver/i);
  });
});
