function requireBridge() {
  if (!window.douyinDesktop) {
    throw new Error('桌面桥接 API 不可用，请在 Electron 应用中打开。');
  }
  return window.douyinDesktop;
}

export function friendlyError(error, fallback = '操作失败') {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return fallback;
  if (raw.includes('fetch failed')) {
    return '请求执行失败：当前网络可能无法访问抖音，或抖音接口没有返回可用数据。请确认右侧浏览器能正常搜索/播放后重试。';
  }
  if (raw.includes('浏览器会话请求失败')) {
    return raw;
  }
  if (raw.includes('页面任务执行失败')) {
    return raw;
  }
  if (raw.includes('Request timeout') && raw.includes('no polling client connected')) {
    return '任务超时：没有在线的账号浏览器接收任务。请在账号页打开账号浏览器，保持抖音页面在线后重试。';
  }
  if (raw.includes('Request timeout')) {
    return '任务超时：浏览器没有及时返回结果。请确认账号浏览器仍在线，并重新执行。';
  }
  return raw;
}

export async function getBackendHealth() {
  return requireBridge().getBackendHealth();
}

export async function getBridgeHealth() {
  return requireBridge().getBridgeHealth();
}

export async function listAccounts() {
  return requireBridge().listAccounts();
}

export async function createAccount(input) {
  return requireBridge().createAccount(input);
}

export async function updateAccount(id, patch) {
  return requireBridge().updateAccount(id, patch);
}

export async function deleteAccount(id) {
  return requireBridge().deleteAccount(id);
}

export async function listTasks() {
  return requireBridge().listTasks();
}

export async function createTask(input) {
  return requireBridge().createTask(input);
}

export async function runTask(id) {
  await ensureBrowserBridge();
  return requireBridge().runTask(id);
}

export async function listSearchSessions(filters) {
  return requireBridge().listSearchSessions(filters);
}

export async function createSearchSession(input) {
  await ensureAccountBrowserBridge(input?.accountId);
  return requireBridge().createSearchSession(input);
}

export async function listSearchResults(id) {
  return requireBridge().listSearchResults(id);
}

export async function listBatchJobs(filters) {
  return requireBridge().listBatchJobs(filters);
}

export async function createBatchJob(input) {
  return requireBridge().createBatchJob(input);
}

export async function createCommentSyncJob(input) {
  return requireBridge().createCommentSyncJob(input);
}

export async function runBatchJob(id, options = {}) {
  if (options.requiresBrowser !== false) {
    if (options.accountId) await ensureAccountBrowserBridge(options.accountId);
    else await ensureBrowserBridge();
  }
  return requireBridge().runBatchJob(id);
}

export async function pauseBatchJob(id) {
  return requireBridge().pauseBatchJob(id);
}

export async function cancelBatchJob(id) {
  return requireBridge().cancelBatchJob(id);
}

export async function resumeBatchJob(id, options = {}) {
  if (options.requiresBrowser !== false) {
    if (options.accountId) await ensureAccountBrowserBridge(options.accountId);
    else await ensureBrowserBridge();
  }
  return requireBridge().resumeBatchJob(id);
}

export async function retryFailedBatchItems(id, options = {}) {
  if (options.requiresBrowser !== false) {
    if (options.accountId) await ensureAccountBrowserBridge(options.accountId);
    else await ensureBrowserBridge();
  }
  return requireBridge().retryFailedBatchItems(id);
}

export async function listBatchItems(id) {
  return requireBridge().listBatchItems(id);
}

export async function listVideos(filters) {
  return requireBridge().listVideos(filters);
}

export async function resolveExternalVideo(input) {
  if (input?.accountId) await ensureAccountBrowserBridge(input.accountId);
  return requireBridge().resolveExternalVideo(input);
}

export async function syncMyVideos(input) {
  await ensureBrowserBridge();
  return requireBridge().syncMyVideos(input);
}

export async function syncComments(awemeId, input) {
  if (input?.accountId) await ensureAccountBrowserBridge(input.accountId);
  else await ensureBrowserBridge();
  return requireBridge().syncComments(awemeId, input);
}

export async function listVideoComments(awemeId) {
  return requireBridge().listVideoComments(awemeId);
}

export async function listComments(filters) {
  return requireBridge().listComments(filters);
}

export async function analyzeComments(input) {
  return requireBridge().analyzeComments(input);
}

export async function listReplyDrafts(filters) {
  return requireBridge().listReplyDrafts(filters);
}

export async function approveReplyDraft(id, input) {
  return requireBridge().approveReplyDraft(id, input);
}

export async function publishReplyDraft(id) {
  await ensureBrowserBridge();
  return requireBridge().publishReplyDraft(id);
}

export async function listDmLeads(filters) {
  return requireBridge().listDmLeads(filters);
}

export async function listDmLeadSources(id) {
  return requireBridge().listDmLeadSources(id);
}

export async function syncDmLeads(input) {
  return requireBridge().syncDmLeads(input);
}

export async function analyzeDmLeads(input) {
  return requireBridge().analyzeDmLeads(input);
}

export async function updateDmLead(id, patch) {
  return requireBridge().updateDmLead(id, patch);
}

