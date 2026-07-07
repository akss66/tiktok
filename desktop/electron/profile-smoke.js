const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { partitionForAccount } = require('./profiles');

const COOKIE_URL = 'https://www.douyin.com';
const COOKIE_NAME = 'douyin_desktop_profile_smoke';
const COOKIE_VALUE = 'account-a-session';

function accountA() {
  return { id: 'acct_profile_smoke_a', profileKey: 'acct_profile_smoke_a' };
}

function accountB() {
  return { id: 'acct_profile_smoke_b', profileKey: 'acct_profile_smoke_b' };
}

async function runElectronPhase() {
  const { app, session } = require('electron');

  const userDataDir = process.env.DOUYIN_PROFILE_SMOKE_USER_DATA;
  if (!userDataDir) throw new Error('Missing DOUYIN_PROFILE_SMOKE_USER_DATA');
  app.setPath('userData', userDataDir);
  app.disableHardwareAcceleration();

  await app.whenReady();

  const partitionA = partitionForAccount(accountA());
  const partitionB = partitionForAccount(accountB());
  assert.notStrictEqual(partitionA, partitionB, 'account partitions must differ');

  const sessionA = session.fromPartition(partitionA);
  const sessionB = session.fromPartition(partitionB);
  const phase = process.env.DOUYIN_PROFILE_SMOKE_PHASE;

  if (phase === 'write') {
    await sessionA.cookies.set({
      url: COOKIE_URL,
      name: COOKIE_NAME,
      value: COOKIE_VALUE,
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
    });
    await sessionA.flushStorageData();
    await sessionB.flushStorageData();
    app.quit();
    return;
  }

  if (phase === 'read') {
    const cookiesA = await sessionA.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
    const cookiesB = await sessionB.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });

    assert.strictEqual(cookiesA.length, 1, 'account A cookie should persist across app restarts');
    assert.strictEqual(cookiesA[0].value, COOKIE_VALUE, 'account A cookie value should match');
    assert.strictEqual(cookiesB.length, 0, 'account B partition should not see account A cookie');

    app.quit();
    return;
  }

  throw new Error(`Unknown DOUYIN_PROFILE_SMOKE_PHASE: ${phase}`);
}

function runNodeOrchestrator() {
  const electronPath = require('electron');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-profile-smoke-'));
  const scriptPath = __filename;

  try {
    for (const phase of ['write', 'read']) {
      const result = spawnSync(electronPath, [scriptPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          DOUYIN_PROFILE_SMOKE_PHASE: phase,
          DOUYIN_PROFILE_SMOKE_USER_DATA: userDataDir,
        },
      });

      if (result.status !== 0) {
        process.exit(result.status || 1);
      }
    }

    console.log('Profile smoke test passed: persistent partitions are isolated per account.');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

if (process.versions.electron) {
  runElectronPhase().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  runNodeOrchestrator();
}
