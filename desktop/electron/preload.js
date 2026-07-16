const { contextBridge, ipcRenderer } = require('electron');

const dmNavigationHandlers = new Map();
let dmNavigationListener = null;

function isValidDmNavigation(payload) {
  return Boolean(
    payload
    && typeof payload.accountId === 'string'
    && payload.accountId.trim()
    && typeof payload.conversationId === 'string'
    && payload.conversationId.trim(),
  );
}

function onDmNavigate(handler) {
  if (typeof handler !== 'function') return () => {};
  dmNavigationHandlers.set(handler, (dmNavigationHandlers.get(handler) || 0) + 1);
  if (!dmNavigationListener) {
    dmNavigationListener = (_event, payload) => {
      if (!isValidDmNavigation(payload)) return;
      dmNavigationHandlers.forEach((_count, subscribedHandler) => subscribedHandler({
        accountId: payload.accountId.trim(),
        conversationId: payload.conversationId.trim(),
      }));
    };
    ipcRenderer.on('dm:navigate', dmNavigationListener);
  }

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    const count = dmNavigationHandlers.get(handler) || 0;
    if (count <= 1) dmNavigationHandlers.delete(handler);
    else dmNavigationHandlers.set(handler, count - 1);
    if (dmNavigationHandlers.size === 0 && dmNavigationListener) {
      ipcRenderer.removeListener('dm:navigate', dmNavigationListener);
      dmNavigationListener = null;
    }
  };
}

contextBridge.exposeInMainWorld('desktopApi', { onDmNavigate });

