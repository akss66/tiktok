import { useEffect, useMemo, useState } from 'react';
import { createTask, listAccounts, listTasks, runTask } from '../api.js';

function formatJson(value) {
  if (!value || !Object.keys(value).length) return '-';
  return JSON.stringify(value);
}

function taskTone(status) {
  if (status === 'success') return 'success';
  if (status === 'running') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

export function TasksPage() {
  const [accounts, setAccounts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState({ accountId: '', type: 'search', keyword: '', count: 5 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const accountById = useMemo(() => {
    return new Map(accounts.map((account) => [account.id, account]));
  }, [accounts]);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [nextAccounts, nextTasks] = await Promise.all([listAccounts(), listTasks()]);
      setAccounts(nextAccounts);
      setTasks(nextTasks);
      setForm((current) => ({
        ...current,
        accountId: current.accountId || nextAccounts[0]?.id || '',
      }));
    } catch (err) {
      setError(err.message || '任务数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!form.accountId) {
      setError('请先选择账号');
      return;
    }
    if (!form.keyword.trim()) {
      setError('关键词不能为空');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await createTask({
        accountId: form.accountId,
        type: 'search',
        input: { keyword: form.keyword.trim(), count: Number(form.count || 5) },
      });
      setForm((current) => ({ ...current, keyword: '' }));
      await refresh();
    } catch (err) {
      setError(err.message || '任务创建失败');
      setLoading(false);
    }
  }

  async function handleRun(task) {
    setLoading(true);
    setError('');
    try {
      const updated = await runTask(task.id);
      setTasks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err.message || '任务运行失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="panel" aria-labelledby="tasks-title">
      <div className="panel-header">
        <div>
          <h1 id="tasks-title">任务</h1>
          <p>创建并运行账号绑定任务。MVP 先支持 search 任务。</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading}>刷新</button>
      </div>

      <form className="inline-form task-form" onSubmit={handleCreate}>
        <label>
          <span>账号</span>
          <select
            value={form.accountId}
            onChange={(event) => setForm((next) => ({ ...next, accountId: event.target.value }))}
          >
            <option value="">选择账号</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select
            value={form.type}
            onChange={(event) => setForm((next) => ({ ...next, type: event.target.value }))}
          >
            <option value="search">search</option>
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input
            value={form.keyword}
            onChange={(event) => setForm((next) => ({ ...next, keyword: event.target.value }))}
            placeholder="美食"
          />
        </label>
        <label>
          <span>数量</span>
          <input
            type="number"
            min="1"
            max="20"
            value={form.count}
            onChange={(event) => setForm((next) => ({ ...next, count: event.target.value }))}
          />
        </label>
        <button type="submit" disabled={loading}>新建任务</button>
      </form>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>账号</th>
              <th>状态</th>
              <th>输入</th>
              <th>结果</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>{task.type}</td>
                <td>{accountById.get(task.accountId)?.name || task.accountId}</td>
                <td><span className={`status-badge ${taskTone(task.status)}`}>{task.status}</span></td>
                <td><code>{formatJson(task.input)}</code></td>
                <td><code>{task.error || formatJson(task.resultSummary)}</code></td>
                <td>{task.createdAt}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => handleRun(task)}
                    disabled={loading || task.status === 'running'}
                  >
                    运行
                  </button>
                </td>
              </tr>
            ))}
            {!tasks.length ? (
              <tr>
                <td colSpan="7" className="empty-row">
                  {loading ? '任务加载中...' : '还没有任务。先选择账号并创建 search 任务。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
