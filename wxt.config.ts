import { defineConfig } from 'wxt';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

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
      ...(browser === 'firefox' || browser === 'safari' ? [] : ['sidePanel', 'offscreen']),
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
    'build:publicAssets': async (wxt, files) => {
      const base = resolve(wxt.config.root, 'node_modules/pdfjs-dist');
      files.push({ absoluteSrc: resolve(base, 'legacy/build/pdf.worker.min.mjs'), relativeDest: 'pdfjs/pdf.worker.mjs' });
      files.push({ absoluteSrc: resolve(base, 'LICENSE'), relativeDest: 'pdfjs/LICENSE' });
      for (const directory of ['cmaps', 'standard_fonts']) {
        for (const entry of await readdir(resolve(base, directory), { withFileTypes: true })) {
          if (entry.isFile()) files.push({ absoluteSrc: resolve(base, directory, entry.name), relativeDest: `pdfjs/${directory}/${entry.name}` });
        }
      }
    },
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
