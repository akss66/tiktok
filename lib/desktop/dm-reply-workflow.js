const fs = require('fs');
const path = require('path');

const { LLMClient } = require('../llm');
const dmInbox = require('./dm-inbox');
const dmWorkQueue = require('./dm-work-queue');
const settings = require('./settings');
const workspace = require('./workspace');
const { stringifyJson } = require('./serialize');

const INTENTS = new Set([
  'greeting', 'price', 'service', 'cooperation', 'support',
  'complaint', 'refund', 'other', 'unknown',
]);
const INTENT_LEVELS = new Set(['high', 'medium', 'low', 'ignore']);
const SENSITIVE_CATEGORIES = new Set([
  'none', 'complaint', 'refund', 'unclear_price', 'conflict',
  'medical', 'legal', 'financial', 'unknown_fact', 'privacy', 'other_sensitive',
]);
const MODE_SENSITIVE_REASONS = new Set(['sensitive_category', 'unknown_fact', 'sensitive_intent']);
const STRATEGY_FILES = [
  '全局规则.md', '执行模板.md', '推广引流.md', '评论区运营.md',
  '评论风格指南.md', 'reply-strategy.md', '快速参考卡.md',
];
const MAX_CONTEXT_MESSAGES = 20;
const MAX_TEXT = 500;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function text(value, max = MAX_TEXT) {
  return String(value || '').trim().slice(0, max);
}

function containsUnsafeAutomaticReply(value) {
  const reply = String(value || '');
  return /https?:\/\/|www\./i.test(reply)
    || /(?:加|联系)(?:我|客服)?(?:的)?(?:微信|vx|v信)/i.test(reply)
    || /(?:联系电话|手机号|手机)\D{0,8}1\d{10}/.test(reply)
    || /(?:保证稳赚|稳赚不赔|百分百有效|包治|必须购买|立刻购买|不买.*后悔)/i.test(reply);
}

function loadStrategyMarkdown(rootDir = process.cwd()) {
  let remaining = 20_000;
  const sections = [];
  for (const name of STRATEGY_FILES) {
    if (remaining <= 0) break;
    try {
      const content = fs.readFileSync(path.join(rootDir, name), 'utf8').slice(0, remaining);
      if (!content.trim()) continue;
      sections.push(`# ${name}\n${content}`);
      remaining -= content.length;
    } catch {}
  }
  return sections.join('\n\n');
}

function getLinkedLead(db, conversation) {
  const row = db.prepare(`
    SELECT intent_level, reason, comment_text
    FROM dm_leads
    WHERE account_id = ? AND conversation_id = ?
    ORDER BY updated_at DESC, id ASC
    LIMIT 1
  `).get(conversation.accountId, conversation.conversationId);
  if (!row) return null;
  return {
    intentLevel: text(row.intent_level, 40),
    reason: text(row.reason),
    commentText: text(row.comment_text),
  };
}

function buildDmConversationContext(db, work, options = {}) {
  const conversation = dmInbox.getConversation(db, work.conversationId);
  if (!conversation || conversation.accountId !== work.accountId) {
    throw Object.assign(new Error('DM conversation not found for analysis'), { statusCode: 404 });
  }
  const ordered = db.prepare(`
    SELECT direction, content
    FROM dm_messages
    WHERE conversation_row_id = ?
      AND LOWER(TRIM(CAST(message_type AS TEXT))) IN ('text', '7')
    ORDER BY
      timestamp_ms DESC,
      CASE WHEN message_key GLOB 'index:[0-9]*' THEN 0 ELSE 1 END DESC,
      CASE
        WHEN message_key GLOB 'index:[0-9]*'
        THEN CAST(SUBSTR(message_key, 7) AS INTEGER)
        ELSE NULL
      END DESC,
      message_key DESC,
      id DESC
    LIMIT ?
  `).all(conversation.id, MAX_CONTEXT_MESSAGES).reverse();
  const messages = ordered.map((message, index) => ({
    role: message.direction === 'outbound' ? 'self' : 'peer',
    content: text(message.content),
    order: index + 1,
  }));
  const sourceComment = text(conversation.sourceComment);
  const lead = getLinkedLead(db, conversation);
  const knowledgeQuery = [
    ...messages.map((message) => message.content),
    sourceComment,
    lead?.commentText,
    lead?.reason,
  ].filter(Boolean).join('\n');
  const knowledge = workspace.findRelevantKnowledge(db, knowledgeQuery, {
    limit: 20,
    maxChars: 12_000,
  }).map((entry) => ({
    id: text(entry.id, 120),
    title: text(entry.title, 160),
    content: text(entry.content, 1000),
    tags: text(entry.tags, 200),
    enabled: true,
  }));
  return {
    messages,
    sourceComment,
    lead,
    knowledge,
    strategyMarkdown: loadStrategyMarkdown(options.strategyRoot || process.cwd()),
  };
}

