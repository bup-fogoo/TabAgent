import { browser } from 'wxt/browser';
import { Agent } from '@/lib/agent';
import { PANEL_PORT_NAME, type PanelRequest } from '@/lib/protocol';
import { AUTO_CLOSE_PAGES_KEY, FOLLOW_PAGES_KEY } from '@/lib/view-preferences';

export default defineBackground(() => {
  const agent = new Agent();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[FOLLOW_PAGES_KEY]) {
      agent.setFollowPages(changes[FOLLOW_PAGES_KEY].newValue !== false);
    }
    if (area === 'local' && changes[AUTO_CLOSE_PAGES_KEY]) {
      agent.setAutoClosePages(changes[AUTO_CLOSE_PAGES_KEY].newValue !== false);
    }
  });

  // 点击工具栏图标打开侧边栏：Chrome/Edge 用 sidePanel，Firefox 用 sidebarAction，
  // 两者都没有的浏览器（如 Safari）退而用一个小窗口打开同一个界面。
  const chromeSidePanel = (globalThis as any).chrome?.sidePanel;
  if (chromeSidePanel?.setPanelBehavior) {
    chromeSidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else {
    // Firefox 用 MV2 构建，图标 API 叫 browserAction
    const action = browser.action ?? (browser as any).browserAction;
    action.onClicked.addListener(() => {
      const sidebar = (browser as any).sidebarAction;
      if (sidebar?.toggle) {
        sidebar.toggle();
      } else {
        browser.windows.create({ url: browser.runtime.getURL('/sidepanel.html'), type: 'popup', width: 420, height: 720 });
      }
    });
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT_NAME) return;
    const unsubscribe = agent.subscribe((event) => {
      try {
        port.postMessage(event);
      } catch {
        // 侧边栏已关闭
      }
    });
    port.onDisconnect.addListener(() => unsubscribe());
    port.onMessage.addListener((msg: unknown) => {
      const req = msg as PanelRequest;
      if (!req || typeof req !== 'object') return;
      if (req.type === 'run') void agent.run(req.text, req.mode, req.tabIds);
      else if (req.type === 'stop') agent.stop();
      else if (req.type === 'keep_page') agent.keepPage(req.tabId);
      else if (req.type === 'sources_open') void agent.openSources(req.taskId, req.sourceIds);
      else if (req.type === 'reset') void agent.reset();
      else if (req.type === 'approve' && typeof req.id === 'string' && typeof req.approved === 'boolean') agent.approve(req.id, req.approved);
      else if (req.type === 'conversation_list') agent.listConversations();
      else if (req.type === 'conversation_search' && typeof req.query === 'string') void agent.searchConversations(req.query);
      else if (req.type === 'conversation_rename' && typeof req.id === 'string' && typeof req.title === 'string') void agent.renameConversation(req.id, req.title);
      else if (req.type === 'conversation_open' && typeof req.id === 'string') void agent.openConversation(req.id);
      else if (req.type === 'conversation_delete' && typeof req.id === 'string') void agent.deleteConversation(req.id);
    });
  });
});
