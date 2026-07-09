import { useEffect, useState } from 'react';
import { listBatchItems, listBatchJobs, runBatchJob } from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function statusLabel(status) {
  return {
    pending: '待执行',
    running: '执行中',
    success: '成功',
    failed: '失败',
    skipped: '已跳过',
    finished_with_errors: '部分失败',
  }[status] || status;
}

function statusTone(status) {
  if (status === 'success') return 'success';
  if (status === 'running' || status === 'finished_with_errors') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function typeLabel(type) {
  return type === 'like' ? '批量点赞' : type === 'comment' ? '批量评论' : type;
}

export function BatchJobsPage() {
  const [jobs, setJobs] = useState([]);
  const [items, setItems] = useState([]);
  const [activeJobId, setActiveJobId] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoading(true);
    setMessage('');
    try {
      const nextJobs = await listBatchJobs();
      setJobs(nextJobs);
      const nextActive = activeJobId || nextJobs[0]?.id || '';
      setActiveJobId(nextActive);
      setItems(nextActive ? await listBatchItems(nextActive) : []);
    } catch (error) {
      setMessage(error.message || '批量任务加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function selectJob(id) {
    setActiveJobId(id);
    setLoading(true);
    setMessage('');
    try {
      setItems(await listBatchItems(id));
    } catch (error) {
      setMessage(error.message || '任务明细加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleRun(job) {
    setLoading(true);
    setMessage('正在逐条执行，写操作会串行处理...');
    try {
      const result = await runBatchJob(job.id);
      setJobs((current) => current.map((item) => (item.id === result.job.id ? result.job : item)));
      setItems(result.items || []);
      setMessage('批量任务执行完成');
    } catch (error) {
      setMessage(error.message || '批量任务执行失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="panel">
      <PageHeader
        title="批量任务"
        description="查看批量点赞、批量评论的整体进度和每条视频的执行结果。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新</button>}
      />

      {message ? <p className={message.includes('失败') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <div className="job-grid">
        <div className="job-list">
          {jobs.map((job) => (
            <article key={job.id} className={`job-card${activeJobId === job.id ? ' active' : ''}`}>
              <button type="button" className="job-card-button" onClick={() => selectJob(job.id)}>
                <strong>{typeLabel(job.type)}</strong>
                <span className={`status-badge ${statusTone(job.status)}`}>{statusLabel(job.status)}</span>
              </button>
              <p>总数 {job.totalCount}，成功 {job.successCount}，失败 {job.failedCount}，跳过 {job.skippedCount}</p>
              <p>创建时间：{job.createdAt}</p>
              <button type="button" onClick={() => handleRun(job)} disabled={loading || job.status === 'running'}>执行</button>
            </article>
          ))}
          {!jobs.length ? <div className="empty-state">{loading ? '加载中...' : '暂无批量任务。先在搜索获客页创建。'}</div> : null}
        </div>

        <div className="table-wrap">
          <table className="dense-table">
            <thead>
              <tr>
                <th>视频</th>
                <th>状态</th>
                <th>结果</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.awemeId || '-'}</code></td>
                  <td><span className={`status-badge ${statusTone(item.status)}`}>{statusLabel(item.status)}</span></td>
                  <td>{item.result?.cid ? `评论 ID：${item.result.cid}` : item.result?.reason || item.result?.action || '-'}</td>
                  <td>{item.error || '-'}</td>
                </tr>
              ))}
              {!items.length ? <tr><td colSpan="4" className="empty-row">选择左侧批量任务查看明细。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
