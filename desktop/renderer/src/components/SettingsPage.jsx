import { useEffect, useMemo, useState } from 'react';
import {
  getAppInfo,
  getBackendHealth,
  getBridgeHealth,
  getDockerStatus,
  getLlmSettings,
  startBackend,
  stopBackend,
  updateLlmSettings,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function StatusBadge({ tone, children }) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}

function flattenConnections(status) {
  const groups = status?.connections || {};
  return Object.entries(groups).flatMap(([site, conns]) => (
    Array.isArray(conns) ? conns.map((conn) => ({ ...conn, site })) : []
  ));
}

function isRealDouyinBrowser(conn) {
  const url = String(conn?.url || '').toLowerCase();
  const title = String(conn?.title || '').toLowerCase();
  const userAgent = String(conn?.userAgent || '').toLowerCase();
  if (title.includes('desktop poll mock')) return false;
  if (userAgent.includes('poll-mock-client')) return false;
  return url.includes('douyin.com');
}

function getSiteCount(map, site = 'douyin.com') {
  return Number(map?.[site] || 0);
}

function bridgeInjectLabel(status) {
  if (status === 'ready') return '已接管';
  if (status === 'connecting') return '连接中';
  if (status === 'injecting') return '注入中';
  if (status === 'inject_failed') return '注入失败';
  if (status === 'poll_failed') return '连接失败';
  return '未接管';
}

function bridgeInjectTone(status) {
  if (status === 'ready') return 'success';
  if (status === 'connecting') return 'neutral';
  if (status === 'injecting') return 'neutral';
  if (status === 'inject_failed') return 'danger';
  if (status === 'poll_failed') return 'danger';
  return 'warning';
}

