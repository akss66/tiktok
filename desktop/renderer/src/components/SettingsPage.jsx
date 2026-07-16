import { useEffect, useState } from 'react';
import { BellRing, Bot, CheckCircle2, MessageSquareText, Package, PlugZap, ShieldCheck } from 'lucide-react';
import {
  getAppInfo,
  getDmSettings,
  getLlmSettings,
  getReplySettings,
  testLlmSettings,
  updateDmSettings,
  updateLlmSettings,
  updateReplySettings,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const DEFAULT_LLM = {
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'deepseek-v4-flash',
  max_tokens: 4096,
  timeout_ms: 60000,
  max_retries: 3,
};

const DEFAULT_REPLY = {
  intent_threshold: 'medium',
  require_knowledge: true,
  max_draft_chars: 60,
};

const DEFAULT_DM = {
  reply_mode: 'manual',
  auto_reply_frequency: 'once',
  knowledge_confidence: '0.85',
  auto_delay_min_seconds: '15',
  auto_delay_max_seconds: '45',
  monitor_after_login: false,
  notifications_enabled: true,
  notification_preview: true,
  quiet_hours_start: '',
  quiet_hours_end: '',
};

const DM_REPLY_MODES = [
  { value: 'automatic', label: '全自动回复' },
  { value: 'tiered', label: '涉敏信息需人工复核' },
  { value: 'manual', label: '全人工审核' },
];

const DM_REPLY_MODE_DESCRIPTIONS = {
  automatic: '有知识依据且通过安全校验的文字消息自动回复',
  tiered: '普通问题自动回复，涉敏信息转人工复核',
  manual: '所有 AI 回复只生成草稿，人工确认后发送',
};

const DM_AUTO_REPLY_FREQUENCIES = [
  { value: 'once', label: '每个会话一次' },
  { value: 'always', label: '持续回复' },
];

function dmSettingsToForm(settings = {}) {
  return {
    ...DEFAULT_DM,
    ...settings,
    knowledge_confidence: String(settings.knowledge_confidence ?? DEFAULT_DM.knowledge_confidence),
    auto_delay_min_seconds: String(Number(settings.auto_delay_min_ms ?? 15000) / 1000),
    auto_delay_max_seconds: String(Number(settings.auto_delay_max_ms ?? 45000) / 1000),
  };
}

export function validateDmSettingsForm(form) {
  const errors = {};
  const confidence = Number(form.knowledge_confidence);
  const minSeconds = Number(form.auto_delay_min_seconds);
  const maxSeconds = Number(form.auto_delay_max_seconds);
  if (String(form.knowledge_confidence).trim() === '' || !Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
    errors.knowledge_confidence = '请输入 0.5 到 1 之间的置信度';
  }
  if (String(form.auto_delay_min_seconds).trim() === '' || !Number.isFinite(minSeconds) || minSeconds < 0 || minSeconds > 100) {
    errors.auto_delay_min_seconds = '最短延迟需为 0 到 100 秒';
  }
  if (String(form.auto_delay_max_seconds).trim() === '' || !Number.isFinite(maxSeconds) || maxSeconds < 0 || maxSeconds > 100) {
    errors.auto_delay_max_seconds = '最长延迟需为 0 到 100 秒';
  } else if (Number.isFinite(minSeconds) && maxSeconds < minSeconds) {
    errors.auto_delay_max_seconds = '最长延迟不能小于最短延迟';
  }
  const hasQuietStart = Boolean(String(form.quiet_hours_start || '').trim());
  const hasQuietEnd = Boolean(String(form.quiet_hours_end || '').trim());
  if (hasQuietStart !== hasQuietEnd) {
    errors.quiet_hours = '免打扰开始和结束时间需要同时填写或同时留空';
  }
  return errors;
}

function createDmPatch(form) {
  return {
    reply_mode: form.reply_mode,
    auto_reply_frequency: form.auto_reply_frequency,
    knowledge_confidence: Number(form.knowledge_confidence),
    auto_delay_min_ms: Math.round(Number(form.auto_delay_min_seconds) * 1000),
    auto_delay_max_ms: Math.round(Number(form.auto_delay_max_seconds) * 1000),
    monitor_after_login: Boolean(form.monitor_after_login),
    notifications_enabled: Boolean(form.notifications_enabled),
    notification_preview: Boolean(form.notification_preview),
    quiet_hours_start: String(form.quiet_hours_start || ''),
    quiet_hours_end: String(form.quiet_hours_end || ''),
  };
}

function createLlmPatch(llm, apiKeyInput) {
  const patch = {
    base_url: String(llm.base_url || '').trim(),
    model: String(llm.model || '').trim(),
    max_tokens: Number(llm.max_tokens || 4096),
    timeout_ms: Number(llm.timeout_ms || 60000),
    max_retries: Number(llm.max_retries ?? 3),
  };
  if (apiKeyInput.trim()) patch.api_key = apiKeyInput.trim();
  return patch;
}

function platformName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform || '-';
}

