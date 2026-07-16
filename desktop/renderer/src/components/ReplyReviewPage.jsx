import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import {
  approveReplyDraft,
  cancelBatchJob,
  createBatchJob,
  listAccounts,
  listBatchItems,
  listBatchJobs,
  listComments,
  listReplyDrafts,
  listVideos,
  pauseBatchJob,
  resumeBatchJob,
  retryFailedBatchItems,
  runBatchJob,
  syncComments,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { Pagination } from './Pagination.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const PAGE_SIZE = 50;
const ACTIVE_JOB_STATUSES = new Set(['pending', 'running', 'pause_requested', 'paused', 'cancel_requested']);

function toneForIntent(level) {
  if (level === '高') return 'success';
  if (level === '中') return 'warning';
  return 'neutral';
}

function statusLabel(status) {
  return {
    draft: '待审核', approved: '已审核', published: '已发布', ignored: '无需回复',
    needs_knowledge: '知识不足', needs_edit: '需精简', pending: '待执行', running: '执行中', paused: '已暂停',
    pause_requested: '正在暂停', cancel_requested: '正在取消', cancelled: '已取消',
    success: '已完成', finished_with_errors: '部分失败', failed: '失败', skipped: '已跳过',
  }[status] || status;
}

function jobTypeLabel(type) {
  return {
    'analyze-comments': '理解评论',
    'reply-comments': '发布回复',
    'delete-comment': '删除评论',
  }[type] || type;
}

function countdown(nextRunAt, now) {
  if (!nextRunAt) return '';
  const seconds = Math.max(0, Math.ceil((new Date(nextRunAt).getTime() - now) / 1000));
  return `${seconds} 秒后继续`;
}

function JobProgress({ job, items, now, onControl, busy }) {
  if (!job) return null;
  const completed = job.successCount + job.failedCount + job.skippedCount;
  const percent = job.totalCount ? Math.round((completed / job.totalCount) * 100) : 0;
  return (
    <section className="operation-progress" aria-live="polite">
      <div className="operation-progress-head">
        <div>
          <strong>{jobTypeLabel(job.type)}</strong>
          <span className={`status-badge ${job.status === 'success' ? 'success' : job.failedCount ? 'danger' : 'warning'}`}>
            {statusLabel(job.status)}
          </span>
        </div>
        <span>{completed}/{job.totalCount} · {percent}%</span>
      </div>
      <div className="progress-track" aria-label={`任务进度 ${completed}/${job.totalCount}`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="operation-progress-meta">
        <span>{job.progressMessage || '等待执行'}</span>
        <span>{countdown(job.nextRunAt, now)}</span>
        <span>成功 {job.successCount} · 失败 {job.failedCount} · 跳过 {job.skippedCount}</span>
      </div>
      <div className="button-row compact">
        {['running', 'pause_requested'].includes(job.status) ? (
          <button type="button" onClick={() => onControl('pause')} disabled={busy || job.status === 'pause_requested'}><Pause size={15} />暂停</button>
        ) : null}
        {job.status === 'paused' ? (
          <button type="button" className="primary-button" onClick={() => onControl('resume')} disabled={busy}><Play size={15} />继续</button>
        ) : null}
        {ACTIVE_JOB_STATUSES.has(job.status) && job.status !== 'cancel_requested' ? (
          <button type="button" className="danger-button" onClick={() => onControl('cancel')} disabled={busy}>取消任务</button>
        ) : null}
        {job.status === 'finished_with_errors' && job.failedCount ? (
          <button type="button" onClick={() => onControl('retry')} disabled={busy}><RotateCcw size={15} />仅重试失败项</button>
        ) : null}
      </div>
      {items.some((item) => item.error) ? (
        <p className="inline-error">{items.find((item) => item.error)?.error}</p>
      ) : null}
    </section>
  );
}

export function ReplyReviewPage() {
  const [accounts, setAccounts] = useState([]);
  const [videos, setVideos] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [awemeId, setAwemeId] = useState('');
  const [comments, setComments] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [mode, setMode] = useState('reply');
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState({});
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [jobItems, setJobItems] = useState([]);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef(null);

  const draftByComment = useMemo(() => new Map(drafts.map((draft) => [draft.commentId, draft])), [drafts]);
  const eligibleComments = useMemo(
    () => comments.filter((comment) => !comment.replied && !comment.deleted && !comment.isOwn),
    [comments],
  );
  const replyRows = useMemo(() => eligibleComments.filter((comment) => {
    const draft = draftByComment.get(comment.cid);
    return draft && ['高', '中'].includes(draft.intentLevel);
  }), [eligibleComments, draftByComment]);
  const deleteRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return comments.filter((comment) => !comment.deleted);
    return comments.filter((comment) => !comment.deleted && (
      comment.userName.toLowerCase().includes(keyword) || comment.text.toLowerCase().includes(keyword)
    ));
  }, [comments, query]);
  const rows = mode === 'reply' ? replyRows : deleteRows;
  const selectableRows = mode === 'reply'
    ? replyRows.filter((comment) => Boolean(draftByComment.get(comment.cid)?.draftText))
    : deleteRows;
  const visibleRows = useMemo(() => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [rows, page]);

  async function loadWorkspace(nextAccountId = accountId, nextAwemeId = awemeId) {
    const [nextComments, nextDrafts] = await Promise.all([
      nextAwemeId ? listComments({ accountId: nextAccountId, awemeId: nextAwemeId, deleted: false, limit: 5000 }) : [],
      nextAccountId ? listReplyDrafts({ accountId: nextAccountId, limit: 5000 }) : [],
    ]);
    setComments(nextComments);
    setDrafts(nextDrafts.filter((draft) => !nextAwemeId || draft.awemeId === nextAwemeId));
    setSelected(new Set());
    setPage(1);
  }

  async function initialize(nextAccountId = accountId) {
    setLoading(true);
    setMessage('');
    try {
      const nextAccounts = await listAccounts();
      const resolvedAccountId = nextAccounts.some((account) => account.id === nextAccountId) ? nextAccountId : '';
      const nextVideos = resolvedAccountId ? await listVideos({ accountId: resolvedAccountId, isMine: true, limit: 500 }) : [];
      const nextAwemeId = nextVideos[0]?.awemeId || '';
      setAccounts(nextAccounts);
      setAccountId(resolvedAccountId);
      setVideos(nextVideos);
      setAwemeId(nextAwemeId);
      await loadWorkspace(resolvedAccountId, nextAwemeId);
      const jobs = resolvedAccountId ? await listBatchJobs({ accountId: resolvedAccountId }) : [];
      const latest = jobs.find((job) => ['analyze-comments', 'reply-comments', 'delete-comment'].includes(job.type));
      if (latest) {
        setActiveJob(latest);
        setJobItems(await listBatchItems(latest.id));
      }
    } catch (error) {
      setMessage(error.message || '评论管理数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function selectVideo(nextAwemeId) {
    setAwemeId(nextAwemeId);
    setLoading(true);
    setMessage('');
    try {
      await loadWorkspace(accountId, nextAwemeId);
    } catch (error) {
      setMessage(error.message || '评论加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    if (!accountId || !awemeId) return setMessage('请选择账号和作品');
    setLoading(true);
    setMessage('正在逐页同步一级评论和回复，请勿关闭应用...');
    try {
      const result = await syncComments(awemeId, { accountId, count: 5000 });
      await loadWorkspace(accountId, awemeId);
      setMessage(`同步完成：保存 ${result.summary?.saved ?? result.items?.length ?? 0} 条评论`);
    } catch (error) {
      setMessage(error.message || '同步评论失败');
    } finally {
      setLoading(false);
    }
  }

  async function pollJob(jobId) {
    const jobs = await listBatchJobs({ accountId });
    const job = jobs.find((item) => item.id === jobId);
    if (job) setActiveJob(job);
    setJobItems(await listBatchItems(jobId));
    return job;
  }

  function startPolling(jobId) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => pollJob(jobId).catch(() => {}), 1000);
  }

  async function executeJob(job) {
    setActiveJob(job);
    setJobItems(await listBatchItems(job.id));
    startPolling(job.id);
    try {
      const result = await runBatchJob(job.id, {
        requiresBrowser: job.type !== 'analyze-comments',
        accountId: job.accountId,
      });
      setActiveJob(result.job);
      setJobItems(result.items || []);
      await loadWorkspace(accountId, awemeId);
      setMessage(`${jobTypeLabel(job.type)}任务已结束`);
    } catch (error) {
      setMessage(error.message || '任务执行失败');
      await pollJob(job.id).catch(() => {});
    } finally {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function createAndRun(type, commentIds) {
    try {
      const job = await createBatchJob({ accountId, awemeId, type, commentIds });
      setSelected(new Set());
      await executeJob(job);
    } catch (error) {
      setMessage(error.message || '创建批量任务失败');
    }
  }

  async function analyzeAll() {
    if (!eligibleComments.length) return setMessage('当前作品没有可分析的新评论');
    setMessage(`准备理解 ${eligibleComments.length} 条评论...`);
    await createAndRun('analyze-comments', eligibleComments.map((comment) => comment.cid));
  }

  async function publishSelected() {
    const selectedDrafts = replyRows.map((comment) => draftByComment.get(comment.cid))
      .filter((draft) => selected.has(draft.commentId));
    if (!selectedDrafts.length) return setMessage('请先选择要发布的回复');
    setLoading(true);
    setMessage('正在保存审核内容...');
    try {
      for (const draft of selectedDrafts) {
        await approveReplyDraft(draft.id, { draftText: editing[draft.id] ?? draft.draftText });
      }
      setLoading(false);
      await createAndRun('reply-comments', selectedDrafts.map((draft) => draft.commentId));
    } catch (error) {
      setLoading(false);
      setMessage(error.message || '审核或创建发布任务失败');
    }
  }

  async function deleteSelected() {
    const ids = rows.filter((comment) => selected.has(comment.cid)).map((comment) => comment.cid);
    if (!ids.length) return setMessage('请先选择要删除的评论');
    if (!window.confirm(`确定删除选中的 ${ids.length} 条评论吗？删除后无法恢复。`)) return;
    await createAndRun('delete-comment', ids);
  }

  function selectAll() {
    setSelected(new Set(selectableRows.map((comment) => comment.cid)));
  }

  function invertSelection() {
    setSelected((current) => new Set(selectableRows.filter((comment) => !current.has(comment.cid)).map((comment) => comment.cid)));
  }

  function toggle(cid) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(cid)) next.delete(cid); else next.add(cid);
      return next;
    });
  }

  async function handleControl(action) {
    if (!activeJob) return;
    setLoading(true);
    try {
      const handlers = { pause: pauseBatchJob, cancel: cancelBatchJob, resume: resumeBatchJob, retry: retryFailedBatchItems };
      if (action === 'resume' || action === 'retry') startPolling(activeJob.id);
      const requiresBrowser = activeJob.type !== 'analyze-comments';
      const result = await handlers[action](activeJob.id, { requiresBrowser, accountId: activeJob.accountId });
      setActiveJob(result.job);
      setJobItems(result.items || []);
      if (action === 'resume' || action === 'retry') await loadWorkspace(accountId, awemeId);
    } catch (error) {
      setMessage(error.message || '任务控制失败');
    } finally {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      setLoading(false);
    }
  }

  useEffect(() => { initialize(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  return (
    <section className="panel">
      <PageHeader
        title="评论管理"
        description="理解自己作品的评论，基于知识库审核回复，或按昵称和内容筛选删除。"
        actions={<button type="button" onClick={() => initialize(accountId)} disabled={loading}>刷新</button>}
      />

      <div className="panel-section comment-context-bar">
        <label><span>账号</span><SelectMenu value={accountId} onChange={(event) => initialize(event.target.value)} aria-label="账号"><option value="">请选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</SelectMenu></label>
        <label><span>我的作品</span><SelectMenu value={awemeId} onChange={(event) => selectVideo(event.target.value)} aria-label="我的作品"><option value="">请选择作品</option>{videos.map((video) => <option key={video.awemeId} value={video.awemeId}>{video.desc || video.awemeId}</option>)}</SelectMenu></label>
        <button type="button" className="primary-button" onClick={handleSync} disabled={loading || !awemeId}>同步评论区</button>
      </div>

      {loading && message.includes('同步') ? <div className="indeterminate-progress"><span /></div> : null}
      {message ? <p className={message.includes('失败') || message.includes('请选择') ? 'inline-error' : 'muted'}>{message}</p> : null}
      <JobProgress job={activeJob} items={jobItems} now={now} onControl={handleControl} busy={loading} />

      <div className="segmented-control comment-mode-tabs" aria-label="评论管理模式">
        <button type="button" className={mode === 'reply' ? 'active' : ''} onClick={() => { setMode('reply'); setSelected(new Set()); setPage(1); }}>理解与回复</button>
        <button type="button" className={mode === 'delete' ? 'active' : ''} onClick={() => { setMode('delete'); setSelected(new Set()); setPage(1); }}>评论清理</button>
      </div>

      {mode === 'reply' ? (
        <div className="comment-toolbar">
          <div><strong>可分析 {eligibleComments.length} 条</strong><span>高/中意向 {replyRows.length} 条</span></div>
          <div className="button-row compact">
            <button type="button" onClick={analyzeAll} disabled={loading || !eligibleComments.length}>理解全部评论</button>
            <button type="button" onClick={selectAll} disabled={!replyRows.length}>全选意向客户</button>
            <button type="button" className="primary-button" onClick={publishSelected} disabled={loading || !selected.size}>审核并发布所选</button>
          </div>
        </div>
      ) : (
        <div className="comment-toolbar delete-toolbar">
          <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelected(new Set()); setPage(1); }} /></label>
          <div className="button-row compact">
            <span>找到 {deleteRows.length} 条</span>
            <button type="button" onClick={selectAll} disabled={!deleteRows.length}>全选</button>
            <button type="button" onClick={invertSelection} disabled={!deleteRows.length}>反选</button>
            <button type="button" className="danger-button" onClick={deleteSelected} disabled={loading || !selected.size}><Trash2 size={15} />删除所选</button>
          </div>
        </div>
      )}

      <div className="table-wrap results-table-wrap">
        <table className="dense-table comment-management-table">
          <thead><tr><th className="check-col"><input type="checkbox" checked={Boolean(selectableRows.length && selected.size === selectableRows.length)} onChange={() => (selected.size === selectableRows.length ? setSelected(new Set()) : selectAll())} aria-label="全选当前结果" /></th><th>评论用户与内容</th>{mode === 'reply' ? <><th>理解结果</th><th>回复草稿</th></> : <><th>层级</th><th>状态</th></>}</tr></thead>
          <tbody>
            {visibleRows.map((comment) => {
              const draft = draftByComment.get(comment.cid);
              return (
                <tr key={comment.cid} className={comment.depth ? 'nested-comment-row' : ''}>
                  <td><input type="checkbox" checked={selected.has(comment.cid)} disabled={mode === 'reply' && !draft?.draftText} onChange={() => toggle(comment.cid)} aria-label={`选择 ${comment.cid}`} /></td>
                  <td><strong>{comment.userName || '未命名用户'}</strong><p>{comment.text || '无文字内容'}</p><code>{comment.cid}</code></td>
                  {mode === 'reply' ? <><td><span className={`status-badge ${toneForIntent(draft?.intentLevel)}`}>{draft?.intentLevel || '未分析'}</span><p>{draft?.category || '-'}</p><p className="muted">{draft?.reason || '-'}</p>{draft?.knowledgeRefs?.length ? <p className="muted">知识：{draft.knowledgeRefs.join('、')}</p> : null}</td><td>{draft ? <><textarea value={editing[draft.id] ?? draft.draftText} onChange={(event) => setEditing((current) => ({ ...current, [draft.id]: event.target.value }))} rows={3} disabled={!draft.draftText} /><span className="muted">{statusLabel(draft.status)}</span></> : '-'}</td></> : <><td>{comment.depth ? '二级回复' : '一级评论'}</td><td><span className="status-badge neutral">可删除</span></td></>}
                </tr>
              );
            })}
            {!visibleRows.length ? <tr><td colSpan="4" className="empty-row">{mode === 'reply' ? '暂无高/中意向评论。请先同步并理解全部评论。' : '没有符合关键词的评论。'}</td></tr> : null}
          </tbody>
        </table>
        <Pagination page={page} pageSize={PAGE_SIZE} total={rows.length} onPageChange={setPage} noun="条评论" />
      </div>
    </section>
  );
}
