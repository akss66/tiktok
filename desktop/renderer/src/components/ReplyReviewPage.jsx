import { useEffect, useMemo, useState } from 'react';
import {
  analyzeComments,
  approveReplyDraft,
  listAccounts,
  listComments,
  listReplyDrafts,
  publishReplyDraft,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';

function toneForIntent(level) {
  if (level === '高') return 'success';
  if (level === '中') return 'warning';
  if (level === '忽略') return 'neutral';
  return 'neutral';
}

function statusLabel(status) {
  return {
    draft: '待审核',
    approved: '已审核',
    published: '已发布',
  }[status] || status;
}

export function ReplyReviewPage() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [comments, setComments] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const draftByComment = useMemo(
    () => new Map(drafts.map((draft) => [draft.commentId, draft])),
    [drafts],
  );

  async function refresh(nextAccountId = accountId) {
    setLoading(true);
    setMessage('');
    try {
      const nextAccounts = await listAccounts();
      const resolvedAccountId = nextAccountId || nextAccounts[0]?.id || '';
      setAccounts(nextAccounts);
      setAccountId(resolvedAccountId);
      const [nextComments, nextDrafts] = await Promise.all([
        resolvedAccountId ? listComments({ accountId: resolvedAccountId, limit: 500 }) : [],
        resolvedAccountId ? listReplyDrafts({ accountId: resolvedAccountId, limit: 500 }) : [],
      ]);
      setComments(nextComments);
      setDrafts(nextDrafts);
      setSelected(new Set());
    } catch (error) {
      setMessage(error.message || '评论回复数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  function toggle(cid) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }

  function toggleAll() {
    const candidates = comments.filter((comment) => !comment.replied);
    setSelected((current) => (
      current.size === candidates.length ? new Set() : new Set(candidates.map((comment) => comment.cid))
    ));
  }

  async function handleAnalyze() {
    if (!accountId) {
      setMessage('请选择账号');
      return;
    }
    if (!selected.size) {
      setMessage('请先选择评论');
      return;
    }
    setLoading(true);
    setMessage('正在生成回复草稿...');
    try {
      const nextDrafts = await analyzeComments({ accountId, commentIds: Array.from(selected) });
      setDrafts(await listReplyDrafts({ accountId, limit: 500 }));
      setMessage(`已生成 ${nextDrafts.length} 条草稿`);
    } catch (error) {
      setMessage(error.message || '生成草稿失败，请检查 AI 配置和知识库');
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(draft) {
    setLoading(true);
    setMessage('');
    try {
      const updated = await approveReplyDraft(draft.id, {
        draftText: editing[draft.id] ?? draft.draftText,
      });
      setDrafts((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setMessage('草稿已审核');
    } catch (error) {
      setMessage(error.message || '审核草稿失败');
    } finally {
      setLoading(false);
    }
  }

  async function handlePublish(draft) {
    setLoading(true);
    setMessage('正在发布回复...');
    try {
      const updated = await publishReplyDraft(draft.id);
      setDrafts((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setComments(await listComments({ accountId, limit: 500 }));
      setMessage('回复已发布');
    } catch (error) {
      setMessage(error.message || '发布回复失败');
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
        title="评论回复"
        description="基于本地知识库生成回复草稿，人工审核后再发布。"
        actions={(
          <>
            <button type="button" onClick={() => refresh()} disabled={loading}>刷新</button>
            <button type="button" onClick={handleAnalyze} disabled={loading}>生成草稿</button>
          </>
        )}
      />

      <div className="panel-section action-strip">
        <label>
          <span>账号</span>
          <select value={accountId} onChange={(event) => refresh(event.target.value)}>
            <option value="">请选择账号</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <div>
          <span className="field-label">已选评论</span>
          <strong>{selected.size} 条</strong>
        </div>
      </div>

      {message ? <p className={message.includes('失败') || message.includes('请选择') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <div className="table-wrap">
        <table className="dense-table reply-table">
          <thead>
            <tr>
              <th className="check-col"><input type="checkbox" onChange={toggleAll} checked={Boolean(selected.size && selected.size === comments.filter((item) => !item.replied).length)} aria-label="全选未回复评论" /></th>
              <th>评论</th>
              <th>分类</th>
              <th>草稿</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {comments.map((comment) => {
              const draft = draftByComment.get(comment.cid);
              return (
                <tr key={comment.cid}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(comment.cid)}
                      disabled={comment.replied}
                      onChange={() => toggle(comment.cid)}
                      aria-label={`选择 ${comment.cid}`}
                    />
                  </td>
                  <td>
                    <strong>{comment.userName || comment.cid}</strong>
                    <p>{comment.text}</p>
                    {comment.replied ? <span className="status-badge success">已回复</span> : <span className="status-badge neutral">未回复</span>}
                  </td>
                  <td>
                    {draft ? (
                      <>
                        <span className={`status-badge ${toneForIntent(draft.intentLevel)}`}>{draft.intentLevel || '-'}</span>
                        <p>{draft.category || '-'}</p>
                        <p>{draft.reason || '-'}</p>
                      </>
                    ) : '-'}
                  </td>
                  <td>
                    {draft ? (
                      <textarea
                        value={editing[draft.id] ?? draft.draftText}
                        onChange={(event) => setEditing((current) => ({ ...current, [draft.id]: event.target.value }))}
                        rows={3}
                        aria-label={`${comment.cid} 回复草稿`}
                      />
                    ) : '未生成'}
                  </td>
                  <td>
                    {draft ? (
                      <div className="button-row compact vertical-actions">
                        <span className={`status-badge ${draft.status === 'published' ? 'success' : 'neutral'}`}>{statusLabel(draft.status)}</span>
                        <button type="button" onClick={() => handleApprove(draft)} disabled={loading || draft.status === 'published'}>审核</button>
                        <button type="button" onClick={() => handlePublish(draft)} disabled={loading || draft.status !== 'approved'}>发布</button>
                      </div>
                    ) : '-'}
                  </td>
                </tr>
              );
            })}
            {!comments.length ? <tr><td colSpan="5" className="empty-row">暂无评论。先在“我的作品”页同步评论区。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
