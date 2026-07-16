import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Info,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  deleteDmConversation,
  friendlyError,
  getDmConversationAnalysis,
  getDmConversation,
  listAccounts,
  listDmConversations,
  listDmMessages,
  listDmMonitorStates,
  markDmConversationRead,
  reanalyzeDmConversation,
  reauthorizeDmAutoReply,
  sendDmReply,
  updateDmConversation,
} from '../api.js';
import { PageHeader } from './PageHeader.jsx';
import { SelectMenu } from './SelectMenu.jsx';

const POLL_INTERVAL_MS = 15_000;

export function subscribeDmNavigation(api, onNavigation, makeNonce = Date.now) {
  if (!api?.onDmNavigate || typeof onNavigation !== 'function') return () => {};
  let lastNonce = 0;
  const unsubscribe = api.onDmNavigate((payload) => {
    const accountId = typeof payload?.accountId === 'string' ? payload.accountId.trim() : '';
    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
    if (!accountId || !conversationId) return;
    const candidate = Number(makeNonce());
    const nonce = Math.max(Number.isFinite(candidate) ? candidate : 0, lastNonce + 1);
    lastNonce = nonce;
    onNavigation({ accountId, conversationId, nonce });
  });
  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}

export function startInboxPolling(load, options = {}) {
  const intervalMs = options.intervalMs || POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn || window.setInterval.bind(window);
  const clearIntervalFn = options.clearIntervalFn || window.clearInterval.bind(window);
  let active = true;
  let inFlight = false;
  const tick = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      await load();
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setIntervalFn(tick, intervalMs);
  return () => {
    if (!active) return;
    active = false;
    clearIntervalFn(timer);
  };
}

export function createRequestGate() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      const current = generation;
      return { isCurrent: () => generation === current };
    },
    invalidate() {
      generation += 1;
    },
  };
}