function normalizeDmReplyDecision(value, context = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const knowledgeIds = context.knowledgeIds instanceof Set ? context.knowledgeIds : new Set();
  const requestedRefs = Array.isArray(input.knowledgeRefs)
    ? [...new Set(input.knowledgeRefs.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
  const knowledgeRefs = requestedRefs.filter((id) => knowledgeIds.has(id));
  const invalidKnowledgeRefs = requestedRefs.filter((id) => !knowledgeIds.has(id));
  const intent = INTENTS.has(input.intent) ? input.intent : 'unknown';
  const intentLevel = INTENT_LEVELS.has(input.intentLevel) ? input.intentLevel : 'ignore';
  const sensitiveCategory = SENSITIVE_CATEGORIES.has(input.sensitiveCategory)
    ? input.sensitiveCategory
    : 'other_sensitive';
  const reply = text(input.reply);
  const reason = text(input.reason);
  const forceManualReasons = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) forceManualReasons.push('invalid_decision');
  if (!INTENTS.has(input.intent) || !INTENT_LEVELS.has(input.intentLevel)) forceManualReasons.push('invalid_classification');
  if (invalidKnowledgeRefs.length) forceManualReasons.push('knowledge_reference_invalid');
  if (!reply) forceManualReasons.push('empty_reply');
  if (containsUnsafeAutomaticReply(reply)) forceManualReasons.push('unsafe_reply');
  if (sensitiveCategory !== 'none') forceManualReasons.push('sensitive_category');
  if (intent === 'unknown') forceManualReasons.push('unknown_fact');
  if (intent === 'complaint' || intent === 'refund') forceManualReasons.push('sensitive_intent');
  return {
    intent,
    intentLevel,
    knowledgeRefs,
    invalidKnowledgeRefs,
    confidence: clamp(input.confidence, 0, 1),
    reply,
    allowAutomatic: input.allowAutomatic === true,
    reason,
    sensitiveCategory,
    forceManualReasons: [...new Set(forceManualReasons)],
  };
}

function isForcedManual(decision) {
  return !decision || decision.forceManualReasons?.length > 0;
}

function manualReasons(decision, predicate) {
  if (!decision || !Array.isArray(decision.forceManualReasons)) return ['invalid_decision'];
  return decision.forceManualReasons.filter(predicate);
}

function hardManualReasons(decision) {
  return manualReasons(decision, (reason) => !MODE_SENSITIVE_REASONS.has(reason));
}

function modeSensitiveReasons(decision) {
  return manualReasons(decision, (reason) => MODE_SENSITIVE_REASONS.has(reason));
}

function forcedReason(decision, reasons = decision?.forceManualReasons || []) {
  if (reasons.includes('unsafe_reply')) return '回复内容触发安全边界，需要人工审核';
  if (reasons.includes('knowledge_reference_invalid')) return '知识引用已失效或未启用，需要人工核实';
  if (reasons.includes('empty_reply')) return 'AI 未生成有效回复，需要人工处理';
  if (reasons.some((item) => item.includes('sensitive') || item === 'unknown_fact')) {
    return '涉及敏感事项或未知事实，需要人工核实后回复';
  }
  return 'AI 判断不完整，需要人工审核';
}

function decideAction(mode, decision, dmSettings) {
  if (mode === 'manual') return { action: 'draft', reason: '当前为人工审核模式' };
  const hardReasons = hardManualReasons(decision);
  if (hardReasons.length) return { action: 'draft', reason: forcedReason(decision, hardReasons) };

  if (mode === 'tiered') {
    const sensitiveReasons = modeSensitiveReasons(decision);
    if (sensitiveReasons.length) return { action: 'draft', reason: forcedReason(decision, sensitiveReasons) };
    if (!decision.allowAutomatic) return { action: 'draft', reason: 'AI 未授权自动回复，需要人工审核' };
    if (!decision.knowledgeRefs.length) return { action: 'draft', reason: '未命中有效知识库，需要人工审核' };
    if (decision.confidence < dmSettings.knowledge_confidence) {
      return { action: 'draft', reason: '知识匹配置信度不足，需要人工审核' };
    }
    return { action: 'send_auto', reason: decision.reason || '知识命中且满足分级自动回复条件' };
  }

  if (mode === 'automatic') {
    if (!decision.knowledgeRefs.length && decision.intent !== 'greeting') {
      return { action: 'draft', reason: '业务问题没有有效知识依据，需要人工审核' };
    }
    if (decision.confidence < 0.5) return { action: 'draft', reason: 'AI 判断置信度过低，需要人工审核' };
    return { action: 'send_auto', reason: decision.reason || '满足自动回复安全条件' };
  }
  return { action: 'draft', reason: '回复模式无效，需要人工审核' };
}

function createLlmClient(storageDir) {
  const config = settings.getLlmSettings({ storageDir });
  return new LLMClient({
    apiKey: config.api_key,
    baseUrl: config.base_url,
    model: config.model,
    maxTokens: config.max_tokens,
    timeoutMs: config.timeout_ms,
    maxRetries: config.max_retries,
  });
}

function randomDelay(settingsValue, random) {
  const min = Number(settingsValue.auto_delay_min_ms);
  const max = Math.max(min, Number(settingsValue.auto_delay_max_ms));
  const unit = clamp(random(), 0, 1);
  return min + Math.floor((max - min) * unit);
}

function safeAnalysisResult(action, reason, draft, autoWork = null) {
  return {
    action,
    reason: text(reason),
    draftId: draft?.id || null,
    autoWorkId: autoWork?.id || null,
  };
}

function persistedAnalysisResult(db, analysisWork) {
  return {
    ...analysisWork.result,
    draft: dmInbox.getReplyDraftByConversation(db, analysisWork.conversationId),
    analysisWork,
    autoWork: analysisWork.result?.autoWorkId
      ? dmWorkQueue.getWork(db, analysisWork.result.autoWorkId)
      : null,
  };
}

async function analyzeIncomingMessage(db, work, options = {}) {
  const existing = dmWorkQueue.getWork(db, work?.id);
  if (!existing) throw Object.assign(new Error('DM analysis work item not found'), { statusCode: 404 });
  const expectedWorkerId = work?.workerId;
  const expectedClaimToken = work?.claimToken;
  const current = dmWorkQueue.validateWorkClaim(
    db,
    existing.id,
    expectedWorkerId,
    expectedClaimToken,
    { allowTerminal: true, type: 'analyze', statuses: ['running'] },
  );
  if (current.type !== 'analyze') {
    throw Object.assign(new Error('DM work item is not an analysis item'), { statusCode: 409 });
  }
  if (current.status === 'success') {
    return persistedAnalysisResult(db, current);
  }
  if (current.status !== 'running') {
    throw Object.assign(new Error('DM analysis work item must be claimed before analysis'), { statusCode: 409 });
  }

  const context = buildDmConversationContext(db, current, options);
  const dmSettings = options.dmSettings || settings.getDmSettings({ storageDir: options.storageDir });
  const conversation = dmInbox.getConversation(db, current.conversationId);
  const mode = conversation.replyModeOverride || dmSettings.reply_mode;
  const knowledgeIds = new Set(context.knowledge.map((entry) => entry.id));
  let decision;
  let llmFailed = false;
  try {
    const client = options.llmClient || createLlmClient(options.storageDir);
    decision = normalizeDmReplyDecision(await client.analyzeDmConversation({
      messages: context.messages,
      sourceComment: context.sourceComment,
      lead: context.lead,
    }, {
      knowledge: context.knowledge,
      strategyMarkdown: context.strategyMarkdown,
    }), { knowledgeIds });
  } catch {
    llmFailed = true;
    decision = normalizeDmReplyDecision({}, { knowledgeIds });
  }
  const initial = llmFailed
    ? { action: 'draft', reason: 'AI 分析失败，已转为人工审核' }
    : decideAction(mode, decision, dmSettings);
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;

  return db.transaction(() => {
    const nowMs = Number(nowFn());
    const commit = dmWorkQueue.acquireAnalysisCommit(
      db,
      current.id,
      expectedWorkerId,
      expectedClaimToken,
      nowMs,
    );
    if (!commit.acquired) return persistedAnalysisResult(db, commit.workItem);
    let action = initial.action;
    let reason = initial.reason;
    let autoWork = null;
    let draft = dmInbox.upsertReplyDraft(db, {
      accountId: current.accountId,
      conversationRowId: current.conversationId,
      content: decision.reply,
      status: action === 'send_auto' ? 'queued' : 'needs_review',
      meta: {
        intent: decision.intent,
        intentLevel: decision.intentLevel,
        knowledgeRefs: decision.knowledgeRefs,
        confidence: decision.confidence,
        allowAutomatic: decision.allowAutomatic,
        reason,
        sensitiveCategory: decision.sensitiveCategory,
        llmFailed,
      },
    });

    if (action === 'send_auto') {
      const frequency = dmSettings.auto_reply_frequency === 'always' ? 'always' : 'once';
      const sourceMessageId = String(current.messageId || current.payload?.sourceMessageId || current.id);
      const pending = dmInbox.createPendingOutboundMessage(db, {
        accountId: current.accountId,
        conversationId: current.conversationId,
        content: decision.reply,
        mode: 'automatic',
      });
      const consumed = dmInbox.consumeAutoReplyAuthorization(db, current.conversationId, {
        messageId: pending.message.id,
        dedupeKey: frequency === 'always' ? `source-message:${sourceMessageId}` : undefined,
        sourceWorkId: current.id,
        text: decision.reply,
        conversationKey: pending.conversationKey,
      }, { frequency });
      if (!consumed.consumed) {
        db.prepare('DELETE FROM dm_messages WHERE id = ?').run(pending.message.id);
        action = 'draft';
        reason = consumed.reason === 'authorization_required'
          ? '该会话已经自动回复过一次，请人工审核或重新授权'
          : '该会话未授权自动回复，请人工审核';
        draft = dmInbox.upsertReplyDraft(db, {
          accountId: current.accountId,
          conversationRowId: current.conversationId,
          content: decision.reply,
          status: 'needs_review',
          meta: { ...draft.meta, reason, authorizationReason: consumed.reason },
        });
      } else if (!consumed.created) {
        db.prepare('DELETE FROM dm_messages WHERE id = ?').run(pending.message.id);
        autoWork = dmWorkQueue.getWork(db, consumed.workItem.id);
        reason = '该条消息的自动回复已在发送队列中';
        draft = dmInbox.upsertReplyDraft(db, {
          accountId: current.accountId,
          conversationRowId: current.conversationId,
          content: String(autoWork?.payload?.text || decision.reply),
          status: 'queued',
          meta: { ...draft.meta, reason, deduplicated: true },
        });
      } else {
        const delayMs = randomDelay(dmSettings, random);
        const nextRunAt = new Date(nowMs + delayMs).toISOString();
        db.prepare(`
          UPDATE dm_work_items
          SET type = 'send_auto', next_run_at = ?, payload = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextRunAt,
          stringifyJson({
            messageId: pending.message.id,
            text: decision.reply,
            conversationKey: pending.conversationKey,
            sourceWorkId: current.id,
            sourceDraftId: draft.id,
          }),
          new Date(nowMs).toISOString(),
          consumed.workItem.id,
        );
        autoWork = dmWorkQueue.getWork(db, consumed.workItem.id);
      }
    }

    const result = safeAnalysisResult(action, reason, draft, autoWork);
    const analysisWork = dmWorkQueue.completeWork(db, current.id, result, {
      workerId: expectedWorkerId,
      claimToken: expectedClaimToken,
      now: nowMs,
    });
    return { ...result, decision, draft, autoWork, analysisWork };
  })();
}

module.exports = {
  analyzeIncomingMessage,
  buildDmConversationContext,
  isForcedManual,
  loadStrategyMarkdown,
  normalizeDmReplyDecision,
};
