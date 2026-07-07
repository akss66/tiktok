import { useEffect, useState } from 'react';
import { createAccount, deleteAccount, listAccounts, updateAccount } from '../api.js';

const STATUS_OPTIONS = [
  { value: 'login_required', label: '需登录' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'disabled', label: '停用' },
];

function statusLabel(value) {
  return STATUS_OPTIONS.find((item) => item.value === value)?.label || value;
}

function statusTone(value) {
  if (value === 'online') return 'success';
  if (value === 'login_required') return 'warning';
  if (value === 'disabled') return 'neutral';
  return 'danger';
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({ name: '', group: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setAccounts(await listAccounts());
    } catch (err) {
      setError(err.message || '账号列表加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('账号名称不能为空');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await createAccount(form);
      setForm({ name: '', group: '', notes: '' });
      await refresh();
    } catch (err) {
      setError(err.message || '账号创建失败');
      setLoading(false);
    }
  }

  async function handlePatch(account, patch) {
    setError('');
    try {
      const updated = await updateAccount(account.id, patch);
      setAccounts((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err.message || '账号更新失败');
    }
  }

  async function handleDelete(account) {
    setError('');
    try {
      await deleteAccount(account.id);
      setAccounts((items) => items.filter((item) => item.id !== account.id));
    } catch (err) {
      setError(err.message || '账号删除失败');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="panel" aria-labelledby="accounts-title">
      <div className="panel-header">
        <div>
          <h1 id="accounts-title">账号</h1>
          <p>管理账号分组、登录状态和浏览器 Profile。</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading}>刷新</button>
      </div>

      <form className="inline-form" onSubmit={handleCreate}>
        <label>
          <span>名称</span>
          <input
            value={form.name}
            onChange={(event) => setForm((next) => ({ ...next, name: event.target.value }))}
            placeholder="账号A"
          />
        </label>
        <label>
          <span>分组</span>
          <input
            value={form.group}
            onChange={(event) => setForm((next) => ({ ...next, group: event.target.value }))}
            placeholder="默认分组"
          />
        </label>
        <label>
          <span>备注</span>
          <input
            value={form.notes}
            onChange={(event) => setForm((next) => ({ ...next, notes: event.target.value }))}
            placeholder="用途、负责人或代理说明"
          />
        </label>
        <button type="submit" disabled={loading}>新建账号</button>
      </form>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>分组</th>
              <th>状态</th>
              <th>Profile</th>
              <th>最近在线</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>
                  <input
                    className="table-input"
                    value={account.group || ''}
                    onChange={(event) => handlePatch(account, { group: event.target.value })}
                    aria-label={`${account.name} 分组`}
                  />
                </td>
                <td>
                  <select
                    value={account.status}
                    onChange={(event) => handlePatch(account, { status: event.target.value })}
                    aria-label={`${account.name} 状态`}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className={`status-badge ${statusTone(account.status)}`}>{statusLabel(account.status)}</span>
                </td>
                <td><code>{account.profileKey}</code></td>
                <td>{account.lastSeenAt || '-'}</td>
                <td>
                  <input
                    className="table-input"
                    value={account.notes || ''}
                    onChange={(event) => handlePatch(account, { notes: event.target.value })}
                    aria-label={`${account.name} 备注`}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => handleDelete(account)}>删除</button>
                </td>
              </tr>
            ))}
            {!accounts.length ? (
              <tr>
                <td colSpan="7" className="empty-row">
                  {loading ? '账号加载中...' : '还没有账号。先创建一个账号，再打开浏览器登录。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