function HealthCard({ label, value, detail }) {
  return (
    <div className="settings-health-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function SettingsPage() {
  const [health, setHealth] = useState(null);
  const [bridgeHealth, setBridgeHealth] = useState(null);
  const [docker, setDocker] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [llm, setLlm] = useState({
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    model: 'deepseek-v4-flash',
    max_tokens: 4096,
    timeout_ms: 60000,
    max_retries: 3,
  });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    setMessage('');
    const [dockerResult, healthResult, bridgeResult, appResult, llmResult] = await Promise.allSettled([
      getDockerStatus(),
      getBackendHealth(),
      getBridgeHealth(),
      getAppInfo(),
      getLlmSettings(),
    ]);

    setDocker(dockerResult.status === 'fulfilled' ? dockerResult.value : {
      available: false,
      running: false,
      backendHealthy: false,
      message: dockerResult.reason?.message || 'Docker 状态不可用',
    });
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    setBridgeHealth(bridgeResult.status === 'fulfilled' ? bridgeResult.value : null);
    setAppInfo(appResult.status === 'fulfilled' ? appResult.value : null);
    if (llmResult.status === 'fulfilled') {
      setLlm(llmResult.value);
      setApiKeyInput('');
    }
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

  async function handleSaveLlm(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const patch = {
        base_url: llm.base_url,
        model: llm.model,
        max_tokens: llm.max_tokens,
        timeout_ms: llm.timeout_ms,
        max_retries: llm.max_retries,
      };
      if (apiKeyInput.trim()) patch.api_key = apiKeyInput.trim();
      const updated = await updateLlmSettings(patch);
      setLlm(updated);
      setApiKeyInput('');
      setMessage('AI 配置已保存');
    } catch (error) {
      setMessage(error.message || 'AI 配置保存失败');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const connections = useMemo(() => flattenConnections(bridgeHealth), [bridgeHealth]);
  const aliveConnections = connections.filter((conn) => conn.alive !== false);
  const activeBrowserOpen = Boolean(appInfo?.browserBridge?.hasActiveView);
  const bridgeDiagnostic = appInfo?.browserBridge || {};
  const waiters = getSiteCount(bridgeHealth?.pollWaiters);
  const queued = getSiteCount(bridgeHealth?.pollQueue);

  const backendBadge = useMemo(() => {
    if (loading) return <StatusBadge tone="neutral">检查中</StatusBadge>;
    if (health?.ok) return <StatusBadge tone="success">在线</StatusBadge>;
    return <StatusBadge tone="danger">离线</StatusBadge>;
  }, [health, loading]);

  const bridgeBadge = useMemo(() => {
    if (loading) return <StatusBadge tone="neutral">检查中</StatusBadge>;
    if (bridgeHealth?.ok) return <StatusBadge tone="success">在线</StatusBadge>;
    return <StatusBadge tone="danger">离线</StatusBadge>;
  }, [bridgeHealth, loading]);

  const dockerBadge = docker?.available
    ? <StatusBadge tone={docker.running ? 'success' : 'warning'}>{docker.running ? '运行中' : '未运行'}</StatusBadge>
    : <StatusBadge tone="danger">不可用</StatusBadge>;
  const dockerText = docker?.available
    ? (docker.running ? 'Docker 已安装且正在运行' : 'Docker 已安装，但当前未运行')
    : 'Docker 不可用';
  const bridgeInjectBadge = (
    <StatusBadge tone={bridgeInjectTone(bridgeDiagnostic.status)}>
      {bridgeInjectLabel(bridgeDiagnostic.status)}
    </StatusBadge>
  );
  const bridgeInjectDetail = bridgeDiagnostic.message
    || (bridgeDiagnostic.bridgePreload ? 'preload 已加载' : '等待账号浏览器')
    || bridgeDiagnostic.activeUrl
    || '';

  return (
    <section className="panel settings-panel">
      <PageHeader
        title="设置"
        description="配置 AI 回复参数、检查本地后端和 Bridge 连接状态。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新状态</button>}
      />

      <div className="settings-health-strip" aria-label="系统状态">
        <HealthCard label="后端" value={backendBadge} detail={health?.ok ? '本地后端' : '未连接'} />
        <HealthCard label="Bridge" value={bridgeBadge} detail={`${aliveConnections.length} 个任务连接`} />
        <HealthCard label="页面注入" value={bridgeInjectBadge} detail={bridgeInjectDetail} />
        <HealthCard label="当前浏览器" value={activeBrowserOpen ? 1 : 0} detail={`${waiters} 个等待任务`} />
        <HealthCard label="排队任务" value={queued} detail={queued ? '等待浏览器执行' : '无等待任务'} />
      </div>

      <div className="settings-layout">
        <form className="panel-section settings-llm-card" onSubmit={handleSaveLlm}>
          <div className="section-heading">
            <h2>AI 回复配置</h2>
            <p>每台电脑本地保存，同事可填写自己的 API Key。</p>
          </div>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={apiKeyInput}
              placeholder={llm.has_api_key ? `已保存：${llm.api_key}` : '粘贴 API Key'}
              onChange={(event) => setApiKeyInput(event.target.value)}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={llm.base_url || ''}
              onChange={(event) => setLlm((current) => ({ ...current, base_url: event.target.value }))}
            />
          </label>
          <label>
            <span>模型</span>
            <input
              value={llm.model || ''}
              onChange={(event) => setLlm((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
          <div className="inline-fields">
            <label>
              <span>最大 tokens</span>
              <input
                type="number"
                min="1"
                value={llm.max_tokens || 4096}
                onChange={(event) => setLlm((current) => ({ ...current, max_tokens: Number(event.target.value) }))}
              />
            </label>
            <label>
              <span>超时毫秒</span>
              <input
                type="number"
                min="1000"
                value={llm.timeout_ms || 60000}
                onChange={(event) => setLlm((current) => ({ ...current, timeout_ms: Number(event.target.value) }))}
              />
            </label>
            <label>
              <span>重试次数</span>
              <input
                type="number"
                min="0"
                value={llm.max_retries || 3}
                onChange={(event) => setLlm((current) => ({ ...current, max_retries: Number(event.target.value) }))}
              />
            </label>
          </div>
          <button type="submit" disabled={saving}>{saving ? '保存中' : '保存 AI 配置'}</button>
        </form>

        <aside className="settings-side">
          <section className="panel-section settings-card">
            <div className="section-heading">
              <h2>本地运行</h2>
              <p>{health?.ok ? `当前使用本地后端运行。${dockerText}，Docker 仅作为备用。` : `本地后端离线。${dockerText}。`}</p>
            </div>
            <div className="settings-status-list">
              <div><span>Docker</span>{dockerBadge}</div>
              <div><span>API 地址</span><code>{appInfo?.backendUrl || 'http://127.0.0.1:19522'}</code></div>
              <div><span>Bridge 地址</span><code>{appInfo?.bridgeUrl || 'http://127.0.0.1:19422'}</code></div>
              <div><span>本地数据</span><code>{appInfo?.userDataPath || '-'}</code></div>
            </div>
            <div className="button-row compact">
              <button type="button" onClick={handleStart} disabled={loading}>启动后端</button>
              <button type="button" onClick={handleStop} disabled={loading}>停止后端</button>
            </div>
            {message ? <p className="muted">{message}</p> : null}
          </section>
        </aside>
      </div>

      <details className="panel-section settings-connections">
        <summary>
          <span>连接明细</span>
          <small>{connections.length} 条历史连接，{aliveConnections.length} 条在线</small>
        </summary>
        <div className="connection-list">
          {connections.map((conn) => (
            <div className="connection-row" key={conn.id}>
              <span>{conn.site}</span>
              <span>{conn.alive === false ? '离线' : '在线'}</span>
              <span>{isRealDouyinBrowser(conn) ? '真实浏览器' : '非真实浏览器/Mock'}</span>
              <code>{conn.url || '-'}</code>
            </div>
          ))}
          {!connections.length ? <p className="muted">暂无浏览器连接。</p> : null}
        </div>
      </details>
    </section>
  );
}
