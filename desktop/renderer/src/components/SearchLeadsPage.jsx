import { useEffect, useMemo, useState } from 'react';
import { createBatchJob, createSearchSession, friendlyError, listAccounts, listSearchSessions, listSearchResults } from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { Pagination } from './Pagination.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const RESULT_PAGE_SIZE = 50;

function compact(text, limit = 86) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function SearchSummary({ summary }) {
  if (!summary) return null;
  return (
    <div className="search-summary" role="status">
      <span>请求 {summary.requested ?? 0} 条</span>
      <span>接口返回 {summary.fetched ?? 0} 条</span>
      <span>本次显示 {summary.saved ?? 0} 条</span>
      {summary.excludeKnown ? <span>已保存跳过 {summary.skippedKnown ?? 0} 条</span> : null}
      {summary.stoppedReason === 'no_progress' ? <span>已停止：连续页面没有新增结果</span> : null}
      {summary.stoppedReason === 'empty_pages' ? <span>已停止：连续空结果</span> : null}
      {summary.warning ? <strong>{summary.warning}</strong> : null}
    </div>
  );
}

function formatSearchLoading(includeSaved) {
  return includeSaved
    ? '正在搜索，最多执行 500 条，会包含已保存视频...'
    : '正在搜索，最多执行 500 条，会自动跳过已保存视频...';
}

function formatSearchDone(result, includeSaved) {
  const summary = result.summary || {};
  const saved = summary.saved ?? result.session?.actualCount ?? 0;
  const fetched = summary.fetched ?? 0;
  const skipped = summary.skippedKnown ?? 0;
  if (includeSaved) {
    return `搜索完成：接口返回 ${fetched} 条，本次显示 ${saved} 条`;
  }
  return `搜索完成：新增 ${saved} 条视频，已保存跳过 ${skipped} 条`;
}

