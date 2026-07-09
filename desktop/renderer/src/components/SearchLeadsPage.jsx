import { useEffect, useMemo, useState } from 'react';
import { createBatchJob, createSearchSession, friendlyError, listAccounts, listSearchSessions, listSearchResults } from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function compact(text, limit = 86) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function SearchLeadsPage() {
  const [accounts, setAccounts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [activeSessionId, setActiveSessionId] = useState('');
  const [form, setForm] = useState({ accountId: '', keyword: 'geo', count: 10 });
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const selectedVideos = useMemo(
    () => results.filter((video) => selected.has(video.awemeId)),
    [results, selected],
  );

  async function refresh() {
    setLoading(true);
    setMessage('');
    try {
      const [nextAccounts, nextSessions] = await Promise.all([listAccounts(), listSearchSessions()]);
      setAccounts(nextAccounts);
      setSessions(nextSessions);
      setForm((current) => ({ ...current, accountId: current.accountId || nextAccounts[0]?.id || '' }));
    } catch (error) {
      setMessage(error.message || '加载搜索数据失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadResults(sessionId) {
    setActiveSessionId(sessionId);
    setSelected(new Set());
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
    setLoading(true);
    setMessage('正在搜索，最多获取 500 条并自动跳过已保存的视频...');
    try {
      const result = await createSearchSession({
        accountId: form.accountId,
        keyword: form.keyword.trim(),
        count: Number(form.count || 10),
        excludeKnown: true,
      });
      setSessions((items) => [result.session, ...items.filter((item) => item.id !== result.session.id)]);
      setResults(result.results || []);
      setActiveSessionId(result.session.id);
      setSelected(new Set());
      setMessage(`搜索完成：新增 ${result.session.actualCount} 条不重复视频`);
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

  function toggleAll() {
    setSelected((current) => {
      if (current.size === results.length) return new Set();
      return new Set(results.map((video) => video.awemeId));
    });
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
          <select value={form.accountId} onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}>
            <option value="">请选择账号</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input value={form.keyword} onChange={(event) => setForm((current) => ({ ...current, keyword: event.target.value }))} placeholder="geo" />
        </label>
        <label>
          <span>执行数量</span>
          <input type="number" min="1" max="500" value={form.count} onChange={(event) => setForm((current) => ({ ...current, count: event.target.value }))} />
        </label>
        <button type="submit" disabled={loading}>开始搜索</button>
      </form>

      <div className="panel-section action-strip">
        <label>
          <span>历史搜索</span>
          <select value={activeSessionId} onChange={(event) => loadResults(event.target.value)}>
            <option value="">选择一次搜索结果</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.keyword} · {session.actualCount}/{session.targetCount} · {session.status}
              </option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          <span>批量评论内容</span>
          <input value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="要发布的评论" />
        </label>
        <button type="button" onClick={() => createBatch('like')} disabled={loading}>创建点赞任务</button>
        <button type="button" onClick={() => createBatch('comment')} disabled={loading}>创建评论任务</button>
      </div>

      {message ? <p className={message.includes('失败') || message.includes('请选择') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <div className="table-wrap">
        <table className="dense-table">
          <thead>
            <tr>
              <th className="check-col"><input type="checkbox" checked={Boolean(results.length && selected.size === results.length)} onChange={toggleAll} aria-label="全选视频" /></th>
              <th>视频</th>
              <th>作者</th>
              <th>状态</th>
              <th>链接</th>
            </tr>
          </thead>
          <tbody>
            {results.map((video) => (
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
                <td><code>{video.url}</code></td>
              </tr>
            ))}
            {!results.length ? (
              <tr><td colSpan="5" className="empty-row">{loading ? '搜索中...' : '暂无搜索结果。'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
