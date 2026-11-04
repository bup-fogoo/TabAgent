// Real-extension coverage for shared drafts, search/rename/export and streamed replies.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let completeStream;
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end('<title>面板回归页面</title><h1>本地测试页面</h1>'); return; }
  let raw = '';
  req.on('data', (part) => raw += part);
  req.on('end', () => {
    const body = JSON.parse(raw);
    const text = body.messages.filter((message) => message.role === 'user').at(-1).content;
    if (text.startsWith('流式')) {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      const chunk = (content) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      chunk('第一段内容已经收到。');
      if (text.startsWith('流式中断')) return;
      completeStream = () => {
        chunk('\n\n第二段生成完成。');
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      };
    } else {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这是可按正文检索的独特词：蓝莓灯塔。' }, finish_reason: 'stop' }] }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-panel-test-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const harness = await context.newPage(); await harness.goto(`${base}/options.html`);
  await harness.evaluate(async (url) => chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${url}/v1`, openaiModel: 'mock', openaiApiKey: 'fake', maxSteps: 5 } }), origin);
  const page = await context.newPage(); await page.goto(origin);
  const a = await context.newPage(); const b = await context.newPage();
  await a.setViewportSize({ width: 420, height: 860 }); await b.setViewportSize({ width: 420, height: 860 });
  const ready = async (panel) => { await panel.goto(`${base}/sidepanel.html`); await panel.waitForSelector('#new-chat:enabled'); await panel.waitForFunction(() => document.getElementById('model-name').textContent === 'mock'); };
  await ready(a); await ready(b);
  const value = (panel, expected) => panel.waitForFunction((text) => document.getElementById('input').value === text, expected);
  await a.fill('#input', '来自 A 的草稿'); await value(b, '来自 A 的草稿');
  await b.fill('#input', '来自 B 的更新'); await value(a, '来自 B 的更新');
  await a.fill('#input', ''); await value(b, '');
  // Hold the cross-window lock so both windows edit the same base revision.
  const id = await harness.evaluate(async () => (await chrome.storage.local.get('tabagent:conversations:v2'))['tabagent:conversations:v2'].activeId);
  await harness.evaluate((id) => {
    window.draftLockHeld = false;
    navigator.locks.request(`tabagent-draft:${id}`, async () => { window.draftLockHeld = true; await new Promise((resolve) => { window.releaseDraftLock = resolve; }); });
  }, id);
  await harness.waitForFunction(() => window.draftLockHeld);
  await a.fill('#input', 'A 同时编辑的版本'); await b.fill('#input', 'B 同时编辑的版本');
  await harness.evaluate(() => window.releaseDraftLock());
  await b.waitForSelector('#draft-conflict:not([hidden])');
  assert.equal(await a.inputValue('#input'), 'A 同时编辑的版本');
  assert.equal(await b.inputValue('#input'), 'B 同时编辑的版本');
  assert.equal(await b.textContent('#draft-remote'), 'A 同时编辑的版本');
  await b.screenshot({ path: 'tests/sidepanel-draft-conflict.png' });
  const c = await context.newPage(); await ready(c); await value(c, 'A 同时编辑的版本');
  assert.equal(await c.locator('#draft-conflict').isHidden(), true, '新面板不能接管仍活跃窗口的未同步草稿');
  await c.close();
  await b.reload(); await b.waitForSelector('#new-chat:enabled');
  await value(b, 'B 同时编辑的版本'); await b.waitForSelector('#draft-conflict:not([hidden])');
  await b.click('#draft-use-remote'); await value(b, 'A 同时编辑的版本');
  await b.waitForSelector('#draft-conflict', { state: 'hidden' });
  await b.reload(); await b.waitForSelector('#new-chat:enabled'); await value(b, 'A 同时编辑的版本');
  assert.equal(await b.locator('#draft-conflict').isHidden(), true, '解决冲突后重开不能恢复已弃用的分支');
  await a.fill('#input', ''); await value(b, '');
  // Lock the real task to the local webpage so panel focus cannot affect scope.
  const tabId = await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url + '/').id, origin);
  await a.click('#context-picker'); await a.check('#scope-selected'); await a.check(`#scope-list input[value="${tabId}"]`); await a.click('#scope-apply');
  const send = async (text) => { await a.fill('#input', text); await a.click('#send'); };
  const idle = () => a.waitForFunction(() => document.getElementById('send-label').textContent === '发送');
  await send('历史搜索任务'); await a.waitForSelector('.msg.assistant'); await idle();
  await a.click('#open-history'); await a.fill('#history-search', '蓝莓灯塔');
  await a.waitForSelector('.history-item'); assert.equal(await a.locator('.history-item').count(), 1);
  await a.locator('.history-rename').click(); await a.fill('.history-rename-form input', '研究记录：蓝莓'); await a.locator('.history-rename-form button[type="submit"]').click();
  await a.waitForFunction(() => document.querySelector('.history-open strong')?.textContent === '研究记录：蓝莓');
  await a.fill('#history-search', '不存在的词'); await a.waitForFunction(() => document.querySelector('#history-empty')?.textContent === '没有找到匹配的会话。');
  await a.fill('#history-search', '研究记录'); await a.waitForSelector('.history-item');
  await a.screenshot({ path: 'tests/sidepanel-search.png' });
  await a.click('#close-history');
  for (const [button, contentType] of [['#export-markdown', 'markdown'], ['#export-json', 'json']]) {
    await a.click('#open-export');
    const downloadEvent = a.waitForEvent('download'); await a.click(button); const download = await downloadEvent;
    const exported = await fs.readFile(await download.path(), 'utf8');
    assert.ok(exported.includes('蓝莓灯塔')); assert.ok(exported.includes('研究记录：蓝莓'));
    if (contentType === 'json') assert.ok(JSON.parse(exported).events.some((event) => event.type === 'assistant'));
  }
  await send('流式完成测试');
  await a.waitForSelector('.msg.assistant.streaming');
  await a.waitForFunction(() => document.querySelector('.msg.assistant.streaming .message-content')?.textContent.includes('第一段'));
  assert.ok(!(await a.locator('.msg.assistant.streaming').textContent()).includes('第二段'));
  await a.screenshot({ path: 'tests/sidepanel-streaming.png' });
  await b.fill('#input', '任务进行时的新草稿');
  completeStream();
  await idle(); await value(a, '任务进行时的新草稿');
  assert.ok((await a.locator('.msg.assistant').last().textContent()).includes('第二段生成完成'));
  assert.equal(await a.locator('.msg.assistant').count(), 2, '最终回复应替换流式消息而非重复追加');
  await a.fill('#input', ''); await value(b, '');
  await send('流式中断测试'); await a.waitForSelector('.msg.assistant.streaming');
  await a.waitForFunction(() => document.querySelector('.msg.assistant.streaming .message-content')?.textContent.includes('第一段'));
  await a.click('#send'); await idle();
  await a.waitForSelector('.stream-interrupted');
  await a.reload(); await a.waitForSelector('#new-chat:enabled'); await a.waitForSelector('.stream-interrupted');
  assert.equal(await a.locator('.msg.assistant').count(), 3);
  await a.setViewportSize({ width: 320, height: 740 }); await a.emulateMedia({ colorScheme: 'dark' });
  await a.click('#open-history'); await a.fill('#history-search', '蓝莓'); await a.waitForSelector('.history-item');
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.screenshot({ path: 'tests/sidepanel-search-narrow-dark.png' });
  console.log('Panel polish: shared drafts/conflict recovery, search, rename, export, streaming and interruption passed.');
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-panel-test-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
