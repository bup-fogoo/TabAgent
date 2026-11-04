// Local Chromium regression: scope details stay current without activating
// background pages, and browser-only tabs still allow a search task.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<meta charset="utf-8"><title>${req.url === '/beta' ? '后台页面 Beta' : '页面 Alpha'}</title><main>本地侧栏测试页面</main>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-panel-behavior-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(url.protocol)) await route.continue();
    else await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const harness = await context.newPage(); await harness.goto(`${base}/options.html`);
  const panel = await context.newPage(); await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForSelector('#new-chat:enabled');
  await panel.locator('#context-picker').click();
  await panel.waitForFunction(() => document.getElementById('scope-feedback').hidden);
  assert.equal(await panel.isChecked('#scope-current'), true);
  assert.equal(await panel.isEnabled('#scope-apply'), true, '无普通网页时，当前范围仍能用于搜索');
  await panel.locator('#scope-selected').check();
  assert.ok((await panel.locator('#scope-feedback').textContent()).includes('直接搜索'));
  assert.equal(await panel.isEnabled('#scope-apply'), false, '指定范围必须选择普通网页');
  await panel.keyboard.press('Escape');
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'context-picker');

  for (const name of ['alpha', 'beta']) {
    const fixture = await context.newPage();
    await fixture.goto(`${origin}/${name}`);
  }
  await panel.bringToFront();
  const ids = await harness.evaluate(async (baseUrl) => {
    const tabs = await chrome.tabs.query({});
    return ['alpha', 'beta'].map((name) => tabs.find((tab) => tab.url === `${baseUrl}/${name}`).id);
  }, origin);
  await panel.locator('#context-picker').click();
  await panel.locator('#scope-selected').check();
  for (const id of ids) await panel.locator(`#scope-list input[value="${id}"]`).check();
  await panel.locator('#scope-apply').click();
  await panel.waitForFunction(() => document.getElementById('page-state').textContent === '2 页');
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'input');
  await harness.evaluate(async (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { document.title = '后台改名已同步'; } }), ids[1]);
  await panel.waitForFunction(() => document.getElementById('page-title').textContent.includes('后台改名已同步'));
  await harness.evaluate(async (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { document.title = ''; } }), ids[1]);
  await panel.waitForFunction(() => !document.getElementById('page-title').textContent.includes('后台改名已同步'));
  assert.equal(await panel.locator('#page-state').textContent(), '2 页', '清空页面标题不会丢失已选页面');
  await harness.evaluate((id) => chrome.tabs.remove(id), ids[1]);
  await panel.waitForFunction(() => document.getElementById('page-state').textContent === '需调整');
  assert.ok((await panel.locator('#page-title').textContent()).includes('Alpha'));
  assert.ok(!(await panel.locator('#page-title').textContent()).includes('后台改名'));

  // Feed genuine panel events through a controlled connection to update sources
  // while the reader is operating its disclosure with the keyboard.
  const eventPanel = await context.newPage();
  await eventPanel.addInitScript(() => {
    if (!globalThis.chrome?.runtime) return;
    chrome.runtime.connect = () => ({
      onMessage: { addListener(listener) {
        window.deliverPanelEvent = listener;
        queueMicrotask(() => {
          listener({ type: 'history', conversationId: 'keyboard-fixture', state: 'running', events: [{ type: 'user', taskId: 'keyboard-task', text: '本地键盘测试' }] });
          listener({ type: 'status', running: true, phase: 'running', step: 1, maxSteps: 4 });
        });
      } },
      onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {},
    });
  });
  await eventPanel.goto(`${base}/sidepanel.html`);
  await eventPanel.waitForFunction(() => typeof window.deliverPanelEvent === 'function');
  const pages = [{ id: 'source-a', title: '来源 A', url: `${origin}/alpha`, kind: 'page' }];
  await eventPanel.evaluate((value) => window.deliverPanelEvent({ type: 'sources', taskId: 'keyboard-task', pages: value }), pages);
  await eventPanel.locator('.reference-summary').focus();
  await eventPanel.keyboard.press('Enter');
  pages.push({ id: 'source-b', title: '来源 B', url: `${origin}/beta`, kind: 'page' });
  await eventPanel.evaluate((value) => window.deliverPanelEvent({ type: 'sources', taskId: 'keyboard-task', pages: value }), pages);
  assert.equal(await eventPanel.evaluate(() => document.activeElement.classList.contains('reference-summary')), true, '来源更新不得丢失键盘焦点');
  assert.equal(await eventPanel.locator('.reference-pages').evaluate((node) => node.open), true, '来源更新保留展开状态');
  await eventPanel.keyboard.press('Enter');
  assert.equal(await eventPanel.locator('.reference-pages').evaluate((node) => node.open), false);
  console.log('✓ 侧栏细节：空当前范围可搜索、指定范围校验、弹窗焦点恢复、后台页变动同步、来源更新保持键盘焦点');
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  const resolvedProfile = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedProfile.startsWith(tempRoot) || !path.basename(resolvedProfile).startsWith('tabagent-panel-behavior-')) throw new Error('拒绝清理非测试目录');
  await fs.rm(resolvedProfile, { recursive: true, force: true });
}