contextBridge.exposeInMainWorld('douyinDesktop', {
  getBackendHealth: () => ipcRenderer.invoke('backend:health'),
  getBridgeHealth: () => ipcRenderer.invoke('bridge:health'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  createAccount: (input) => ipcRenderer.invoke('accounts:create', input),
  updateAccount: (id, patch) => ipcRenderer.invoke('accounts:update', id, patch),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (input) => ipcRenderer.invoke('tasks:create', input),
  runTask: (id) => ipcRenderer.invoke('tasks:run', id),
  listSearchSessions: (filters) => ipcRenderer.invoke('search-sessions:list', filters),
  createSearchSession: (input) => ipcRenderer.invoke('search-sessions:create', input),
  listSearchResults: (id) => ipcRenderer.invoke('search-sessions:results', id),
  listBatchJobs: (filters) => ipcRenderer.invoke('batch-jobs:list', filters),
  createBatchJob: (input) => ipcRenderer.invoke('batch-jobs:create', input),
  createCommentSyncJob: (input) => ipcRenderer.invoke('comment-sync-jobs:create', input),
  runBatchJob: (id) => ipcRenderer.invoke('batch-jobs:run', id),
  pauseBatchJob: (id) => ipcRenderer.invoke('batch-jobs:pause', id),
  cancelBatchJob: (id) => ipcRenderer.invoke('batch-jobs:cancel', id),
  resumeBatchJob: (id) => ipcRenderer.invoke('batch-jobs:resume', id),
  retryFailedBatchItems: (id) => ipcRenderer.invoke('batch-jobs:retry-failed', id),
  listBatchItems: (id) => ipcRenderer.invoke('batch-jobs:items', id),
  listVideos: (filters) => ipcRenderer.invoke('videos:list', filters),
  resolveExternalVideo: (input) => ipcRenderer.invoke('external-videos:resolve', input),
  syncMyVideos: (input) => ipcRenderer.invoke('my-videos:sync', input),
  syncComments: (awemeId, input) => ipcRenderer.invoke('videos:comments-sync', awemeId, input),
  listVideoComments: (awemeId) => ipcRenderer.invoke('videos:comments', awemeId),
  listComments: (filters) => ipcRenderer.invoke('comments:list', filters),
  analyzeComments: (input) => ipcRenderer.invoke('comments:analyze', input),
  listReplyDrafts: (filters) => ipcRenderer.invoke('reply-drafts:list', filters),
  approveReplyDraft: (id, input) => ipcRenderer.invoke('reply-drafts:approve', id, input),
  publishReplyDraft: (id) => ipcRenderer.invoke('reply-drafts:publish', id),
  listDmLeads: (filters) => ipcRenderer.invoke('dm-leads:list', filters),
  listDmLeadSources: (id) => ipcRenderer.invoke('dm-leads:sources', id),
  syncDmLeads: (input) => ipcRenderer.invoke('dm-leads:sync', input),
  analyzeDmLeads: (input) => ipcRenderer.invoke('dm-leads:analyze', input),
  updateDmLead: (id, patch) => ipcRenderer.invoke('dm-leads:update', id, patch),
  createDmSendJob: (input) => ipcRenderer.invoke('dm-leads:send-job', input),
  listDmMonitorStates: () => ipcRenderer.invoke('dm:monitor-states:list'),
  updateDmMonitorState: (accountId, patch) => ipcRenderer.invoke('dm:monitor-state:update', accountId, patch),
  listDmConversations: (filters) => ipcRenderer.invoke('dm:conversations:list', filters),
  getDmConversation: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:get', accountId, conversationId),
  deleteDmConversation: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:delete', accountId, conversationId),
  listDmMessages: (accountId, conversationId, filters) => ipcRenderer.invoke('dm:messages:list', accountId, conversationId, filters),
  getDmConversationAnalysis: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:analysis', accountId, conversationId),
  reanalyzeDmConversation: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:reanalyze', accountId, conversationId),
  markDmConversationRead: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:read', accountId, conversationId),
  updateDmConversation: (accountId, conversationId, patch) => ipcRenderer.invoke('dm:conversation:update', accountId, conversationId, patch),
  reauthorizeDmAutoReply: (accountId, conversationId) => ipcRenderer.invoke('dm:conversation:reauthorize', accountId, conversationId),
  sendDmReply: (accountId, conversationId, input) => ipcRenderer.invoke('dm:reply', accountId, conversationId, input),
  getDmWorkerStatus: () => ipcRenderer.invoke('dm-worker:status'),
  listKnowledge: () => ipcRenderer.invoke('knowledge:list'),
  queryKnowledge: (filters) => ipcRenderer.invoke('knowledge:query', filters),
  checkKnowledgeDuplicate: (content) => ipcRenderer.invoke('knowledge:check-duplicate', content),
  bulkKnowledge: (input) => ipcRenderer.invoke('knowledge:bulk', input),
  createKnowledge: (input) => ipcRenderer.invoke('knowledge:create', input),
  updateKnowledge: (id, patch) => ipcRenderer.invoke('knowledge:update', id, patch),
  deleteKnowledge: (id) => ipcRenderer.invoke('knowledge:delete', id),
  listEvents: (filters) => ipcRenderer.invoke('events:list', filters),
  getLlmSettings: () => ipcRenderer.invoke('settings:llm:get'),
  updateLlmSettings: (patch) => ipcRenderer.invoke('settings:llm:update', patch),
  testLlmSettings: (patch) => ipcRenderer.invoke('settings:llm:test', patch),
  getReplySettings: () => ipcRenderer.invoke('settings:reply:get'),
  updateReplySettings: (patch) => ipcRenderer.invoke('settings:reply:update', patch),
  getDmSettings: () => ipcRenderer.invoke('settings:dm:get'),
  updateDmSettings: (patch) => ipcRenderer.invoke('settings:dm:update', patch),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getDockerStatus: () => ipcRenderer.invoke('docker:status'),
  startBackend: () => ipcRenderer.invoke('backend:start-local'),
  stopBackend: () => ipcRenderer.invoke('backend:stop-local'),
  getDmMonitorStatus: () => ipcRenderer.invoke('dm-monitor:status'),
  startDmMonitor: () => ipcRenderer.invoke('dm-monitor:start'),
  stopDmMonitor: () => ipcRenderer.invoke('dm-monitor:stop'),
  openAccountBrowser: (account) => ipcRenderer.invoke('browser:open-account', account),
  openEdgeAccountBrowser: (account) => ipcRenderer.invoke('browser:open-edge-account', account),
  getEdgeBrowserStatus: () => ipcRenderer.invoke('browser:edge-status'),
  openCleanLoginBrowser: (account) => ipcRenderer.invoke('browser:open-clean-login', account),
  closeAccountBrowser: () => ipcRenderer.invoke('browser:close-account'),
  hideAccountBrowser: () => ipcRenderer.invoke('browser:hide-account'),
  showAccountBrowser: () => ipcRenderer.invoke('browser:show-account'),
  reloadAccountBrowser: () => ipcRenderer.invoke('browser:reload-account'),
  setBrowserDockMode: (mode) => ipcRenderer.invoke('browser:set-dock-mode', mode),
  ensureBrowserBridge: () => ipcRenderer.invoke('browser:ensure-bridge'),
  runBridgeSelfTest: () => ipcRenderer.invoke('browser:bridge-self-test'),
  resetAccountBrowser: (account) => ipcRenderer.invoke('browser:reset-account', account),
  onBrowserNotice: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('browser:notice', listener);
    return () => ipcRenderer.removeListener('browser:notice', listener);
  },
  onBrowserLayout: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('browser:layout', listener);
    return () => ipcRenderer.removeListener('browser:layout', listener);
  },
  onAccountsChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('accounts:changed', listener);
    return () => ipcRenderer.removeListener('accounts:changed', listener);
  },
  onDmNavigate,
});