export function SettingsPage() {
  const [llm, setLlm] = useState(DEFAULT_LLM);
  const [reply, setReply] = useState(DEFAULT_REPLY);
  const [dm, setDm] = useState(DEFAULT_DM);
  const [dmErrors, setDmErrors] = useState({});
  const [appInfo, setAppInfo] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [testResult, setTestResult] = useState(null);

  async function loadSettings() {
    setLoading(true);
    setMessage('');
    try {
      const [llmSettings, replySettings, dmSettings, info] = await Promise.all([
        getLlmSettings(),
        getReplySettings(),
        getDmSettings(),
        getAppInfo(),
      ]);
      setLlm(llmSettings);
      setReply(replySettings);
      setDm(dmSettingsToForm(dmSettings));
      setDmErrors({});
      setAppInfo(info);
      setApiKeyInput('');
    } catch (error) {
      setMessage(error.message || '设置加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    const validationErrors = validateDmSettingsForm(dm);
    setDmErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      setMessage('请先修正私信设置中的错误');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const [savedLlm, savedReply, savedDm] = await Promise.all([
        updateLlmSettings(createLlmPatch(llm, apiKeyInput)),
        updateReplySettings(reply),
        updateDmSettings(createDmPatch(dm)),
      ]);
      setLlm(savedLlm);
      setReply(savedReply);
      setDm(dmSettingsToForm(savedDm));
      setDmErrors({});
      setApiKeyInput('');
      setMessage('设置已保存');
    } catch (error) {
      setMessage(error.message || '设置保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setMessage('');
    setTestResult(null);
    try {
      const result = await testLlmSettings(createLlmPatch(llm, apiKeyInput));
      setTestResult(result);
    } catch (error) {
      setMessage(error.message || 'AI 服务连接失败');
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => { loadSettings(); }, []);

  return (
    <section className="panel settings-panel preferences-panel">
      <PageHeader
        title="设置"
        description="配置 AI 服务、回复默认值和本机版本信息。"
        actions={<button type="button" onClick={loadSettings} disabled={loading}>重新加载</button>}
      />

      {message ? <p className={message.includes('失败') || message.includes('修正') ? 'inline-error' : 'inline-success'} role="status">{message}</p> : null}

      <form className="preferences-stack" onSubmit={handleSave}>
        <section className="panel-section settings-llm-card preferences-card">
          <div className="section-heading settings-section-heading">
            <span className="settings-section-icon"><Bot size={18} /></span>
            <div>
              <h2>AI 服务</h2>
              <p>配置只保存在当前电脑，不会写入安装包。</p>
            </div>
          </div>

          <div className="settings-primary-fields">
            <label>
              <span>API Key</span>
              <input
                aria-label="API Key"
                type="password"
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              <span>API 地址</span>
              <input value={llm.base_url || ''} onChange={(event) => setLlm((current) => ({ ...current, base_url: event.target.value }))} />
            </label>
            <label>
              <span>模型名称</span>
              <input value={llm.model || ''} onChange={(event) => setLlm((current) => ({ ...current, model: event.target.value }))} />
            </label>
          </div>

          <details className="settings-advanced">
            <summary>高级参数</summary>
            <div className="inline-fields">
              <label>
                <span>最大 tokens</span>
                <input type="number" min="1" value={llm.max_tokens || 4096} onChange={(event) => setLlm((current) => ({ ...current, max_tokens: Number(event.target.value) }))} />
              </label>
              <label>
                <span>超时（毫秒）</span>
                <input type="number" min="1000" value={llm.timeout_ms || 60000} onChange={(event) => setLlm((current) => ({ ...current, timeout_ms: Number(event.target.value) }))} />
              </label>
              <label>
                <span>重试次数</span>
                <input type="number" min="0" max="10" value={llm.max_retries ?? 3} onChange={(event) => setLlm((current) => ({ ...current, max_retries: Number(event.target.value) }))} />
              </label>
            </div>
          </details>

          <div className="settings-test-row">
            <div className="settings-test-status" aria-live="polite">
              {testResult ? (
                <><CheckCircle2 size={16} />连接成功，{testResult.model}，{testResult.latencyMs} ms</>
              ) : (
                <span>{llm.has_api_key || apiKeyInput ? '可测试当前填写的配置' : '填写 API Key 后测试连接'}</span>
              )}
            </div>
            <button type="button" onClick={handleTestConnection} disabled={testing || loading}>
              <PlugZap size={16} />{testing ? '测试中' : '测试连接'}
            </button>
          </div>
        </section>

        <section className="panel-section preferences-card dm-settings-section">
          <div className="section-heading settings-section-heading">
            <span className="settings-section-icon"><BellRing size={18} /></span>
            <div>
              <h2>私信与自动回复</h2>
              <p>控制登录后监听、通知和知识库命中后的回复方式。</p>
            </div>
          </div>

          <div className="dm-mode-setting">
            <div>
              <strong>自动程度</strong>
              <span><ShieldCheck size={14} />{DM_REPLY_MODE_DESCRIPTIONS[dm.reply_mode] || DM_REPLY_MODE_DESCRIPTIONS.manual}</span>
            </div>
            <div className="segmented-control dm-mode-control" role="group" aria-label="私信自动回复模式">
              {DM_REPLY_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className="dm-mode-option"
                  aria-pressed={dm.reply_mode === mode.value}
                  onClick={() => setDm((current) => ({ ...current, reply_mode: mode.value }))}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="dm-mode-setting dm-frequency-setting">
            <div>
              <strong>自动回复频率</strong>
              <span>
                <ShieldCheck size={14} />
                {dm.auto_reply_frequency === 'always'
                  ? '每条新的对方文字消息都会重新分析并按规则回复'
                  : '每个会话自动回复一次，之后转人工处理'}
              </span>
            </div>
            <div className="segmented-control dm-mode-control dm-frequency-control" role="group" aria-label="自动回复频率">
              {DM_AUTO_REPLY_FREQUENCIES.map((frequency) => (
                <button
                  key={frequency.value}
                  type="button"
                  className="dm-frequency-option"
                  aria-pressed={dm.auto_reply_frequency === frequency.value}
                  onClick={() => setDm((current) => ({ ...current, auto_reply_frequency: frequency.value }))}
                >
                  {frequency.label}
                </button>
              ))}
            </div>
          </div>

          <div className="dm-settings-grid">
            <div className="dm-settings-group" aria-label="监听与通知">
              <h3>监听与通知</h3>
              <label className="settings-switch-row">
                <span><strong>登录后默认监听</strong><small>登录稳定 30 秒后开始，不刷新抖音页面</small></span>
                <input
                  type="checkbox"
                  checked={Boolean(dm.monitor_after_login)}
                  onChange={(event) => setDm((current) => ({ ...current, monitor_after_login: event.target.checked }))}
                />
                <span className="switch-control" aria-hidden="true" />
              </label>
              <label className="settings-switch-row">
                <span><strong>Windows 通知</strong><small>有新私信时发送系统通知</small></span>
                <input
                  type="checkbox"
                  checked={Boolean(dm.notifications_enabled)}
                  onChange={(event) => setDm((current) => ({ ...current, notifications_enabled: event.target.checked }))}
                />
                <span className="switch-control" aria-hidden="true" />
              </label>
              <label className="settings-switch-row compact">
                <span><strong>显示消息预览</strong><small>关闭后通知只显示“收到新私信”</small></span>
                <input
                  type="checkbox"
                  checked={Boolean(dm.notification_preview)}
                  disabled={!dm.notifications_enabled}
                  onChange={(event) => setDm((current) => ({ ...current, notification_preview: event.target.checked }))}
                />
                <span className="switch-control" aria-hidden="true" />
              </label>
              <div className="dm-time-fields">
                <label className="settings-field">
                  <span>免打扰开始</span>
                  <input
                    type="time"
                    value={dm.quiet_hours_start}
                    onChange={(event) => setDm((current) => ({ ...current, quiet_hours_start: event.target.value }))}
                  />
                </label>
                <label className="settings-field">
                  <span>免打扰结束</span>
                  <input
                    type="time"
                    value={dm.quiet_hours_end}
                    onChange={(event) => setDm((current) => ({ ...current, quiet_hours_end: event.target.value }))}
                  />
                </label>
              </div>
              {dmErrors.quiet_hours ? <span className="field-error" role="alert">{dmErrors.quiet_hours}</span> : null}
            </div>

            <div className="dm-settings-group" aria-label="自动回复阈值">
              <h3>自动回复阈值</h3>
              <label className="settings-field">
                <span>自动回复置信度</span>
                <input
                  aria-label="自动回复置信度"
                  type="number"
                  min="0.5"
                  max="1"
                  step="0.01"
                  value={dm.knowledge_confidence}
                  onChange={(event) => setDm((current) => ({ ...current, knowledge_confidence: event.target.value }))}
                />
                {dmErrors.knowledge_confidence ? <small className="field-error" role="alert">{dmErrors.knowledge_confidence}</small> : null}
              </label>
              <div className="dm-delay-fields">
                <label className="settings-field">
                  <span>最短延迟（秒）</span>
                  <input
                    aria-label="自动发送最短延迟秒数"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={dm.auto_delay_min_seconds}
                    onChange={(event) => setDm((current) => ({ ...current, auto_delay_min_seconds: event.target.value }))}
                  />
                  {dmErrors.auto_delay_min_seconds ? <small className="field-error" role="alert">{dmErrors.auto_delay_min_seconds}</small> : null}
                </label>
                <label className="settings-field">
                  <span>最长延迟（秒）</span>
                  <input
                    aria-label="自动发送最长延迟秒数"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={dm.auto_delay_max_seconds}
                    onChange={(event) => setDm((current) => ({ ...current, auto_delay_max_seconds: event.target.value }))}
                  />
                  {dmErrors.auto_delay_max_seconds ? <small className="field-error" role="alert">{dmErrors.auto_delay_max_seconds}</small> : null}
                </label>
              </div>
              <p className="settings-helper">延迟会在范围内随机选择；分析过程不占用抖音写操作队列。</p>
            </div>
          </div>
        </section>

        <div className="settings-preference-grid">
          <section className="panel-section settings-card preferences-card">
            <div className="section-heading settings-section-heading">
              <span className="settings-section-icon"><MessageSquareText size={18} /></span>
              <div>
                <h2>回复默认值</h2>
                <p>用于评论理解和回复草稿生成。</p>
              </div>
            </div>

            <label className="settings-field">
              <span>回复意向范围</span>
              <SelectMenu value={reply.intent_threshold} onChange={(event) => setReply((current) => ({ ...current, intent_threshold: event.target.value }))} aria-label="回复意向范围">
                <option value="medium">高意向和中意向</option>
                <option value="high">仅高意向</option>
              </SelectMenu>
            </label>
            <label className="settings-check-row">
              <input type="checkbox" checked={Boolean(reply.require_knowledge)} onChange={(event) => setReply((current) => ({ ...current, require_knowledge: event.target.checked }))} />
              <span>业务回复必须引用知识库</span>
            </label>
            <label className="settings-field">
              <span>草稿最大字数</span>
              <input type="number" min="20" max="200" value={reply.max_draft_chars} onChange={(event) => setReply((current) => ({ ...current, max_draft_chars: Number(event.target.value) }))} />
            </label>
          </section>

          <section className="panel-section settings-card preferences-card">
            <div className="section-heading settings-section-heading">
              <span className="settings-section-icon"><Package size={18} /></span>
              <div>
                <h2>版本与安装包</h2>
                <p>当前电脑正在运行的软件版本。</p>
              </div>
            </div>

            <dl className="version-info-list">
              <div><dt>当前版本</dt><dd>v{appInfo?.version || '-'}</dd></div>
              <div><dt>运行方式</dt><dd>{appInfo?.packaged ? '安装包运行' : '源码运行（测试环境）'}</dd></div>
              <div><dt>系统架构</dt><dd>{platformName(appInfo?.platform)} {appInfo?.arch || ''}</dd></div>
              <div><dt>安装包名称</dt><dd title={appInfo?.installerName}>{appInfo?.installerName || '-'}</dd></div>
              <div><dt>更新方式</dt><dd>手动安装新版安装包</dd></div>
            </dl>
          </section>
        </div>

        <div className="settings-save-row panel-section">
          <span>{llm.has_api_key ? 'API Key 已配置' : '尚未配置 API Key'}</span>
          <button type="submit" className="primary-button" disabled={saving || loading}>{saving ? '保存中' : '保存全部设置'}</button>
        </div>
      </form>
    </section>
  );
}