function messageIndex(message) {
  const match = /^index:(\d+)$/.exec(String(message?.messageKey || ''));
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function sortDmMessages(messages) {
  return [...(Array.isArray(messages) ? messages : [])].sort((left, right) => (
    Number(left.timestamp || 0) - Number(right.timestamp || 0)
    || messageIndex(left) - messageIndex(right)
    || String(left.messageKey || left.id || '').localeCompare(String(right.messageKey || right.id || ''))
  ));
}

export function scrollDmTimelineToLatest(timeline) {
  if (!timeline) return false;
  timeline.scrollTop = timeline.scrollHeight;
  return true;
}

export function canSendDmReply(text, sending) {
  return !sending && Boolean(String(text || '').trim());
}

export function conversationDisplayName(conversation = {}) {
  const peerName = String(conversation.peerName || '').trim();
  if (peerName) return peerName;
  const peerId = String(conversation.peerId || '').trim();
  return peerId ? `抖音用户 ${peerId}` : '抖音用户';
}

export function mergePinnedConversation(conversations, pinnedConversation, limit = 100) {
  const safeLimit = Math.max(1, Number(limit) || 100);
  const merged = [];
  const seen = new Set();
  for (const conversation of [pinnedConversation, ...(Array.isArray(conversations) ? conversations : [])]) {
    if (!conversation?.id || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    merged.push(conversation);
    if (merged.length >= safeLimit) break;
  }
  return merged;
}

export function dmMessageStatus(status) {
  return {
    pending: { label: '等待发送', tone: 'neutral' },
    accepted: { label: '平台已受理，等待确认', tone: 'warning' },
    sent: { label: '已发送', tone: 'success' },
    failed: { label: '发送失败', tone: 'danger' },
    needs_confirmation: { label: '需要人工确认', tone: 'warning' },
    cancelled: { label: '已取消', tone: 'neutral' },
  }[status] || { label: '已接收', tone: 'neutral' };
}

function monitorMeta(status) {
  return {
    enabled: ['监听中', 'success'],
    online: ['监听中', 'success'],
    running: ['连接中', 'warning'],
    connecting: ['连接中', 'warning'],
    backoff: ['等待重连', 'warning'],
    login_required: ['需要登录', 'warning'],
    error: ['监听异常', 'danger'],
    disabled: ['未开启', 'neutral'],
    idle: ['等待消息', 'neutral'],
  }[status] || ['未开启', 'neutral'];
}

export function dmHistoryStatusText(status) {
  return {
    available: '历史同步能力可用',
    realtime_only: '仅实时：只保证监听期间收到的消息',
    syncing: '正在同步历史消息',
    complete: '历史消息已同步',
    incomplete: '历史补拉不完整：只保证监听期间收到的消息',
  }[status] || '仅实时：只保证监听期间收到的消息';
}

export function dmMessageDisplayContent(message = {}) {
  const type = String(message.messageType ?? '').trim().toLowerCase();
  const content = String(message.content || '').trim();
  if (type === 'text' || type === '7') return content || '空白文字消息';
  const mediaLabel = {
    image: '图片',
    sticker: '表情',
    emoji: '表情',
    video: '视频',
    audio: '语音',
    voice: '语音',
  }[type] || '非文字消息';
  return `收到一条${mediaLabel}，请在抖音中查看`;
}

export function dmConversationPreview(conversation = {}) {
  const content = String(conversation.lastMessageText || '').trim();
  if (!content) return '暂无文字消息';
  if (/^[\[{]/.test(content)) {
    try {
      JSON.parse(content);
      return '收到一条非文字消息';
    } catch {
      // Keep ordinary text that only happens to start with a bracket.
    }
  }
  return content;
}

function intentLabel(intent) {
  return {
    greeting: '问候互动',
    price: '价格咨询',
    service: '服务咨询',
    cooperation: '合作意向',
    support: '售后支持',
    complaint: '投诉反馈',
    refund: '退款相关',
    other: '一般咨询',
    unknown: '暂未识别',
  }[intent] || '暂未识别';
}

function intentLevelLabel(level) {
  return { high: '高意向', medium: '中意向', low: '低意向', ignore: '无需跟进' }[level] || '待判断';
}

export function dmAnalysisPresentation(analysis) {
  const work = analysis?.workItem;
  const draft = analysis?.draft;
  if (!work && !draft) return { label: '等待文字消息', tone: 'neutral', detail: '收到文字消息后会自动排队分析。' };
  if (work?.status === 'pending') return { label: '等待分析', tone: 'warning', detail: '已进入本地串行队列。' };
  if (work?.status === 'running' || work?.status === 'committing') return { label: '分析中', tone: 'warning', detail: '正在理解会话并匹配知识库。' };
  if (work?.status === 'failed') return { label: '分析失败', tone: 'danger', detail: work.error || '请检查 AI 配置后重试。' };
  if (draft?.meta?.llmFailed) return { label: 'AI 分析失败', tone: 'danger', detail: draft.meta?.reason || '请检查 AI 配置后人工处理。' };
  if (draft?.status === 'queued') return { label: '等待发送', tone: 'warning', detail: '草稿已审核，正在等待串行发送。' };
  if (draft?.status === 'accepted') return { label: '等待平台确认', tone: 'warning', detail: '发送请求已受理，正在等待抖音会话回显。' };
  if (draft?.status === 'cancelled') return { label: '已取消', tone: 'neutral', detail: '该自动回复已被人工回复替代，没有发送。' };
  if (draft?.status === 'sent') return { label: '已发送', tone: 'success', detail: '该草稿已经发送成功。' };
  if (draft) return { label: '待人工审核', tone: 'success', detail: draft.meta?.reason || 'AI 草稿已生成，请核对后发送。' };
  return { label: '等待分析结果', tone: 'warning', detail: '分析任务已经完成，正在读取结果。' };
}

function conversationStatusLabel(status) {
  return { open: '待处理', follow_up: '跟进中', closed: '已结束' }[status] || '待处理';
}

function replyModeLabel(mode) {
  return { manual: '全部人工', tiered: '分级自动', automatic: '完全自动' }[mode] || '跟随全局设置';
}

function formatListTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function formatMessageTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LoadingLines({ count = 4 }) {
  return (
    <div className="dm-inbox-skeleton" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: count }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function DmInboxPage({ navigation = null }) {
  const [accounts, setAccounts] = useState([]);
  const [monitorStates, setMonitorStates] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState([]);
  const timelineRef = useRef(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [composer, setComposer] = useState('');
  const [composerDraftId, setComposerDraftId] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [analysisError, setAnalysisError] = useState('');
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendOperation, setSendOperation] = useState(null);
  const [deletingId, setDeletingId] = useState('');
  const [conversationError, setConversationError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [composerError, setComposerError] = useState('');
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState('list');
  const accountIdRef = useRef(accountId);
  const selectedIdRef = useRef(selectedId);
  const conversationsRef = useRef(conversations);
  const pendingNavigationRef = useRef(null);
  const pinnedSelectionRef = useRef(null);
  const sendOperationRef = useRef(null);
  const sendGenerationRef = useRef(0);
  const conversationGateRef = useRef(createRequestGate());
  const messageGateRef = useRef(createRequestGate());
  const analysisGateRef = useRef(createRequestGate());
  const drawerCloseRef = useRef(null);

  accountIdRef.current = accountId;
  selectedIdRef.current = selectedId;
  conversationsRef.current = conversations;

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) || null,
    [conversations, selectedId],
  );
  const sending = Boolean(
    sendOperation
      && sendOperation.accountId === accountId
      && sendOperation.conversationId === selectedId,
  );
  const sendInFlight = Boolean(sendOperation);
  const deletingConversation = Boolean(deletingId);

  const refreshMonitorStates = useCallback(async () => {
    try {
      const states = await listDmMonitorStates();
      setMonitorStates(Array.isArray(states) ? states : []);
    } catch {
      // Conversation data stays usable even when the monitor diagnostic is temporarily unavailable.
    }
  }, []);

  const refreshConversations = useCallback(async ({ targetId = '', background = false } = {}) => {
    const currentAccountId = accountIdRef.current;
    if (!currentAccountId) {
      setConversations([]);
      setSelectedId('');
      return;
    }
    const request = conversationGateRef.current.next();
    if (!background) setLoadingConversations(true);
    setConversationError('');
    try {
      let next = await listDmConversations({ accountId: currentAccountId, limit: 100, offset: 0 });
      next = Array.isArray(next) ? next : [];
      const requestedId = targetId || (
        pendingNavigationRef.current?.accountId === currentAccountId
          ? pendingNavigationRef.current.conversationId
          : pinnedSelectionRef.current?.accountId === currentAccountId
            ? pinnedSelectionRef.current.conversationId
            : ''
      );
      let pinnedConversation = null;
      if (requestedId && !next.some((conversation) => conversation.id === requestedId)) {
        try {
          pinnedConversation = await getDmConversation(currentAccountId, requestedId);
        } catch (error) {
          if (request.isCurrent()) {
            setConversationError('通知对应的会话不存在，或不属于当前账号。');
          }
        }
      }
      if (!request.isCurrent()) return;
      next = mergePinnedConversation(next, pinnedConversation, 100);
      next.sort((left, right) => Number(right.lastMessageAt || 0) - Number(left.lastMessageAt || 0));
      setConversations(next);
      setSelectedId((current) => {
        if (requestedId && next.some((conversation) => conversation.id === requestedId)) return requestedId;
        if (next.some((conversation) => conversation.id === current)) return current;
        return next[0]?.id || '';
      });
      if (requestedId) pendingNavigationRef.current = null;
    } catch (error) {
      if (request.isCurrent()) setConversationError(friendlyError(error, '加载私信会话失败'));
    } finally {
      if (request.isCurrent()) setLoadingConversations(false);
    }
  }, []);

  const refreshMessages = useCallback(async (conversationId = selectedIdRef.current, { background = false } = {}) => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    const request = messageGateRef.current.next();
    if (!background) setLoadingMessages(true);
    setMessageError('');
    try {
      const nextMessages = await listDmMessages(accountIdRef.current, conversationId, { limit: 200 });
      if (!request.isCurrent() || conversationId !== selectedIdRef.current) return;
      const currentConversation = conversationsRef.current.find((item) => item.id === conversationId);
      let readConversation = null;
      if (currentConversation?.unreadCount > 0) {
        readConversation = await markDmConversationRead(accountIdRef.current, conversationId);
      }
      if (!request.isCurrent() || conversationId !== selectedIdRef.current) return;
      setMessages(sortDmMessages(nextMessages));
      if (readConversation) {
        setConversations((current) => current.map((item) => (
          item.id === readConversation.id ? readConversation : item
        )));
      }
    } catch (error) {
      if (request.isCurrent()) setMessageError(friendlyError(error, '加载消息记录失败'));
    } finally {
      if (request.isCurrent()) setLoadingMessages(false);
    }
  }, []);

  const refreshAnalysis = useCallback(async (conversationId = selectedIdRef.current, { background = false } = {}) => {
    if (!conversationId) {
      setAnalysis(null);
      return;
    }
    const request = analysisGateRef.current.next();
    if (!background) setLoadingAnalysis(true);
    setAnalysisError('');
    try {
      const nextAnalysis = await getDmConversationAnalysis(accountIdRef.current, conversationId);
      if (!request.isCurrent() || conversationId !== selectedIdRef.current) return;
      setAnalysis(nextAnalysis || null);
    } catch (error) {
      if (request.isCurrent()) setAnalysisError(friendlyError(error, '加载 AI 分析结果失败'));
    } finally {
      if (request.isCurrent()) setLoadingAnalysis(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([
      refreshMonitorStates(),
      refreshConversations({ background: true }),
      refreshMessages(selectedIdRef.current, { background: true }),
      refreshAnalysis(selectedIdRef.current, { background: true }),
    ]);
  }, [refreshAnalysis, refreshConversations, refreshMessages, refreshMonitorStates]);

  useEffect(() => {
    let active = true;
    setLoadingAccounts(true);
    listAccounts()
      .then((items) => { if (active) setAccounts(Array.isArray(items) ? items : []); })
      .catch((error) => { if (active) setConversationError(friendlyError(error, '加载账号失败')); })
      .finally(() => { if (active) setLoadingAccounts(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const account = typeof navigation?.accountId === 'string' ? navigation.accountId.trim() : '';
    const conversation = typeof navigation?.conversationId === 'string' ? navigation.conversationId.trim() : '';
    if (!account || !conversation) return;
    const sameAccount = accountIdRef.current === account;
    pendingNavigationRef.current = { accountId: account, conversationId: conversation };
    pinnedSelectionRef.current = { accountId: account, conversationId: conversation };
    setMobilePane('thread');
    if (sameAccount) {
      void refreshConversations({ targetId: conversation });
      return;
    }
    accountIdRef.current = account;
    setAccountId(account);
  }, [navigation?.nonce, refreshConversations]);

  useEffect(() => {
    messageGateRef.current.invalidate();
    setComposer('');
    setComposerDraftId('');
    setAnalysis(null);
    setComposerError('');
    setMessages([]);
    if (!accountId) {
      conversationGateRef.current.invalidate();
      setConversations([]);
      setSelectedId('');
      return;
    }
    void refreshConversations();
  }, [accountId, refreshConversations]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setComposer('');
    setComposerDraftId('');
    setComposerError('');
    if (selectedId) {
      void refreshMessages(selectedId);
      void refreshAnalysis(selectedId);
    } else {
      setMessages([]);
      setAnalysis(null);
    }
  }, [refreshAnalysis, refreshMessages, selectedId]);

  useEffect(() => {
    let stop = () => {};
    const start = () => {
      if (document.hidden) return;
      stop = startInboxPolling(refreshAll, { intervalMs: POLL_INTERVAL_MS });
    };
    const handleVisibility = () => {
      stop();
      stop = () => {};
      if (!document.hidden) start();
    };
    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
      conversationGateRef.current.invalidate();
      messageGateRef.current.invalidate();
      analysisGateRef.current.invalidate();
    };
  }, [refreshAll]);

  useEffect(() => {
    if (!insightsOpen) return undefined;
    drawerCloseRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setInsightsOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [insightsOpen]);

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (unreadOnly && !conversation.unreadCount) return false;
      if (statusFilter && conversation.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [conversation.peerName, conversation.lastMessageText, conversation.conversationId]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
    });
  }, [conversations, query, statusFilter, unreadOnly]);

  const monitorState = monitorStates.find((state) => state.accountId === accountId);
  const [monitorLabel, monitorTone] = monitorMeta(monitorState?.status);
  const historyStatusLabel = dmHistoryStatusText(monitorState?.historyStatus);
  const needsConfirmation = messages.some((message) => message.status === 'needs_confirmation');
  const analysisState = dmAnalysisPresentation(analysis);
  const latestMessageMarker = messages.length
    ? String(messages[messages.length - 1].messageKey || messages[messages.length - 1].id || messages[messages.length - 1].timestamp || '')
    : '';

  useLayoutEffect(() => {
    if (!selectedId || loadingMessages) return;
    scrollDmTimelineToLatest(timelineRef.current);
  }, [selectedId, loadingMessages, latestMessageMarker]);

  async function handleSend() {
    if (!selectedId || !canSendDmReply(composer, Boolean(sendOperationRef.current))) return;
    const sendAccountId = accountIdRef.current;
    const sendConversationId = selectedIdRef.current;
    const draftSnapshot = composer;
    const sourceDraftId = composerDraftId;
    const text = draftSnapshot.trim();
    const requestId = sendGenerationRef.current + 1;
    sendGenerationRef.current = requestId;
    const operation = { requestId, accountId: sendAccountId, conversationId: sendConversationId };
    sendOperationRef.current = operation;
    setSendOperation(operation);
    setComposerError('');
    const isCapturedSendOperation = () => (
      sendOperationRef.current?.requestId === requestId
      && sendOperationRef.current?.accountId === sendAccountId
      && sendOperationRef.current?.conversationId === sendConversationId
      && sendGenerationRef.current === requestId
    );
    const isCurrentSendContext = () => (
      isCapturedSendOperation()
      && accountIdRef.current === sendAccountId
      && selectedIdRef.current === sendConversationId
    );
    try {
      const result = await sendDmReply(sendAccountId, sendConversationId, {
        text,
        mode: 'manual',
        ...(sourceDraftId ? { sourceDraftId } : {}),
      });
      const isCurrentConversation = isCurrentSendContext();
      if (result?.message && isCurrentConversation) {
        setMessages((current) => sortDmMessages([
          ...current.filter((message) => message.id !== result.message.id),
          result.message,
        ]));
      }
      if (isCurrentConversation) {
        setComposer((current) => (current === draftSnapshot ? '' : current));
        setComposerDraftId((current) => (current === sourceDraftId ? '' : current));
        await refreshMessages(sendConversationId);
        await refreshAnalysis(sendConversationId, { background: true });
      }
      await refreshConversations({ background: true });
    } catch (error) {
      if (isCurrentSendContext()) {
        setComposerError(friendlyError(error, '发送私信失败'));
      }
    } finally {
      if (isCapturedSendOperation()) {
        sendOperationRef.current = null;
        setSendOperation((current) => (
          current?.requestId === requestId
          && current.accountId === sendAccountId
          && current.conversationId === sendConversationId
            ? null
            : current
        ));
      }
    }
  }

  function handleUseAiDraft() {
    if (!analysis?.draft?.id || !analysis.draft.content) return;
    setComposer(analysis.draft.content);
    setComposerDraftId(analysis.draft.id);
    setInsightsOpen(false);
  }

  async function handleReanalyze() {
    const targetAccountId = accountIdRef.current;
    const targetConversationId = selectedIdRef.current;
    if (!targetAccountId || !targetConversationId || reanalyzing) return;
    setReanalyzing(true);
    setAnalysisError('');
    try {
      const workItem = await reanalyzeDmConversation(targetAccountId, targetConversationId);
      if (targetConversationId === selectedIdRef.current) {
        setAnalysis((current) => ({ ...(current || {}), workItem }));
        await refreshAnalysis(targetConversationId, { background: true });
      }
    } catch (error) {
      if (targetConversationId === selectedIdRef.current) {
        setAnalysisError(friendlyError(error, '重新分析失败'));
      }
    } finally {
      setReanalyzing(false);
    }
  }

  async function handleConversationStatus(status) {
    if (!selectedId) return;
    try {
      const updated = await updateDmConversation(accountIdRef.current, selectedId, { status });
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setMessageError(friendlyError(error, '更新会话状态失败'));
    }
  }

  async function handleDeleteConversation() {
    const deleteAccountId = accountIdRef.current;
    const deleteConversationId = selectedIdRef.current;
    if (!deleteAccountId || !deleteConversationId || sendOperationRef.current || deletingId) return;
    const target = conversationsRef.current.find((item) => item.id === deleteConversationId);
    const displayName = conversationDisplayName(target || {});
    const confirmed = window.confirm(
      `只会删除 Vulcan 本地保存的“${displayName}”聊天记录，不会删除抖音中的私信。确定继续吗？`,
    );
    if (!confirmed) return;
    setDeletingId(deleteConversationId);
    setMessageError('');
    try {
      await deleteDmConversation(deleteAccountId, deleteConversationId);
      const current = conversationsRef.current;
      const deletedIndex = Math.max(0, current.findIndex((item) => item.id === deleteConversationId));
      const remaining = current.filter((item) => item.id !== deleteConversationId);
      const nextConversation = remaining[Math.min(deletedIndex, Math.max(0, remaining.length - 1))] || null;
      const nextId = nextConversation?.id || '';
      conversationGateRef.current.invalidate();
      messageGateRef.current.invalidate();
      analysisGateRef.current.invalidate();
      pendingNavigationRef.current = null;
      pinnedSelectionRef.current = nextId ? { accountId: deleteAccountId, conversationId: nextId } : null;
      conversationsRef.current = remaining;
      selectedIdRef.current = nextId;
      setConversations(remaining);
      setSelectedId(nextId);
      setMessages([]);
      setAnalysis(null);
      setComposer('');
      setComposerDraftId('');
      setInsightsOpen(false);
      if (!nextId) setMobilePane('list');
    } catch (error) {
      setMessageError(friendlyError(error, '删除本地聊天记录失败'));
    } finally {
      setDeletingId('');
    }
  }

  async function handleReauthorize() {
    if (!selectedId) return;
    try {
      const updated = await reauthorizeDmAutoReply(accountIdRef.current, selectedId);
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setMessageError(friendlyError(error, '重新授权失败'));
    }
  }

  return (
    <section className="panel panel-wide dm-inbox-page">
      <PageHeader
        title="我的私信"
        description="查看账号新消息、处理会话并人工回复。"
        actions={(
          <button type="button" onClick={refreshAll} title="刷新本地私信数据">
            <RefreshCw size={15} aria-hidden="true" />刷新
          </button>
        )}
      />

      <div className={`dm-inbox-workspace mobile-${mobilePane}`}>
        <aside className="dm-inbox-conversations" aria-label="私信会话列表">
          <div className="dm-inbox-sidebar-tools">
            <label>
              <span>账号</span>
              <SelectMenu value={accountId} disabled={sendInFlight} onChange={(event) => {
                pinnedSelectionRef.current = null;
                pendingNavigationRef.current = null;
                setAccountId(event.target.value);
                setMobilePane('list');
              }} aria-label="私信账号">
                <option value="">请选择账号</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </SelectMenu>
            </label>
            <div className="dm-monitor-line">
              <span>监听状态</span>
              <strong className={`dm-state-text ${monitorTone}`}>{accountId ? monitorLabel : '未选择账号'}</strong>
            </div>
            <p className="dm-history-limitation">{historyStatusLabel}</p>
            {monitorState?.lastError ? (
              <p className="dm-monitor-error" role="alert" title={monitorState.lastError}>
                {monitorState.lastError}
              </p>
            ) : null}
            <label className="dm-inbox-search">
              <Search size={15} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索客户昵称或消息" />
            </label>
            <div className="dm-inbox-filter-row">
              <SelectMenu value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="会话状态筛选">
                <option value="">全部状态</option>
                <option value="open">待处理</option>
                <option value="follow_up">跟进中</option>
                <option value="closed">已结束</option>
              </SelectMenu>
              <button type="button" className={unreadOnly ? 'active' : ''} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((value) => !value)}>未读</button>
            </div>
          </div>

          <div className="dm-conversation-list" role="list" aria-busy={loadingConversations || loadingAccounts}>
            {loadingConversations || loadingAccounts ? <LoadingLines /> : null}
            {!loadingConversations && conversationError ? (
              <div className="dm-inbox-error" role="alert"><span>{conversationError}</span><button type="button" onClick={() => refreshConversations()}>重试</button></div>
            ) : null}
            {!loadingConversations && !conversationError && accountId && !visibleConversations.length ? (
              <div className="dm-inbox-empty"><MessageCircle size={22} /><strong>暂无匹配会话</strong><span>新私信入库后会显示在这里。</span></div>
            ) : null}
            {!loadingConversations && !accountId ? (
              <div className="dm-inbox-empty"><UserRound size={22} /><strong>先选择账号</strong><span>每个账号的私信记录相互隔离。</span></div>
            ) : null}
            {visibleConversations.map((conversation) => (
              <button
                type="button"
                role="listitem"
                key={conversation.id}
                className={`dm-conversation-item${selectedId === conversation.id ? ' active' : ''}`}
                disabled={sendInFlight}
                onClick={() => {
                  pinnedSelectionRef.current = { accountId, conversationId: conversation.id };
                  pendingNavigationRef.current = null;
                  setSelectedId(conversation.id);
                  setMobilePane('thread');
                }}
              >
                <span className="dm-avatar" aria-hidden="true">{conversationDisplayName(conversation).slice(0, 1)}</span>
                <span className="dm-conversation-copy">
                  <span className="dm-conversation-head"><strong>{conversationDisplayName(conversation)}</strong><time>{formatListTime(conversation.lastMessageAt)}</time></span>
                  <span className="dm-conversation-preview">{dmConversationPreview(conversation)}</span>
                  <span className="dm-conversation-meta">{conversationStatusLabel(conversation.status)}</span>
                </span>
                {conversation.unreadCount ? <span className="dm-unread-count" aria-label={`${conversation.unreadCount} 条未读`}>{Math.min(conversation.unreadCount, 99)}</span> : null}
              </button>
            ))}
          </div>
        </aside>

        <main className="dm-inbox-thread" aria-label="私信消息">
          {selectedConversation ? (
            <>
              <header className="dm-thread-header">
                <button type="button" className="icon-button dm-inbox-mobile-switch" aria-label="返回会话列表" onClick={() => setMobilePane('list')}><ArrowLeft size={16} /></button>
                <div><strong>{conversationDisplayName(selectedConversation)}</strong><span>{conversationStatusLabel(selectedConversation.status)}</span></div>
                <div className="dm-thread-header-actions">
                  <SelectMenu value={selectedConversation.status} onChange={(event) => handleConversationStatus(event.target.value)} aria-label="更新会话状态">
                    <option value="open">待处理</option>
                    <option value="follow_up">跟进中</option>
                    <option value="closed">已结束</option>
                  </SelectMenu>
                  <button
                    type="button"
                    className="icon-button dm-delete-conversation"
                    aria-label="删除本地聊天记录"
                    title="删除本地聊天记录"
                    disabled={sendInFlight || deletingConversation}
                    onClick={handleDeleteConversation}
                  >
                    <Trash2 size={16} />
                  </button>
                  <button type="button" className="icon-button dm-insights-trigger" aria-label="打开会话洞察" title="打开会话洞察" onClick={() => setInsightsOpen(true)}><Info size={16} /></button>
                </div>
              </header>

              <div className="dm-source-comment">
                <span>来源评论</span>
                <p>{selectedConversation.sourceComment || '暂无来源评论记录'}</p>
              </div>

              <div ref={timelineRef} className="dm-message-timeline" aria-live="polite" aria-busy={loadingMessages}>
                {loadingMessages ? <LoadingLines count={3} /> : null}
                {!loadingMessages && messageError ? <div className="dm-inbox-error" role="alert"><span>{messageError}</span><button type="button" onClick={() => refreshMessages(selectedId)}>重试</button></div> : null}
                {!loadingMessages && !messageError && !messages.length ? <div className="dm-inbox-empty"><MessageCircle size={22} /><strong>暂无消息记录</strong><span>等待对方回复，或先发送一条人工消息。</span></div> : null}
                {messages.map((message) => {
                  const status = dmMessageStatus(message.status);
                  return (
                    <article className={`dm-message-row ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`} key={message.id || message.messageKey || `${message.timestamp}-${message.content}`}>
                      <div className="dm-message-bubble">
                        <p>{dmMessageDisplayContent(message)}</p>
                        <footer><time>{formatMessageTime(message.timestamp)}</time>{message.direction === 'outbound' ? <span className={`dm-message-status ${status.tone}`}>{status.label}</span> : null}</footer>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="dm-composer">
                {needsConfirmation ? <p className="dm-confirmation-notice" role="status">有消息发送结果不确定，请先在抖音中人工确认，不会自动重试。</p> : null}
                {composerError ? <p className="dm-composer-error" role="alert">{composerError}</p> : null}
                <textarea
                  rows={3}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  aria-label="私信回复内容"
                />
                <div><span>Ctrl+Enter 或 Cmd+Enter 发送</span><button type="button" className="primary-button" title="发送私信" onClick={handleSend} disabled={!selectedId || !canSendDmReply(composer, sendInFlight)}><Send size={15} aria-hidden="true" />{sending ? '发送中' : '发送'}</button></div>
              </div>
            </>
          ) : (
            <div className="dm-thread-empty"><MessageCircle size={28} /><strong>选择一个会话</strong><span>消息记录和人工回复会显示在这里。</span></div>
          )}
        </main>

        {insightsOpen ? <button type="button" className="dm-insights-backdrop" aria-label="关闭会话洞察遮罩" onClick={() => setInsightsOpen(false)} /> : null}
        <aside className={`dm-inbox-insights${insightsOpen ? ' is-drawer' : ''}`} aria-label="会话洞察" aria-modal={insightsOpen || undefined} role={insightsOpen ? 'dialog' : undefined}>
          <header><div><Info size={16} /><strong>会话洞察</strong></div><button ref={drawerCloseRef} type="button" className="icon-button dm-insights-close" aria-label="关闭会话洞察" onClick={() => setInsightsOpen(false)}><X size={16} /></button></header>
          {selectedConversation ? (
            <div className="dm-insight-sections">
              <section>
                <span><UserRound size={15} />客户意向</span>
                <strong className={`dm-analysis-state ${analysisState.tone}`}>{analysisState.label}</strong>
                {analysis?.draft ? (
                  <p>{intentLevelLabel(analysis.draft.meta?.intentLevel)} · {intentLabel(analysis.draft.meta?.intent)}</p>
                ) : null}
                <p>{analysisError || analysisState.detail}</p>
                {loadingAnalysis ? <span className="dm-analysis-loading">正在读取最新分析结果...</span> : null}
                <button type="button" onClick={handleReanalyze} disabled={reanalyzing || loadingAnalysis} title="按当前自动回复模式和最新知识库重新处理">
                  <RefreshCw size={14} aria-hidden="true" />{reanalyzing ? '分析中' : '重新分析'}
                </button>
              </section>
              <section>
                <span><BookOpen size={15} />知识引用</span>
                <strong>{analysis?.knowledge?.length ? `已引用 ${analysis.knowledge.length} 条知识` : '暂无引用'}</strong>
                <p>{analysis?.knowledge?.length
                  ? analysis.knowledge.map((entry) => entry.title).join('、')
                  : '未命中知识库时，草稿必须由人工核实后发送。'}</p>
              </section>
              <section>
                <span><MessageCircle size={15} />AI 回复草稿</span>
                <strong>{analysis?.draft?.content ? '草稿已生成' : '暂无草稿'}</strong>
                <p className="dm-draft-preview">{analysis?.draft?.content || '收到可分析的文字消息后，这里会显示 AI 草稿。'}</p>
                <button type="button" onClick={handleUseAiDraft} disabled={!analysis?.draft?.content || analysis?.draft?.status === 'sent'}>
                  采用草稿并编辑
                </button>
              </section>
              <section><span><ShieldCheck size={15} />回复控制</span><strong>{replyModeLabel(selectedConversation.replyModeOverride)}</strong><p>{selectedConversation.autoReplyAuthorized ? '当前会话允许一次自动回复。' : '自动回复授权已使用，需要人工重新允许。'}</p><button type="button" onClick={handleReauthorize} disabled={selectedConversation.autoReplyAuthorized}>重新允许自动回复</button></section>
            </div>
          ) : <div className="dm-inbox-empty"><Info size={22} /><strong>暂无会话洞察</strong><span>选择会话后查看。</span></div>}
        </aside>
      </div>
    </section>
  );
}
