import { defineConfig } from 'wxt';

const icons = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 96: 'icon/96.png', 128: 'icon/128.png' };

// 一套代码，按浏览器分别构建：chrome / edge / firefox（以及其它 Chromium 浏览器）。
export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'TabAgent',
    icons,
    description: '用自然语言指挥 AI 操作网页：点击、填写、提取、跨标签页汇总。',
    permissions: [
      'tabs',
      'scripting',
      'storage',
      ...(browser === 'firefox' || browser === 'safari' ? [] : ['sidePanel']),
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: '打开 TabAgent', default_icon: icons },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tabagent@example.com',
              strict_min_version: '115.0',
              // 页面内容会发送给用户自己配置的模型服务
              data_collection_permissions: { required: ['websiteContent'] },
            },
          },
        }
      : {}),
  }),
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      const sidebar = (manifest as { sidebar_action?: { default_icon?: string } }).sidebar_action;
      if (sidebar) sidebar.default_icon = icons[32];
      // Safari 没有侧边栏 API，点击图标时改为在小窗口中打开同一界面
      if (wxt.config.browser === 'safari') {
        delete (manifest as any).side_panel;
        manifest.permissions = manifest.permissions?.filter((p) => p !== 'sidePanel');
      }
    },
  },
});