export async function createDmSendJob(input) {
  return requireBridge().createDmSendJob(input);
}

export async function listDmMonitorStates() {
  return requireBridge().listDmMonitorStates();
}

export async function updateDmMonitorState(accountId, patch) {
  return requireBridge().updateDmMonitorState(accountId, {
    enabled: patch?.enabled === undefined ? null : patch.enabled,
    settingSource: patch?.settingSource,
    replyModeOverride: patch?.replyModeOverride === undefined ? null : patch.replyModeOverride,
  });
}

export async function listDmConversations(filters) {
  return requireBridge().listDmConversations(filters);
}

export async function getDmConversation(accountId, conversationId) {
  return requireBridge().getDmConversation(accountId, conversationId);
}

export async function deleteDmConversation(accountId, conversationId) {
  return requireBridge().deleteDmConversation(accountId, conversationId);
}

export async function listDmMessages(accountId, conversationId, filters) {
  return requireBridge().listDmMessages(accountId, conversationId, filters);
}

export async function getDmConversationAnalysis(accountId, conversationId) {
  return requireBridge().getDmConversationAnalysis(accountId, conversationId);
}

export async function reanalyzeDmConversation(accountId, conversationId) {
  return requireBridge().reanalyzeDmConversation(accountId, conversationId);
}

export async function markDmConversationRead(accountId, conversationId) {
  return requireBridge().markDmConversationRead(accountId, conversationId);
}

export async function updateDmConversation(accountId, conversationId, patch) {
  return requireBridge().updateDmConversation(accountId, conversationId, patch);
}

export async function reauthorizeDmAutoReply(accountId, conversationId) {
  return requireBridge().reauthorizeDmAutoReply(accountId, conversationId);
}

export async function sendDmReply(accountId, conversationId, input) {
  return requireBridge().sendDmReply(accountId, conversationId, input);
}

export async function listKnowledge() {
  return requireBridge().listKnowledge();
}

export async function queryKnowledge(filters) {
  return requireBridge().queryKnowledge(filters);
}

export async function checkKnowledgeDuplicate(content) {
  return requireBridge().checkKnowledgeDuplicate(content);
}

export async function bulkKnowledge(input) {
  return requireBridge().bulkKnowledge(input);
}

export async function createKnowledge(input) {
  return requireBridge().createKnowledge(input);
}

export async function updateKnowledge(id, patch) {
  return requireBridge().updateKnowledge(id, patch);
}

export async function deleteKnowledge(id) {
  return requireBridge().deleteKnowledge(id);
}

export async function listEvents(filters) {
  return requireBridge().listEvents(filters);
}

export async function getLlmSettings() {
  return requireBridge().getLlmSettings();
}

export async function updateLlmSettings(patch) {
  return requireBridge().updateLlmSettings(patch);
}

export async function testLlmSettings(patch) {
  return requireBridge().testLlmSettings(patch);
}

export async function getReplySettings() {
  return requireBridge().getReplySettings();
}

export async function getDmSettings() {
  return requireBridge().getDmSettings();
}

export async function updateDmSettings(patch) {
  return requireBridge().updateDmSettings(patch);
}

export async function updateReplySettings(patch) {
  return requireBridge().updateReplySettings(patch);
}

export async function getAppInfo() {
  return requireBridge().getAppInfo();
}

export async function getDockerStatus() {
  return requireBridge().getDockerStatus();
}

export async function startBackend() {
  return requireBridge().startBackend();
}

export async function stopBackend() {
  return requireBridge().stopBackend();
}

export async function openAccountBrowser(account) {
  return requireBridge().openAccountBrowser(account);
}

export async function openEdgeAccountBrowser(account) {
  return requireBridge().openEdgeAccountBrowser(account);
}

export async function getEdgeBrowserStatus() {
  return requireBridge().getEdgeBrowserStatus();
}

export async function openCleanLoginBrowser(account) {
  return requireBridge().openCleanLoginBrowser(account);
}

export async function closeAccountBrowser() {
  return requireBridge().closeAccountBrowser();
}

export async function hideAccountBrowser() {
  return requireBridge().hideAccountBrowser();
}

export async function showAccountBrowser() {
  return requireBridge().showAccountBrowser();
}

export async function reloadAccountBrowser() {
  return requireBridge().reloadAccountBrowser();
}

export async function setBrowserDockMode(mode) {
  return requireBridge().setBrowserDockMode(mode);
}

export async function ensureBrowserBridge() {
  const result = await requireBridge().ensureBrowserBridge();
  if (!result?.ok) {
    throw new Error(result?.error || '任务 Bridge 启用失败，请先打开账号浏览器并登录。');
  }
  return result;
}

export async function runBridgeSelfTest() {
  return requireBridge().runBridgeSelfTest();
}

export async function ensureAccountBrowserBridge(accountId) {
  try {
    return await ensureBrowserBridge();
  } catch (firstError) {
    if (!accountId) throw firstError;
    const accounts = await listAccounts();
    const account = accounts.find((item) => item.id === accountId);
    if (!account) throw firstError;
    await openAccountBrowser(account);
    return ensureBrowserBridge();
  }
}

export async function resetAccountBrowser(account) {
  return requireBridge().resetAccountBrowser(account);
}
