import { useEffect, useMemo, useState } from 'react';
import { createTask, listAccounts, listTasks, runTask } from '../api.js';
import { PageHeader } from './PageHeader.jsx';

const TASK_TYPES = [
  { value: 'search', label: '搜索视频' },
  { value: 'like', label: '点赞' },
  { value: 'publish', label: '发布评论' },
  { value: 'delete-comment', label: '删除评论' },
  { value: 'suggest', label: '生成回复草稿' },
];

const LIKE_ACTIONS = [
  { value: 'like', label: '点赞' },
  { value: 'unlike', label: '取消点赞' },
];

function taskTone(status) {
  if (status === 'success') return 'success';
  if (status === 'running') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function taskStatusLabel(status) {
  if (status === 'pending') return '待执行';
  if (status === 'running') return '执行中';
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  return status || '-';
}

function getTaskTypeLabel(type) {
  return TASK_TYPES.find((item) => item.value === type)?.label || type;
}

function defaultForm(overrides = {}) {
  return {
    accountId: '',
    type: 'search',
    keyword: '',
    count: 5,
    offset: 0,
    awemeId: '',
    commentText: '',
    commentId: '',
    replyToCommentId: '',
    likeAction: 'like',
    autoPublish: false,
    suggestStrategy: '',
    suggestAwemeId: '',
    suggestReplyTo: '',
    ...overrides,
  };
}

function parseTaskInput(form) {
  if (form.type === 'search') {
    const keyword = form.keyword.trim();
    const count = Number(form.count || 0);
    const offset = Number(form.offset || 0);
    if (!keyword) return { error: '关键词不能为空' };
    if (!Number.isFinite(count) || count < 1 || count > 20) return { error: '数量需要在 1-20 之间' };
    return { input: { keyword, count, offset: Number.isFinite(offset) ? offset : 0 } };
  }

  if (form.type === 'like') {
    const awemeId = form.awemeId.trim();
    if (!awemeId) return { error: '作品 ID 或链接不能为空' };
    return { input: { awemeId, action: form.likeAction } };
  }

  if (form.type === 'publish') {
    const awemeId = form.awemeId.trim();
    const text = form.commentText.trim();
    if (!awemeId) return { error: '作品 ID 或链接不能为空' };
    if (!text) return { error: '评论内容不能为空' };
    return {
      input: {
        awemeId,
        text,
        replyToCommentId: form.replyToCommentId.trim() || null,
      },
    };
  }

  if (form.type === 'delete-comment') {
    const commentId = form.commentId.trim();
    if (!commentId) return { error: '评论 ID 不能为空' };
    return { input: { commentId } };
  }

  if (form.type === 'suggest') {
    const sourceText = form.commentText.trim();
    if (!sourceText) return { error: '源评论不能为空' };
    const input = {
      sourceText,
      autoPublish: Boolean(form.autoPublish),
      strategy: form.suggestStrategy.trim() || null,
      awemeId: form.suggestAwemeId.trim() || null,
      replyToCommentId: form.suggestReplyTo.trim() || null,
    };
    if (input.autoPublish && (!input.awemeId || !input.replyToCommentId)) {
      return { error: '直接发布时必须填写作品 ID/链接和回复评论 ID' };
    }
    return { input };
  }

  return { error: `不支持的任务类型：${form.type}` };
}

function compact(value, max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describeInput(task) {
  const input = task.input || {};
  if (task.type === 'search') return `关键词：${input.keyword || '-'}，数量：${input.count || 10}`;
  if (task.type === 'like') return `作品：${compact(input.awemeId)}；动作：${input.action === 'unlike' ? '取消点赞' : '点赞'}`;
  if (task.type === 'publish') {
    const reply = input.replyToCommentId ? `；回复评论：${input.replyToCommentId}` : '';
    return `作品：${compact(input.awemeId)}；评论：${compact(input.text || input.commentText)}${reply}`;
  }
  if (task.type === 'delete-comment') return `评论 ID：${input.commentId || input.cid || '-'}`;
  if (task.type === 'suggest') {
    return `源评论：${compact(input.sourceText || input.commentText)}${input.autoPublish ? '；生成后直接发布' : '；仅生成草稿'}`;
  }
  return '-';
}

function describeResult(task) {
  if (task.error) return task.error;
  const result = task.resultSummary || {};
  if (task.status === 'pending') return '尚未执行';
  if (task.status === 'running') return '正在执行';
  if (task.type === 'search') return `找到 ${result.count || 0} 条结果`;
  if (task.type === 'like') return result.action === 'unlike' ? '已取消点赞' : '已点赞';
  if (task.type === 'publish') return `评论成功，评论 ID：${result.cid || '-'}`;
  if (task.type === 'delete-comment') return `已删除评论：${result.commentId || '-'}`;
  if (task.type === 'suggest') {
    if (result.published?.cid) return `已生成并发布：${compact(result.suggested)}；评论 ID：${result.published.cid}`;
    return `回复草稿：${compact(result.suggested)}`;
  }
  return '执行完成';
}

function TaskTypeFields({ form, setForm }) {
  if (form.type === 'search') {
    return (
      <>
        <label>
          <span>关键词</span>
          <input
            value={form.keyword}
            onChange={(event) => setForm((next) => ({ ...next, keyword: event.target.value }))}
            placeholder="例如：美食"
          />
        </label>
        <label>
          <span>数量</span>
          <input
            type="number"
            min="1"
            max="20"
            value={form.count}
            onChange={(event) => setForm((next) => ({ ...next, count: event.target.value }))}
          />
        </label>
      </>
    );
  }

  if (form.type === 'like') {
    return (
      <>
        <label>
          <span>作品 ID / 链接</span>
          <input
            value={form.awemeId}
            onChange={(event) => setForm((next) => ({ ...next, awemeId: event.target.value }))}
            placeholder="数字 ID、抖音链接或整段分享文案"
          />
        </label>
        <label>
          <span>动作</span>
          <select
            value={form.likeAction}
            onChange={(event) => setForm((next) => ({ ...next, likeAction: event.target.value }))}
          >
            {LIKE_ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </>
    );
  }

  if (form.type === 'publish') {
    return (
      <>
        <label>
          <span>作品 ID / 链接</span>
          <input
            value={form.awemeId}
            onChange={(event) => setForm((next) => ({ ...next, awemeId: event.target.value }))}
            placeholder="数字 ID、抖音链接或整段分享文案"
          />
        </label>
        <label className="col-span-2">
          <span>评论内容</span>
          <textarea
            value={form.commentText}
            onChange={(event) => setForm((next) => ({ ...next, commentText: event.target.value }))}
            rows={2}
            placeholder="要发布的评论"
          />
        </label>
        <label>
          <span>回复评论 ID</span>
          <input
            value={form.replyToCommentId}
            onChange={(event) => setForm((next) => ({ ...next, replyToCommentId: event.target.value }))}
            placeholder="可选"
          />
        </label>
      </>
    );
  }

  if (form.type === 'delete-comment') {
    return (
      <label className="col-span-2">
        <span>评论 ID</span>
        <input
          value={form.commentId}
          onChange={(event) => setForm((next) => ({ ...next, commentId: event.target.value }))}
          placeholder="commentId"
        />
      </label>
    );
  }

  return (
    <>
      <label className="col-span-2">
        <span>源评论</span>
        <textarea
          value={form.commentText}
          onChange={(event) => setForm((next) => ({ ...next, commentText: event.target.value }))}
          rows={3}
          placeholder="需要生成回复的用户评论"
        />
      </label>
      <label>
        <span>回复风格</span>
        <input
          value={form.suggestStrategy}
          onChange={(event) => setForm((next) => ({ ...next, suggestStrategy: event.target.value }))}
          placeholder="可选，例如：热情、简洁"
        />
      </label>
      <label>
        <span>作品 ID / 链接</span>
        <input
          value={form.suggestAwemeId}
          onChange={(event) => setForm((next) => ({ ...next, suggestAwemeId: event.target.value }))}
          placeholder="直接发布时必填"
        />
      </label>
      <label>
        <span>回复评论 ID</span>
        <input
          value={form.suggestReplyTo}
          onChange={(event) => setForm((next) => ({ ...next, suggestReplyTo: event.target.value }))}
          placeholder="直接发布时必填"
        />
      </label>
      <label>
        <span>发布方式</span>
        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={form.autoPublish}
            onChange={(event) => setForm((next) => ({ ...next, autoPublish: event.target.checked }))}
          />
          <span>生成后直接发布</span>
        </label>
      </label>
    </>
  );
}

export function TasksPage() {
  const [accounts, setAccounts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState(defaultForm());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  function resetFieldsForType(type, current) {
    return defaultForm({ accountId: current.accountId, type });
  }

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [nextAccounts, nextTasks] = await Promise.all([listAccounts(), listTasks()]);
      setAccounts(nextAccounts);
      setTasks(nextTasks);
      setForm((current) => ({
        ...current,
        accountId: current.accountId || nextAccounts[0]?.id || '',
      }));
    } catch (err) {
      setError(err.message || '获取任务失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!form.accountId) {
      setError('请选择账号');
      return;
    }

    const parsed = parseTaskInput(form);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setLoading(true);
    setError('');
    try {
      await createTask({
        accountId: form.accountId,
        type: form.type,
        input: parsed.input,
      });
      setForm((current) => resetFieldsForType(current.type, current));
      await refresh();
    } catch (err) {
      setError(err.message || '任务创建失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleRun(task) {
    setLoading(true);
    setError('');
    try {
      const updated = await runTask(task.id);
      setTasks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err.message || '任务执行失败');
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
        title="高级任务"
        description="保留底层单条任务入口，用于调试搜索、点赞、评论和回复草稿。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新</button>}
      />

      <form className="inline-form task-form" onSubmit={handleCreate}>
        <label>
          <span>账号</span>
          <select
            value={form.accountId}
            onChange={(event) => setForm((next) => ({ ...next, accountId: event.target.value }))}
          >
            <option value="">请选择账号</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select
            value={form.type}
            onChange={(event) => setForm((current) => resetFieldsForType(event.target.value, current))}
          >
            {TASK_TYPES.map((taskType) => (
              <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
            ))}
          </select>
        </label>
        <TaskTypeFields form={form} setForm={setForm} />
        <button type="submit" disabled={loading}>创建任务</button>
      </form>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="task-list">
        {tasks.map((task) => (
          <article className="task-card" key={task.id}>
            <div className="task-main">
              <div className="task-title-row">
                <strong>{getTaskTypeLabel(task.type)}</strong>
                <span className={`status-badge ${taskTone(task.status)}`}>{taskStatusLabel(task.status)}</span>
              </div>
              <p><span>账号：</span>{accountById.get(task.accountId)?.name || task.accountId}</p>
              <p><span>输入：</span>{describeInput(task)}</p>
              <p><span>{task.error ? '错误：' : '结果：'}</span>{describeResult(task)}</p>
              <p className="muted">创建时间：{task.createdAt}</p>
            </div>
            <button
              type="button"
              onClick={() => handleRun(task)}
              disabled={loading || task.status === 'running'}
            >
              执行
            </button>
          </article>
        ))}
        {!tasks.length ? (
          <div className="empty-state">
            {loading ? '任务加载中...' : '暂无任务，请先创建'}
          </div>
        ) : null}
      </div>
    </section>
  );
}
