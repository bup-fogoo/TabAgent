# TabAgent

用自然语言指挥 AI 操作网页：点击、填写、提取、跨标签页汇总。把“复制、粘贴、切换标签页”的循环交给 AI，让浏览器变成任务执行器。

一套 TypeScript 代码（Manifest V3，基于 [WXT](https://wxt.dev)），分别构建出 Chrome、Edge、Firefox、Safari 版本；Brave、Opera、Arc、360、QQ 等 Chromium 内核浏览器直接用 Chrome 版。

## 能做什么

- **读页面**：把当前页面整理成带编号的可交互元素列表和正文，交给模型理解。
- **操作页面**：点击、输入（兼容 React/Vue 受控输入框）、选择下拉框、按键、悬停、滚动、前进后退、打开网址。
- **提取数据**：按 CSS 选择器批量抓取列表和表格。
- **跨标签页**：列出、打开、切换、关闭标签页，不切换也能读取其它标签页，把多个页面的信息汇总成一张表。
- **安全**：网页上的文字只当数据，不当指令；付款、下单、发消息、删除等不可撤销操作前会先问你。

## 安装（开发者模式加载）

先构建（需要 Node.js 18+）：

```bash
npm install
npm run build:all      # 生成 .output/chrome-mv3、edge-mv3、firefox-mv2
```

或者直接用已经打好的安装包（`dist/` 目录里的 zip，解压后加载）。

| 浏览器 | 步骤 |
| --- | --- |
| Chrome / Brave / Opera 等 | 打开 `chrome://extensions` → 右上角打开“开发者模式” → “加载已解压的扩展程序” → 选 `.output/chrome-mv3` |
| Edge | 打开 `edge://extensions` → 左侧打开“开发人员模式” → “加载解压缩的扩展” → 选 `.output/edge-mv3` |
| Firefox | 打开 `about:debugging#/runtime/this-firefox` → “临时载入附加组件” → 选 `.output/firefox-mv2/manifest.json`（临时加载，重启浏览器后需重新加载；长期使用需要提交到 AMO 签名） |
| Safari | 需要一台装了 Xcode 的 Mac：`npm run build:safari`，然后 `xcrun safari-web-extension-converter .output/safari-mv3`，用 Xcode 运行生成的工程，再在 Safari 设置 → 扩展中启用 |

加载后：

1. 点工具栏上的 TabAgent 图标打开侧边栏（Safari 没有侧边栏，会弹出一个小窗口）。
2. 点“设置”，填写 API Key：
   - **Claude（推荐）**：在 [console.anthropic.com](https://console.anthropic.com) 创建 Key，默认模型 `claude-opus-5-5`，也可选 Sonnet 5.5 / Haiku 5.5（更快更便宜）。可填中转地址。
   - **OpenAI 兼容接口**：填接口地址、Key 和模型名，支持 OpenAI、DeepSeek、通义千问、Kimi、智谱、OpenRouter、本地 Ollama 等（模型需支持工具调用）。
3. 在侧边栏输入指令，例如“把这个页面的表格整理成 Markdown”“对比我打开的所有商品页的价格”。

API Key 只保存在本机浏览器的插件存储里，插件直接从浏览器调用模型服务，不经过其它服务器。

## 开发

```bash
npm run dev            # Chrome 热重载开发
npm run dev:firefox    # Firefox
npm run compile        # 类型检查
npm run test:e2e       # 端到端测试：在真实 Chromium 里用本地假模型跑完整流程（需要 Playwright 的 Chromium）
npm run zip:all        # 打包商店用的 zip
```

## 代码结构

```
entrypoints/
  background.ts        后台：打开侧边栏、管理智能体会话
  content.ts           内容脚本：给页面元素编号，执行点击/输入/提取
  sidepanel/           侧边栏聊天界面
  options/             设置页
lib/
  agent.ts             智能体循环：调用模型 → 执行工具 → 回传结果，直到完成
  tools.ts             工具定义与执行（标签页、页面操作）
  llm/anthropic.ts     Claude（官方 SDK）
  llm/openai.ts        OpenAI 兼容接口
  markdown.ts          安全的 Markdown 渲染
  settings.ts          设置读写
tests/e2e.mjs          端到端测试
```

## 已知限制

- 浏览器禁止插件操作内部页面（`chrome://`、扩展商店、新标签页）。
- 暂不支持跨域 iframe 内部和 canvas 绘制的界面；验证码需要你自己处理。
- Firefox 用 MV2 构建（安装即获得网站权限，体验更顺）；Safari 需要 Mac + Xcode 打包。
