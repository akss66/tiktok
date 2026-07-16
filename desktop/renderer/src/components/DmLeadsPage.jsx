import { Fragment, useEffect, useMemo, useState } from 'react';
import { Check, Link, ListChecks, Pause, RefreshCw, RotateCcw, Send, Sparkles, Square } from 'lucide-react';
import {
  analyzeDmLeads,
  cancelBatchJob,
  createCommentSyncJob,
  createDmSendJob,
  listAccounts,
  listBatchItems,
  listBatchJobs,
  listDmLeadSources,
  listDmLeads,
  listSearchResults,
  listSearchSessions,
  pauseBatchJob,
  resolveExternalVideo,
  resumeBatchJob,
  retryFailedBatchItems,
  runBatchJob,
  updateDmLead,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { Pagination } from './Pagination.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const LEAD_PAGE_SIZE = 20;
const VIDEO_PAGE_SIZE = 10;

function intentLabel(value) {
  return { high: '高意向', medium: '中意向', low: '低意向', ignore: '忽略', unreviewed: '未分析' }[value] || value;
}

function intentTone(value) {
  if (value === 'high') return 'danger';
  if (value === 'medium') return 'warning';
  return 'neutral';
}

function statusLabel(value) {
  return {
    new: '待分析', draft: '待审核', approved: '已审核', sent: '已发送',
    failed: '发送失败', ignored: '已忽略',
  }[value] || value;
}

function statusTone(value) {
  if (value === 'sent') return 'success';
  if (value === 'approved' || value === 'draft') return 'warning';
  if (value === 'failed') return 'danger';
  return 'neutral';
}

function jobStatusLabel(value, runningLabel = '执行中') {
  return {
    pending: '待执行', running: runningLabel, success: '已完成', finished_with_errors: '部分失败',
    paused: '已暂停', pause_requested: '正在暂停', cancelled: '已取消', cancel_requested: '正在取消',
  }[value] || value;
}

function completedCount(job) {
  return job ? job.successCount + job.failedCount + job.skippedCount : 0;
}

export function DmLeadsPage() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [sourceMode, setSourceMode] = useState('link');
  const [shareInput, setShareInput] = useState('');
  const [resolvedVideo, setResolvedVideo] = useState(null);
  const [searchSessions, setSearchSessions] = useState([]);
  const [searchSessionId, setSearchSessionId] = useState('');
  const [searchVideos, setSearchVideos] = useState([]);
  const [selectedVideoIds, setSelectedVideoIds] = useState(new Set());
  const [videoPage, setVideoPage] = useState(1);
  const [targetCount, setTargetCount] = useState('');
  const [collectionJob, setCollectionJob] = useState(null);
  const [collectionItems, setCollectionItems] = useState([]);

  const [leads, setLeads] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState('');
  const [intentFilter, setIntentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sendJob, setSendJob] = useState(null);
  const [sendItems, setSendItems] = useState([]);
  const [expandedLeadId, setExpandedLeadId] = useState('');
  const [sourcesByLead, setSourcesByLead] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const filteredLeads = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return leads.filter((lead) => (
      (!keyword || `${lead.userName} ${lead.userId} ${lead.commentText} ${lead.sourceTexts || ''}`.toLowerCase().includes(keyword))
      && (!intentFilter || lead.intentLevel === intentFilter)
      && (!statusFilter || lead.status === statusFilter)
    ));
  }, [leads, query, intentFilter, statusFilter]);
  const pageLeads = useMemo(
    () => filteredLeads.slice((page - 1) * LEAD_PAGE_SIZE, page * LEAD_PAGE_SIZE),
    [filteredLeads, page],
  );
  const visibleVideos = useMemo(
    () => searchVideos.slice((videoPage - 1) * VIDEO_PAGE_SIZE, videoPage * VIDEO_PAGE_SIZE),
    [searchVideos, videoPage],
  );
  const selectedSourceIds = useMemo(() => (
    sourceMode === 'link'
      ? (resolvedVideo ? [resolvedVideo.awemeId] : [])
      : searchVideos.filter((video) => selectedVideoIds.has(video.awemeId)).map((video) => video.awemeId)
  ), [sourceMode, resolvedVideo, searchVideos, selectedVideoIds]);

  async function loadLeads(nextAccountId = accountId) {
    if (!nextAccountId) return setLeads([]);
    setLeads(await listDmLeads({ accountId: nextAccountId, limit: 1000 }));
  }

  async function selectAccount(nextAccountId) {
    setAccountId(nextAccountId);
    setResolvedVideo(null);
    setSearchSessionId('');
    setSearchVideos([]);
    setSelectedVideoIds(new Set());
    setSelected(new Set());
    setPage(1);
    setMessage('');
    if (!nextAccountId) {
      setSearchSessions([]);
      setLeads([]);
      return;
    }
    setLoading(true);
    try {
      const [sessions, nextLeads, jobs] = await Promise.all([
        listSearchSessions({ accountId: nextAccountId, limit: 3 }),
        listDmLeads({ accountId: nextAccountId, limit: 1000 }),
        listBatchJobs({ accountId: nextAccountId }),
      ]);
      setSearchSessions(sessions);
      setLeads(nextLeads);
      const latestCollection = jobs.find((job) => job.type === 'comment-sync') || null;
      const latestSend = jobs.find((job) => job.type === 'dm-send') || null;
      setCollectionJob(latestCollection);
      setSendJob(latestSend);
      setCollectionItems(latestCollection ? await listBatchItems(latestCollection.id) : []);
      setSendItems(latestSend ? await listBatchItems(latestSend.id) : []);
    } catch (error) {
      setMessage(error.message || '线索数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setMessage('');
    try {
      setAccounts(await listAccounts());
      if (accountId) await selectAccount(accountId);
    } catch (error) {
      setMessage(error.message || '页面刷新失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleResolveVideo() {
    if (!accountId || !shareInput.trim()) return setMessage('请选择账号并粘贴抖音分享链接');
    setLoading(true);
    setMessage('正在解析分享链接...');
    try {
      const video = await resolveExternalVideo({ accountId, input: shareInput.trim() });
      setResolvedVideo(video);
      setMessage(`已识别作品 ${video.awemeId}`);
    } catch (error) {
      setResolvedVideo(null);
      setMessage(error.message || '分享链接解析失败');
    } finally {
      setLoading(false);
    }
  }

  async function selectSearchSession(nextId) {
    setSearchSessionId(nextId);
    setSelectedVideoIds(new Set());
    setVideoPage(1);
    if (!nextId) return setSearchVideos([]);
    setLoading(true);
    try {
      setSearchVideos(await listSearchResults(nextId));
    } catch (error) {
      setMessage(error.message || '搜索结果加载失败');
    } finally {
      setLoading(false);
    }
  }

  function toggleVideo(awemeId) {
    setSelectedVideoIds((current) => {
      const next = new Set(current);
      if (next.has(awemeId)) next.delete(awemeId);
      else next.add(awemeId);
      return next;
    });
  }

  function selectAllVideos() {
    setSelectedVideoIds(new Set(searchVideos.map((video) => video.awemeId)));
  }

  function invertVideos() {
    setSelectedVideoIds((current) => new Set(
      searchVideos.filter((video) => !current.has(video.awemeId)).map((video) => video.awemeId),
    ));
  }

  async function refreshJob(jobId, setter, itemSetter) {
    const [jobs, items] = await Promise.all([listBatchJobs({ accountId }), listBatchItems(jobId)]);
    setter(jobs.find((job) => job.id === jobId) || null);
    itemSetter(items);
  }

  async function handleCollectComments() {
    if (!accountId || !selectedSourceIds.length) return setMessage('请选择账号和至少一个外部视频');
    const count = Math.max(1, Math.min(5000, Number(targetCount || 200)));
    setLoading(true);
    setMessage('正在创建评论采集任务...');
    try {
      const job = await createCommentSyncJob({ accountId, awemeIds: selectedSourceIds, targetCount: count });
      setCollectionJob(job);
      setCollectionItems(await listBatchItems(job.id));
      setLoading(false);
      setMessage('评论采集任务已创建，正在逐个视频采集');
      const result = await runBatchJob(job.id, { accountId });
      setCollectionJob(result.job);
      setCollectionItems(result.items);
      await loadLeads();
      setMessage(result.job.status === 'success' ? '评论采集完成，线索列表已更新' : '评论采集已结束，请查看进度和失败原因');
    } catch (error) {
      setMessage(error.message || '评论采集任务失败');
    } finally {
      setLoading(false);
    }
  }

  async function controlCollection(action) {
    if (!collectionJob) return;
    try {
      let result;
      if (action === 'pause') result = await pauseBatchJob(collectionJob.id);
      if (action === 'cancel') result = await cancelBatchJob(collectionJob.id);
      if (action === 'resume') {
        setCollectionJob((current) => ({ ...current, status: 'running', progressMessage: '正在继续评论采集' }));
        result = await resumeBatchJob(collectionJob.id, { accountId });
      }
      if (action === 'retry') {
        setCollectionJob((current) => ({ ...current, status: 'running', progressMessage: '正在重试失败视频' }));
        result = await retryFailedBatchItems(collectionJob.id, { accountId });
      }
      if (result?.job) {
        setCollectionJob(result.job);
        setCollectionItems(result.items || []);
        if (['resume', 'retry'].includes(action)) await loadLeads();
      } else {
        await refreshJob(collectionJob.id, setCollectionJob, setCollectionItems);
      }
    } catch (error) {
      setMessage(error.message || '采集任务操作失败');
    }
  }

  async function handleAnalyze() {
    const ids = [...selected];
    if (!ids.length) return setMessage('请先勾选需要分析的线索');
    setLoading(true);
    setMessage(`正在综合分析 ${ids.length} 位用户的来源评论...`);
    try {
      await analyzeDmLeads({ accountId, leadIds: ids });
      await loadLeads();
      setSelected(new Set());
      setMessage('意向分析和私信草稿已生成，请审核后发送');
    } catch (error) {
      setMessage(error.message || 'LLM 意向分析失败');
    } finally {
      setLoading(false);
    }
  }

  function updateLocalLead(id, patch) {
    setLeads((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function saveDraft(lead) {
    try {
      updateLocalLead(lead.id, await updateDmLead(lead.id, { draftText: lead.draftText, status: lead.status }));
    } catch (error) {
      setMessage(error.message || '草稿保存失败');
    }
  }

  async function handleApprove() {
    const candidates = leads.filter((lead) => selected.has(lead.id));
    if (!candidates.length) return setMessage('请先勾选需要审核的草稿');
    if (candidates.some((lead) => !lead.draftText.trim())) return setMessage('所选线索中存在空白私信草稿');
    setLoading(true);
    try {
      for (const lead of candidates) {
        await updateDmLead(lead.id, { draftText: lead.draftText, status: 'approved' });
      }
      await loadLeads();
      setSelected(new Set());
      setMessage(`已审核 ${candidates.length} 条私信草稿`);
    } catch (error) {
      setMessage(error.message || '草稿审核失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    const candidates = leads.filter((lead) => selected.has(lead.id) && ['approved', 'failed'].includes(lead.status));
    if (!candidates.length) return setMessage('请选择已经审核通过的私信草稿');
    setLoading(true);
    setMessage('正在创建私信发送队列...');
    try {
      const job = await createDmSendJob({ accountId, leadIds: candidates.map((lead) => lead.id) });
      setSendJob(job);
      setSendItems(await listBatchItems(job.id));
      setLoading(false);
      const result = await runBatchJob(job.id, { accountId });
      setSendJob(result.job);
      setSendItems(result.items);
      await loadLeads();
      setSelected(new Set());
      setMessage(result.job.status === 'success' ? '私信发送任务已完成' : '私信任务已结束，请查看失败原因');
    } catch (error) {
      setMessage(error.message || '私信任务创建或执行失败');
    } finally {
      setLoading(false);
    }
  }

  async function toggleLeadSources(leadId) {
    if (expandedLeadId === leadId) return setExpandedLeadId('');
    setExpandedLeadId(leadId);
    if (sourcesByLead[leadId]) return;
    try {
      const sources = await listDmLeadSources(leadId);
      setSourcesByLead((current) => ({ ...current, [leadId]: sources }));
    } catch (error) {
      setMessage(error.message || '来源评论加载失败');
    }
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => { setPage(1); }, [query, intentFilter, statusFilter]);
  useEffect(() => {
    const jobs = [
      [collectionJob, setCollectionJob, setCollectionItems],
      [sendJob, setSendJob, setSendItems],
    ].filter(([job]) => job && ['running', 'pause_requested', 'cancel_requested'].includes(job.status));
    if (!jobs.length) return undefined;
    const timer = window.setInterval(() => {
      for (const [job, setter, itemSetter] of jobs) refreshJob(job.id, setter, itemSetter).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [collectionJob?.id, collectionJob?.status, sendJob?.id, sendJob?.status]);

  const visibleLeadIds = pageLeads.map((lead) => lead.id);
  const allVisibleLeadsSelected = visibleLeadIds.length > 0 && visibleLeadIds.every((id) => selected.has(id));
  const visibleVideoIds = visibleVideos.map((video) => video.awemeId);
  const allVisibleVideosSelected = visibleVideoIds.length > 0 && visibleVideoIds.every((id) => selectedVideoIds.has(id));
  const collected = Number(collectionJob?.input?.savedComments || 0);
  const collectionTarget = Number(collectionJob?.input?.targetCount || 0);
  const collectionPercent = collectionTarget ? Math.min(100, (collected / collectionTarget) * 100) : 0;

  return (
    <section className="panel panel-wide dm-leads-page">
      <PageHeader
        title="线索私信"
        description="从外部视频评论中筛选意向客户，审核私信草稿后逐条发送。"
        actions={<button type="button" onClick={refresh} disabled={loading}><RefreshCw size={15} />刷新</button>}
      />

      <section className="panel-section dm-collection-card">
        <div className="dm-source-heading">
          <label><span>发送账号</span><SelectMenu value={accountId} onChange={(event) => selectAccount(event.target.value)} aria-label="发送账号"><option value="">请选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</SelectMenu></label>
          <div className="comment-mode-tabs" aria-label="视频来源">
            <button type="button" className={sourceMode === 'link' ? 'active' : ''} onClick={() => setSourceMode('link')}><Link size={15} />分享链接</button>
            <button type="button" className={sourceMode === 'search' ? 'active' : ''} onClick={() => setSourceMode('search')}><ListChecks size={15} />搜索结果</button>
          </div>
        </div>

        {sourceMode === 'link' ? (
          <div className="dm-link-source">
            <label><span>抖音分享链接或分享文案</span><textarea rows={2} value={shareInput} onChange={(event) => setShareInput(event.target.value)} /></label>
            <button type="button" onClick={handleResolveVideo} disabled={loading}>解析视频</button>
            <div className="dm-resolved-video">
              {resolvedVideo ? <><strong>{resolvedVideo.awemeId}</strong><span>已加入采集范围</span></> : <span>尚未解析视频</span>}
            </div>
          </div>
        ) : (
          <div className="dm-search-source">
            <div className="dm-search-toolbar">
              <label><span>历史搜索</span><SelectMenu value={searchSessionId} onChange={(event) => selectSearchSession(event.target.value)} aria-label="历史搜索"><option value="">请选择一次搜索结果</option>{searchSessions.map((session) => <option key={session.id} value={session.id}>{session.keyword} · {session.actualCount} 条</option>)}</SelectMenu></label>
              <div className="button-row compact">
                <button type="button" onClick={() => setSelectedVideoIds((current) => { const next = new Set(current); for (const id of visibleVideoIds) { if (allVisibleVideosSelected) next.delete(id); else next.add(id); } return next; })}>选择当前页</button>
                <button type="button" onClick={selectAllVideos}>全选全部</button>
                <button type="button" onClick={invertVideos}>反选</button>
                <button type="button" onClick={() => setSelectedVideoIds(new Set())}>清空</button>
              </div>
            </div>
            <div className="dm-video-picker">
              {visibleVideos.map((video) => (
                <label key={video.awemeId} className="dm-video-option">
                  <input type="checkbox" checked={selectedVideoIds.has(video.awemeId)} onChange={() => toggleVideo(video.awemeId)} />
                  <span><strong>{video.desc || '未命名视频'}</strong><small>{video.authorName || video.awemeId}</small></span>
                </label>
              ))}
              {!visibleVideos.length ? <div className="empty-row">选择历史搜索后显示视频。</div> : null}
            </div>
            <Pagination page={videoPage} pageSize={VIDEO_PAGE_SIZE} total={searchVideos.length} onPageChange={setVideoPage} noun="个视频" />
          </div>
        )}

        <div className="dm-collection-footer">
          <div><strong>已选择 {selectedSourceIds.length} 个视频</strong><span>后端将逐个视频、逐页采集</span></div>
          <label><span>评论总量</span><input type="number" min="1" max="5000" value={targetCount} onChange={(event) => setTargetCount(event.target.value)} /><small>留空使用 200</small></label>
          <button type="button" className="primary-button" onClick={handleCollectComments} disabled={loading || !selectedSourceIds.length}>开始采集评论</button>
        </div>
      </section>

      {collectionJob ? (
        <section className="operation-progress" aria-live="polite">
          <div className="operation-progress-head">
            <div><RefreshCw size={16} /><strong>{jobStatusLabel(collectionJob.status, '采集中')}</strong></div>
            <span>评论 {collected}/{collectionTarget} · 视频 {collectionJob.input?.processedVideos || 0}/{collectionJob.totalCount}</span>
          </div>
          <div className="progress-track"><span style={{ width: `${collectionPercent}%` }} /></div>
          <div className="operation-progress-meta"><span>成功 {collectionJob.successCount}，失败 {collectionJob.failedCount}，跳过 {collectionJob.skippedCount}</span><span>{collectionJob.progressMessage}</span></div>
          <div className="button-row compact">
            {['running', 'pause_requested'].includes(collectionJob.status) ? <button type="button" onClick={() => controlCollection('pause')}><Pause size={14} />暂停</button> : null}
            {collectionJob.status === 'paused' ? <button type="button" onClick={() => controlCollection('resume')}><RotateCcw size={14} />继续</button> : null}
            {collectionJob.failedCount > 0 && !['running', 'pause_requested'].includes(collectionJob.status) ? <button type="button" onClick={() => controlCollection('retry')}>仅重试失败项</button> : null}
            {!['success', 'finished_with_errors', 'cancelled'].includes(collectionJob.status) ? <button type="button" onClick={() => controlCollection('cancel')}><Square size={14} />取消</button> : null}
          </div>
          {collectionItems.some((item) => item.error) ? <p className="inline-error">{collectionItems.find((item) => item.error)?.error}</p> : null}
        </section>
      ) : null}

      <section className="panel-section dm-filter-bar">
        <label><span>关键词</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span>意向等级</span><SelectMenu value={intentFilter} onChange={(event) => setIntentFilter(event.target.value)} aria-label="意向等级"><option value="">全部意向</option><option value="high">高意向</option><option value="medium">中意向</option><option value="low">低意向</option><option value="ignore">忽略</option><option value="unreviewed">未分析</option></SelectMenu></label>
        <label><span>处理状态</span><SelectMenu value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="处理状态"><option value="">全部状态</option><option value="new">待分析</option><option value="draft">待审核</option><option value="approved">已审核</option><option value="sent">已发送</option><option value="failed">发送失败</option></SelectMenu></label>
        <div className="button-row compact dm-lead-actions">
          <button type="button" onClick={handleAnalyze} disabled={loading}><Sparkles size={15} />分析所选</button>
          <button type="button" onClick={handleApprove} disabled={loading}><Check size={15} />审核所选</button>
          <button type="button" className="primary-button" onClick={handleSend} disabled={loading}><Send size={15} />创建发送任务</button>
        </div>
      </section>

      {message ? <p className={message.includes('失败') || message.includes('请选择') || message.includes('空白') ? 'inline-error' : 'muted'}>{message}</p> : null}

      {sendJob ? (
        <section className="operation-progress" aria-live="polite">
          <div className="operation-progress-head"><div><Send size={16} /><strong>{jobStatusLabel(sendJob.status, '发送中')}</strong></div><span>{completedCount(sendJob)}/{sendJob.totalCount}</span></div>
          <div className="progress-track"><span style={{ width: `${sendJob.totalCount ? (completedCount(sendJob) / sendJob.totalCount) * 100 : 0}%` }} /></div>
          <div className="operation-progress-meta"><span>成功 {sendJob.successCount}，失败 {sendJob.failedCount}，跳过 {sendJob.skippedCount}</span><span>{sendJob.progressMessage}</span></div>
          {sendItems.some((item) => item.error) ? <p className="inline-error">{sendItems.find((item) => item.error)?.error}</p> : null}
        </section>
      ) : null}

      <div className="table-wrap results-table-wrap">
        <table className="dense-table dm-leads-table">
          <thead><tr><th><input type="checkbox" checked={allVisibleLeadsSelected} onChange={() => setSelected((current) => { const next = new Set(current); for (const id of visibleLeadIds) { if (allVisibleLeadsSelected) next.delete(id); else next.add(id); } return next; })} aria-label="选择当前页线索" /></th><th>用户</th><th>来源评论</th><th>意向</th><th>判断理由</th><th>私信草稿</th><th>状态</th></tr></thead>
          <tbody>
            {pageLeads.map((lead) => (
              <Fragment key={lead.id}>
                <tr>
                  <td><input type="checkbox" checked={selected.has(lead.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(lead.id)) next.delete(lead.id); else next.add(lead.id); return next; })} aria-label={`选择 ${lead.userName || lead.userId}`} /></td>
                  <td><strong>{lead.userName || '未命名用户'}</strong><code>{lead.userId}</code></td>
                  <td><p>{lead.commentText}</p><button type="button" className="text-button" onClick={() => toggleLeadSources(lead.id)}>{lead.sourceCount || 1} 条来源</button></td>
                  <td><span className={`status-badge ${intentTone(lead.intentLevel)}`}>{intentLabel(lead.intentLevel)}</span></td>
                  <td>{lead.reason || '-'}</td>
                  <td><textarea rows={3} value={lead.draftText} disabled={lead.status === 'sent'} onChange={(event) => updateLocalLead(lead.id, { draftText: event.target.value, status: lead.status === 'approved' ? 'draft' : lead.status })} onBlur={() => saveDraft(lead)} /></td>
                  <td><span className={`status-badge ${statusTone(lead.status)}`}>{statusLabel(lead.status)}</span>{lead.lastError ? <small className="row-error">{lead.lastError}</small> : null}</td>
                </tr>
                {expandedLeadId === lead.id ? (
                  <tr className="dm-source-detail-row"><td colSpan="7"><div className="dm-source-list">{(sourcesByLead[lead.id] || []).map((source) => <article key={source.commentId}><strong>{source.userName || lead.userName}</strong><span>{source.commentText}</span><code>{source.awemeId}</code></article>)}</div></td></tr>
                ) : null}
              </Fragment>
            ))}
            {!pageLeads.length ? <tr><td colSpan="7" className="empty-row">采集外部视频评论后，这里会显示按用户去重的线索。</td></tr> : null}
          </tbody>
        </table>
        <Pagination page={page} pageSize={LEAD_PAGE_SIZE} total={filteredLeads.length} onPageChange={setPage} noun="位线索" />
      </div>
    </section>
  );
}
