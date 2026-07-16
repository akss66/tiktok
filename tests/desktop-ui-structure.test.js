const fs = require('fs');
const path = require('path');
const React = require('../desktop/node_modules/react');
const TestRenderer = require('../desktop/node_modules/react-test-renderer');

const { act } = TestRenderer;

global.IS_REACT_ACT_ENVIRONMENT = true;

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node?.children) return '';
  return node.children.map(nodeText).join('');
}

function hasClass(node, className) {
  return String(node?.props?.className || '').split(/\s+/).includes(className);
}

function createDmBridge(overrides = {}) {
  return {
    listAccounts: vi.fn(async () => [{ id: 'account-1', name: '账号一' }]),
    listDmMonitorStates: vi.fn(async () => []),
    listDmConversations: vi.fn(async () => []),
    getDmConversation: vi.fn(async () => null),
    listDmMessages: vi.fn(async () => []),
    getDmConversationAnalysis: vi.fn(async () => ({ workItem: null, draft: null, knowledge: [] })),
    markDmConversationRead: vi.fn(async (_accountId, id) => ({ id, unreadCount: 0 })),
    updateDmConversation: vi.fn(async (_accountId, id, patch) => ({ id, ...patch })),
    deleteDmConversation: vi.fn(async (_accountId, id) => ({ id, deleted: true })),
    reauthorizeDmAutoReply: vi.fn(async (_accountId, id) => ({ id, autoReplyAuthorized: true })),
    sendDmReply: vi.fn(async (_accountId, id, input) => ({
      message: {
        id: `message-${id}`,
        conversationId: id,
        content: input.text,
        direction: 'outbound',
        status: 'pending',
        timestamp: Date.now(),
      },
    })),
    ...overrides,
  };
}

function installDmRendererEnvironment(bridge) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = new Map();
  let nextIntervalId = 1;

  const addListener = (store) => (type, handler) => {
    if (!store.has(type)) store.set(type, new Set());
    store.get(type).add(handler);
  };
  const removeListener = (store) => (type, handler) => store.get(type)?.delete(handler);

  global.document = {
    hidden: false,
    body: {},
    addEventListener: vi.fn(addListener(documentListeners)),
    removeEventListener: vi.fn(removeListener(documentListeners)),
  };
  global.window = {
    douyinDesktop: bridge,
    innerHeight: 900,
    innerWidth: 1400,
    addEventListener: vi.fn(addListener(windowListeners)),
    removeEventListener: vi.fn(removeListener(windowListeners)),
    setInterval: vi.fn((callback) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, callback);
      return id;
    }),
    clearInterval: vi.fn((id) => intervals.delete(id)),
  };

  return {
    async dispatchDocument(type, event = {}) {
      const handlers = [...(documentListeners.get(type) || [])];
      await Promise.all(handlers.map((handler) => handler(event)));
    },
    async runIntervals() {
      await Promise.all([...intervals.values()].map((callback) => callback()));
    },
    intervalCount() {
      return intervals.size;
    },
    restore() {
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
      if (previousDocument === undefined) delete global.document;
      else global.document = previousDocument;
    },
  };
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function conversation(id, name, lastMessageAt) {
  return {
    id,
    accountId: 'account-1',
    conversationId: `platform-${id}`,
    peerName: name,
    status: 'open',
    lastMessageAt,
    lastMessageText: `${name}的消息`,
    unreadCount: 0,
    autoReplyAuthorized: true,
  };
}

