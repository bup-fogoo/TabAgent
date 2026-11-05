// Browser regression: model discovery and supplier routing use simulated APIs only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-model-picker-'));
const requests = [];
const unexpected = [];
let mode = 'normal';
let held;
let context;
const generic = { object: 'list', data: [
  { id: 'gpt-alpha', owned_by: 'openai', supports_vision: true },
  { id: 'vendor-beta', owned_by: 'other-vendor' },
  { id: 'image-only', type: 'image' },
  { id: 'no-tools-model', owned_by: 'openai', supports_tools: false },
] };
const native = { data: [{ id: 'claude-alpha', display_name: 'Claude Alpha', type: 'model' }], has_more: false };
// Match AITransX's public response: the actual_model relation identifies a route,
// and its exact id is sent as model. owned_by on base entries is the gateway.
const aitransx = { object: 'list', data: [
  { id: 'openai/gpt-alpha', object: 'model', owned_by: 'aitransx', region: 'auto' },
  { id: 'relay@openai/gpt-alpha', actual_model: 'openai/gpt-alpha', object: 'model', owned_by: 'relay', region: 'usa' },
  { id: 'openrouter@openai/gpt-alpha', actual_model: 'openai/gpt-alpha', object: 'model', owned_by: 'openrouter', region: 'multi' },
  { id: 'anthropic/claude-beta', object: 'model', owned_by: 'aitransx', region: 'auto' },
  { id: 'relay@anthropic/claude-beta', actual_model: 'anthropic/claude-beta', object: 'model', owned_by: 'relay', region: 'usa' },
  { id: 'solo@orphan-chat', actual_model: 'orphan-chat', object: 'model', owned_by: 'solo', region: 'usa' },
  { id: 'auto', object: 'model', owned_by: 'aitransx' },
  { id: 'gpt-image-2', object: 'model', owned_by: 'aitransx' },
] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (route, body, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const row = { url: request.url(), method: request.method(), headers: await request.allHeaders() };
    requests.push(row);
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/models')) {
      if (mode === 'held') {
        held = route;
        return;
      }
      if (mode === 'empty') { await json(route, { data: [] }); return; }
      if (mode === 'error') { await json(route, { error: { message: 'fake-private-key must never appear in UI' } }, 401); return; }
      if (new URL(request.url()).hostname === 'api.aitransx.com') { await json(route, aitransx); return; }
      if (new URL(request.url()).hostname === 'api.anthropic.com') { await json(route, native); return; }
      await json(route, request.url().includes('/new/v1/models') ? { data: [{ id: 'new-server-model', owned_by: 'new-vendor' }] } : generic);
      return;
    }
    if (request.method() === 'POST' && request.url().endsWith('/chat/completions')) {
      row.body = request.postDataJSON();
      await json(route, { choices: [{ message: { tool_calls: [{ function: { name: 'tabagent_connection_probe', arguments: '{"value":"tabagent-ok"}' } }] } }] });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1000, height: 1100 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const ready = () => page.waitForSelector('#form[aria-busy="false"]');
  const findModel = (id) => page.locator(`#model-list button[data-model-id="${id}"]`);
  const open = async (provider = 'openai') => { await page.click(`#${provider}-pick-model`); await page.waitForSelector('#model-picker[open]'); };
  const close = async () => { await page.click('#model-close'); await page.waitForSelector('#model-picker[open]', { state: 'hidden' }); };
  const stored = () => page.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']);
  const save = async () => { await page.click('#save-button'); await page.waitForSelector('#saved:not([hidden])'); };
  const choose = async (id) => { await findModel(id).click(); await page.click('#model-apply'); await page.waitForSelector('#model-picker[open]', { state: 'hidden' }); };
  const settled = async () => page.waitForFunction(() => !document.querySelector('#model-refresh').disabled && document.querySelector('#model-status').dataset.state !== 'loading');
  await ready();
  assert.equal(requests.length, 0, 'opening default settings must not contact a model service');
  await page.check('[name="provider"][value="openai"]');
  await page.fill('#openai-key', 'fake-private-key');
  await page.check('#openai-vision');
  const original = await page.inputValue('#openai-model');
  await open();
  await findModel('gpt-alpha').waitFor();
  assert.equal(requests.at(-1).url, 'https://api.openai.com/v1/models');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer fake-private-key');
  assert.equal(await findModel('image-only').count(), 0, 'explicit image-only models do not belong in an assistant model picker');
  assert.equal(await findModel('no-tools-model').isDisabled(), true, 'known models without tools cannot be selected for browser tasks');
  await page.fill('#model-search', 'alpha');
  assert.equal(await findModel('vendor-beta').count(), 0, 'search must narrow the selectable models');
  await findModel('gpt-alpha').click();
  assert.equal(await page.inputValue('#openai-model'), original, 'browsing models must not change the active draft before confirmation');
  await page.click('#model-apply');
  assert.equal(await page.inputValue('#openai-model'), 'gpt-alpha');
  assert.equal(await page.isChecked('#openai-vision'), false, 'selecting another model clears previous vision permission');
  assert.equal(await stored(), undefined, 'choosing a model must wait for an explicit settings save');

  // A refresh with no results or an authentication error must keep the configured model.
  await open(); await findModel('gpt-alpha').waitFor();
  mode = 'empty';
  await page.click('#model-refresh'); await settled();
  assert.equal(await page.locator('#model-list button[data-model-id]').count(), 0);
  assert.equal(await page.isDisabled('#model-apply'), true);
  assert.equal(await page.inputValue('#openai-model'), 'gpt-alpha');
  mode = 'error';
  await page.click('#model-refresh'); await settled();
  assert.ok((await page.textContent('#model-status')).trim(), 'failed discovery needs an actionable status');
  assert.equal((await page.textContent('#model-status')).includes('fake-private-key'), false);
  await close();
  mode = 'normal';

  await page.selectOption('#openai-service', 'aitransx');
  const beforeAIT = requests.length;
  await page.fill('#openai-key', 'fake-aitransx-key');
  assert.equal(requests.length, beforeAIT, 'selecting a service must not fetch until the picker is opened');
  await open(); await findModel('openai/gpt-alpha').waitFor();
  assert.equal(requests.at(-1).url, 'https://api.aitransx.com/v1/models');
  assert.equal(requests.at(-1).headers.authorization, undefined, 'the public AITransX catalog must not receive the private key');
  assert.equal(await findModel('relay@openai/gpt-alpha').count(), 0, 'supplier routes belong to their model rather than duplicate list entries');
  assert.equal(await findModel('auto').count(), 0);
  assert.equal(await findModel('gpt-image-2').count(), 0, 'AITransX filtering must match its official chat workbench');
  await findModel('solo@orphan-chat').click();
  assert.deepEqual(await page.locator('#model-supplier option').evaluateAll((options) => options.map((option) => option.value)), ['solo@orphan-chat'],
    'a route without an advertised automatic ID must not invent one');
  await page.fill('#model-search', 'claude');
  assert.equal(await page.isDisabled('#model-apply'), true, 'filtering away the selected model must not apply an invisible previous choice');
  assert.equal(await findModel('openai/gpt-alpha').count(), 0);
  await findModel('anthropic/claude-beta').waitFor();
  await page.fill('#model-search', '');
  const vendorValues = await page.locator('#model-vendor option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(vendorValues.includes('anthropic'), 'model vendor is distinct from routing supplier');
  await page.selectOption('#model-vendor', 'anthropic');
  assert.equal(await findModel('openai/gpt-alpha').count(), 0);
  await page.selectOption('#model-vendor', '');
  await findModel('openai/gpt-alpha').click();
  const supplierValues = await page.locator('#model-supplier option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(new Set(supplierValues), new Set(['openai/gpt-alpha', 'relay@openai/gpt-alpha', 'openrouter@openai/gpt-alpha']));
  await page.selectOption('#model-supplier', 'relay@openai/gpt-alpha');
  await page.click('#model-refresh'); await settled();
  assert.equal(await page.inputValue('#model-supplier'), 'relay@openai/gpt-alpha', 'refresh must preserve the model and supplier selected before applying');
  assert.equal(await page.locator('#model-list button').first().getAttribute('data-model-id'), 'openai/gpt-alpha', 'the current selection should be visible at the top of a long catalog');
  assert.equal(await page.locator('#model-list button[tabindex="0"]').count(), 1, 'the catalog must have only one Tab stop');
  await findModel('openai/gpt-alpha').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'anthropic/claude-beta');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'model-supplier', 'Tab should leave the catalog instead of visiting every model');
  await page.click('#model-apply');
  assert.equal(await page.inputValue('#openai-model'), 'relay@openai/gpt-alpha');
  await page.click('#test-connection');
  await page.waitForSelector('#connection-result[data-state="success"]');
  const probe = requests.at(-1);
  assert.equal(probe.url, 'https://api.aitransx.com/v1/chat/completions');
  assert.equal(probe.body.model, 'relay@openai/gpt-alpha', 'send the exact model ID advertised by the supplier route');
  assert.equal(probe.body.provider, undefined, 'do not invent a provider parameter');
  await save(); await page.reload(); await ready();
  assert.equal(await page.inputValue('#openai-model'), 'relay@openai/gpt-alpha');
  await open(); await findModel('openai/gpt-alpha').waitFor();
  assert.equal(await page.inputValue('#model-supplier'), 'relay@openai/gpt-alpha', 'reopening must retain the saved supplier route');
  await page.selectOption('#model-supplier', 'openai/gpt-alpha');
  await page.click('#model-apply');
  assert.equal(await page.inputValue('#openai-model'), 'openai/gpt-alpha', 'platform automatic routing uses the base model ID');
  await page.click('#discard-changes');

  // Private catalog cache and late responses cannot cross service/URL/key changes.
  await page.selectOption('#openai-service', 'official');
  await open(); await findModel('gpt-alpha').waitFor();
  mode = 'held'; held = undefined;
  await page.click('#model-refresh');
  for (let i = 0; !held && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(held, 'the old request must be in flight before testing cancellation');
  await close();
  await page.selectOption('#openai-service', 'custom');
  await page.fill('#openai-url', 'https://custom.example.invalid/new/v1');
  await page.fill('#openai-key', 'new-private-key');
  mode = 'normal';
  await open(); await findModel('new-server-model').waitFor();
  assert.equal(requests.at(-1).headers.authorization, 'Bearer new-private-key');
  await json(held, { data: [{ id: 'stale-secret-model' }] }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await findModel('stale-secret-model').count(), 0);
  assert.equal(await findModel('new-server-model').count(), 1);
  await close();
  await page.fill('#openai-key', 'replacement-key');
  const beforeKeyRefresh = requests.length;
  await open(); await findModel('new-server-model').waitFor();
  assert.ok(requests.length > beforeKeyRefresh, 'changing key invalidates a private catalog cache');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer replacement-key');
  await close();
  await page.fill('#openai-model', 'manual/model-not-listed');
  await save(); await page.reload(); await ready();
  assert.equal(await page.inputValue('#openai-model'), 'manual/model-not-listed', 'manual model IDs remain supported');

  await page.check('[name="provider"][value="anthropic"]');
  await page.fill('#anthropic-key', 'native-test-key');
  await open('anthropic'); await findModel('claude-alpha').waitFor();
  assert.equal(new URL(requests.at(-1).url).origin + new URL(requests.at(-1).url).pathname, 'https://api.anthropic.com/v1/models');
  assert.equal(requests.at(-1).headers['x-api-key'], 'native-test-key');
  assert.equal(requests.at(-1).headers.authorization, undefined);
  await choose('claude-alpha');
  assert.equal(await page.inputValue('#anthropic-model'), 'claude-alpha');

  await page.check('[name="provider"][value="openai"]');
  await page.selectOption('#openai-service', 'aitransx');
  await open(); await findModel('openai/gpt-alpha').waitFor();
  await findModel('openai/gpt-alpha').click();
  await page.screenshot({ path: 'tests/model-picker-wide.png', fullPage: true, animations: 'disabled' });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const fontSize of [16, 32]) {
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#model-picker').evaluate((dialog) => dialog.scrollWidth > dialog.clientWidth + 1), false,
        `picker must not overflow at 320px/${fontSize}px in ${colorScheme}`);
      await page.locator('#model-apply').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#model-apply').isVisible(), true);
    }
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await page.screenshot({ path: 'tests/model-picker-narrow.png', fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#model-picker[open]', { state: 'hidden' });
  await page.click('#discard-changes');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(pageErrors, []);
  console.log('✓ 模型选择：官方/自定义目录、AITransX供应商精确路由、搜索筛选、错误与空列表、保存手填、取消和密钥隔离、窄屏布局');
} finally {
  await context?.close();
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-model-picker-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
