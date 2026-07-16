import { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Eye,
  EyeOff,
  FileClock,
  FileText,
  ListChecks,
  MessageCircle,
  MessageSquareReply,
  Send,
  RefreshCw,
  Search,
  Settings,
  UsersRound,
  Video,
  X,
} from 'lucide-react';
import { closeAccountBrowser, getAppInfo, hideAccountBrowser, reloadAccountBrowser, setBrowserDockMode, showAccountBrowser } from './api.js';
import { AccountsPage } from './components/AccountsPage.jsx';
import { BatchJobsPage } from './components/BatchJobsPage.jsx';
import { KnowledgePage } from './components/KnowledgePage.jsx';
import { LogsPage } from './components/LogsPage.jsx';
import { DmLeadsPage } from './components/DmLeadsPage.jsx';
import { DmInboxPage, subscribeDmNavigation } from './components/DmInboxPage.jsx';
import { MyVideosPage } from './components/MyVideosPage.jsx';
import { ReplyReviewPage } from './components/ReplyReviewPage.jsx';
import { SearchLeadsPage } from './components/SearchLeadsPage.jsx';
import { SettingsPage } from './components/SettingsPage.jsx';
import { SystemStatusPage } from './components/SystemStatusPage.jsx';
import { TasksPage } from './components/TasksPage.jsx';
import logoUrl from './assets/tongzhouxing-logo.png';

const NAV_ITEMS = [
  { id: 'accounts', label: '账号', icon: UsersRound, description: '账号登录状态和独立浏览器' },
  { id: 'search', label: '搜索获客', icon: Search, description: '批量搜索视频并创建运营任务' },
  { id: 'dmLeads', label: '线索私信', icon: Send, description: '从评论线索审核并发送私信' },
  { id: 'dmInbox', label: '我的私信', icon: MessageCircle, description: '查看新消息并人工回复' },
  { id: 'batch', label: '批量任务', icon: ListChecks, description: '查看点赞、评论、拉取评论进度' },
  { id: 'myVideos', label: '我的作品', icon: Video, description: '同步账号作品和评论区' },
  { id: 'reply', label: '评论管理', icon: MessageSquareReply, description: '理解、回复和清理自己作品的评论' },
  { id: 'knowledge', label: '知识库', icon: BookOpen, description: '维护业务资料和回复依据' },
  { id: 'tasks', label: '高级任务', icon: ClipboardList, description: '保留底层单条任务入口' },
  { id: 'logs', label: '日志', icon: FileText, description: '查看后端事件和失败原因' },
  { id: 'systemStatus', label: '系统状态', icon: Activity, description: '检查后端、Bridge 和浏览器连接' },
  { id: 'settings', label: '设置', icon: Settings, description: '配置 LLM 与系统参数' },
];