describe('desktop information architecture', () => {
  it('serializes DM startup, renderer navigation, shutdown, and account deletion lifecycle', () => {
    const main = read('desktop/electron/main.js');

    expect(main).toContain('await dmWorker.start()');
    expect(main).toContain('await dmMonitor.start()');
    expect(main.indexOf('await dmWorker.start()')).toBeLessThan(main.indexOf('await dmMonitor.start()'));
    expect(main).toContain("webContents.on('did-finish-load'");
    expect(main).toContain('pendingDmNavigation');
    expect(main).toContain('event.preventDefault()');
    expect(main).toContain('await stopDmMonitor()');
    expect(main).toContain('await stopDmWorker()');
    expect(main).toContain("['BrowserView shutdown', () => browserTabs.shutdown(mainWindow)]");
    expect(main).toContain("['local backend stop', () => localBackend.stop()]");

    const deleteStart = main.indexOf('async function deleteAccount(');
    const deleteEnd = main.indexOf('function registerIpc()', deleteStart);
    const deleteSource = main.slice(deleteStart, deleteEnd);
    const orderedMarkers = [
      'await dmMonitor.disableAccount(accountId)',
      'await stopDmWorker()',
      '/cancel-dm-work',
      'await browserTabs.closeAccountView(mainWindow, accountId)',
      'await browserTabs.clearAccountPartition(account)',
      "method: 'DELETE'",
    ];
    for (let index = 1; index < orderedMarkers.length; index += 1) {
      expect(deleteSource.indexOf(orderedMarkers[index - 1]))
        .toBeLessThan(deleteSource.indexOf(orderedMarkers[index]));
    }
  });
  it('mounts private-message settings, validates inline, and saves the selected automation mode', async () => {
    const { SettingsPage } = await import('../desktop/renderer/src/components/SettingsPage.jsx');
    const updateDmSettings = vi.fn(async (patch) => ({ ...patch }));
    const bridge = {
      getLlmSettings: vi.fn(async () => ({
        has_api_key: true,
        base_url: 'https://api.example.test/v1',
        model: 'deepseek-test',
        max_tokens: 4096,
        timeout_ms: 60000,
        max_retries: 3,
      })),
      getReplySettings: vi.fn(async () => ({ intent_threshold: 'medium', require_knowledge: true, max_draft_chars: 60 })),
      getDmSettings: vi.fn(async () => ({
        reply_mode: 'manual',
        auto_reply_frequency: 'once',
        knowledge_confidence: 0.85,
        auto_delay_min_ms: 15000,
        auto_delay_max_ms: 45000,
        monitor_after_login: false,
        notifications_enabled: true,
        notification_preview: false,
        quiet_hours_start: '',
        quiet_hours_end: '',
      })),
      getAppInfo: vi.fn(async () => ({ version: '1.1.1', packaged: true, platform: 'win32', arch: 'x64' })),
      updateLlmSettings: vi.fn(async (patch) => ({ ...patch, has_api_key: true })),
      updateReplySettings: vi.fn(async (patch) => patch),
      updateDmSettings,
      testLlmSettings: vi.fn(async () => ({ ok: true })),
    };
    const previousWindow = global.window;
    global.window = { douyinDesktop: bridge };
    let renderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(SettingsPage));
        await flushReact();
      });
      expect(nodeText(renderer.root)).toContain('私信与自动回复');
      const modeButtons = renderer.root.findAll((node) => hasClass(node, 'dm-mode-option'));
      expect(modeButtons.map(nodeText)).toEqual(['全自动回复', '涉敏信息需人工复核', '全人工审核']);
      expect(nodeText(renderer.root)).toContain('所有 AI 回复只生成草稿，人工确认后发送');
      const frequencyButtons = renderer.root.findAll((node) => hasClass(node, 'dm-frequency-option'));
      expect(frequencyButtons.map(nodeText)).toEqual(['每个会话一次', '持续回复']);
      expect(frequencyButtons[0].props['aria-pressed']).toBe(true);
      expect(renderer.root.findByProps({ 'aria-label': 'API Key' }).props.value).toBe('');

      await act(async () => modeButtons[0].props.onClick());
      await act(async () => frequencyButtons[1].props.onClick());
      expect(renderer.root.findAll((node) => hasClass(node, 'dm-mode-option'))[0].props['aria-pressed']).toBe(true);
      expect(nodeText(renderer.root)).toContain('有知识依据且通过安全校验的文字消息自动回复');
      expect(renderer.root.findAll((node) => hasClass(node, 'dm-frequency-option'))[1].props['aria-pressed']).toBe(true);

      const getConfidence = () => renderer.root.findByProps({ 'aria-label': '自动回复置信度' });
      expect(getConfidence().props).toMatchObject({ min: '0.5', max: '1', step: '0.01' });
      expect(renderer.root.findByProps({ 'aria-label': '自动发送最短延迟秒数' }).props)
        .toMatchObject({ min: '0', max: '100', step: '1', value: '15' });
      expect(renderer.root.findByProps({ 'aria-label': '自动发送最长延迟秒数' }).props)
        .toMatchObject({ min: '0', max: '100', step: '1', value: '45' });
      await act(async () => getConfidence().props.onChange({ target: { value: '0.4' } }));
      const form = renderer.root.findByType('form');
      await act(async () => form.props.onSubmit({ preventDefault() {} }));
      expect(updateDmSettings).not.toHaveBeenCalled();
      expect(nodeText(renderer.root)).toContain('请输入 0.5 到 1 之间的置信度');

      await act(async () => getConfidence().props.onChange({ target: { value: '0.5' } }));
      await act(async () => form.props.onSubmit({ preventDefault() {} }));
      expect(updateDmSettings).toHaveBeenCalledWith(expect.objectContaining({
        reply_mode: 'automatic',
        auto_reply_frequency: 'always',
        knowledge_confidence: 0.5,
        auto_delay_min_ms: 15000,
        auto_delay_max_ms: 45000,
      }));

      await act(async () => getConfidence().props.onChange({ target: { value: '1' } }));
      await act(async () => form.props.onSubmit({ preventDefault() {} }));
      expect(updateDmSettings).toHaveBeenLastCalledWith(expect.objectContaining({
        reply_mode: 'automatic',
        knowledge_confidence: 1,
      }));
      expect(updateDmSettings).toHaveBeenCalledTimes(2);
      expect(nodeText(renderer.root)).toContain('设置已保存');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      global.window = previousWindow;
    }
  });

  it('mounts account monitor controls and serializes inherited and explicit overrides exactly', async () => {
    const { AccountsPage } = await import('../desktop/renderer/src/components/AccountsPage.jsx');
    const { SelectMenu } = await import('../desktop/renderer/src/components/SelectMenu.jsx');
    const account = { id: 'account-1', name: '测试', group: '', notes: '', status: 'online', profileKey: 'profile-1' };
    const inherited = {
      accountId: account.id,
      enabled: false,
      settingSource: 'inherited',
      replyModeOverride: null,
      status: 'idle',
      lastError: null,
      historyStatus: 'realtime_only',
      historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
    };
    const updateDmMonitorState = vi.fn(async (_id, patch) => ({
      ...inherited,
      ...patch,
      enabled: patch.enabled === null ? false : patch.enabled,
    }));
    const bridge = {
      listAccounts: vi.fn(async () => [account]),
      listDmMonitorStates: vi.fn(async () => [inherited]),
      getDmSettings: vi.fn(async () => ({ monitor_after_login: true, reply_mode: 'tiered' })),
      updateDmMonitorState,
      updateAccount: vi.fn(async (_id, patch) => ({ ...account, ...patch })),
      onAccountsChanged: vi.fn(() => () => {}),
    };
    const previousWindow = global.window;
    global.window = { douyinDesktop: bridge, confirm: vi.fn(() => true) };
    let renderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(AccountsPage));
        await flushReact();
      });
      expect(nodeText(renderer.root)).toContain('私信监听');
      expect(nodeText(renderer.root)).toContain('继承全局');
      expect(nodeText(renderer.root)).toContain('仅实时：只保证监听期间收到的消息');

      const modeMenu = renderer.root.findAllByType(SelectMenu)
        .find((node) => node.props['aria-label'] === '测试 私信回复模式');
      await act(async () => {
        await modeMenu.props.onChange({ target: { value: 'automatic' } });
        await flushReact();
      });
      expect(updateDmMonitorState).toHaveBeenLastCalledWith(account.id, {
        enabled: true,
        settingSource: 'explicit',
        replyModeOverride: 'automatic',
      });

      const inheritButton = renderer.root.findByProps({ 'aria-label': '测试 使用全局默认' });
      await act(async () => {
        await inheritButton.props.onClick();
        await flushReact();
      });
      expect(updateDmMonitorState).toHaveBeenLastCalledWith(account.id, {
        enabled: null,
        settingSource: 'inherited',
        replyModeOverride: null,
      });
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      global.window = previousWindow;
    }
  });

  it('shows the honest realtime-only history limitation in the private-message inbox', async () => {
    const { DmInboxPage, dmHistoryStatusText } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    expect(dmHistoryStatusText('realtime_only')).toBe('仅实时：只保证监听期间收到的消息');
    expect(dmHistoryStatusText('incomplete')).toBe('历史补拉不完整：只保证监听期间收到的消息');
    expect(dmHistoryStatusText('syncing')).toBe('正在同步历史消息');
    const bridge = createDmBridge({
      listDmMonitorStates: vi.fn(async () => [{
        accountId: 'account-1',
        enabled: true,
        status: 'idle',
        historyStatus: 'realtime_only',
        historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
      }]),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage));
        await flushReact();
      });
      expect(nodeText(renderer.root)).toContain('仅实时：只保证监听期间收到的消息');
      expect(nodeText(renderer.root)).not.toContain('历史同步已完成');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('provides behavior-safe private message navigation, polling, ordering, and send guards', async () => {
    const inbox = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const navigations = [];
    const unsubscribe = vi.fn();
    let navigationHandler;
    const api = {
      onDmNavigate: vi.fn((handler) => {
        navigationHandler = handler;
        return unsubscribe;
      }),
    };
    const cleanup = inbox.subscribeDmNavigation(api, (payload) => navigations.push(payload), () => 17);

    navigationHandler({ accountId: ' account-1 ', conversationId: ' conversation-1 ' });
    navigationHandler({ accountId: '', conversationId: 'conversation-2' });
    expect(navigations).toEqual([{
      accountId: 'account-1',
      conversationId: 'conversation-1',
      nonce: 17,
    }]);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    let intervalCallback;
    const clearIntervalFn = vi.fn();
    let releaseLoad;
    const load = vi.fn(() => new Promise((resolve) => { releaseLoad = resolve; }));
    const stopPolling = inbox.startInboxPolling(load, {
      intervalMs: 15_000,
      setIntervalFn: (callback, intervalMs) => {
        intervalCallback = callback;
        expect(intervalMs).toBe(15_000);
        return 91;
      },
      clearIntervalFn,
    });

    await Promise.resolve();
    intervalCallback();
    expect(load).toHaveBeenCalledTimes(1);
    releaseLoad();
    await Promise.resolve();
    intervalCallback();
    expect(load).toHaveBeenCalledTimes(2);
    stopPolling();
    expect(clearIntervalFn).toHaveBeenCalledWith(91);

    const gate = inbox.createRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    gate.invalidate();
    expect(second.isCurrent()).toBe(false);

    const ordered = inbox.sortDmMessages([
      { id: 'late', timestamp: 2000, messageKey: 'index:3' },
      { id: 'second', timestamp: 1000, messageKey: 'index:2' },
      { id: 'first', timestamp: 1000, messageKey: 'index:1' },
    ]);
    expect(ordered.map((message) => message.id)).toEqual(['first', 'second', 'late']);
    const timeline = { scrollTop: 0, scrollHeight: 640 };
    expect(inbox.scrollDmTimelineToLatest(timeline)).toBe(true);
    expect(timeline.scrollTop).toBe(640);
    expect(inbox.scrollDmTimelineToLatest(null)).toBe(false);
    expect(inbox.canSendDmReply('   ', false)).toBe(false);
    expect(inbox.canSendDmReply('你好', true)).toBe(false);
    expect(inbox.canSendDmReply('你好', false)).toBe(true);
    expect(inbox.conversationDisplayName({ peerName: '阿k桑', peerId: '99723040126' })).toBe('阿k桑');
    expect(inbox.conversationDisplayName({ peerName: '', peerId: '99723040126' }))
      .toBe('抖音用户 99723040126');
    expect(inbox.conversationDisplayName({ peerName: '', peerId: '' })).toBe('抖音用户');
    expect(inbox.dmMessageStatus('needs_confirmation')).toMatchObject({
      label: '需要人工确认',
      tone: 'warning',
    });
    expect(inbox.dmMessageStatus('accepted')).toMatchObject({
      label: '平台已受理，等待确认',
      tone: 'warning',
    });
    expect(inbox.dmMessageStatus('cancelled')).toMatchObject({
      label: '已取消',
      tone: 'neutral',
    });
    expect(inbox.dmMessageDisplayContent({ messageType: 7, content: '你好' })).toBe('你好');
    expect(inbox.dmMessageDisplayContent({ messageType: 'image', content: '{"uri":"secret"}' }))
      .toBe('收到一条图片，请在抖音中查看');
    expect(inbox.dmMessageDisplayContent({ messageType: 999, content: '{"binary":"payload"}' }))
      .toBe('收到一条非文字消息，请在抖音中查看');
    expect(inbox.dmConversationPreview({ lastMessageText: '{"message_type":5,"image":"secret"}' }))
      .toBe('收到一条非文字消息');
    expect(inbox.dmConversationPreview({ lastMessageText: '怎么收费？' })).toBe('怎么收费？');
    expect(inbox.dmAnalysisPresentation({ workItem: { status: 'pending' } })).toMatchObject({
      label: '等待分析', tone: 'warning',
    });
    expect(inbox.dmAnalysisPresentation({
      workItem: { status: 'success' }, draft: { status: 'needs_review' },
    })).toMatchObject({ label: '待人工审核', tone: 'success' });
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: `conversation-${index}` }));
    const pinnedPage = inbox.mergePinnedConversation(fullPage, { id: 'pinned-conversation' }, 100);
    expect(pinnedPage).toHaveLength(100);
    expect(pinnedPage[0].id).toBe('pinned-conversation');
    expect(new Set(pinnedPage.map((item) => item.id)).size).toBe(100);
  });

  it('adds the responsive private message workspace and local IPC-only data access', async () => {
    const app = read('desktop/renderer/src/App.jsx');
    const page = read('desktop/renderer/src/components/DmInboxPage.jsx');
    const styles = read('desktop/renderer/src/styles.css');
    const main = read('desktop/electron/main.js');
    const preload = read('desktop/electron/preload.js');
    const rendererApi = await import('../desktop/renderer/src/api.js');
    const bridge = {
      listDmMonitorStates: vi.fn(async () => []),
      listDmConversations: vi.fn(async () => []),
      getDmConversation: vi.fn(async () => ({ id: 'conversation-1' })),
      listDmMessages: vi.fn(async () => []),
      getDmConversationAnalysis: vi.fn(async () => ({ workItem: null, draft: null, knowledge: [] })),
      reanalyzeDmConversation: vi.fn(async () => ({ id: 'work-1', status: 'pending' })),
      markDmConversationRead: vi.fn(async () => ({ id: 'conversation-1', unreadCount: 0 })),
      updateDmConversation: vi.fn(async () => ({ id: 'conversation-1', status: 'open' })),
      reauthorizeDmAutoReply: vi.fn(async () => ({ id: 'conversation-1', autoReplyAuthorized: true })),
      sendDmReply: vi.fn(async () => ({ message: { id: 'message-1', status: 'pending' } })),
    };
    const previousWindow = global.window;
    global.window = { douyinDesktop: bridge };

    try {
      await rendererApi.listDmMonitorStates();
      await rendererApi.listDmConversations({ accountId: 'account-1', limit: 50 });
      await rendererApi.getDmConversation('account-1', 'conversation-1');
      await rendererApi.listDmMessages('account-1', 'conversation-1', { limit: 100 });
      await rendererApi.getDmConversationAnalysis('account-1', 'conversation-1');
      await rendererApi.reanalyzeDmConversation('account-1', 'conversation-1');
      await rendererApi.markDmConversationRead('account-1', 'conversation-1');
      await rendererApi.updateDmConversation('account-1', 'conversation-1', { status: 'follow_up' });
      await rendererApi.reauthorizeDmAutoReply('account-1', 'conversation-1');
      await rendererApi.sendDmReply('account-1', 'conversation-1', { text: '你好', mode: 'manual' });
    } finally {
      global.window = previousWindow;
    }

    expect(bridge.listDmConversations).toHaveBeenCalledWith({ accountId: 'account-1', limit: 50 });
    expect(bridge.getDmConversation).toHaveBeenCalledWith('account-1', 'conversation-1');
    expect(bridge.listDmMessages).toHaveBeenCalledWith('account-1', 'conversation-1', { limit: 100 });
    expect(bridge.getDmConversationAnalysis).toHaveBeenCalledWith('account-1', 'conversation-1');
    expect(bridge.reanalyzeDmConversation).toHaveBeenCalledWith('account-1', 'conversation-1');
    expect(bridge.markDmConversationRead).toHaveBeenCalledWith('account-1', 'conversation-1');
    expect(bridge.updateDmConversation).toHaveBeenCalledWith('account-1', 'conversation-1', { status: 'follow_up' });
    expect(bridge.reauthorizeDmAutoReply).toHaveBeenCalledWith('account-1', 'conversation-1');
    expect(bridge.sendDmReply).toHaveBeenCalledWith('account-1', 'conversation-1', { text: '你好', mode: 'manual' });
    expect(app).toContain("id: 'dmInbox'");
    expect(app).toContain("label: '我的私信'");
    expect(app).toContain('window.desktopApi');
    expect(app).toContain('subscribeDmNavigation');
    expect(page).toContain('dm-inbox-conversations');
    expect(page).toContain('dm-inbox-thread');
    expect(page).toContain('dm-inbox-insights');
    expect(page).toContain('重新允许自动回复');
    expect(page).toContain('重新分析');
    expect(page).toContain('aria-label="关闭会话洞察"');
    expect(page).toContain('Ctrl+Enter');
    expect(app).toContain("activePage === 'dmInbox' ? ' dm-inbox-host' : ''");
    expect(styles).toMatch(/\.workspace\.dm-inbox-host\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.dm-inbox-page\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.dm-inbox-workspace\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.dm-message-timeline\s*\{[^}]*overflow-y:\s*auto/s);
    expect(styles).toContain('@media (max-width: 1100px)');
    expect(styles).toContain('container-type: inline-size');
    expect(styles).toContain('@container dm-inbox (max-width: 1100px)');
    expect(styles).toContain('@container dm-inbox (max-width: 760px)');
    expect(styles).toContain('.dm-inbox-insights.is-drawer');
    expect(styles).toContain('.dm-inbox-mobile-switch');
    expect(main).toContain("'dm:conversation:get'");
    expect(main).toContain("'dm:conversation:analysis'");
    expect(preload).toContain('listDmConversations');
    expect(preload).toContain('getDmConversation');
    expect(preload).toContain('getDmConversationAnalysis');
  });

  it('mounts the inbox and keeps a paginated deep-link target pinned across polling and manual refresh', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const firstPage = [conversation('first', '普通会话', 2000)];
    const pinned = conversation('pinned', '通知目标', 1000);
    const bridge = createDmBridge({
      listDmConversations: vi.fn(async () => firstPage),
      getDmConversation: vi.fn(async (_accountId, id) => (id === pinned.id ? pinned : null)),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: pinned.id, nonce: 1 },
        }));
        await flushReact();
      });

      const assertPinned = () => {
        const items = renderer.root.findAll((node) => hasClass(node, 'dm-conversation-item'));
        expect(items).toHaveLength(2);
        expect(items.find((node) => nodeText(node).includes('通知目标'))?.props.className).toContain('active');
      };
      assertPinned();
      const callsAfterInitialLoad = bridge.getDmConversation.mock.calls.length;

      await act(async () => {
        await environment.runIntervals();
        await flushReact();
      });
      assertPinned();
      expect(bridge.getDmConversation).toHaveBeenCalledTimes(callsAfterInitialLoad + 1);

      const refresh = renderer.root.find((node) => node.props.title === '刷新本地私信数据');
      await act(async () => {
        await refresh.props.onClick();
        await flushReact();
      });
      assertPinned();
      expect(bridge.getDmConversation).toHaveBeenCalledTimes(callsAfterInitialLoad + 2);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('isolates composer state by conversation and sends the visible draft with Ctrl/Cmd+Enter', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const first = conversation('first', '会话一', 2000);
    const second = conversation('second', '会话二', 1000);
    let resolveFirstSend;
    const firstSend = new Promise((resolve) => { resolveFirstSend = resolve; });
    const bridge = createDmBridge({
      listAccounts: vi.fn(async () => [
        { id: 'account-1', name: '账号一' },
        { id: 'account-2', name: '账号二' },
      ]),
      listDmConversations: vi.fn(async () => [first, second]),
      getDmConversation: vi.fn(async (_accountId, id) => (id === first.id ? first : second)),
      sendDmReply: vi.fn()
        .mockImplementationOnce(() => firstSend)
        .mockResolvedValueOnce({ message: { id: 'message-2', conversationId: first.id, content: 'Cmd草稿', direction: 'outbound', status: 'pending', timestamp: 3000 } }),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: first.id, nonce: 1 },
        }));
        await flushReact();
      });

      let textarea = renderer.root.findByType('textarea');
      await act(async () => textarea.props.onChange({ target: { value: '不能带过去' } }));
      const secondButton = renderer.root.findAll((node) => hasClass(node, 'dm-conversation-item'))
        .find((node) => nodeText(node).includes('会话二'));
      await act(async () => {
        secondButton.props.onClick();
        await flushReact();
      });
      textarea = renderer.root.findByType('textarea');
      expect(textarea.props.value).toBe('');

      await act(async () => textarea.props.onChange({ target: { value: '当前会话草稿' } }));
      textarea = renderer.root.findByType('textarea');
      await act(async () => {
        textarea.props.onKeyDown({ ctrlKey: true, metaKey: false, key: 'Enter', preventDefault: vi.fn() });
        await Promise.resolve();
      });
      expect(bridge.sendDmReply).toHaveBeenNthCalledWith(1, 'account-1', second.id, { text: '当前会话草稿', mode: 'manual' });
      expect(renderer.root.findAll((node) => hasClass(node, 'dm-conversation-item')).every((node) => node.props.disabled)).toBe(true);

      await act(async () => {
        renderer.update(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: first.id, nonce: 2 },
        }));
        await flushReact();
      });
      textarea = renderer.root.findByType('textarea');
      await act(async () => textarea.props.onChange({ target: { value: '新会话草稿' } }));
      await act(async () => {
        resolveFirstSend({ message: { id: 'message-1', conversationId: second.id, content: '当前会话草稿', direction: 'outbound', status: 'pending', timestamp: 2500 } });
        await firstSend;
        await flushReact();
      });
      expect(renderer.root.findByType('textarea').props.value).toBe('新会话草稿');

      await act(async () => renderer.root.findByType('textarea').props.onChange({ target: { value: 'Cmd草稿' } }));
      await act(async () => {
        renderer.root.findByType('textarea').props.onKeyDown({ ctrlKey: false, metaKey: true, key: 'Enter', preventDefault: vi.fn() });
        await flushReact();
      });
      expect(bridge.sendDmReply).toHaveBeenNthCalledWith(2, 'account-1', first.id, { text: 'Cmd草稿', mode: 'manual' });

      await act(async () => renderer.root.findByType('textarea').props.onChange({ target: { value: '账号一草稿' } }));
      const accountSelect = renderer.root.find((node) => (
        typeof node.type === 'function' && node.props['aria-label'] === '私信账号'
      ));
      await act(async () => accountSelect.props.onChange({ target: { value: 'account-2' } }));
      expect(renderer.root.findByType('textarea').props.value).toBe('');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('confirms local-only conversation deletion and selects the next conversation', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const first = conversation('delete-first', 'Delete first', 2000);
    const second = conversation('delete-second', 'Delete second', 1000);
    const bridge = createDmBridge({
      listDmConversations: vi.fn(async () => [first, second]),
      getDmConversation: vi.fn(async (_accountId, id) => (id === first.id ? first : second)),
    });
    const environment = installDmRendererEnvironment(bridge);
    window.confirm = vi.fn(() => true);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: first.id, nonce: 1 },
        }));
        await flushReact();
      });

      const deleteButton = renderer.root.find((node) => node.props.title === '删除本地聊天记录');
      expect(deleteButton.props.disabled).toBe(false);
      await act(async () => {
        await deleteButton.props.onClick();
        await flushReact();
      });

      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('只会删除 Vulcan 本地'));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('不会删除抖音'));
      expect(bridge.deleteDmConversation).toHaveBeenCalledWith('account-1', first.id);
      const header = renderer.root.find((node) => hasClass(node, 'dm-thread-header'));
      expect(nodeText(header)).toContain('Delete second');
      expect(nodeText(renderer.root)).not.toContain('Delete first');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('loads an AI reply draft and preserves its id through manual review and send', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const selected = conversation('ai-review', '意向客户', 2000);
    const bridge = createDmBridge({
      listDmConversations: vi.fn(async () => [selected]),
      getDmConversation: vi.fn(async () => selected),
      getDmConversationAnalysis: vi.fn(async () => ({
        workItem: { id: 'analysis-1', status: 'success', type: 'analyze' },
        draft: {
          id: 'draft-1',
          content: '这是根据知识库生成的回复',
          status: 'needs_review',
          meta: { intent: 'price', intentLevel: 'high', reason: '明确询价' },
        },
        knowledge: [{ id: 'knowledge-1', title: 'GEO 服务报价' }],
      })),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: selected.id, nonce: 1 },
        }));
        await flushReact();
      });

      await act(async () => renderer.root.find((node) => hasClass(node, 'dm-insights-trigger')).props.onClick());
      expect(nodeText(renderer.root)).toContain('高意向 · 价格咨询');
      expect(nodeText(renderer.root)).toContain('GEO 服务报价');
      const useDraft = renderer.root.findAllByType('button')
        .find((node) => nodeText(node) === '采用草稿并编辑');
      await act(async () => useDraft.props.onClick());
      expect(renderer.root.findByType('textarea').props.value).toBe('这是根据知识库生成的回复');

      await act(async () => {
        renderer.root.find((node) => node.props.title === '发送私信').props.onClick();
        await flushReact();
      });
      expect(bridge.sendDmReply).toHaveBeenCalledWith('account-1', selected.id, {
        text: '这是根据知识库生成的回复',
        mode: 'manual',
        sourceDraftId: 'draft-1',
      });
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('does not leak a rejected send state or error into a newly selected conversation', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const first = conversation('first', '会话一', 2000);
    const second = conversation('second', '会话二', 1000);
    let rejectFirstSend;
    const firstSend = new Promise((_resolve, reject) => { rejectFirstSend = reject; });
    const bridge = createDmBridge({
      listDmConversations: vi.fn(async () => [first, second]),
      getDmConversation: vi.fn(async (_accountId, id) => (id === first.id ? first : second)),
      sendDmReply: vi.fn(() => firstSend),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: first.id, nonce: 1 },
        }));
        await flushReact();
      });

      await act(async () => renderer.root.findByType('textarea').props.onChange({ target: { value: 'A草稿' } }));
      await act(async () => {
        renderer.root.findByType('textarea').props.onKeyDown({
          ctrlKey: true,
          metaKey: false,
          key: 'Enter',
          preventDefault: vi.fn(),
        });
        await Promise.resolve();
      });

      await act(async () => {
        renderer.update(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: second.id, nonce: 2 },
        }));
        await flushReact();
      });
      await act(async () => renderer.root.findByType('textarea').props.onChange({ target: { value: 'B的新草稿' } }));

      const sendButtonWhileAIsPending = renderer.root.find((node) => node.props.title === '发送私信');
      expect(nodeText(sendButtonWhileAIsPending)).toBe('发送');
      expect(renderer.root.findAll((node) => hasClass(node, 'dm-composer-error'))).toHaveLength(0);

      await act(async () => {
        rejectFirstSend(new Error('A发送失败'));
        try {
          await firstSend;
        } catch {
          // The component owns the visible error handling for this rejected operation.
        }
        await flushReact();
      });

      expect(renderer.root.findByType('textarea').props.value).toBe('B的新草稿');
      expect(renderer.root.findAll((node) => hasClass(node, 'dm-composer-error'))).toHaveLength(0);
      expect(nodeText(renderer.root.find((node) => node.props.title === '发送私信'))).toBe('发送');
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('mounts the responsive drawer and cleans polling on visibility, Escape, backdrop, and unmount', async () => {
    const { DmInboxPage } = await import('../desktop/renderer/src/components/DmInboxPage.jsx');
    const selected = conversation('selected', '会话用户', 1000);
    const bridge = createDmBridge({
      listDmConversations: vi.fn(async () => [selected]),
      getDmConversation: vi.fn(async () => selected),
    });
    const environment = installDmRendererEnvironment(bridge);
    let renderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(DmInboxPage, {
          navigation: { accountId: 'account-1', conversationId: selected.id, nonce: 1 },
        }));
        await flushReact();
      });
      expect(environment.intervalCount()).toBe(1);
      expect(renderer.root.find((node) => hasClass(node, 'dm-inbox-workspace'))).toBeTruthy();

      const openDrawer = () => renderer.root.find((node) => hasClass(node, 'dm-insights-trigger'));
      await act(async () => openDrawer().props.onClick());
      expect(renderer.root.findByProps({ 'aria-label': '会话洞察' }).props).toMatchObject({ role: 'dialog', 'aria-modal': true });
      await act(async () => environment.dispatchDocument('keydown', { key: 'Escape' }));
      expect(renderer.root.findByProps({ 'aria-label': '会话洞察' }).props.role).toBeUndefined();

      await act(async () => openDrawer().props.onClick());
      const backdrop = renderer.root.findByProps({ 'aria-label': '关闭会话洞察遮罩' });
      await act(async () => backdrop.props.onClick());
      expect(renderer.root.findByProps({ 'aria-label': '会话洞察' }).props.role).toBeUndefined();

      global.document.hidden = true;
      await act(async () => environment.dispatchDocument('visibilitychange'));
      expect(environment.intervalCount()).toBe(0);
      global.document.hidden = false;
      await act(async () => environment.dispatchDocument('visibilitychange'));
      expect(environment.intervalCount()).toBe(1);
      await act(async () => renderer.unmount());
      renderer = null;
      expect(environment.intervalCount()).toBe(0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      environment.restore();
    }
  });

  it('keeps diagnostics on a dedicated system status page instead of settings', () => {
    const app = read('desktop/renderer/src/App.jsx');
    const settings = read('desktop/renderer/src/components/SettingsPage.jsx');
    const systemStatus = read('desktop/renderer/src/components/SystemStatusPage.jsx');

    expect(app).toContain("id: 'systemStatus'");
    expect(app).toContain("label: '系统状态'");
    expect(systemStatus).toContain('settings-health-strip');
    expect(systemStatus).toContain('页面注入');
    expect(systemStatus).toContain('连接明细');
    expect(systemStatus).toContain('bridgeHealth?.totalAliveConnections');
    expect(systemStatus).toContain('个有效任务连接');
    expect(systemStatus).toContain('本地运行');
    const inbox = read('desktop/renderer/src/components/DmInboxPage.jsx');
    expect(inbox).toContain("connecting: ['连接中', 'warning']");
    expect(settings).not.toContain('settings-health-strip');
    expect(settings).not.toContain('连接明细');
    expect(settings).not.toContain('启动后端');
    expect(app).not.toContain('sidebar-status');
    expect(app).not.toContain('本地 SQLite');
  });

  it('keeps AI testing, reply defaults, and local installer information in settings', () => {
    const settings = read('desktop/renderer/src/components/SettingsPage.jsx');
    const main = read('desktop/electron/main.js');

    expect(settings).toContain('测试连接');
    expect(settings).toContain('回复默认值');
    expect(settings).toContain('版本与安装包');
    expect(settings).not.toContain('检查更新');
    expect(main).toContain('installerName');
    expect(main).toContain('app.isPackaged');
  });

  it('keeps new-entry text and number fields visually empty by default', () => {
    const files = [
      'desktop/renderer/src/components/SearchLeadsPage.jsx',
      'desktop/renderer/src/components/TasksPage.jsx',
      'desktop/renderer/src/components/AccountsPage.jsx',
      'desktop/renderer/src/components/KnowledgePage.jsx',
      'desktop/renderer/src/components/ReplyReviewPage.jsx',
      'desktop/renderer/src/components/SettingsPage.jsx',
      'desktop/renderer/src/components/MyVideosPage.jsx',
    ];
    const source = files.map(read).join('\n');

    expect(source).not.toContain('placeholder=');
    expect(read(files[0])).toContain("keyword: '', count: ''");
    expect(read(files[1])).toContain("count: ''");
    expect(read(files[3])).toContain("useState('')");
    expect(read(files[5])).toContain("appInfo?.packaged ? '安装包运行' : '源码运行（测试环境）'");
    expect(source).not.toContain("nextAccounts[0]?.id");
  });

  it('uses the workflow navigation order, a single credit, and the shared dropdown', () => {
    const app = read('desktop/renderer/src/App.jsx');
    const componentDir = path.resolve(__dirname, '..', 'desktop/renderer/src/components');
    const componentSource = fs.readdirSync(componentDir)
      .filter((name) => name.endsWith('.jsx'))
      .map((name) => fs.readFileSync(path.join(componentDir, name), 'utf8'))
      .join('\n');
    const order = ['账号', '搜索获客', '线索私信', '批量任务', '我的作品', '评论管理', '知识库', '高级任务', '日志', '系统状态', '设置'];

    for (let index = 1; index < order.length; index += 1) {
      expect(app.indexOf(`label: '${order[index - 1]}'`)).toBeLessThan(app.indexOf(`label: '${order[index]}'`));
    }
    expect(app).not.toContain('developer-credit');
    expect(app.match(/Powered By ZZY/g)).toHaveLength(1);
    expect(componentSource).not.toContain('<select');
    expect(componentSource).toContain('export function SelectMenu');
    expect(componentSource).toContain('select-menu-separator');
    expect(componentSource).toContain("option.value && option.value === selectedValue");
  });

  it('keeps the shared dropdown open while its option list is scrolling', () => {
    const selectMenu = read('desktop/renderer/src/components/SelectMenu.jsx');

    expect(selectMenu).toContain("event.type === 'scroll'");
    expect(selectMenu).toContain('menuRef.current?.contains(event.target)');
  });

  it('exposes a browser refresh action through Electron IPC', () => {
    const app = read('desktop/renderer/src/App.jsx');
    const tabs = read('desktop/electron/browser-tabs.js');
    const main = read('desktop/electron/main.js');
    const preload = read('desktop/electron/preload.js');

    expect(app).toContain('刷新浏览器');
    expect(tabs).toContain('function reloadAccountBrowser');
    expect(main).toContain("'browser:reload-account'");
    expect(preload).toContain('reloadAccountBrowser');
  });

  it('cleans up initial browser load listeners before later reloads', () => {
    const tabs = read('desktop/electron/browser-tabs.js');

    expect(tabs).toContain("removeListener('did-finish-load', onInitialLoadFinished)");
    expect(tabs).toContain("removeListener('did-fail-load', onInitialLoadFailed)");
  });

  it('does not destroy a background account view after it becomes the visible browser', () => {
    const tabs = read('desktop/electron/browser-tabs.js');

    expect(tabs).toContain('if (activeView !== nextView) {');
    expect(tabs).toContain("destroyCurrentAccountView(mainWindow, accountKey, nextView, 'background-bootstrap-failed');");
  });

  it('prepares the native DM account view without requiring page Bridge injection', () => {
    const tabs = read('desktop/electron/browser-tabs.js');
    const main = read('desktop/electron/main.js');

    expect(tabs).toContain('if (options.requireBridge !== false)');
    expect(tabs).toContain("'/aweme/v1/web/query/user/?device_platform=webapp&aid=6383&channel=channel_pc_web'");
    expect(main).toContain('ensureBackgroundAccountView(window, account, { requireBridge: false })');
    expect(main).toContain('return browserTabs.readAccountDeviceId(account.id, { timeoutMs: 5000 });');
  });

  it('keeps a user-owned account browser when the DM monitor releases its background view', () => {
    const tabs = read('desktop/electron/browser-tabs.js');
    const main = read('desktop/electron/main.js');

    expect(tabs).toContain('function releaseBackgroundAccountView');
    expect(tabs).toContain('if (view === activeView) {');
    expect(tabs).toContain('retained: true');
    expect(main).toContain('browserTabs.releaseBackgroundAccountView(mainWindow, accountId)');
  });

  it('retains the visible BrowserView when a refresh or initial page load fails', () => {
    const tabs = read('desktop/electron/browser-tabs.js');

    expect(tabs).toContain('async function reloadAccountBrowser');
    expect(tabs).toContain("reason: 'reload-failed'");
    expect(tabs).toContain("reason: 'initial-load-failed'");
    expect(tabs).toContain('recordBrowserLifecycle');
  });

  it('keeps browser controls compact and gives the account table stable wide columns', () => {
    const app = read('desktop/renderer/src/App.jsx');
    const accounts = read('desktop/renderer/src/components/AccountsPage.jsx');
    const styles = read('desktop/renderer/src/styles.css');

    expect(app).toContain('browser-control-panel');
    expect(app).toContain('browser-control-buttons');
    expect(app).toContain('aria-label="最小化浏览器"');
    expect(app).toContain('aria-label="刷新浏览器"');
    expect(app).toContain('aria-label="关闭浏览器"');
    expect(accounts).toContain('panel panel-wide');
    expect(accounts).toContain('className="accounts-table"');
    expect(accounts).toContain('<colgroup>');
    expect(accounts).not.toContain('status-badge');
    expect(accounts).toContain('account-status-select status-${account.status}');
    expect(styles).toContain('.account-status-select.status-online');
    expect(styles).toContain('.account-status-select.status-login_required');
    expect(styles).toContain('.account-status-select.status-offline');
    expect(styles).toContain('.account-status-select.status-disabled');
    expect(styles).toContain('.accounts-table');
    expect(styles).toContain('.panel-wide');
    expect(styles).toContain('min-width: 0');
    expect(styles).toContain('width: 31%');
    expect(styles).toContain('width: 104px');
    expect(styles).not.toContain('min-width: 1180px');
    expect(styles).toContain('@media (max-width: 1200px)');
    expect(styles).toContain('.app-shell.browser-docked .account-dm-actions');
    expect(styles).toContain('.app-shell.browser-docked .dm-mode-setting');
    expect(styles).toContain('.app-shell.browser-docked .dm-settings-grid');
  });

  it('exposes the reviewed lead-to-DM workflow in the desktop UI', () => {
    const app = read('desktop/renderer/src/App.jsx');
    const page = read('desktop/renderer/src/components/DmLeadsPage.jsx');
    const preload = read('desktop/electron/preload.js');
    const main = read('desktop/electron/main.js');

    expect(app).toContain("id: 'dmLeads'");
    expect(app).toContain("label: '线索私信'");
    expect(page).toContain('分享链接');
    expect(page).toContain('搜索结果');
    expect(page).toContain('全选全部');
    expect(page).toContain('反选');
    expect(page).toContain('评论总量');
    expect(page).toContain('开始采集评论');
    expect(page).toContain('listSearchSessions');
    expect(page).toContain('listSearchResults');
    expect(page).toContain('resolveExternalVideo');
    expect(page).toContain('createCommentSyncJob');
    expect(page).toContain('listDmLeadSources');
    expect(page).toContain('分析所选');
    expect(page).toContain('审核所选');
    expect(page).toContain('创建发送任务');
    expect(page).toContain('progress-track');
    expect(preload).toContain('createDmSendJob');
    expect(preload).toContain('createCommentSyncJob');
    expect(main).toContain("'dm-leads:send-job'");
    expect(main).toContain("'comment-sync-jobs:create'");
  });

  it('exposes paged knowledge management without Word or PDF imports', () => {
    const page = read('desktop/renderer/src/components/KnowledgePage.jsx');
    const preload = read('desktop/electron/preload.js');
    const main = read('desktop/electron/main.js');

    expect(preload).toContain('queryKnowledge');
    expect(preload).toContain('checkKnowledgeDuplicate');
    expect(preload).toContain('bulkKnowledge');
    expect(main).toContain("'knowledge:query'");
    expect(main).toContain("'knowledge:check-duplicate'");
    expect(main).toContain("'knowledge:bulk'");
    expect(page).toContain("['.txt', '.md', '.markdown', '.csv', '.json']");
    expect(page).not.toContain('.docx');
    expect(page).not.toContain('.pdf');
  });
});
