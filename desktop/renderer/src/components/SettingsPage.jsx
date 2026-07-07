import { useEffect, useMemo, useState } from 'react';
import { getAppInfo, getBackendHealth, getDockerStatus, startBackend, stopBackend } from '../api.js';

function StatusBadge({ tone, children }) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}

export function SettingsPage() {
  const [health, setHealth] = useState(null);
  const [docker, setDocker] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    setMessage('');
    const [dockerResult, healthResult, appResult] = await Promise.allSettled([
      getDockerStatus(),
      getBackendHealth(),
      getAppInfo(),
    ]);
    setDocker(dockerResult.status === 'fulfilled' ? dockerResult.value : {
      available: false,
      running: false,
      backendHealthy: false,
      message: dockerResult.reason?.message || 'Docker 状态不可用',
    });
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    setAppInfo(appResult.status === 'fulfilled' ? appResult.value : null);
    if (healthResult.status === 'rejected') setMessage(healthResult.reason?.message || '后端不可用');
    setLoading(false);
  }

  async function handleStart() {
    setLoading(true);
    const result = await startBackend();
    setMessage(result.message);
    await refresh();
  }

  async function handleStop() {
    setLoading(true);
    const result = await stopBackend();
    setMessage(result.message);
    await refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

  const backendBadge = useMemo(() => {
    if (loading) return <StatusBadge tone="neutral">检查中</StatusBadge>;
    if (health?.ok) return <StatusBadge tone="success">在线</StatusBadge>;
    return <StatusBadge tone="danger">离线</StatusBadge>;
  }, [health, loading]);

  const dockerBadge = docker?.available
    ? <StatusBadge tone={docker.running ? 'success' : 'warning'}>{docker.running ? '运行中' : '未运行'}</StatusBadge>
    : <StatusBadge tone="danger">不可用</StatusBadge>;

  return (
    <section className="panel" aria-labelledby="settings-title">
      <div className="panel-header">
        <div>
          <h1 id="settings-title">设置</h1>
          <p>管理 Docker 后端和本地运行状态。</p>
        </div>
        <div className="button-row">
          <button type="button" onClick={refresh} disabled={loading}>刷新</button>
          <button type="button" onClick={handleStart} disabled={loading}>启动后端</button>
          <button type="button" onClick={handleStop} disabled={loading}>停止后端</button>
        </div>
      </div>

      <dl className="status-grid">
        <div>
          <dt>Docker</dt>
          <dd>{dockerBadge}</dd>
        </div>
        <div>
          <dt>后端状态</dt>
          <dd>{backendBadge}</dd>
        </div>
        <div>
          <dt>API 地址</dt>
          <dd>{appInfo?.backendUrl || 'http://127.0.0.1:19522'}</dd>
        </div>
        <div>
          <dt>应用版本</dt>
          <dd>{appInfo?.version || '-'}</dd>
        </div>
      </dl>

      <div className="panel-section">
        <h2>本地数据</h2>
        <p>{appInfo?.userDataPath || '仅在 Electron 中可用'}</p>
      </div>

      <div className="panel-section">
        <h2>状态消息</h2>
        <p>{message || docker?.message || health?.service || '等待操作。'}</p>
      </div>
    </section>
  );
}
