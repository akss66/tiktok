function requireBridge() {
  if (!window.douyinDesktop) {
    throw new Error('桌面桥接 API 不可用，请在 Electron 应用中打开。');
  }
  return window.douyinDesktop;
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
  return requireBridge().runTask(id);
}

export async function listEvents(filters) {
  return requireBridge().listEvents(filters);
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

export async function closeAccountBrowser() {
  return requireBridge().closeAccountBrowser();
}
