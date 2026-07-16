import { useEffect, useState } from 'react';
import { CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import {
  cancelBatchJob,
  listBatchItems,
  listBatchJobs,
  pauseBatchJob,
  resumeBatchJob,
  retryFailedBatchItems,
  runBatchJob,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function statusLabel(status) {
  return {
    pending: '待执行',
    running: '执行中',
    success: '成功',
    failed: '失败',
    skipped: '已跳过',
    finished_with_errors: '部分失败',
    pause_requested: '正在暂停',
    paused: '已暂停',
    cancel_requested: '正在取消',
    cancelled: '已取消',
  }[status] || status;
}

function statusTone(status) {
  if (status === 'success') return 'success';
  if (['running', 'pause_requested', 'paused', 'finished_with_errors'].includes(status)) return 'warning';
  if (['failed', 'cancel_requested', 'cancelled'].includes(status)) return 'danger';
  return 'neutral';
}

function typeLabel(type) {
  return {
    like: '批量点赞',
    comment: '批量评论',
    'analyze-comments': '理解评论',
    'reply-comments': '发布回复',
    'delete-comment': '删除评论',
    'dm-send': '私信发送',
    'comment-sync': '评论采集',
  }[type] || type;
}

export function BatchJobsPage() {
  const [jobs, setJobs] = useState([]);
  const [items, setItems] = useState([]);
  const [activeJobId, setActiveJobId] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [activeOperations, setActiveOperations] = useState(new Set());
  const [now, setNow] = useState(Date.now());

  function applyResult(result) {
    if (!result?.job) return;
    setJobs((current) => current.map((item) => (item.id === result.job.id ? result.job : item)));
    if (result.job.id === activeJobId || !activeJobId) {
      setActiveJobId(result.job.id);
      setItems(result.items || []);
    }
  }

  function setOperation(jobId, active) {
    setActiveOperations((current) => {
      const next = new Set(current);
      if (active) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

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

  async function refreshProgress() {
    const nextJobs = await listBatchJobs();
    setJobs(nextJobs);
    const nextActive = activeJobId || nextJobs[0]?.id || '';
    if (nextActive) setItems(await listBatchItems(nextActive));
  }

  async function handleRun(job) {
    setOperation(job.id, true);
    setJobs((current) => current.map((item) => (
      item.id === job.id ? { ...item, status: 'running' } : item
    )));
    setMessage('正在逐条执行，写操作会串行处理...');
    try {
      const result = await runBatchJob(job.id, {
        requiresBrowser: job.type !== 'analyze-comments',
        accountId: job.accountId,
      });
      applyResult(result);
      setMessage(result.job.status === 'paused' ? '任务已暂停，可稍后继续' : '批量任务执行完成');
    } catch (error) {
      setMessage(error.message || '批量任务执行失败');
    } finally {
      setOperation(job.id, false);
    }
  }

  async function handleControl(job, action) {
    const handlers = {
      pause: pauseBatchJob,
      cancel: cancelBatchJob,
      resume: resumeBatchJob,
      retry: retryFailedBatchItems,
    };
    const labels = {
      pause: '正在暂停任务...',
      cancel: '正在取消任务...',
      resume: '正在继续剩余任务...',
      retry: '正在重试失败项...',
    };
    setOperation(job.id, true);
    setMessage(labels[action]);
    try {
      const result = await handlers[action](job.id, {
        requiresBrowser: job.type !== 'analyze-comments',
        accountId: job.accountId,
      });
      applyResult(result);
      setMessage({
        pause: '暂停请求已提交',
        cancel: '任务已取消',
        resume: '剩余任务执行完成',
        retry: '失败项重试完成',
      }[action]);
    } catch (error) {
      setMessage(error.message || '任务操作失败');
    } finally {
      setOperation(job.id, false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const hasRunningJob = jobs.some((job) => ['running', 'pause_requested', 'cancel_requested'].includes(job.status));
    if (!hasRunningJob && !activeOperations.size) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      refreshProgress().catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [jobs, activeOperations, activeJobId]);

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
              <div className="progress-track" aria-label={`任务进度 ${job.successCount + job.failedCount + job.skippedCount}/${job.totalCount}`}>
                <span style={{ width: `${job.totalCount ? ((job.successCount + job.failedCount + job.skippedCount) / job.totalCount) * 100 : 0}%` }} />
              </div>
              {job.progressMessage ? <p>{job.progressMessage}</p> : null}
              {job.nextRunAt ? <p className="muted">{Math.max(0, Math.ceil((new Date(job.nextRunAt).getTime() - now) / 1000))} 秒后继续</p> : null}
              <p>创建时间：{job.createdAt}</p>
              <div className="button-row compact-actions">
                {['pending'].includes(job.status) ? (
                  <button type="button" className="primary-button" onClick={() => handleRun(job)} disabled={activeOperations.has(job.id)}><Play size={15} />执行</button>
                ) : null}
                {['running', 'pause_requested'].includes(job.status) ? (
                  <button type="button" onClick={() => handleControl(job, 'pause')} disabled={job.status === 'pause_requested'}><Pause size={15} />暂停</button>
                ) : null}
                {job.status === 'paused' ? (
                  <button type="button" className="primary-button" onClick={() => handleControl(job, 'resume')} disabled={activeOperations.has(job.id)}><Play size={15} />继续</button>
                ) : null}
                {['running', 'pause_requested', 'paused', 'pending'].includes(job.status) ? (
                  <button type="button" className="danger-button" onClick={() => handleControl(job, 'cancel')}><CircleStop size={15} />取消</button>
                ) : null}
                {job.status === 'finished_with_errors' && job.failedCount > 0 ? (
                  <button type="button" className="primary-button" onClick={() => handleControl(job, 'retry')} disabled={activeOperations.has(job.id)}><RotateCcw size={15} />仅重试失败项</button>
                ) : null}
              </div>
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
                  <td><code>{item.commentId || item.awemeId || '-'}</code></td>
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
