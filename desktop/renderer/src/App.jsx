import { useEffect, useState } from 'react';
import {
  BookOpen,
  Bot,
  CheckCircle2,
  ClipboardList,
  Database,
  Eye,
  EyeOff,
  FileClock,
  FileText,
  ListChecks,
  MessageSquareReply,
  Search,
  Settings,
  UsersRound,
  Video,
  X,
} from 'lucide-react';
import { closeAccountBrowser, hideAccountBrowser, showAccountBrowser } from './api.js';
import { AccountsPage } from './components/AccountsPage.jsx';
import { BatchJobsPage } from './components/BatchJobsPage.jsx';
import { KnowledgePage } from './components/KnowledgePage.jsx';
import { LogsPage } from './components/LogsPage.jsx';
import { MyVideosPage } from './components/MyVideosPage.jsx';
import { ReplyReviewPage } from './components/ReplyReviewPage.jsx';
import { SearchLeadsPage } from './components/SearchLeadsPage.jsx';
import { SettingsPage } from './components/SettingsPage.jsx';
import { TasksPage } from './components/TasksPage.jsx';
import logoUrl from './assets/tongzhouxing-logo.png';

const NAV_ITEMS = [
  { id: 'search', label: '搜索获客', icon: Search, description: '批量搜索视频并创建运营任务' },
  { id: 'batch', label: '批量任务', icon: ListChecks, description: '查看点赞、评论、拉取评论进度' },
  { id: 'myVideos', label: '我的作品', icon: Video, description: '同步账号作品和评论区' },
  { id: 'reply', label: '评论回复', icon: MessageSquareReply, description: '审核 AI 草稿后回复评论' },
  { id: 'knowledge', label: '知识库', icon: BookOpen, description: '维护业务资料和回复依据' },
  { id: 'accounts', label: '账号', icon: UsersRound, description: '账号登录状态和独立浏览器' },
  { id: 'tasks', label: '高级任务', icon: ClipboardList, description: '保留底层单条任务入口' },
  { id: 'logs', label: '日志', icon: FileText, description: '查看后端事件和失败原因' },
  { id: 'settings', label: '设置', icon: Settings, description: '配置 LLM 与系统参数' },
];

export function App() {
  const [activePage, setActivePage] = useState('search');
  const [browserVisible, setBrowserVisible] = useState(false);
  const [browserAvailable, setBrowserAvailable] = useState(false);
  const [browserMessage, setBrowserMessage] = useState('浏览器未打开');

  async function handleHideBrowser() {
    setBrowserMessage('');
    try {
      await hideAccountBrowser();
      setBrowserVisible(false);
      setBrowserAvailable(true);
      setBrowserMessage('浏览器已最小化，账号浏览器信息不会丢');
    } catch (error) {
      setBrowserMessage(error.message || '最小化浏览器失败');
    }
  }

  async function handleCloseBrowser() {
    setBrowserMessage('');
    try {
      const result = await closeAccountBrowser();
      if (!result.ok) {
        setBrowserMessage(result.error || '关闭浏览器失败');
        return;
      }
      setBrowserVisible(false);
      setBrowserAvailable(false);
      setBrowserMessage('浏览器已关闭，需要时可在账号页重新打开');
    } catch (error) {
      setBrowserMessage(error.message || '关闭浏览器失败');
    }
  }

  async function handleShowBrowser() {
    setBrowserMessage('');
    try {
      const result = await showAccountBrowser();
      if (!result.ok) {
        setBrowserMessage(result.error || '显示浏览器失败');
        return;
      }
      setBrowserVisible(true);
      setBrowserAvailable(true);
      setBrowserMessage('浏览器已显示');
    } catch (error) {
      setBrowserMessage(error.message || '显示浏览器失败');
    }
  }

  function handleBrowserOpened() {
    setBrowserVisible(true);
    setBrowserAvailable(true);
    setBrowserMessage('浏览器已打开');
  }

  useEffect(() => {
    if (!window.douyinDesktop?.onBrowserNotice) return undefined;
    return window.douyinDesktop.onBrowserNotice((notice) => {
      if (notice?.message) setBrowserMessage(notice.message);
    });
  }, []);

  const browserStatus = browserVisible ? '浏览器显示中' : browserAvailable ? '浏览器已隐藏' : '浏览器未打开';

  const page = {
    search: <SearchLeadsPage />,
    batch: <BatchJobsPage />,
    myVideos: <MyVideosPage />,
    reply: <ReplyReviewPage />,
    knowledge: <KnowledgePage />,
    accounts: <AccountsPage onBrowserOpened={handleBrowserOpened} />,
    tasks: <TasksPage />,
    logs: <LogsPage />,
    settings: <SettingsPage />,
  }[activePage];

  return (
    <div className={`app-shell${browserVisible ? ' browser-docked' : ''}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <img src={logoUrl} alt="" className="brand-logo" />
          <div className="brand-copy">
            <strong>Vulcan</strong>
            <span>抖音控制台</span>
          </div>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? 'active' : ''}
              onClick={() => setActivePage(item.id)}
            >
              <item.icon className="nav-icon" size={18} strokeWidth={1.9} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>
        <section className="sidebar-status" aria-label="系统状态">
          <p>系统状态</p>
          <div className="status-mini">
            {browserVisible ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
            <span>浏览器</span>
            <strong>{browserStatus}</strong>
          </div>
          <div className="status-mini">
            <Bot size={15} aria-hidden="true" />
            <span>LLM</span>
            <strong>deepseek-v4-flash</strong>
          </div>
          <div className="status-mini">
            <Database size={15} aria-hidden="true" />
            <span>数据</span>
            <strong>本地 SQLite</strong>
          </div>
        </section>
        <div className="sidebar-actions">
          {browserVisible ? (
            <div className="browser-actions">
              <button type="button" className="ghost-action" onClick={handleHideBrowser}>
                <EyeOff size={16} aria-hidden="true" />
                最小化浏览器
              </button>
              <button type="button" className="ghost-action danger-action" onClick={handleCloseBrowser}>
                <X size={16} aria-hidden="true" />
                关闭浏览器
              </button>
            </div>
          ) : browserAvailable ? (
            <button type="button" className="ghost-action" onClick={handleShowBrowser}>
              <Eye size={16} aria-hidden="true" />
              显示浏览器
            </button>
          ) : null}
          <span className="browser-message">{browserMessage}</span>
          <small className="developer-credit">Powered By ZZY</small>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar" aria-label="运行状态">
          <div className="topbar-status">
            <span>
              <CheckCircle2 size={15} aria-hidden="true" />
              本机运行
            </span>
            <span>
              {browserVisible ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
              {browserStatus}
            </span>
          </div>
        </header>
        <div className="workspace">{page}</div>
        <footer className="app-footer">
          <span>Powered By ZZY</span>
          <span>v0.1.0</span>
          <span>
            <CheckCircle2 size={14} aria-hidden="true" />
            本地运行
          </span>
          <span>
            <FileClock size={14} aria-hidden="true" />
            人工审核后发布
          </span>
        </footer>
      </main>
    </div>
  );
}
