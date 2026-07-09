const { contextBridge, ipcRenderer } = require('electron');

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
  runBatchJob: (id) => ipcRenderer.invoke('batch-jobs:run', id),
  listBatchItems: (id) => ipcRenderer.invoke('batch-jobs:items', id),
  listVideos: (filters) => ipcRenderer.invoke('videos:list', filters),
  syncMyVideos: (input) => ipcRenderer.invoke('my-videos:sync', input),
  syncComments: (awemeId, input) => ipcRenderer.invoke('videos:comments-sync', awemeId, input),
  listVideoComments: (awemeId) => ipcRenderer.invoke('videos:comments', awemeId),
  listComments: (filters) => ipcRenderer.invoke('comments:list', filters),
  analyzeComments: (input) => ipcRenderer.invoke('comments:analyze', input),
  listReplyDrafts: (filters) => ipcRenderer.invoke('reply-drafts:list', filters),
  approveReplyDraft: (id, input) => ipcRenderer.invoke('reply-drafts:approve', id, input),
  publishReplyDraft: (id) => ipcRenderer.invoke('reply-drafts:publish', id),
  listKnowledge: () => ipcRenderer.invoke('knowledge:list'),
  createKnowledge: (input) => ipcRenderer.invoke('knowledge:create', input),
  updateKnowledge: (id, patch) => ipcRenderer.invoke('knowledge:update', id, patch),
  deleteKnowledge: (id) => ipcRenderer.invoke('knowledge:delete', id),
  listEvents: (filters) => ipcRenderer.invoke('events:list', filters),
  getLlmSettings: () => ipcRenderer.invoke('settings:llm:get'),
  updateLlmSettings: (patch) => ipcRenderer.invoke('settings:llm:update', patch),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getDockerStatus: () => ipcRenderer.invoke('docker:status'),
  startBackend: () => ipcRenderer.invoke('backend:start-local'),
  stopBackend: () => ipcRenderer.invoke('backend:stop-local'),
  openAccountBrowser: (account) => ipcRenderer.invoke('browser:open-account', account),
  openEdgeAccountBrowser: (account) => ipcRenderer.invoke('browser:open-edge-account', account),
  getEdgeBrowserStatus: () => ipcRenderer.invoke('browser:edge-status'),
  openCleanLoginBrowser: (account) => ipcRenderer.invoke('browser:open-clean-login', account),
  closeAccountBrowser: () => ipcRenderer.invoke('browser:close-account'),
  hideAccountBrowser: () => ipcRenderer.invoke('browser:hide-account'),
  showAccountBrowser: () => ipcRenderer.invoke('browser:show-account'),
  ensureBrowserBridge: () => ipcRenderer.invoke('browser:ensure-bridge'),
  runBridgeSelfTest: () => ipcRenderer.invoke('browser:bridge-self-test'),
  resetAccountBrowser: (account) => ipcRenderer.invoke('browser:reset-account', account),
  onBrowserNotice: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('browser:notice', listener);
    return () => ipcRenderer.removeListener('browser:notice', listener);
  },
  onAccountsChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('accounts:changed', listener);
    return () => ipcRenderer.removeListener('accounts:changed', listener);
  },
});
