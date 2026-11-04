// Real Chromium checks for task templates, keyboard flows and readable results.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let fixtureTabId;
let nextCall = 0;
let streamMore;
let streamFinish;
const code = 'const greeting = "hello";\nconsole.log(greeting);';
const answer = [
  '已完成页面整理，下面是可以直接使用的结果。', '',
  '```javascript', code, '```', '',
  '| 商品名称 | 华东库存 | 华南库存 | 华北库存 | 西南库存 | 最近更新时间 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 便携显示器 | 128 | 256 | 144 | 390 | 2026-11-03 12:30 |',
  '| 无线键盘 | 456 | 219 | 320 | 173 | 2026-11-03 12:35 |', '',
  '需要进一步比较时，可以继续提问。',
].join('\n');
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><title>${req.url === '/beta' ? '库存列表 Beta' : '调研网页 Alpha'}</title><main><h1>本地测试网页</h1><p>用于验证界面操作，不发送外部请求。</p></main>`);
    return;
  }
  let raw = '';
  req.on('data', (part) => raw += part);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const userIndex = body.messages.map((message) => message.role).lastIndexOf('user');
    const text = body.messages[userIndex].content;
    const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool');
    if (text.startsWith('长结果流式回归')) {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      const chunk = (content) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      chunk('阅读过程中，新的内容会继续到达。\n\n' + '这是一段用于检查阅读位置的较长说明。\n\n'.repeat(35));
      streamMore = () => chunk('\n\n追加内容已经到达。\n\n' + '后续说明不会把正在查看旧消息的人拉回底部。\n\n'.repeat(15));
      streamFinish = () => {
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      };
      return;
    }
    const call = (name, input) => ({ role: 'assistant', content: null, tool_calls: [{ id: `ux_${++nextCall}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
    let message;
    if (text.startsWith('失败工具回归')) message = results.length ? { role: 'assistant', content: '目标页面不可访问，请重新选择页面后继续。' } : call('read_page', { tab_id: 999999999 });
    else if (!results.length) message = call('list_tabs', {});
    else if (results.length === 1) message = call('read_page', { tab_id: fixtureTabId });
    else message = { role: 'assistant', content: answer };
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-ux-test-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const harness = await context.newPage(); await harness.goto(`${base}/options.html`);
  await harness.evaluate(async (url) => chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${url}/v1`, openaiModel: 'mock', openaiApiKey: 'fake', maxSteps: 5 } }), origin);
  const alpha = await context.newPage(); await alpha.goto(`${origin}/alpha`);
  const beta = await context.newPage(); await beta.goto(`${origin}/beta`);
  const tabIds = await harness.evaluate(async (url) => (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(url)).map((tab) => ({ id: tab.id, url: tab.url })), origin);
  fixtureTabId = tabIds.find((tab) => tab.url.endsWith('/alpha')).id;
  const panel = await context.newPage();
  await panel.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.uxCopiedText = text; } }, configurable: true }));
  await panel.setViewportSize({ width: 420, height: 860 });
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForSelector('#new-chat:enabled');
  await panel.waitForFunction(() => document.getElementById('model-name').textContent === 'mock');
  const noOverflow = async () => assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '面板不应横向溢出');
  const visibleTemplates = async () => {
    const result = await panel.evaluate(() => {
      const box = document.getElementById('log').getBoundingClientRect();
      return [...document.querySelectorAll('#examples button')].every((button) => { const rect = button.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom + 1; });
    });
    assert.equal(result, true, '欢迎页应在无需滚动时看见四个任务入口');
  };
  await noOverflow(); await visibleTemplates();
  await panel.screenshot({ path: 'tests/ux-welcome-wide.png', animations: 'disabled' });
  await panel.setViewportSize({ width: 320, height: 740 }); await noOverflow(); await visibleTemplates();
  await panel.screenshot({ path: 'tests/ux-welcome-narrow.png', animations: 'disabled' });
  await panel.setViewportSize({ width: 420, height: 860 });

  const fillTemplate = panel.locator('#examples button[data-mode="confirm"]');
  await fillTemplate.click();
  assert.equal(await panel.inputValue('#task-mode'), 'confirm');
  assert.equal(await panel.inputValue('#input'), await fillTemplate.getAttribute('data-prompt'));
  await panel.fill('#input', '');
  await panel.locator('#examples button[data-scope="selected"]').click();
  await panel.waitForSelector('#scope-options[open]');
  assert.equal(await panel.isChecked('#scope-selected'), true);
  await panel.waitForSelector('#scope-list input');
  await panel.fill('#scope-search', 'Beta');
  await panel.waitForFunction(() => [...document.querySelectorAll('.scope-tab')].filter((item) => item.getClientRects().length).length === 1);
  assert.ok((await panel.locator('.scope-tab:visible').textContent()).includes('Beta'));
  await panel.fill('#scope-search', '');
  for (const tab of tabIds) await panel.check(`#scope-list input[value="${tab.id}"]`);
  await panel.click('#scope-apply');
  await panel.waitForFunction(() => document.getElementById('page-state').textContent === '2 页');
  await panel.waitForFunction(() => document.getElementById('context-label').textContent === '本轮任务范围' && document.getElementById('page-title').textContent.includes('Beta'));
  await panel.click('#context-picker');
  await panel.waitForSelector('#scope-options[open]');
  await panel.keyboard.press('Escape');
  await panel.waitForFunction(() => document.activeElement?.id === 'context-picker');
  await panel.fill('#input', '');
  const readTemplate = panel.locator('#examples button[data-mode="read-only"]').first();
  await readTemplate.click();
  assert.equal(await panel.inputValue('#task-mode'), 'read-only');
  const draft = '需要保留的现有草稿';
  await panel.fill('#input', draft); await fillTemplate.click();
  assert.equal(await panel.inputValue('#input'), draft);
  assert.equal(await panel.inputValue('#task-mode'), 'read-only', '已有草稿时不得暗中改变任务模式');
  await panel.click('#open-history');
  await panel.waitForFunction(() => document.activeElement?.id === 'history-search');
  await panel.keyboard.press('Escape');
  await panel.waitForFunction(() => document.activeElement?.id === 'open-history');
  assert.equal(await panel.inputValue('#input'), draft);

  const send = async (text) => { await panel.fill('#input', text); await panel.click('#send'); };
  const idle = () => panel.waitForFunction(() => document.getElementById('send-label').textContent === '发送');
  // A large-font welcome page scrolls as a document. Starting a chat must
  // return to its fixed frame so the reply and composer remain reachable.
  await panel.setViewportSize({ width: 320, height: 480 });
  await panel.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await panel.locator('#input').scrollIntoViewIfNeeded();
  assert.ok(await panel.evaluate(() => scrollY > 0), '大字体短屏欢迎页应允许整页滚动到输入框');
  await send('可读性回归');
  await panel.waitForSelector('.copy-code'); await idle();
  assert.equal(await panel.evaluate(() => scrollY), 0, '进入对话后应重置欢迎页的外层滚动位置');
  assert.ok(await panel.locator('#log').evaluate((log) => log.clientHeight >= 80), '短屏大字体应保留可阅读的回复区域');
  const frame = await panel.evaluate(() => ({
    height: innerHeight, documentHeight: document.documentElement.scrollHeight,
    rects: ['body', '.conversation', '#log', '.composer-area'].map((selector) => {
      const node = document.querySelector(selector);
      const rect = node.getBoundingClientRect();
      return { selector, top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: node.scrollHeight };
    }),
  }));
  assert.ok(frame.documentHeight <= frame.height + 1, `对话只能在消息区和输入区内部滚动：${JSON.stringify(frame)}`);
  await panel.fill('#input', '检查下一条任务的发送入口');
  await panel.locator('#send').click({ trial: true });
  await panel.fill('#input', '');
  await panel.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
  await panel.setViewportSize({ width: 420, height: 860 });
  const group = panel.locator('.execution-group').first();
  assert.equal(await group.getAttribute('open'), null, '成功结束后收起执行过程');
  assert.equal(await group.locator('details.tool').count(), 2);
  await group.locator('.execution-summary').click();
  await group.locator('details.tool').first().locator('summary').click();
  assert.equal(await group.locator('details.tool').first().locator('.tool-detail').isVisible(), true);
  await group.locator('.execution-summary').click();
  await panel.locator('.copy-code').click();
  assert.equal(await panel.evaluate(() => window.uxCopiedText), code);
  const table = panel.locator('.table-scroll').first();
  assert.equal(await table.getAttribute('role'), 'region');
  assert.equal(await table.getAttribute('tabindex'), '0');
  await panel.setViewportSize({ width: 320, height: 740 }); await noOverflow();
  await table.focus(); await panel.keyboard.press('ArrowRight');
  await panel.waitForFunction(() => document.querySelector('.table-scroll').scrollLeft > 0);
  await panel.waitForSelector('#toast', { state: 'hidden' });
  await panel.screenshot({ path: 'tests/ux-result-narrow.png', animations: 'disabled' });

  await send('长结果流式回归');
  await panel.waitForFunction(() => document.querySelector('.msg.assistant.streaming .message-content')?.textContent.includes('阅读过程中'));
  await panel.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = 0; log.dispatchEvent(new Event('scroll')); });
  await panel.waitForSelector('#scroll-latest:not([hidden])');
  streamMore();
  await panel.waitForFunction(() => document.querySelector('.msg.assistant.streaming .message-content')?.textContent.includes('追加内容已经到达'));
  assert.ok(await panel.evaluate(() => document.getElementById('log').scrollTop <= 1), '流式追加不得改变正在阅读旧内容的位置');
  streamFinish(); await idle();
  assert.ok(await panel.evaluate(() => document.getElementById('log').scrollTop <= 1), '流式完成不得把旧内容阅读者拉回底部');
  await panel.click('#scroll-latest');
  await panel.waitForFunction(() => { const log = document.getElementById('log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 2; });
  await send('失败工具回归'); await panel.waitForSelector('.tool.fail'); await idle();
  const failedGroup = panel.locator('.execution-group').last();
  assert.equal(await failedGroup.getAttribute('open'), '', '失败过程保留展开以便检查');
  assert.equal(await panel.textContent('#task-status'), '部分步骤未完成');
  await panel.emulateMedia({ colorScheme: 'dark' }); await noOverflow();
  await panel.screenshot({ path: 'tests/ux-failure-dark.png', animations: 'disabled' });
  console.log('✓ 体验回归通过：模板模式/范围、草稿保护、弹窗焦点、执行过程折叠、代码复制、表格键盘滚动、流式阅读位置与窄屏');
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-ux-test-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
