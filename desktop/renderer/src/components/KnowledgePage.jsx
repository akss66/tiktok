import { useEffect, useMemo, useState } from 'react';
import { createKnowledge, deleteKnowledge, listKnowledge, updateKnowledge } from '../api.js';
import { PageHeader } from './PageHeader.jsx';

const EMPTY_FORM = {
  title: '',
  tags: '',
  content: '',
  enabled: true,
};

const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json'];

function extensionOf(name = '') {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function titleFromFileName(name = '') {
  return String(name).replace(/\.[^.]+$/, '').trim() || '未命名资料';
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isAcceptedFile(file) {
  return ACCEPTED_EXTENSIONS.includes(extensionOf(file.name));
}

export function KnowledgePage() {
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState({});
  const [selectedId, setSelectedId] = useState('');
  const [queuedFiles, setQueuedFiles] = useState([]);
  const [importTags, setImportTags] = useState('导入资料');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const enabledCount = useMemo(
    () => entries.filter((entry) => entry.enabled !== false).length,
    [entries],
  );
  const selectedEntry = selectedId ? editing[selectedId] : null;

  async function refresh() {
    setLoading(true);
    setMessage('');
    try {
      const items = await listKnowledge();
      setEntries(items);
      setEditing(Object.fromEntries(items.map((item) => [item.id, item])));
      setSelectedId((current) => (current && items.some((item) => item.id === current) ? current : items[0]?.id || ''));
    } catch (error) {
      setMessage(error.message || '知识库加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!form.title.trim() || !form.content.trim()) {
      setMessage('标题和内容不能为空');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const created = await createKnowledge({
        ...form,
        title: form.title.trim(),
        content: form.content.trim(),
        tags: form.tags.trim(),
      });
      setForm(EMPTY_FORM);
      await refresh();
      setSelectedId(created.id);
      setMessage('知识已保存');
    } catch (error) {
      setMessage(error.message || '知识保存失败');
      setLoading(false);
    }
  }

  async function handleSave(id) {
    const draft = editing[id];
    if (!draft?.title?.trim() || !draft?.content?.trim()) {
      setMessage('标题和内容不能为空');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const updated = await updateKnowledge(id, {
        ...draft,
        title: draft.title.trim(),
        content: draft.content.trim(),
        tags: String(draft.tags || '').trim(),
      });
      setEntries((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setEditing((current) => ({ ...current, [updated.id]: updated }));
      setMessage('知识已更新');
    } catch (error) {
      setMessage(error.message || '知识更新失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id) {
    setLoading(true);
    setMessage('');
    try {
      await deleteKnowledge(id);
      setEntries((items) => items.filter((item) => item.id !== id));
      setEditing((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setSelectedId('');
      setMessage('知识已删除');
      await refresh();
    } catch (error) {
      setMessage(error.message || '知识删除失败');
    } finally {
      setLoading(false);
    }
  }

  function patchEditing(id, patch) {
    setEditing((current) => ({
      ...current,
      [id]: { ...(current[id] || {}), ...patch },
    }));
  }

  function handleFilePick(event) {
    const files = Array.from(event.target.files || []);
    const accepted = files.filter(isAcceptedFile);
    const rejected = files.filter((file) => !isAcceptedFile(file));
    setQueuedFiles(accepted);
    if (rejected.length) {
      setMessage(`已忽略 ${rejected.length} 个不支持的文件，仅支持 ${ACCEPTED_EXTENSIONS.join('、')}`);
    } else {
      setMessage(accepted.length ? `已选择 ${accepted.length} 个文件，点击导入后写入知识库` : '');
    }
  }

  async function importFiles() {
    if (!queuedFiles.length) {
      setMessage('请先选择要导入的文件');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      let imported = 0;
      for (const file of queuedFiles) {
        const content = (await file.text()).trim();
        if (!content) continue;
        await createKnowledge({
          title: titleFromFileName(file.name),
          tags: importTags.trim(),
          content,
          enabled: true,
        });
        imported += 1;
      }
      setQueuedFiles([]);
      await refresh();
      setMessage(`已导入 ${imported} 个文件`);
    } catch (error) {
      setMessage(error.message || '文件导入失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="panel knowledge-panel">
      <PageHeader
        title="知识库"
        description="维护 GEO 服务、价格、交付方式和常见问题，供评论回复生成草稿时引用。"
        actions={<button type="button" onClick={refresh} disabled={loading}>刷新</button>}
      />

      <div className="knowledge-summary" aria-label="知识库状态">
        <div>
          <strong>{entries.length}</strong>
          <span>资料总数</span>
        </div>
        <div>
          <strong>{enabledCount}</strong>
          <span>启用中</span>
        </div>
        <div>
          <strong>{queuedFiles.length}</strong>
          <span>待导入文件</span>
        </div>
      </div>

      <div className="knowledge-workbench">
        <form className="panel-section knowledge-editor" onSubmit={handleCreate}>
          <div className="section-heading">
            <h2>新增资料</h2>
            <p>适合写价格、交付方式、常见问题、售后规则。</p>
          </div>
          <label>
            <span>标题</span>
            <input
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="GEO 服务收费"
            />
          </label>
          <label>
            <span>标签</span>
            <input
              value={form.tags}
              onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))}
              placeholder="价格,GEO,交付"
            />
          </label>
          <label>
            <span>内容</span>
            <textarea
              value={form.content}
              onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
              rows={7}
              placeholder="按项目复杂度报价，先沟通需求再给方案。"
            />
          </label>
          <div className="editor-actions">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>启用</span>
            </label>
            <button type="submit" disabled={loading}>保存资料</button>
          </div>
        </form>

        <section className="panel-section knowledge-import" aria-labelledby="knowledge-import-title">
          <div className="section-heading">
            <h2 id="knowledge-import-title">文件导入</h2>
            <p>支持 TXT、Markdown、CSV、JSON。每个文件会生成一条知识。</p>
          </div>
          <label>
            <span>导入标签</span>
            <input value={importTags} onChange={(event) => setImportTags(event.target.value)} placeholder="导入资料" />
          </label>
          <label className="file-drop">
            <input
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={handleFilePick}
            />
            <strong>选择文件导入知识库</strong>
            <span>文件内容会保存在本地 SQLite，不上传到外部服务。</span>
          </label>
          <div className="import-file-list">
            {queuedFiles.map((file) => (
              <div key={`${file.name}-${file.size}`}>
                <span>{file.name}</span>
                <small>{formatSize(file.size)}</small>
              </div>
            ))}
            {!queuedFiles.length ? <p>还没有选择文件。</p> : null}
          </div>
          <button type="button" onClick={importFiles} disabled={loading || !queuedFiles.length}>导入文件</button>
        </section>
      </div>

      {message ? <p className={message.includes('失败') || message.includes('不能为空') || message.includes('请先') ? 'inline-error' : 'muted'}>{message}</p> : null}

      <section className="knowledge-browser" aria-label="知识列表">
        <div className="knowledge-list">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`knowledge-list-item${selectedId === entry.id ? ' active' : ''}`}
              onClick={() => setSelectedId(entry.id)}
            >
              <strong>{entry.title}</strong>
              <span>{entry.tags || '未设置标签'}</span>
              <small>{entry.enabled === false ? '停用' : '启用'}</small>
            </button>
          ))}
          {!entries.length ? (
            <div className="empty-state">{loading ? '加载中...' : '暂无知识。可以手动新增，也可以导入文件。'}</div>
          ) : null}
        </div>

        <article className="knowledge-detail panel-section">
          {selectedEntry ? (
            <>
              <div className="section-heading">
                <h2>编辑资料</h2>
                <p>修改后会立即影响后续 AI 回复草稿的参考资料。</p>
              </div>
              <label>
                <span>标题</span>
                <input value={selectedEntry.title || ''} onChange={(event) => patchEditing(selectedId, { title: event.target.value })} />
              </label>
              <label>
                <span>标签</span>
                <input value={selectedEntry.tags || ''} onChange={(event) => patchEditing(selectedId, { tags: event.target.value })} />
              </label>
              <label>
                <span>内容</span>
                <textarea value={selectedEntry.content || ''} onChange={(event) => patchEditing(selectedId, { content: event.target.value })} rows={9} />
              </label>
              <div className="editor-actions">
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={selectedEntry.enabled !== false}
                    onChange={(event) => patchEditing(selectedId, { enabled: event.target.checked })}
                  />
                  <span>启用</span>
                </label>
                <div className="button-row compact">
                  <button type="button" onClick={() => handleSave(selectedId)} disabled={loading}>保存修改</button>
                  <button type="button" className="danger-button" onClick={() => handleDelete(selectedId)} disabled={loading}>删除资料</button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">选择左侧资料进行编辑。</div>
          )}
        </article>
      </section>
    </section>
  );
}
