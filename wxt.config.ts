import { defineConfig } from 'wxt';

// 一套代码，按浏览器分别构建：chrome / edge / firefox（以及其它 Chromium 浏览器）。
export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'TabAgent',
    description: '用自然语言指挥 AI 操作网页：点击、填写、提取、跨标签页汇总。',
    permissions: [
      'tabs',
      'scripting',
      'storage',
      ...(browser === 'firefox' || browser === 'safari' ? [] : ['sidePanel']),
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: '打开 TabAgent' },
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
      // Safari 没有侧边栏 API，点击图标时改为在小窗口中打开同一界面
      if (wxt.config.browser === 'safari') {
        delete (manifest as any).side_panel;
        manifest.permissions = manifest.permissions?.filter((p) => p !== 'sidePanel');
      }
    },
  },
});
