const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesktopApiServer } = require('../lib/desktop/api-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe('desktop api', () => {
  let dir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-desktop-api-'));
    server = createDesktopApiServer({ storageDir: dir });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns health status', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'desktop-backend' });
  });

  it('creates and lists accounts', async () => {
    const create = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A', group: '测试组' }),
    });
    expect(create.status).toBe(201);
    const account = await create.json();
    expect(account.name).toBe('账号A');

    const list = await fetch(`${baseUrl}/api/accounts`);
    expect(await list.json()).toHaveLength(1);
  });

  it('creates a pending search task', async () => {
    const account = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '账号A' }),
    })).json();

    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        type: 'search',
        input: { keyword: '美食', count: 3 },
      }),
    });

    expect(create.status).toBe(201);
    const task = await create.json();
    expect(task.status).toBe('pending');
    expect(task.type).toBe('search');
  });
});