export function SearchLeadsPage() {
  const [accounts, setAccounts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [activeSessionId, setActiveSessionId] = useState('');
  const [form, setForm] = useState({ accountId: '', keyword: '', count: '', includeSaved: false });
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState(null);
  const [page, setPage] = useState(1);

  const selectedVideos = useMemo(
    () => results.filter((video) => selected.has(video.awemeId)),
    [results, selected],
  );
  const visibleResults = useMemo(
    () => results.slice((page - 1) * RESULT_PAGE_SIZE, page * RESULT_PAGE_SIZE),
    [results, page],
  );
  const pageFullySelected = Boolean(
    visibleResults.length && visibleResults.every((video) => selected.has(video.awemeId)),
  );

  async function refresh() {
    setLoading(true);
    setMessage('');
    try {
      const [nextAccounts, nextSessions] = await Promise.all([listAccounts(), listSearchSessions({ limit: 3 })]);
      setAccounts(nextAccounts);
      setSessions(nextSessions.slice(0, 3));
      setForm((current) => ({
        ...current,
        accountId: nextAccounts.some((account) => account.id === current.accountId) ? current.accountId : '',
      }));
    } catch (error) {
      setMessage(error.message || '加载搜索数据失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadResults(sessionId) {
    setActiveSessionId(sessionId);
    setSelected(new Set());
    setPage(1);
    setSummary(null);
    if (!sessionId) {
      setResults([]);
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      setResults(await listSearchResults(sessionId));
    } catch (error) {
      setMessage(error.message || '加载搜索结果失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (!form.accountId) {
      setMessage('请选择账号');
      return;
    }
    if (!form.keyword.trim()) {
      setMessage('请输入关键词');
      return;
    }
    const count = Number(form.count);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      setMessage('请输入 1-500 之间的执行数量');
      return;
    }
    setLoading(true);
    setMessage(formatSearchLoading(form.includeSaved));
    try {
      const result = await createSearchSession({
        accountId: form.accountId,
        keyword: form.keyword.trim(),
        count,
        excludeKnown: !form.includeSaved,
      });
      setSessions((items) => [result.session, ...items.filter((item) => item.id !== result.session.id)].slice(0, 3));
      setResults(result.results || []);
      setSummary(result.summary || null);
      setActiveSessionId(result.session.id);
      setSelected(new Set());
      setPage(1);
      setMessage(formatSearchDone(result, form.includeSaved));
    } catch (error) {
      setMessage(friendlyError(error, '搜索失败，请确认内置浏览器已登录并在线'));
    } finally {
      setLoading(false);
    }
  }

  function toggle(awemeId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(awemeId)) next.delete(awemeId);
      else next.add(awemeId);
      return next;
    });
  }

  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      if (pageFullySelected) visibleResults.forEach((video) => next.delete(video.awemeId));
      else visibleResults.forEach((video) => next.add(video.awemeId));
      return next;
    });
  }

  function selectAllResults() {
    setSelected(new Set(results.map((video) => video.awemeId)));
  }

  async function createBatch(type) {
    if (!form.accountId) {
      setMessage('请选择账号');
      return;
    }
    if (!selectedVideos.length) {
      setMessage('请先勾选视频');
      return;
    }
    if (type === 'comment' && !commentText.trim()) {
      setMessage('请填写批量评论内容');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const payload = {
        accountId: form.accountId,
        type,
        awemeIds: selectedVideos.map((video) => video.awemeId),
        commentText: commentText.trim(),
      };
      await createBatchJob(payload);
      setMessage(`已创建批量${type === 'like' ? '点赞' : '评论'}任务：${selectedVideos.length} 条`);
    } catch (error) {
      setMessage(error.message || '创建批量任务失败');
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
        title="搜索获客"
        description="按关键词批量获取不重复视频，勾选后创建批量点赞或评论任务。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新</button>}
      />

      <form className="inline-form search-form" onSubmit={handleSearch}>
        <label>
          <span>账号</span>
          <SelectMenu value={form.accountId} onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))} aria-label="账号">
            <option value="">请选择账号</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </SelectMenu>
        </label>
        <label>
          <span>关键词</span>
          <input value={form.keyword} onChange={(event) => setForm((current) => ({ ...current, keyword: event.target.value }))} />
        </label>
        <label>
          <span>执行数量</span>
          <input type="number" min="1" max="500" value={form.count} onChange={(event) => setForm((current) => ({ ...current, count: event.target.value }))} />
        </label>
        <label>
          <span>结果策略</span>
          <SelectMenu
            value={form.includeSaved ? 'all' : 'new'}
            onChange={(event) => setForm((current) => ({ ...current, includeSaved: event.target.value === 'all' }))}
            aria-label="结果策略"
          >
            <option value="new">只看新视频</option>
            <option value="all">包含已保存视频</option>
          </SelectMenu>
        </label>
        <button type="submit" className="primary-button" disabled={loading}>开始搜索</button>
      </form>

      <div className="panel-section action-strip">
        <label>
          <span>历史搜索</span>
          <SelectMenu value={activeSessionId} onChange={(event) => loadResults(event.target.value)} aria-label="历史搜索">
            <option value="">选择一次搜索结果</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.keyword} · {session.actualCount}/{session.targetCount} · {session.status}
              </option>
            ))}
          </SelectMenu>
        </label>
        <label className="wide-field">
          <span>批量评论内容</span>
          <input value={commentText} onChange={(event) => setCommentText(event.target.value)} />
        </label>
        <button type="button" onClick={() => createBatch('like')} disabled={loading}>创建点赞任务</button>
        <button type="button" className="primary-button" onClick={() => createBatch('comment')} disabled={loading}>创建评论任务</button>
      </div>

      {message ? <p className={message.includes('失败') || message.includes('请选择') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <SearchSummary summary={summary} />

      {results.length ? (
        <div className="results-toolbar">
          <div>
            <strong>{results.length} 条结果</strong>
            <span>已选择 {selected.size} 条</span>
          </div>
          <div className="button-row compact">
            <button type="button" onClick={togglePage}>{pageFullySelected ? '取消本页' : '选择本页'}</button>
            <button type="button" onClick={selectAllResults} disabled={selected.size === results.length}>全选全部结果</button>
            <button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size}>清空选择</button>
          </div>
        </div>
      ) : null}

      <div className="table-wrap results-table-wrap">
        <table className="dense-table">
          <thead>
            <tr>
              <th className="check-col"><input type="checkbox" checked={pageFullySelected} onChange={togglePage} aria-label="选择当前页视频" /></th>
              <th>视频</th>
              <th>作者</th>
              <th>状态</th>
              <th>链接</th>
            </tr>
          </thead>
          <tbody>
            {visibleResults.map((video) => (
              <tr key={video.awemeId}>
                <td><input type="checkbox" checked={selected.has(video.awemeId)} onChange={() => toggle(video.awemeId)} aria-label={`选择 ${video.awemeId}`} /></td>
                <td>
                  <strong>{video.awemeId}</strong>
                  <p>{compact(video.desc)}</p>
                </td>
                <td>{video.authorName || '-'}</td>
                <td>
                  {video.liked ? <span className="status-badge success">已点赞</span> : <span className="status-badge neutral">未点赞</span>}
                  {video.commented ? <span className="status-badge success">已评论</span> : <span className="status-badge neutral">未评论</span>}
                </td>
                <td><code title={video.url}>{video.url}</code></td>
              </tr>
            ))}
            {!results.length ? (
              <tr><td colSpan="5" className="empty-row">{loading ? '搜索中...' : '暂无搜索结果。'}</td></tr>
            ) : null}
          </tbody>
        </table>
        <Pagination page={page} pageSize={RESULT_PAGE_SIZE} total={results.length} onPageChange={setPage} noun="条视频" />
      </div>
    </section>
  );
}
