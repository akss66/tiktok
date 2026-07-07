import { useState } from 'react';
import { closeAccountBrowser } from './api.js';
import { AccountsPage } from './components/AccountsPage.jsx';
import { SettingsPage } from './components/SettingsPage.jsx';

const NAV_ITEMS = [
  { id: 'accounts', label: '账号' },
  { id: 'tasks', label: '任务' },
  { id: 'logs', label: '日志' },
  { id: 'settings', label: '设置' },
];

function PlaceholderPage({ title, description }) {
  return (
    <section className="panel" aria-labelledby={`${title}-title`}>
      <div className="panel-header">
        <div>
          <h1 id={`${title}-title`}>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      <div className="empty-state">此模块会在后续任务中接入真实数据。</div>
    </section>
  );
}

export function App() {
  const [activePage, setActivePage] = useState('settings');
  const [browserMessage, setBrowserMessage] = useState('');

  async function handleCloseBrowser() {
    setBrowserMessage('');
    try {
      await closeAccountBrowser();
      setBrowserMessage('浏览器已关闭');
    } catch (error) {
      setBrowserMessage(error.message || '关闭浏览器失败');
    }
  }

  const page = {
    accounts: <AccountsPage />,
    tasks: <PlaceholderPage title="任务" description="创建和跟踪搜索、采集、回复等任务。" />,
    logs: <PlaceholderPage title="日志" description="查看后端任务和账号浏览器事件。" />,
    settings: <SettingsPage />,
  }[activePage];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <strong>Douyin Desktop</strong>
          <span>本地运营控制台</span>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? 'active' : ''}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-actions">
          <button type="button" onClick={handleCloseBrowser}>关闭浏览器</button>
          {browserMessage ? <span>{browserMessage}</span> : null}
        </div>
      </aside>
      <main className="workspace">{page}</main>
    </div>
  );
}