export function App() {
  const [activePage, setActivePage] = useState('search');
  const [browserVisible, setBrowserVisible] = useState(false);
  const [browserAvailable, setBrowserAvailable] = useState(false);
  const [browserMessage, setBrowserMessage] = useState('浏览器未打开');
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [browserDockMode, setBrowserDockModeState] = useState(() => localStorage.getItem('vulcan.browserDockMode') || 'balanced');
  const [browserLayout, setBrowserLayout] = useState(null);
  const [dmNavigation, setDmNavigation] = useState(null);

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

  async function handleReloadBrowser() {
    setBrowserMessage('');
    try {
      const result = await reloadAccountBrowser();
      if (!result.ok) {
        setBrowserMessage(result.error || '刷新浏览器失败');
        return;
      }
      setBrowserMessage('浏览器已刷新，正在恢复任务连接');
    } catch (error) {
      setBrowserMessage(error.message || '刷新浏览器失败');
    }
  }

  async function handleBrowserOpened() {
    setBrowserVisible(true);
    setBrowserAvailable(true);
    setBrowserMessage('浏览器已打开');
    try {
      await setBrowserDockMode(browserDockMode);
    } catch {
      // The browser is already usable; layout sync will retry on the next resize.
    }
  }

  async function handleDockModeChange(mode) {
    try {
      const result = await setBrowserDockMode(mode);
      const nextMode = result?.mode || mode;
      setBrowserDockModeState(nextMode);
      localStorage.setItem('vulcan.browserDockMode', nextMode);
      setBrowserMessage(`浏览器已切换为${{ compact: '紧凑', balanced: '均衡', wide: '宽屏' }[nextMode]}停靠`);
    } catch (error) {
      setBrowserMessage(error.message || '调整浏览器宽度失败');
    }
  }

  async function syncBrowserState() {
    try {
      const info = await getAppInfo();
      const diagnostic = info?.browserBridge || {};
      const hasView = Boolean(diagnostic.hasActiveView);
      const visible = Boolean(diagnostic.hasActiveView && diagnostic.activeViewVisible);
      setBrowserAvailable(hasView);
      setBrowserVisible(visible);
      if (hasView && diagnostic.browserDockMode) {
        setBrowserDockModeState(diagnostic.browserDockMode);
        setBrowserLayout({
          appWidth: Math.max(0, window.innerWidth - Number(diagnostic.browserDockWidth || 0)),
          browserWidth: Number(diagnostic.browserDockWidth || 0),
          zoomFactor: Number(diagnostic.browserZoomFactor || 1),
          mode: diagnostic.browserDockMode,
        });
      }
      if (!hasView) {
        setBrowserMessage((current) => (current === '浏览器未打开' ? current : '浏览器未打开'));
      }
    } catch {
      // App info is best-effort UI state sync; normal actions still report their own errors.
    }
  }

  useEffect(() => {
    if (!window.douyinDesktop?.onBrowserNotice) return undefined;
    return window.douyinDesktop.onBrowserNotice((notice) => {
      if (notice?.message) setBrowserMessage(notice.message);
    });
  }, []);

  useEffect(() => subscribeDmNavigation(
    window.desktopApi || window.douyinDesktop,
    (navigation) => {
      setDmNavigation(navigation);
      setActivePage('dmInbox');
    },
  ), []);

  useEffect(() => {
    if (!window.douyinDesktop?.onBrowserLayout) return undefined;
    return window.douyinDesktop.onBrowserLayout((layout) => {
      if (!layout) return;
      setBrowserLayout(layout);
      if (layout.mode) setBrowserDockModeState(layout.mode);
    });
  }, []);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    syncBrowserState();
    const timer = window.setInterval(syncBrowserState, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const browserStatus = browserVisible ? '浏览器显示中' : browserAvailable ? '浏览器已隐藏' : '浏览器未打开';
  const dockRatios = { compact: 0.4, balanced: 0.48, wide: 0.56 };
  const adaptiveAppWidth = Math.min(720, Math.max(520, Math.round(windowWidth * 0.52)));
  const fallbackBrowserWidth = Math.min(
    980,
    Math.max(560, windowWidth - adaptiveAppWidth),
    Math.max(560, Math.round(windowWidth * (dockRatios[browserDockMode] || 0.48))),
  );
  const dockedAppWidth = browserLayout?.appWidth || Math.max(520, windowWidth - fallbackBrowserWidth);

  const page = {
    search: <SearchLeadsPage />,
    dmLeads: <DmLeadsPage />,
    dmInbox: <DmInboxPage navigation={dmNavigation} />,
    batch: <BatchJobsPage />,
    myVideos: <MyVideosPage />,
    reply: <ReplyReviewPage />,
    knowledge: <KnowledgePage />,
    accounts: <AccountsPage onBrowserOpened={handleBrowserOpened} />,
    tasks: <TasksPage />,
    logs: <LogsPage />,
    systemStatus: <SystemStatusPage />,
    settings: <SettingsPage />,
  }[activePage];

  return (
    <div
      className={`app-shell${browserVisible ? ' browser-docked' : ''}`}
      style={{ '--app-docked-width': `${dockedAppWidth}px` }}
    >
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
        <div className="sidebar-actions">
          {browserVisible ? (
            <div className="browser-control-panel">
              <div className="browser-control-status">
                <Eye size={15} aria-hidden="true" />
                <span>浏览器</span>
              </div>
              <div className="browser-control-buttons" role="group" aria-label="浏览器操作">
                <button
                  type="button"
                  className="browser-control-button"
                  onClick={handleHideBrowser}
                  aria-label="最小化浏览器"
                  title="最小化浏览器"
                >
                  <EyeOff size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="browser-control-button"
                  onClick={handleReloadBrowser}
                  aria-label="刷新浏览器"
                  title="刷新浏览器"
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="browser-control-button danger-action"
                  onClick={handleCloseBrowser}
                  aria-label="关闭浏览器"
                  title="关闭浏览器"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : browserAvailable ? (
            <button type="button" className="ghost-action" onClick={handleShowBrowser}>
              <Eye size={16} aria-hidden="true" />
              显示浏览器
            </button>
          ) : null}
          <span className="browser-message">{browserMessage}</span>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar" aria-label="运行状态">
          {browserVisible ? (
            <div className="dock-mode-control" role="group" aria-label="浏览器停靠宽度">
              {[
                ['compact', '紧凑'],
                ['balanced', '均衡'],
                ['wide', '宽屏'],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={browserDockMode === mode ? 'active' : ''}
                  onClick={() => handleDockModeChange(mode)}
                  aria-pressed={browserDockMode === mode}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
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
        <div className={`workspace${activePage === 'dmInbox' ? ' dm-inbox-host' : ''}`}>{page}</div>
        <footer className="app-footer">
          <span>Powered By ZZY</span>
          <span>v1.1.1</span>
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
