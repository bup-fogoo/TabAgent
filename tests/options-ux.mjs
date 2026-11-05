// Settings recovery, cancellation and layout in the real extension.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let requested = false;
let cancelled = false;
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (part) => { body += part; });
  req.on('end', () => {
    requested = true;
    if (JSON.parse(body).model === 'pending-probe') {
      res.on('close', () => { cancelled = true; });
      return;
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'tabagent_connection_probe', arguments: '{"value":"tabagent-ok"}' } }] } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-options-ux-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1100, height: 1300 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await page.waitForSelector('#form[aria-busy="false"]');
  assert.equal(await page.isChecked('#anthropic-vision'), false);
  assert.equal(await page.isChecked('#openai-vision'), false);
  await page.evaluate(() => chrome.storage.local.set({ 'tabagent:settings': { anthropicVision: 'true', openaiVision: 1 } }));
  await page.reload(); await page.waitForSelector('#form[aria-busy="false"]');
  assert.equal(await page.isChecked('#anthropic-vision'), false, 'only the boolean true may enable image access');
  assert.equal(await page.isChecked('#openai-vision'), false);
  const baseline = {
    provider: 'openai', openaiBaseUrl: `${origin}/v1`, openaiApiKey: 'saved-secret', openaiModel: 'saved-model',
    anthropicBaseUrl: origin, anthropicApiKey: 'saved-anthropic-secret', anthropicModel: 'saved-claude', effort: 'medium', maxSteps: 40,
    anthropicVision: false, openaiVision: false,
  };
  await page.evaluate((settings) => chrome.storage.local.set({ 'tabagent:settings': settings }), baseline);
  await page.reload(); await page.waitForSelector('#form[aria-busy="false"]');
  const stored = () => page.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']);
  const flatStored = async () => { const { connections, ...settings } = await stored(); return settings; };
  assert.equal(await page.inputValue('#openai-model'), 'saved-model');
  assert.equal(await page.inputValue('[name="provider"]:checked'), 'openai');
  assert.equal(await page.isDisabled('#save-button'), true);
  assert.equal(await page.isDisabled('#discard-changes'), true);
  assert.equal(await page.getAttribute('#openai-key', 'type'), 'password');

  await page.fill('#openai-model', 'unsaved-model');
  await page.check('#openai-vision');
  await page.fill('#openai-key', 'unsaved-secret');
  assert.equal(await page.isChecked('#openai-vision'), true, 'changing a key must preserve the vision preference');
  await page.check('[name="provider"][value="anthropic"]');
  await page.check('#anthropic-vision');
  await page.fill('#anthropic-key', 'unsaved-anthropic');
  assert.equal(await page.isChecked('#anthropic-vision'), true);
  await page.click('.reveal-key[aria-controls="anthropic-key"]');
  await page.fill('#max-steps', '2');
  await page.click('#save-button');
  assert.equal(await page.getAttribute('#max-steps', 'aria-invalid'), 'true');
  assert.equal(await page.locator('#max-steps').evaluate((input) => getComputedStyle(input).borderColor),
    await page.locator('#max-steps-error').evaluate((message) => getComputedStyle(message).color),
    'invalid inputs must keep their error border while focused');
  await page.locator('.page-header').click();
  assert.equal(await page.locator('#max-steps').evaluate((input) => getComputedStyle(input).borderColor),
    await page.locator('#max-steps-error').evaluate((message) => getComputedStyle(message).color),
    'invalid inputs must remain identifiable after leaving the field');
  assert.equal(await page.isDisabled('#discard-changes'), false);
  assert.equal(await page.inputValue('[name="provider"]:checked'), 'anthropic');
  assert.deepEqual(await stored(), baseline);
  await page.click('#discard-changes');
  assert.equal(await page.inputValue('[name="provider"]:checked'), 'openai');
  assert.equal(await page.inputValue('#openai-model'), 'saved-model');
  assert.equal(await page.inputValue('#openai-key'), 'saved-secret');
  assert.equal(await page.inputValue('#anthropic-key'), 'saved-anthropic-secret');
  assert.equal(await page.getAttribute('#anthropic-key', 'type'), 'password');
  assert.equal(await page.inputValue('#max-steps'), '40');
  assert.equal(await page.getAttribute('#max-steps', 'aria-invalid'), 'false');
  assert.equal(await page.isDisabled('#save-button'), true);
  assert.equal(await page.isDisabled('#discard-changes'), true);
  assert.equal(await page.isChecked('#anthropic-vision'), false, 'undo must restore each provider switch');
  assert.equal(await page.isChecked('#openai-vision'), false);

  await page.fill('#openai-model', 'pending-probe');
  await page.click('#test-connection');
  await page.waitForSelector('#connection-result[data-state="testing"]');
  for (let i = 0; !requested && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requested, true);
  await page.click('#discard-changes');
  await page.waitForSelector('#connection-result[data-state="stale"]');
  assert.equal(await page.inputValue('#openai-model'), 'saved-model');
  for (let i = 0; !cancelled && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled, true, 'reverting must cancel the in-flight test');
  assert.deepEqual(await stored(), baseline);
  await page.click('#test-connection');
  await page.waitForSelector('#connection-result[data-state="success"]');
  assert.deepEqual(await stored(), baseline, 'testing must not save configuration');

  await page.check('#openai-vision');
  assert.equal(await page.isDisabled('#save-button'), false);
  await page.click('#save-button');
  await page.waitForSelector('#saved:not([hidden])');
  assert.deepEqual(await flatStored(), { ...baseline, openaiVision: true });
  await page.reload(); await page.waitForSelector('#form[aria-busy="false"]');
  assert.equal(await page.isChecked('#openai-vision'), true, 'saved vision choice must survive reload');
  assert.match(await page.getAttribute('#test-connection', 'title'), /不测试图片识别/);
  await page.check('[name="provider"][value="anthropic"]');
  await page.check('#anthropic-vision');
  await page.check('[name="provider"][value="openai"]');
  assert.equal(await page.isChecked('#openai-vision'), true, 'switching provider must preserve its preference');
  await page.check('[name="provider"][value="anthropic"]');
  assert.equal(await page.isChecked('#anthropic-vision'), true);
  await page.click('#save-button');
  await page.waitForSelector('#saved:not([hidden])');
  const visionBaseline = { ...baseline, provider: 'anthropic', anthropicVision: true, openaiVision: true };
  assert.deepEqual(await flatStored(), visionBaseline, 'save must persist both booleans, including the hidden provider');

  await page.fill('#anthropic-model', 'different-claude');
  assert.equal(await page.isChecked('#anthropic-vision'), false, 'a different model requires vision to be enabled again');
  assert.equal(await page.isChecked('#openai-vision'), true);
  await page.click('#discard-changes');
  assert.equal(await page.isChecked('#anthropic-vision'), true);
  assert.equal(await page.inputValue('#anthropic-model'), baseline.anthropicModel);
  await page.fill('#anthropic-url', `${origin}/new-anthropic`);
  assert.equal(await page.isChecked('#anthropic-vision'), false, 'a different service requires vision to be enabled again');
  await page.click('#discard-changes');
  assert.equal(await page.isChecked('#anthropic-vision'), true);
  await page.check('[name="provider"][value="openai"]');
  await page.fill('#openai-model', 'different-openai');
  assert.equal(await page.isChecked('#openai-vision'), false);
  assert.equal(await page.isChecked('#anthropic-vision'), true);
  await page.click('#discard-changes');
  assert.equal(await page.isChecked('#openai-vision'), true);
  await page.check('[name="provider"][value="openai"]');
  await page.fill('#openai-url', `${origin}/new-openai`);
  assert.equal(await page.isChecked('#openai-vision'), false);
  await page.click('#discard-changes');
  assert.equal(await page.isChecked('#openai-vision'), true);
  assert.deepEqual(await flatStored(), visionBaseline);
  await page.screenshot({ path: 'tests/options-refreshed.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'tests/options-refreshed-narrow-dark.png', fullPage: true, animations: 'disabled' });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const fontSize of [16, 32]) {
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const width of [280, 320, 768, 1280]) {
        await page.setViewportSize({ width, height: 740 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
          `settings must fit ${colorScheme}, ${fontSize}px text and ${width}px width`);
      }
    }
  }
  console.log('✓ 设置体验：图片识别独立开关、布尔持久化、模型与地址变更保护、撤销恢复、取消测试及窄屏深色布局');
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-options-ux-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
