import { useEffect, useMemo, useState } from 'react';
import { listAccounts, listVideoComments, listVideos, syncComments, syncMyVideos } from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { Pagination } from './Pagination.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const VIDEO_PAGE_SIZE = 12;
const COMMENT_PAGE_SIZE = 50;

function compact(text, limit = 74) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function MyVideosPage() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [videos, setVideos] = useState([]);
  const [comments, setComments] = useState([]);
  const [activeAwemeId, setActiveAwemeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncSummary, setSyncSummary] = useState(null);
  const [videoPage, setVideoPage] = useState(1);
  const [commentPage, setCommentPage] = useState(1);

  const activeVideo = useMemo(
    () => videos.find((video) => video.awemeId === activeAwemeId),
    [videos, activeAwemeId],
  );
  const visibleVideos = useMemo(
    () => videos.slice((videoPage - 1) * VIDEO_PAGE_SIZE, videoPage * VIDEO_PAGE_SIZE),
    [videos, videoPage],
  );
  const visibleComments = useMemo(
    () => comments.slice((commentPage - 1) * COMMENT_PAGE_SIZE, commentPage * COMMENT_PAGE_SIZE),
    [comments, commentPage],
  );

  async function refresh(nextAccountId = accountId) {
    setLoading(true);
    setMessage('');
    setSyncSummary(null);
    setComments([]);
    setActiveAwemeId('');
    try {
      const nextAccounts = await listAccounts();
      const resolvedAccountId = nextAccounts.some((account) => account.id === nextAccountId) ? nextAccountId : '';
      setAccounts(nextAccounts);
      setAccountId(resolvedAccountId);
      const nextVideos = resolvedAccountId ? await listVideos({ accountId: resolvedAccountId, isMine: true }) : [];
      setVideos(nextVideos);
      setVideoPage(1);
      setCommentPage(1);
      const nextActive = nextVideos[0]?.awemeId || '';
      setActiveAwemeId(nextActive);
      setComments(nextActive ? await listVideoComments(nextActive) : []);
    } catch (error) {
      setMessage(error.message || '我的作品加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncVideos() {
    if (!accountId) {
      setMessage('请选择账号');
      return;
    }
    setLoading(true);
    setMessage('正在拉取我的作品...');
    try {
      const result = await syncMyVideos({ accountId, count: 500 });
      const nextVideos = result.items || result;
      setVideos(nextVideos);
      setSyncSummary(result.summary || null);
      setVideoPage(1);
      setCommentPage(1);
      setActiveAwemeId(nextVideos[0]?.awemeId || '');
      setComments([]);
      setMessage(`已同步 ${nextVideos.length} 个作品，共请求 ${result.summary?.pages || 1} 页`);
    } catch (error) {
      setMessage(error.message || '同步我的作品失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectVideo(awemeId) {
    setActiveAwemeId(awemeId);
    setCommentPage(1);
    setSyncSummary(null);
    setLoading(true);
    setMessage('');
    try {
      setComments(await listVideoComments(awemeId));
    } catch (error) {
      setMessage(error.message || '评论加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncComments() {
    if (!accountId || !activeAwemeId) {
      setMessage('请选择账号和作品');
      return;
    }
    setLoading(true);
    setMessage('正在同步评论区...');
    try {
      const result = await syncComments(activeAwemeId, { accountId, count: 500 });
      const nextComments = result.items || result;
      setComments(nextComments);
      setSyncSummary(result.summary || null);
      setCommentPage(1);
      setMessage(`已同步 ${nextComments.length} 条评论，共请求 ${result.summary?.pages || 1} 页`);
    } catch (error) {
      setMessage(error.message || '同步评论失败');
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
        title="我的作品"
        description="同步登录账号已发布的作品，并拉取对应评论区用于后续回复。"
        actions={(
          <>
            <button type="button" onClick={() => refresh()} disabled={loading}>刷新</button>
            <button type="button" className="primary-button" onClick={handleSyncVideos} disabled={loading}>同步我的作品</button>
            <button type="button" onClick={handleSyncComments} disabled={loading || !activeAwemeId}>同步评论</button>
          </>
        )}
      />

      <div className="panel-section action-strip">
        <label>
          <span>账号</span>
          <SelectMenu value={accountId} onChange={(event) => refresh(event.target.value)} aria-label="账号">
            <option value="">请选择账号</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </SelectMenu>
        </label>
        <div>
          <span className="field-label">当前作品</span>
          <strong>{activeVideo ? compact(activeVideo.desc, 120) : '未选择'}</strong>
        </div>
      </div>

      {message ? <p className={message.includes('失败') || message.includes('请选择') ? 'inline-error' : 'muted'}>{message}</p> : null}

      {syncSummary ? (
        <div className="sync-summary" role="status">
          <span>请求 {syncSummary.requested}</span>
          <span>获取 {syncSummary.fetched}</span>
          <span>保存 {syncSummary.saved}</span>
          {syncSummary.duplicates ? <span>去重 {syncSummary.duplicates}</span> : null}
          <span>分页 {syncSummary.pages}</span>
        </div>
      ) : null}

      <div className="job-grid">
        <div className="job-list">
          {visibleVideos.map((video) => (
            <article key={video.awemeId} className={`job-card${activeAwemeId === video.awemeId ? ' active' : ''}`}>
              <button type="button" className="job-card-button" onClick={() => handleSelectVideo(video.awemeId)}>
                <strong>{video.awemeId}</strong>
                <span className="status-badge success">我的作品</span>
              </button>
              <p>{compact(video.desc)}</p>
              <p>{video.url}</p>
            </article>
          ))}
          {!videos.length ? <div className="empty-state">{loading ? '加载中...' : '暂无作品，先同步我的作品。'}</div> : null}
          <Pagination page={videoPage} pageSize={VIDEO_PAGE_SIZE} total={videos.length} onPageChange={setVideoPage} noun="个作品" />
        </div>

        <div className="table-wrap">
          <table className="dense-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>评论</th>
                <th>点赞</th>
                <th>回复状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleComments.map((comment) => (
                <tr key={comment.cid}>
                  <td>{comment.userName || '-'}</td>
                  <td>
                    <strong>{comment.cid}</strong>
                    <p>{comment.text}</p>
                  </td>
                  <td>{comment.diggCount ?? '-'}</td>
                  <td>{comment.replied ? <span className="status-badge success">已回复</span> : <span className="status-badge neutral">未回复</span>}</td>
                </tr>
              ))}
              {!comments.length ? <tr><td colSpan="4" className="empty-row">选择作品并同步评论区。</td></tr> : null}
            </tbody>
          </table>
          <Pagination page={commentPage} pageSize={COMMENT_PAGE_SIZE} total={comments.length} onPageChange={setCommentPage} noun="条评论" />
        </div>
      </div>
    </section>
  );
}
