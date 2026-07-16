import { useEffect, useState } from 'react';
import {
  createAccount,
  deleteAccount,
  getDmSettings,
  listAccounts,
  listDmMonitorStates,
  openAccountBrowser,
  openCleanLoginBrowser,
  openEdgeAccountBrowser,
  resetAccountBrowser,
  updateAccount,
  updateDmMonitorState,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const STATUS_OPTIONS = [
  { value: 'login_required', label: '需登录' },
  { value: 'enabled', label: '已登录' },
  { value: 'online', label: '已登录' },
  { value: 'offline', label: '离线' },
  { value: 'disabled', label: '停用' },
];

const DM_REPLY_MODE_OPTIONS = [
  { value: 'manual', label: '人工审核' },
  { value: 'tiered', label: '分级自动' },
  { value: 'automatic', label: '自动回复' },
];

const MONITOR_STATUS_LABELS = {
  idle: '待机',
  running: '监听中',
  backoff: '稍后重试',
  login_required: '需登录',
  disabled: '已停用',
  stopped: '已停止',
  enabled: '已启用',
  online: '在线',
};

function historyStatusText(status) {
  return {
    available: '历史同步能力可用',
    realtime_only: '仅实时：只保证监听期间收到的消息',
    syncing: '正在同步历史消息',
    complete: '历史消息已同步',
    incomplete: '历史补拉不完整：只保证监听期间收到的消息',
  }[status] || '仅实时：只保证监听期间收到的消息';
}

function effectiveMonitorEnabled(state, dmSettings) {
  return state?.settingSource === 'explicit'
    ? state.enabled === true
    : dmSettings?.monitor_after_login === true;
}

function effectiveReplyMode(state, dmSettings) {
  return state?.replyModeOverride || dmSettings?.reply_mode || 'manual';
}

export function AccountsPage({ onBrowserOpened }) {
  const [accounts, setAccounts] = useState([]);
  const [monitorStates, setMonitorStates] = useState({});
  const [dmSettings, setDmSettings] = useState({ monitor_after_login: false, reply_mode: 'manual' });
  const [monitorSaving, setMonitorSaving] = useState({});
  const [form, setForm] = useState({ name: '', group: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [nextAccounts, nextMonitorStates, nextDmSettings] = await Promise.all([
        listAccounts(),
        listDmMonitorStates(),
        getDmSettings(),
      ]);
      setAccounts(nextAccounts);
      setMonitorStates(Object.fromEntries(nextMonitorStates.map((state) => [state.accountId, state])));
      setDmSettings(nextDmSettings);
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

  async function handleMonitorPatch(account, patch) {
    setError('');
    setMonitorSaving((current) => ({ ...current, [account.id]: true }));
    try {
      const updated = await updateDmMonitorState(account.id, patch);
      setMonitorStates((current) => ({ ...current, [account.id]: updated }));
    } catch (err) {
      setError(err.message || '私信监听设置更新失败');
    } finally {
      setMonitorSaving((current) => ({ ...current, [account.id]: false }));
    }
  }

  async function handleDelete(account) {
    setError('');
    const confirmed = window.confirm(`确定删除「${account.name}」吗？这会同时清空该账号的浏览器登录态、Cookie 和缓存。`);
    if (!confirmed) return;
    setLoading(true);
    try {
      await deleteAccount(account.id);
      setAccounts((items) => items.filter((item) => item.id !== account.id));
      setForm({ name: '', group: '', notes: '' });
      setError(`已删除 ${account.name}，并清空该账号浏览器环境`);
    } catch (err) {
      setError(err.message || '账号删除失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenBrowser(account) {
    setError('');
    try {
      const result = await openAccountBrowser(account);
      if (!result.ok) {
        setError(result.error || '浏览器打开失败');
        return;
      }
      onBrowserOpened?.();
    } catch (err) {
      setError(err.message || '浏览器打开失败');
    }
  }

  async function handleOpenEdgeBrowser(account) {
    setError('');
    try {
      const result = await openEdgeAccountBrowser(account);
      if (!result.ok) {
        setError(result.error || 'Edge 浏览器打开失败');
        return;
      }
      setError(`已打开 Edge 托管浏览器：账号 ${account.name} 使用独立资料目录，登录状态会保存在该账号环境里。`);
    } catch (err) {
      setError(err.message || 'Edge 浏览器打开失败');
    }
  }

  async function handleOpenCleanLogin(account) {
    setError('');
    try {
      const result = await openCleanLoginBrowser(account);
      if (!result.ok) {
        setError(result.error || '纯净登录诊断浏览器打开失败');
        return;
      }
      setError('已打开纯净登录诊断浏览器：不复用缓存、不注入 Bridge，只用于判断是否为网络/IP/账号限流。');
      onBrowserOpened?.();
    } catch (err) {
      setError(err.message || '纯净登录诊断浏览器打开失败');
    }
  }

  async function handleResetBrowser(account) {
    setError('');
    const confirmed = window.confirm(`确定要重置「${account.name}」的浏览器环境吗？这会清空该账号的 Cookie、缓存和本地存储，需要重新扫码登录。`);
    if (!confirmed) return;
    setLoading(true);
    try {
      const result = await resetAccountBrowser(account);
      if (!result.ok) {
        setError(result.error || '浏览器环境重置失败');
        return;
      }
      setError('浏览器环境已重置，请重新打开该账号浏览器扫码');
    } catch (err) {
      setError(err.message || '浏览器环境重置失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleMoreAction(account, action) {
    if (action === 'edge') {
      await handleOpenEdgeBrowser(account);
      return;
    }
    if (action === 'diagnose') {
      await handleOpenCleanLogin(account);
      return;
    }
    if (action === 'reset') {
      await handleResetBrowser(account);
      return;
    }
    if (action === 'delete') {
      await handleDelete(account);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!window.douyinDesktop?.onAccountsChanged) return undefined;
    return window.douyinDesktop.onAccountsChanged((payload) => {
      if (!payload?.account) return;
      setAccounts((items) => items.map((item) => (
        item.id === payload.account.id ? payload.account : item
      )));
      setError('');
    });
  }, []);

  return (
    <section className="panel panel-wide">
      <PageHeader
        title="账号"
        description="每个账号使用独立浏览器信息；打开后可隐藏，登录状态不会丢。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新</button>}
      />

      <form className="inline-form" onSubmit={handleCreate}>
        <label>
          <span>名称</span>
          <input
            value={form.name}
            onChange={(event) => setForm((next) => ({ ...next, name: event.target.value }))}
          />
        </label>
        <label>
          <span>分组</span>
          <input
            value={form.group}
            onChange={(event) => setForm((next) => ({ ...next, group: event.target.value }))}
          />
        </label>
        <label>
          <span>备注</span>
          <input
            value={form.notes}
            onChange={(event) => setForm((next) => ({ ...next, notes: event.target.value }))}
          />
        </label>
        <button type="submit" className="primary-button" disabled={loading}>新建账号</button>
      </form>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="table-wrap">
        <table className="accounts-table">
          <colgroup>
            <col className="account-col-name" />
            <col className="account-col-group" />
            <col className="account-col-status" />
            <col className="account-col-profile" />
            <col className="account-col-seen" />
            <col className="account-col-notes" />
            <col className="account-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>名称</th>
              <th>分组</th>
              <th>状态</th>
              <th>浏览器信息</th>
              <th>最近在线</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td className="account-name-cell" title={account.name}>{account.name}</td>
                <td>
                  <input
                    className="table-input"
                    value={account.group || ''}
                    onChange={(event) => handlePatch(account, { group: event.target.value })}
                    aria-label={`${account.name} 分组`}
                  />
                </td>
                <td>
                  <SelectMenu
                    className={`account-status-select status-${account.status}`}
                    value={account.status}
                    onChange={(event) => handlePatch(account, { status: event.target.value })}
                    aria-label={`${account.name} 状态`}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </SelectMenu>
                </td>
                <td><code className="account-profile-code" title={account.profileKey}>{account.profileKey}</code></td>
                <td className="account-seen-cell" title={account.lastSeenAt || '-'}>{account.lastSeenAt || '-'}</td>
                <td>
                  <input
                    className="table-input"
                    value={account.notes || ''}
                    onChange={(event) => handlePatch(account, { notes: event.target.value })}
                    aria-label={`${account.name} 备注`}
                  />
                </td>
                <td>
                  <div className="account-action-stack">
                    <div className="account-actions">
                      <button type="button" className="primary-action" onClick={() => handleOpenBrowser(account)}>打开浏览器</button>
                      <SelectMenu
                        className="action-select"
                        defaultValue=""
                        disabled={loading}
                        aria-label={`${account.name} 更多操作`}
                        onChange={(event) => {
                          const action = event.target.value;
                          event.target.value = '';
                          handleMoreAction(account, action);
                        }}
                      >
                        <option value="" disabled>更多操作</option>
                        <option value="edge">Edge 备用登录</option>
                        <option value="diagnose">登录诊断</option>
                        <option value="reset">重置环境</option>
                        <option value="delete">删除账号</option>
                      </SelectMenu>
                    </div>
                    {(() => {
                      const monitorState = monitorStates[account.id] || {
                        accountId: account.id,
                        enabled: false,
                        settingSource: 'inherited',
                        replyModeOverride: null,
                        status: 'idle',
                      };
                      const enabled = effectiveMonitorEnabled(monitorState, dmSettings);
                      const inherited = monitorState.settingSource !== 'explicit';
                      const saving = Boolean(monitorSaving[account.id]);
                      const mode = effectiveReplyMode(monitorState, dmSettings);
                      return (
                        <div className="account-dm-control">
                          <div className="account-dm-summary">
                            <span className={`monitor-state-dot ${enabled ? 'enabled' : 'disabled'}`} aria-hidden="true" />
                            <span>
                              <strong>私信监听</strong>
                              <small>
                                {inherited ? '继承全局' : '单独设置'} · {enabled ? '已开启' : '已停用'} · {MONITOR_STATUS_LABELS[monitorState.status] || '待机'}
                              </small>
                              <small className="account-history-limitation">
                                {historyStatusText(monitorState.historyStatus)}
                              </small>
                            </span>
                          </div>
                          <div className="account-dm-actions">
                            <button
                              type="button"
                              className="compact-toggle"
                              aria-label={`${account.name} ${enabled ? '停用' : '启用'}私信监听`}
                              aria-pressed={enabled}
                              disabled={saving}
                              onClick={() => handleMonitorPatch(account, {
                                enabled: !enabled,
                                settingSource: 'explicit',
                                replyModeOverride: monitorState.replyModeOverride ?? null,
                              })}
                            >
                              <span aria-hidden="true" />
                              {enabled ? '监听已开' : '监听已停'}
                            </button>
                            <SelectMenu
                              className="account-dm-mode"
                              value={monitorState.replyModeOverride || ''}
                              disabled={saving}
                              aria-label={`${account.name} 私信回复模式`}
                              onChange={(event) => handleMonitorPatch(account, {
                                enabled,
                                settingSource: 'explicit',
                                replyModeOverride: event.target.value || null,
                              })}
                            >
                              <option value="">跟随全局（{DM_REPLY_MODE_OPTIONS.find((item) => item.value === mode)?.label || '人工审核'}）</option>
                              {DM_REPLY_MODE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </SelectMenu>
                            <button
                              type="button"
                              className="text-action"
                              aria-label={`${account.name} 使用全局默认`}
                              disabled={saving || inherited}
                              onClick={() => handleMonitorPatch(account, {
                                enabled: null,
                                settingSource: 'inherited',
                                replyModeOverride: null,
                              })}
                            >
                              使用全局
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </td>
              </tr>
            ))}
            {!accounts.length ? (
              <tr>
                <td colSpan="7" className="empty-row">
                  {loading ? '账号加载中...' : '还没有账号。先创建账号，再打开该账号浏览器登录。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
