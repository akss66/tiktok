const BASE_URL = process.env.DESKTOP_BACKEND_URL || 'http://127.0.0.1:19522';

async function request(method, pathname, body) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`[desktop-smoke] ${method} ${pathname} ${response.status} ${data.error || ''}`);
  }
  return data;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const account = await request('POST', '/api/accounts', {
    name: `smoke-${Date.now()}`,
    status: 'online',
  });
  console.log('[desktop-smoke] created account', account.id);

  const tasks = [
    { type: 'search', input: { keyword: 'music' } },
    { type: 'like', input: { awemeId: '123', action: 'like' } },
    { type: 'publish', input: { awemeId: '456', text: '你好，测试评论' } },
    { type: 'delete-comment', input: { commentId: 'cmt-1' } },
  ];

  const created = [];
  for (const task of tasks) {
    const createdTask = await request('POST', '/api/tasks', {
      accountId: account.id,
      ...task,
    });
    created.push(createdTask);
  }
  console.log('[desktop-smoke] created tasks', created.map((item) => item.id).join(','));

  for (const item of created) {
    const before = await request('GET', `/api/tasks?accountId=${account.id}`);
    const target = before.find((task) => task.id === item.id);
    console.log('[desktop-smoke] run task', item.id, target?.type, target?.status);

    const result = await request('POST', `/api/tasks/${item.id}/run`);
    await sleep(200);
    const refreshed = await request('GET', `/api/tasks?accountId=${account.id}`);
    const done = refreshed.find((task) => task.id === result.id);
    if (!done) {
      throw new Error(`[desktop-smoke] task ${item.id} not found after run`);
    }
    console.log('[desktop-smoke] task done', done.id, done.status, done.resultSummary || done.error || {});
  }

  const events = await request('GET', '/api/events');
  const latest = events.slice(-3);
  console.log('[desktop-smoke] latest events');
  for (const event of latest) {
    console.log(`- ${event.level} ${event.accountId} ${event.taskId} ${event.message}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
