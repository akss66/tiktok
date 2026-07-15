# GEO Knowledge Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善本地知识库管理、导入、检索和维护能力，并交付 6 份可导入的 GEO 获客 Demo 知识。

**Architecture:** 保留 `knowledge_entries` 兼容旧数据，增加文档元数据和 `knowledge_chunks`。后端负责校验、分段、重复检测、查询分页、批量操作和相关性检索；Electron IPC 只转发结构化参数；React 页面负责完整管理体验和本地文件读取/导出。

**Tech Stack:** Node.js、better-sqlite3、Electron IPC、React、Vitest、Vite。

## Global Constraints

- 仅支持 TXT、Markdown、CSV、JSON，不支持 Word 和 PDF。
- GEO 内容为 Demo，未知价格、案例、周期和效果必须转人工确认。
- 不改变现有私信、评论和批量任务的串行发送规则。
- 兼容已有 `knowledge_entries` 数据，不删除用户资料。
- 所有数据保存在本地 SQLite，文件内容不上传到外部存储。

---

### Task 1: 知识文档元数据与分段

**Files:**
- Modify: `lib/desktop/db.js`
- Modify: `lib/desktop/workspace.js`
- Test: `tests/desktop-db.test.js`
- Test: `tests/desktop-mvp-workflows.test.js`

**Interfaces:**
- Produces: `createKnowledgeEntry(db, input)`、`updateKnowledgeEntry(db, id, patch)`、`rebuildKnowledgeChunks(db, id)`、`getKnowledgeEntry(db, id)`。

- [ ] 新增失败测试，验证旧知识迁移、元数据默认值、分段生成、更新重建和删除级联。
- [ ] 运行 `npm.cmd test -- --run tests/desktop-db.test.js tests/desktop-mvp-workflows.test.js`，确认新测试失败。
- [ ] 为 `knowledge_entries` 增加 `category/source_type/source_name/source_size/content_hash/version/imported_at`，新建 `knowledge_chunks` 和索引。
- [ ] 实现稳定的 SHA-256 内容哈希和按段落优先、最长约 1200 字符的分段函数。
- [ ] 在创建和更新事务中维护片段与版本，启动时为旧数据回填片段。
- [ ] 重跑目标测试并确认通过。

### Task 2: 查询、批量操作与相关性检索 API

**Files:**
- Modify: `lib/desktop/workspace.js`
- Modify: `lib/desktop/api-server.js`
- Test: `tests/desktop-api.test.js`

**Interfaces:**
- Produces: `queryKnowledgeEntries(db, query)` 返回 `{items,total,page,pageSize,facets}`。
- Produces: `bulkUpdateKnowledgeEntries(db, {ids, action})`。
- Produces: `findRelevantKnowledge(db, text, {limit,maxChars})`。

- [ ] 新增失败测试，覆盖组合筛选、排序、分页、重复哈希、批量启停/删除和只检索启用片段。
- [ ] 运行 `npm.cmd test -- --run tests/desktop-api.test.js`，确认新增测试失败。
- [ ] 实现查询参数白名单：`q/status/category/tag/sourceType/sort/order/page/pageSize`。
- [ ] 实现批量接口 `POST /api/knowledge/bulk`，仅允许 `enable/disable/delete` 和非空 ID 数组。
- [ ] 实现 `POST /api/knowledge/check-duplicate`，按内容哈希返回匹配文档。
- [ ] 让旧 `GET /api/knowledge` 无参数时保持数组响应，带查询参数时返回分页对象，避免破坏现有调用。
- [ ] 重跑 API 测试并确认通过。

### Task 3: Electron 和渲染端知识接口

**Files:**
- Modify: `desktop/electron/preload.js`
- Modify: `desktop/electron/main.js`
- Modify: `desktop/renderer/src/api.js`
- Test: `tests/desktop-ui-structure.test.js`

**Interfaces:**
- Produces: `queryKnowledge(query)`、`bulkKnowledge(input)`、`checkKnowledgeDuplicate(input)`。

- [ ] 新增失败测试，验证 IPC 暴露并正确编码查询参数和批量请求。
- [ ] 实现主进程 IPC 到本地 API 的薄转发。
- [ ] 实现渲染端 API 包装，不在组件中拼接 HTTP 地址。
- [ ] 重跑结构测试并确认通过。

### Task 4: 完整知识库管理页面

**Files:**
- Modify: `desktop/renderer/src/components/KnowledgePage.jsx`
- Modify: `desktop/renderer/src/styles.css`
- Test: `tests/desktop-ui-structure.test.js`

**Interfaces:**
- Consumes: Task 3 的查询、批量和重复检测接口。

- [ ] 新增失败测试，覆盖搜索、状态/分类/标签/来源筛选、排序、分页、多选和批量动作。
- [ ] 将页面整理为操作区、筛选工具栏、文档列表和编辑详情四个清晰区域。
- [ ] 文件导入逐个执行重复检测，重复默认跳过，显示成功/跳过/失败明细。
- [ ] 增加当前页全选、批量启用、批量停用、批量删除和 JSON 导出。
- [ ] 增加来源、版本、字符数、片段数和时间信息；未保存修改切换前要求确认。
- [ ] 为窄窗口和浏览器停靠布局添加响应式规则，禁止横向溢出遮挡操作。
- [ ] 重跑结构测试并确认通过。

### Task 5: GEO 获客 Demo 知识

**Files:**
- Create: `knowledge-demo/01-GEO服务说明.md`
- Create: `knowledge-demo/02-客户意向识别.md`
- Create: `knowledge-demo/03-常见问题回复.md`
- Create: `knowledge-demo/04-获客私信话术.md`
- Create: `knowledge-demo/05-自动回复规则.md`
- Create: `knowledge-demo/06-人工接管与禁区.md`
- Test: `tests/knowledge-demo.test.js`

- [ ] 新增内容校验测试，检查 6 个文件、统一元信息、禁用虚构承诺和人工接管规则。
- [ ] 编写 6 份 UTF-8 Markdown，使用 `用途/分类/标签/适用渠道/维护提示` 统一头部。
- [ ] 在 FAQ 和话术中覆盖收费、周期、效果、流程、资料、行业、拒绝联系和非文本消息。
- [ ] 运行 `npm.cmd test -- --run tests/knowledge-demo.test.js` 并确认通过。

### Task 6: LLM 使用相关知识片段

**Files:**
- Modify: `lib/desktop/mvp-workflows.js`
- Modify: `lib/desktop/dm-reply-workflow.js`
- Test: `tests/desktop-mvp-workflows.test.js`
- Test: `tests/desktop-dm-reply-workflow.test.js`

- [ ] 新增失败测试，验证评论和私信只取得启用且相关的有限知识，不把停用或无关内容传给 LLM。
- [ ] 用 `findRelevantKnowledge` 替换无条件加载全部知识的路径，保留知识 ID 供引用校验。
- [ ] 控制知识总字符数，避免大型知识库造成 LLM 请求过大。
- [ ] 重跑两个工作流测试并确认通过。

### Task 7: 完整验证与本地启动

**Files:**
- Verify only.

- [ ] 运行 `npm.cmd test -- --run`，预期所有测试通过。
- [ ] 在 `desktop/` 运行 `npm.cmd run build`，预期 Vite 生产构建成功。
- [ ] 重启 Electron 开发项目，确认 `5174/19422/19522` 监听且窗口打开。
- [ ] 手动确认知识库页面可导入 `knowledge-demo/` 的 6 个文件并显示导入结果。
