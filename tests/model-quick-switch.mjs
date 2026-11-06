// Model switching in the real side panel, with only temporary profiles and fake keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-quick-model-'));
const requests = [];
let holdResponse = false;
let releaseResponse;
const server = http.createServer((req, res) => {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404, headers); res.end('{}'); return; }
    const { model } = JSON.parse(body);
    requests.push({ path: req.url, model });
    const reply = () => {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `本地测试回复 ${model}` }, finish_reason: 'stop' }] }));
    };
    if (holdResponse) releaseResponse = reply;
    else reply();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  await worker.evaluate((origin) => {
    globalThis.quickModelRequests = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin === origin) return realFetch(input, options);
      globalThis.quickModelRequests.push(url);
      throw new Error('Remote requests disabled in quick-model regression');
    };
  }, origin);
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const harness = await context.newPage();
  await harness.goto(`${base}/options.html`);
  const alpha = { name: '本地 A', apiKey: 'fake-alpha-key', baseUrl: `${origin}/alpha/v1`, model: 'alpha-current', vision: true };
  const beta = { name: '工作 B', apiKey: 'fake-beta-key', baseUrl: `${origin}/beta/v1`, model: 'beta-current', vision: true };
  const settings = { provider: 'openai', openaiBaseUrl: alpha.baseUrl, openaiApiKey: alpha.apiKey, openaiModel: alpha.model, openaiVision: true,
    maxSteps: 40, effort: 'medium', connections: { openai: { selected: 'custom', selectedCustomId: 'alpha',
      profiles: { custom: alpha }, customProfiles: { alpha, beta } } } };
  await harness.evaluate((value) => chrome.storage.local.set({ 'tabagent:settings': value }), settings);
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.setViewportSize({ width: 390, height: 850 });
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'alpha-current');
  const stored = () => harness.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']);
  const store = (value) => harness.evaluate((value) => chrome.storage.local.set({ 'tabagent:settings': value }), value);
  const row = (model) => panel.locator(`.quick-model-use[data-model="${model}"]`);
  const favorite = (model) => panel.locator(`.quick-model-favorite[data-model="${model}"]`);
  const ready = () => panel.waitForFunction(() => !document.querySelector('#quick-model-connection').disabled && !document.querySelector('#quick-model-search').disabled);
  const open = async () => { await panel.click('#model-settings'); await panel.waitForSelector('#quick-model-dialog[open]'); await ready(); };
  const close = async () => { await panel.keyboard.press('Escape'); await panel.waitForSelector('#quick-model-dialog[open]', { state: 'hidden' }); };

  await open();
  assert.equal(await panel.evaluate(() => document.activeElement.id), 'quick-model-search', 'opening the picker focuses its search field');
  const targetIds = await panel.locator('#quick-model-connection option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(new Set(targetIds), new Set(['openai:custom:alpha', 'openai:custom:beta']), 'only configured connections appear');
  assert.equal(await panel.inputValue('#quick-model-connection'), 'openai:custom:alpha');
  assert.equal(await row('alpha-current').getAttribute('aria-current'), 'true');
  assert.equal((await panel.locator('#quick-model-dialog').innerHTML()).includes('fake-alpha-key'), false, 'keys must never be rendered in the dialog');
  await favorite('alpha-current').click();
  await ready();
  assert.equal(await favorite('alpha-current').getAttribute('aria-pressed'), 'true');
  assert.equal(await favorite('alpha-current').evaluate((button) => button === document.activeElement), true, 'saving a favorite keeps keyboard focus');
  await close();

  const changed = await stored();
  changed.openaiModel = 'alpha-new';
  changed.connections.openai.profiles.custom.model = 'alpha-new';
  changed.connections.openai.customProfiles.alpha.model = 'alpha-new';
  await store(changed);
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'alpha-new');
  await open();
  assert.equal(await row('alpha-current').count(), 1, 'favorites survive a saved model change');
  await panel.fill('#quick-model-search', 'current');
  assert.equal(await row('alpha-new').count(), 0);
  await row('alpha-current').click();
  await panel.waitForSelector('#quick-model-dialog[open]', { state: 'hidden' });
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'alpha-current');
  assert.equal((await stored()).openaiVision, false, 'changing a model must not silently retain image permission');
  await open();
  await favorite('alpha-current').click(); await ready();
  assert.equal(await favorite('alpha-current').getAttribute('aria-pressed'), 'false');
  await close();
  const recent = await stored();
  recent.openaiModel = 'alpha-new'; recent.connections.openai.profiles.custom.model = 'alpha-new'; recent.connections.openai.customProfiles.alpha.model = 'alpha-new';
  await store(recent);
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'alpha-new');
  await open();
  assert.equal(await row('alpha-current').locator('small').textContent(), '最近使用');

  await panel.selectOption('#quick-model-connection', 'openai:custom:beta'); await ready();
  assert.equal(await row('alpha-current').count(), 0, 'favorites and recent models are isolated by connection');
  assert.equal(await row('beta-current').count(), 1);
  // A concurrent settings edit must be preserved, including updated credentials.
  const latest = await stored();
  latest.maxSteps = 73;
  latest.connections.openai.customProfiles.beta.apiKey = 'fake-beta-updated';
  await store(latest);
  await panel.waitForTimeout(50); await ready();
  await row('beta-current').click();
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'beta-current');
  const switched = await stored();
  assert.equal(switched.maxSteps, 73);
  assert.equal(switched.openaiApiKey, 'fake-beta-updated', 'quick switching must use the latest connection, not an old snapshot');
  assert.equal(switched.connections.openai.selectedCustomId, 'beta');

  await open();
  await favorite('beta-current').click(); await ready();
  await panel.screenshot({ path: 'tests/model-quick-switch.png', fullPage: true });
  for (const colorScheme of ['light', 'dark']) {
    await panel.emulateMedia({ colorScheme });
    await panel.setViewportSize({ width: 320, height: 520 });
    for (const fontSize of [16, 32]) {
      await panel.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await panel.locator('#quick-model-dialog').evaluate((dialog) => dialog.scrollWidth > dialog.clientWidth + 1), false);
      await panel.locator('#quick-model-manage').scrollIntoViewIfNeeded();
      assert.equal(await panel.locator('#quick-model-manage').isVisible(), true);
    }
  }
  await close();
  await panel.reload();
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'beta-current');
  await open();
  assert.equal(await favorite('beta-current').getAttribute('aria-pressed'), 'true');
  await close();
  assert.deepEqual(requests, [], 'opening or switching models must not invoke a model');

  // Hold a genuine local model request while changing the next task's model.
  await panel.setViewportSize({ width: 390, height: 850 });
  holdResponse = true;
  await panel.fill('#input', '本地运行中切换回归');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('#send.stop');
  for (let attempt = 0; attempt < 100 && !releaseResponse; attempt++) await panel.waitForTimeout(50);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'beta-current');
  await open();
  assert.equal(await panel.locator('#quick-model-running').isVisible(), true);
  await panel.selectOption('#quick-model-connection', 'openai:custom:alpha'); await ready();
  await row('alpha-new').click();
  await panel.waitForFunction(() => document.querySelector('#model-name').textContent === 'alpha-new');
  assert.equal(await panel.locator('#send.stop').count(), 1, 'switching the next model must not interrupt the in-flight task');
  assert.equal(requests.length, 1, 'switching does not start a replacement request');
  holdResponse = false; releaseResponse();
  await panel.waitForSelector('#send:not(.stop)');
  assert.ok((await panel.locator('#log').textContent()).includes('本地测试回复 beta-current'));
  await panel.fill('#input', '使用新连接继续');
  await panel.press('#input', 'Enter');
  await panel.waitForFunction(() => document.querySelector('#log').textContent.includes('本地测试回复 alpha-new'));
  await panel.waitForSelector('#send:not(.stop)');
  assert.deepEqual(requests[1], { path: '/alpha/v1/chat/completions', model: 'alpha-new' });
  assert.deepEqual(await worker.evaluate(() => globalThis.quickModelRequests), []);
  assert.deepEqual(errors, []);
  console.log('✓ 侧栏快捷模型：收藏/最近、连接隔离、实时配置重读、视觉权限保护、保存恢复、窄屏/键盘与运行中切换');
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-quick-model-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
