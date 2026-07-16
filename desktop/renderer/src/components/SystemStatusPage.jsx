import { useEffect, useMemo, useState } from 'react';
import {
  getAppInfo,
  getBackendHealth,
  getBridgeHealth,
  getDockerStatus,
  startBackend,
  stopBackend,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function StatusBadge({ tone, children }) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}

function HealthCard({ label, value, detail }) {
  return <div className="settings-health-card"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>;
}

function flattenConnections(status) {
  return Object.entries(status?.connections || {}).flatMap(([site, connections]) => (
    Array.isArray(connections) ? connections.map((connection) => ({ ...connection, site })) : []
  ));
}

function isRealDouyinBrowser(connection) {
  const url = String(connection?.url || '').toLowerCase();
  const title = String(connection?.title || '').toLowerCase();
  const userAgent = String(connection?.userAgent || '').toLowerCase();
  return url.includes('douyin.com') && !title.includes('desktop poll mock') && !userAgent.includes('poll-mock-client');
}

function siteCount(map, site = 'douyin.com') {
  return Number(map?.[site] || 0);
}

function injectionLabel(status) {
  return { ready: '已接管', connecting: '连接中', injecting: '注入中', inject_failed: '注入失败', poll_failed: '连接失败' }[status] || '未接管';
}

function injectionTone(status) {
  if (status === 'ready') return 'success';
  if (['inject_failed', 'poll_failed'].includes(status)) return 'danger';
  return status ? 'neutral' : 'warning';
}

export function SystemStatusPage() {
  const [health, setHealth] = useState(null);
  const [bridgeHealth, setBridgeHealth] = useState(null);
  const [docker, setDocker] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    setMessage('');
    const [dockerResult, healthResult, bridgeResult, appResult] = await Promise.allSettled([
      getDockerStatus(), getBackendHealth(), getBridgeHealth(), getAppInfo(),
    ]);
    setDocker(dockerResult.status === 'fulfilled' ? dockerResult.value : { available: false, running: false });
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    setBridgeHealth(bridgeResult.status === 'fulfilled' ? bridgeResult.value : null);
    setAppInfo(appResult.status === 'fulfilled' ? appResult.value : null);
    if (healthResult.status === 'rejected') setMessage(healthResult.reason?.message || '后端不可用');
    setLoading(false);
  }

  async function handleBackend(action) {
    setLoading(true);
    try {
      const result = action === 'start' ? await startBackend() : await stopBackend();
      setMessage(result.message || (action === 'start' ? '后端已启动' : '后端已停止'));
      await refresh();
    } catch (error) {
      setMessage(error.message || '后端操作失败');
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const connections = useMemo(() => flattenConnections(bridgeHealth), [bridgeHealth]);
  const aliveConnections = connections.filter((connection) => connection.alive !== false);
  const reportedAliveConnections = Number(bridgeHealth?.totalAliveConnections);
  const aliveConnectionCount = Number.isFinite(reportedAliveConnections)
    ? reportedAliveConnections
    : aliveConnections.length;
  const diagnostic = appInfo?.browserBridge || {};
  const currentBrowser = diagnostic.hasActiveView ? 1 : 0;
  const waiters = siteCount(bridgeHealth?.pollWaiters);
  const queued = siteCount(bridgeHealth?.pollQueue);
  const online = (value) => loading
    ? <StatusBadge tone="neutral">检查中</StatusBadge>
    : <StatusBadge tone={value ? 'success' : 'danger'}>{value ? '在线' : '离线'}</StatusBadge>;
  const dockerText = !docker?.available ? 'Docker 不可用' : docker.running ? 'Docker 正在运行' : 'Docker 已安装，当前未运行';

  return (
    <section className="panel settings-panel system-status-panel">
      <PageHeader title="系统状态" description="查看本地服务、页面接管和任务连接情况。" actions={<button type="button" onClick={refresh} disabled={loading}>刷新状态</button>} />

      {message ? <p className={message.includes('失败') || message.includes('不可用') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <div className="settings-health-strip" aria-label="系统运行概览">
        <HealthCard label="后端" value={online(health?.ok)} detail="本地后端" />
        <HealthCard label="Bridge" value={online(bridgeHealth?.ok)} detail={`${aliveConnectionCount} 个有效任务连接`} />
        <HealthCard label="页面注入" value={<StatusBadge tone={injectionTone(diagnostic.status)}>{injectionLabel(diagnostic.status)}</StatusBadge>} detail={diagnostic.message || '等待账号浏览器'} />
        <HealthCard label="当前浏览器" value={currentBrowser} detail={`${waiters} 个等待任务`} />
        <HealthCard label="排队任务" value={queued} detail={queued ? '等待浏览器执行' : '无等待任务'} />
      </div>

      <div className="system-status-layout">
        <section className="panel-section settings-card">
          <div className="section-heading"><h2>本地运行</h2><p>桌面版优先使用内置本地后端，Docker 仅作为备用环境。</p></div>
          <div className="settings-status-list">
            <div><span>Docker</span><strong>{dockerText}</strong></div>
            <div><span>API 地址</span><code>{appInfo?.backendUrl || 'http://127.0.0.1:19522'}</code></div>
            <div><span>Bridge 地址</span><code>{appInfo?.bridgeUrl || 'http://127.0.0.1:19422'}</code></div>
            <div><span>本地数据</span><code>{appInfo?.userDataPath || '-'}</code></div>
          </div>
          <div className="button-row compact"><button type="button" onClick={() => handleBackend('start')} disabled={loading}>启动后端</button><button type="button" onClick={() => handleBackend('stop')} disabled={loading}>停止后端</button></div>
        </section>

        <section className="panel-section settings-card">
          <div className="section-heading"><h2>浏览器接管</h2><p>{diagnostic.message || '打开账号浏览器后，系统会自动注入并建立任务连接。'}</p></div>
          <div className="settings-status-list">
            <div><span>注入状态</span><strong>{injectionLabel(diagnostic.status)}</strong></div>
            <div><span>当前页面</span><code>{diagnostic.activeUrl || '-'}</code></div>
            <div><span>停靠模式</span><strong>{diagnostic.browserDockMode || '-'}</strong></div>
            <div><span>页面缩放</span><strong>{diagnostic.browserZoomFactor ? `${Math.round(diagnostic.browserZoomFactor * 100)}%` : '-'}</strong></div>
          </div>
        </section>
      </div>

      <details className="panel-section settings-connections">
        <summary><span>连接明细</span><small>{connections.length} 条历史记录，{aliveConnectionCount} 条有效</small></summary>
        <div className="connection-list">
          {connections.map((connection) => <div className="connection-row" key={connection.id}><span>{connection.site}</span><span>{connection.alive === false ? '离线' : '在线'}</span><span>{isRealDouyinBrowser(connection) ? '真实浏览器' : '非真实浏览器/Mock'}</span><code>{connection.url || '-'}</code></div>)}
          {!connections.length ? <p className="muted">暂无浏览器连接。</p> : null}
        </div>
      </details>
    </section>
  );
}
