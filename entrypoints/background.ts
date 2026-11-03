import { browser } from 'wxt/browser';
import { Agent } from '@/lib/agent';
import { PANEL_PORT_NAME, type PanelRequest } from '@/lib/protocol';

export default defineBackground(() => {
  const agent = new Agent();

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
      if (req.type === 'run') agent.run(req.text);
      else if (req.type === 'stop') agent.stop();
      else if (req.type === 'reset') agent.reset();
    });
  });
});
