import { useEffect, useState } from 'react';
import { listEvents } from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { SelectMenu } from './SelectMenu.jsx';

function formatMetadata(metadata) {
  if (!metadata || !Object.keys(metadata).length) return '-';
  return JSON.stringify(metadata);
}

function levelTone(level) {
  if (level === 'error') return 'danger';
  if (level === 'warn' || level === 'warning') return 'warning';
  return 'neutral';
}

export function LogsPage() {
  const [logs, setLogs] = useState([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refresh(nextLimit = limit) {
    setLoading(true);
    setError('');
    try {
      setLogs(await listEvents({ limit: nextLimit }));
    } catch (err) {
      setError(err.message || '日志加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(limit);
  }, []);

  return (
    <section className="panel">
      <PageHeader
        title="日志"
        description="查看账号、任务和后端事件，定位失败原因。"
        actions={<button type="button" onClick={() => refresh()} disabled={loading}>刷新</button>}
      />

      <div className="panel-section logs-toolbar">
        <label>
          <span>日志数量</span>
          <SelectMenu
            className="limit-select"
            value={limit}
            onChange={(event) => {
              const nextLimit = Number(event.target.value);
              setLimit(nextLimit);
              refresh(nextLimit);
            }}
            aria-label="日志数量"
          >
            <option value="50">50 条</option>
            <option value="100">100 条</option>
            <option value="200">200 条</option>
          </SelectMenu>
        </label>
      </div>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>等级</th>
              <th>账号</th>
              <th>任务</th>
              <th>消息</th>
              <th>元数据</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{log.createdAt}</td>
                <td><span className={`status-badge ${levelTone(log.level)}`}>{log.level}</span></td>
                <td><code>{log.accountId || '-'}</code></td>
                <td><code>{log.taskId || '-'}</code></td>
                <td>{log.message}</td>
                <td><code>{formatMetadata(log.metadata)}</code></td>
              </tr>
            ))}
            {!logs.length ? (
              <tr>
                <td colSpan="6" className="empty-row">
                  {loading ? '日志加载中...' : '暂无日志。运行任务后这里会显示事件。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
