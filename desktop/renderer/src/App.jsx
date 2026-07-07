import { useEffect, useMemo, useState } from 'react';
import { getBackendHealth } from './api.js';

const NAV_ITEMS = [
  { id: 'accounts', label: '账号' },
  { id: 'tasks', label: '任务' },
  { id: 'logs', label: '日志' },
  { id: 'settings', label: '设置' },
];

function StatusBadge({ tone, children }) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}

function PlaceholderPage({ title, description }) {
  return (
    <section className="panel" aria-labelledby={`${title}-title`}>
      <div className="panel-header">
        <div>
          <h1 id={`${title}-title`}>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      <div className="empty-state">此模块会在后续任务中接入真实数据。</div>
    </section>
  );
}

function SettingsPreview({ health, loading, error, onRefresh }) {
  const badge = useMemo(() => {
    if (loading) return <StatusBadge tone="neutral">检查中</StatusBadge>;
    if (error) return <StatusBadge tone="danger">离线</StatusBadge>;
    if (health?.ok) return <StatusBadge tone="success">在线</StatusBadge>;
    return <StatusBadge tone="warning">未知</StatusBadge>;
  }, [error, health, loading]);

  return (
    <section className="panel" aria-labelledby="settings-title">
      <div className="panel-header">
        <div>
          <h1 id="settings-title">设置</h1>
          <p>查看本地后端和桌面运行状态。</p>
        </div>
        <button type="button" onClick={onRefresh}>刷新</button>
      </div>
      <dl className="status-grid">
        <div>
          <dt>后端状态</dt>
          <dd>{badge}</dd>
        </div>
        <div>
          <dt>API 地址</dt>
          <dd>http://127.0.0.1:19522</dd>
        </div>
        <div>
          <dt>服务</dt>
          <dd>{health?.service || '-'}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{health?.version || '-'}</dd>
        </div>
      </dl>
      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  );
}

export function App() {
  const [activePage, setActivePage] = useState('settings');
  const [health, setHealth] = useState(null);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [healthError, setHealthError] = useState('');

  async function refreshHealth() {
    setLoadingHealth(true);
    setHealthError('');
    try {
      setHealth(await getBackendHealth());
    } catch (error) {
      setHealth(null);
      setHealthError(error.message || '后端不可用');
    } finally {
      setLoadingHealth(false);
    }
  }

  useEffect(() => {
    refreshHealth();
  }, []);

  const page = {
    accounts: <PlaceholderPage title="账号" description="管理账号、分组、登录状态和浏览器 Profile。" />,
    tasks: <PlaceholderPage title="任务" description="创建和跟踪搜索、采集、回复等任务。" />,
    logs: <PlaceholderPage title="日志" description="查看后端任务和账号浏览器事件。" />,
    settings: (
      <SettingsPreview
        health={health}
        loading={loadingHealth}
        error={healthError}
        onRefresh={refreshHealth}
      />
    ),
  }[activePage];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <strong>Douyin Desktop</strong>
          <span>本地运营控制台</span>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? 'active' : ''}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace">{page}</main>
    </div>
  );
}
