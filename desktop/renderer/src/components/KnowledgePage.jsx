import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  bulkKnowledge,
  checkKnowledgeDuplicate,
  createKnowledge,
  queryKnowledge,
  updateKnowledge,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { Pagination } from './Pagination.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILES = 20;

const EMPTY_FORM = {
  title: '',
  category: '',
  tags: '',
  content: '',
  enabled: true,
  sourceType: 'manual',
  sourceName: '',
  sourceSize: 0,
};

const DEFAULT_FILTERS = {
  q: '',
  status: '',
  category: '',
  sourceType: '',
  sort: 'updatedAt',
  order: 'desc',
  page: 1,
  pageSize: 20,
};

function extensionOf(name = '') {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function sourceTypeFromFile(name) {
  const extension = extensionOf(name);
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.txt') return 'text';
  if (extension === '.csv') return 'csv';
  if (extension === '.json') return 'json';
  return 'manual';
}

function sourceTypeLabel(value) {
  return {
    manual: '手动录入',
    markdown: 'Markdown',
    text: '文本文件',
    csv: 'CSV',
    json: 'JSON',
  }[value] || value || '手动录入';
}

function titleFromFileName(name = '') {
  return String(name).replace(/\.[^.]+$/, '').trim() || '未命名资料';
}

function formatSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

async function readKnowledgeFile(file) {
  const raw = (await file.text()).trim();
  if (!raw) return '';
  if (extensionOf(file.name) === '.json') {
    return JSON.stringify(JSON.parse(raw), null, 2);
  }
  return raw;
}

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

export function KnowledgePage() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [result, setResult] = useState({ items: [], total: 0, page: 1, pageSize: 20, facets: {} });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [activeId, setActiveId] = useState('');
  const [editorMode, setEditorMode] = useState('edit');
  const [draft, setDraft] = useState(EMPTY_FORM);
  const [showImport, setShowImport] = useState(false);
  const [queuedFiles, setQueuedFiles] = useState([]);
  const [importCategory, setImportCategory] = useState('');
  const [importTags, setImportTags] = useState('');
  const [importReport, setImportReport] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const entries = result.items || [];
  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === activeId) || null,
    [activeId, entries],
  );
  const allPageSelected = entries.length > 0 && entries.every((entry) => selectedIds.has(entry.id));

  async function load(nextFilters = filters) {
    setLoading(true);
    try {
      const data = await queryKnowledge(nextFilters);
      setResult(data);
      setActiveId((current) => {
        if (editorMode === 'create') return current;
        return data.items.some((entry) => entry.id === current) ? current : data.items[0]?.id || '';
      });
      return data;
    } catch (error) {
      setMessage({ type: 'error', text: errorMessage(error, '知识库加载失败') });
      return null;
    } finally {
      setLoading(false);
    }
  }

  function patchFilters(patch) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page || 1 }));
    setSelectedIds(new Set());
  }

  function openCreate() {
    setEditorMode('create');
    setActiveId('');
    setDraft(EMPTY_FORM);
    setShowImport(false);
    setMessage({ type: '', text: '' });
  }

  function openEntry(entry) {
    setEditorMode('edit');
    setActiveId(entry.id);
    setDraft({ ...entry });
  }

  async function saveDraft(event) {
    event.preventDefault();
    if (!draft.title.trim() || !draft.content.trim()) {
      setMessage({ type: 'error', text: '标题和内容不能为空' });
      return;
    }
    setLoading(true);
    try {
      const payload = {
        title: draft.title.trim(),
        category: draft.category.trim() || '未分类',
        tags: draft.tags.trim(),
        content: draft.content.trim(),
        enabled: draft.enabled !== false,
      };
      const saved = editorMode === 'create'
        ? await createKnowledge(payload)
        : await updateKnowledge(activeId, payload);
      setEditorMode('edit');
      setMessage({ type: 'success', text: editorMode === 'create' ? '资料已新增' : '资料已更新' });
      const data = await load({ ...filters, page: editorMode === 'create' ? 1 : filters.page });
      const visible = data?.items.find((entry) => entry.id === saved.id);
      if (visible) openEntry(visible);
      else {
        setActiveId(saved.id);
        setDraft(saved);
      }
    } catch (error) {
      setMessage({ type: 'error', text: errorMessage(error, '资料保存失败') });
    } finally {
      setLoading(false);
    }
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelectedIds(allPageSelected ? new Set() : new Set(entries.map((entry) => entry.id)));
  }

  async function runBulk(action, ids = [...selectedIds]) {
    if (!ids.length) {
      setMessage({ type: 'error', text: '请先选择资料' });
      return;
    }
    if (action === 'delete' && !window.confirm(`只删除本地选中的 ${ids.length} 条知识资料？`)) return;
    setLoading(true);
    try {
      const response = await bulkKnowledge({ action, ids });
      setSelectedIds(new Set());
      setMessage({
        type: 'success',
        text: action === 'delete' ? `已删除 ${response.changed} 条资料` : `已更新 ${response.changed} 条资料`,
      });
      await load();
    } catch (error) {
      setMessage({ type: 'error', text: errorMessage(error, '批量操作失败') });
    } finally {
      setLoading(false);
    }
  }

  function exportSelected() {
    const exported = entries.filter((entry) => selectedIds.has(entry.id));
    if (!exported.length) {
      setMessage({ type: 'error', text: '请先选择要导出的资料' });
      return;
    }
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), entries: exported }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Vulcan知识库-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage({ type: 'success', text: `已导出 ${exported.length} 条资料` });
  }

  function handleFilePick(event) {
    const files = Array.from(event.target.files || []);
    const accepted = [];
    const report = [];
    files.slice(0, MAX_IMPORT_FILES).forEach((file) => {
      if (!ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
        report.push({ name: file.name, status: 'failed', detail: '不支持的文件格式' });
      } else if (file.size > MAX_FILE_BYTES) {
        report.push({ name: file.name, status: 'failed', detail: '文件超过 2 MB' });
      } else {
        accepted.push(file);
      }
    });
    if (files.length > MAX_IMPORT_FILES) {
      report.push({ name: '其余文件', status: 'failed', detail: `单次最多选择 ${MAX_IMPORT_FILES} 个文件` });
    }
    setQueuedFiles(accepted);
    setImportReport(report);
    event.target.value = '';
  }

  async function importFiles() {
    if (!queuedFiles.length) {
      setMessage({ type: 'error', text: '请先选择要导入的文件' });
      return;
    }
    setLoading(true);
    const report = [];
    for (const file of queuedFiles) {
      try {
        const content = await readKnowledgeFile(file);
        if (!content) {
          report.push({ name: file.name, status: 'skipped', detail: '空文件' });
          continue;
        }
        const duplicate = await checkKnowledgeDuplicate(content);
        if (duplicate.duplicate) {
          report.push({ name: file.name, status: 'duplicate', detail: `与“${duplicate.entry.title}”内容相同` });
          continue;
        }
        await createKnowledge({
          title: titleFromFileName(file.name),
          category: importCategory.trim() || '未分类',
          tags: importTags.trim(),
          content,
          enabled: true,
          sourceType: sourceTypeFromFile(file.name),
          sourceName: file.name,
          sourceSize: file.size,
        });
        report.push({ name: file.name, status: 'success', detail: '导入成功' });
      } catch (error) {
        report.push({ name: file.name, status: 'failed', detail: errorMessage(error, '读取或导入失败') });
      }
    }
    const imported = report.filter((item) => item.status === 'success').length;
    setImportReport(report);
    setQueuedFiles([]);
    setMessage({
      type: imported ? 'success' : 'error',
      text: imported ? `已导入 ${imported} 个文件，详细结果见导入报告` : '没有文件成功导入，请查看导入报告',
    });
    await load({ ...filters, page: 1 });
    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => load(filters), filters.q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [
    filters.q,
    filters.status,
    filters.category,
    filters.sourceType,
    filters.sort,
    filters.order,
    filters.page,
    filters.pageSize,
  ]);

  useEffect(() => {
    if (editorMode === 'edit' && activeEntry) setDraft({ ...activeEntry });
  }, [activeEntry, editorMode]);

  return (
    <section className="panel panel-wide knowledge-panel">
      <PageHeader
        title="知识库"
        description="集中维护业务事实与回复依据；知识内容保存在本机，AI 只引用与当前对话相关的资料。"
        actions={(
          <div className="button-row compact">
            <button type="button" onClick={openCreate}><Plus size={16} />新增资料</button>
            <button type="button" onClick={() => { setShowImport((value) => !value); setEditorMode('edit'); }}>
              <Upload size={16} />导入文件
            </button>
            <button type="button" className="icon-button" title="刷新" aria-label="刷新知识库" onClick={() => load()} disabled={loading}>
              <RefreshCw size={16} />
            </button>
          </div>
        )}
      />

      <div className="knowledge-summary" aria-label="知识库概况">
        <div><strong>{result.total}</strong><span>资料总数</span></div>
        <div><strong>{result.facets?.categories?.length || 0}</strong><span>业务分类</span></div>
        <div><strong>{selectedIds.size}</strong><span>已选择</span></div>
        <div><strong>{queuedFiles.length}</strong><span>待导入</span></div>
      </div>

      {showImport ? (
        <section className="panel-section knowledge-import-panel" aria-labelledby="knowledge-import-title">
          <div className="section-heading knowledge-section-heading">
            <div>
              <h2 id="knowledge-import-title">导入本地资料</h2>
              <p>支持 TXT、Markdown、CSV、JSON；每个文件保存为一条可独立维护的知识。</p>
            </div>
            <button type="button" className="icon-button" title="收起" onClick={() => setShowImport(false)}><X size={16} /></button>
          </div>
          <div className="knowledge-import-grid">
            <label><span>统一分类</span><input value={importCategory} onChange={(event) => setImportCategory(event.target.value)} /></label>
            <label><span>统一标签</span><input value={importTags} onChange={(event) => setImportTags(event.target.value)} /></label>
            <label className="knowledge-file-picker">
              <input type="file" multiple accept={ACCEPTED_EXTENSIONS.join(',')} onChange={handleFilePick} />
              <Upload size={18} />
              <span>选择文件</span>
              <small>单个不超过 2 MB，单次最多 20 个</small>
            </label>
          </div>
          {queuedFiles.length ? (
            <div className="knowledge-file-chips">
              {queuedFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}<small>{formatSize(file.size)}</small></span>)}
            </div>
          ) : null}
          <div className="knowledge-import-actions">
            <button type="button" className="primary-button" onClick={importFiles} disabled={loading || !queuedFiles.length}>开始导入</button>
          </div>
          {importReport.length ? (
            <div className="knowledge-import-report" aria-label="导入报告">
              {importReport.map((item, index) => (
                <div key={`${item.name}-${index}`} className={`import-${item.status}`}>
                  {item.status === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                  <strong>{item.name}</strong><span>{item.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="panel-section knowledge-toolbar" aria-label="知识筛选">
        <label className="knowledge-search-field">
          <span>搜索资料</span>
          <div><Search size={16} /><input value={filters.q} onChange={(event) => patchFilters({ q: event.target.value })} /></div>
        </label>
        <label>
          <span>状态</span>
          <SelectMenu value={filters.status} onChange={(event) => patchFilters({ status: event.target.value })} aria-label="筛选知识状态">
            <option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option>
          </SelectMenu>
        </label>
        <label>
          <span>分类</span>
          <SelectMenu value={filters.category} onChange={(event) => patchFilters({ category: event.target.value })} aria-label="筛选知识分类">
            <option value="">全部分类</option>
            {(result.facets?.categories || []).map((category) => <option value={category} key={category}>{category}</option>)}
          </SelectMenu>
        </label>
        <label>
          <span>来源</span>
          <SelectMenu value={filters.sourceType} onChange={(event) => patchFilters({ sourceType: event.target.value })} aria-label="筛选知识来源">
            <option value="">全部来源</option>
            {(result.facets?.sourceTypes || []).map((source) => <option value={source} key={source}>{sourceTypeLabel(source)}</option>)}
          </SelectMenu>
        </label>
        <label>
          <span>排序</span>
          <SelectMenu value={`${filters.sort}:${filters.order}`} onChange={(event) => {
            const [sort, order] = event.target.value.split(':');
            patchFilters({ sort, order });
          }} aria-label="知识排序">
            <option value="updatedAt:desc">最近更新</option>
            <option value="createdAt:desc">最近创建</option>
            <option value="title:asc">标题升序</option>
          </SelectMenu>
        </label>
      </section>

      {message.text ? <div className={`knowledge-message ${message.type}`} role="status">{message.text}</div> : null}

      <section className="knowledge-bulk-bar" aria-label="批量操作">
        <label className="checkbox-inline"><input type="checkbox" checked={allPageSelected} onChange={togglePage} /><span>选择本页</span></label>
        <span className="muted">已选 {selectedIds.size} 条</span>
        <div className="button-row compact">
          <button type="button" onClick={() => runBulk('enable')} disabled={!selectedIds.size || loading}>启用</button>
          <button type="button" onClick={() => runBulk('disable')} disabled={!selectedIds.size || loading}>停用</button>
          <button type="button" onClick={exportSelected} disabled={!selectedIds.size}><Download size={15} />导出</button>
          <button type="button" className="danger-text-button" onClick={() => runBulk('delete')} disabled={!selectedIds.size || loading}><Trash2 size={15} />删除</button>
        </div>
      </section>

      <div className="knowledge-management-layout">
        <section className="knowledge-table-wrap" aria-label="知识资料列表">
          <table className="knowledge-table">
            <thead><tr><th aria-label="选择" /><th>资料</th><th>分类</th><th>来源</th><th>版本</th><th>状态</th></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className={activeId === entry.id ? 'active' : ''} onClick={() => openEntry(entry)}>
                  <td><input type="checkbox" checked={selectedIds.has(entry.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelected(entry.id)} aria-label={`选择 ${entry.title}`} /></td>
                  <td><strong>{entry.title}</strong><span>{entry.tags || '无标签'}</span></td>
                  <td>{entry.category || '未分类'}</td>
                  <td><span>{sourceTypeLabel(entry.sourceType)}</span><small>{entry.sourceName || '本地录入'}</small></td>
                  <td>v{entry.version || 1}<small>{entry.chunkCount || 0} 个片段</small></td>
                  <td><span className={`knowledge-status ${entry.enabled === false ? 'disabled' : 'enabled'}`}>{entry.enabled === false ? '已停用' : '已启用'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length ? (
            <div className="empty-state knowledge-empty"><FileText size={28} /><strong>{loading ? '正在加载资料' : '没有符合条件的资料'}</strong><span>调整筛选条件，或新增、导入知识。</span></div>
          ) : null}
          <Pagination page={result.page || 1} pageSize={result.pageSize || 20} total={result.total || 0} noun="条资料" onPageChange={(page) => setFilters((current) => ({ ...current, page }))} />
        </section>

        <form className="panel-section knowledge-detail" onSubmit={saveDraft}>
          <div className="section-heading knowledge-section-heading">
            <div><h2>{editorMode === 'create' ? '新增资料' : '资料详情'}</h2><p>{editorMode === 'create' ? '录入可验证的业务事实和回复依据。' : '保存后，新任务会使用最新版本。'}</p></div>
            {editorMode === 'edit' && activeEntry ? <span className="knowledge-version">v{activeEntry.version || 1}</span> : null}
          </div>
          {editorMode === 'create' || activeEntry ? (
            <>
              <label><span>标题</span><input value={draft.title || ''} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
              <div className="knowledge-detail-grid">
                <label><span>分类</span><input value={draft.category || ''} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} /></label>
                <label><span>标签</span><input value={draft.tags || ''} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} /></label>
              </div>
              <label className="knowledge-content-field"><span>内容</span><textarea rows={13} value={draft.content || ''} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></label>
              {editorMode === 'edit' && activeEntry ? (
                <dl className="knowledge-metadata">
                  <div><dt>来源</dt><dd>{sourceTypeLabel(activeEntry.sourceType)}{activeEntry.sourceName ? ` · ${activeEntry.sourceName}` : ''}</dd></div>
                  <div><dt>大小</dt><dd>{formatSize(activeEntry.sourceSize)}</dd></div>
                  <div><dt>更新时间</dt><dd>{formatDate(activeEntry.updatedAt)}</dd></div>
                </dl>
              ) : null}
              <div className="editor-actions">
                <label className="checkbox-inline"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span>启用这条知识</span></label>
                <div className="button-row compact">
                  {editorMode === 'edit' && activeEntry ? <button type="button" className="danger-text-button" onClick={() => runBulk('delete', [activeEntry.id])} disabled={loading}><Trash2 size={15} />删除</button> : null}
                  <button type="submit" className="primary-button" disabled={loading}>{editorMode === 'create' ? '新增资料' : '保存修改'}</button>
                </div>
              </div>
            </>
          ) : <div className="empty-state"><FileText size={28} /><strong>选择一条资料</strong><span>在左侧列表中选择资料后查看和编辑。</span></div>}
        </form>
      </div>
    </section>
  );
}
