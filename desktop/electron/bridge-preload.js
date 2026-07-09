const { contextBridge, ipcRenderer } = require('electron');

// 在 BrowserView 页面中暴露一个走主进程的 HTTP 代理通道
// 绕过 Chromium Private Network Access 限制：
//   https://www.douyin.com → http://127.0.0.1:19422 的跨协议请求
contextBridge.exposeInMainWorld('__electronBridgeFetch', {
  request: (method, url, headers, body) =>
    ipcRenderer.invoke('bridge:fetch', { method, url, headers, body }),
});
