// Connection drafts and model library regressions. All network requests use fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-connection-library-'));
const screenshots = [];
const requests = [];
const unexpected = [];
let offline = false;
let context;
let page;
const generic = { data: [
  { id: 'custom-one', owned_by: 'fixture', supports_tools: true },
  { id: 'custom-two', owned_by: 'fixture', supports_tools: true },
] };
const aitransx = { data: [
  { id: 'openai/gpt-alpha', owned_by: 'aitransx', region: 'auto' },
  { id: 'relay@openai/gpt-alpha', actual_model: 'openai/gpt-alpha', owned_by: 'relay', region: 'usa' },
  { id: 'openrouter@openai/gpt-alpha', actual_model: 'openai/gpt-alpha', owned_by: 'openrouter', region: 'multi' },
  { id: 'anthropic/claude-beta', owned_by: 'aitransx' },
] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    requests.push({ url: request.url(), method: request.method(), headers: await request.allHeaders() });
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/models')) {
      await route.fulfill({ status: offline ? 503 : 200, headers: cors, contentType: 'application/json',
        body: JSON.stringify(offline ? { error: { message: 'Fixture service unavailable' } }
          : new URL(request.url()).hostname === 'api.aitransx.com' ? aitransx : generic) });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1040, height: 1100 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const ready = () => page.waitForSelector('#form[aria-busy="false"]');
  const stored = () => page.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']);
  const save = async () => { await page.click('#save-button'); await page.waitForSelector('#saved:not([hidden])'); };
  const reload = async () => { await page.reload(); await ready(); };
  const edit = async (action, name, provider = 'openai') => {
    await page.click(`#${provider}-custom-${action}`);
    await page.waitForSelector('#connection-editor[open]');
    if (name !== undefined) await page.fill('#connection-name', name);
    await page.click('#connection-editor-confirm');
    await page.waitForSelector('#connection-editor[open]', { state: 'hidden' });
  };
  const picker = async () => {
    await page.click('#openai-pick-model');
    await page.waitForSelector('#model-picker[open]');
    await page.waitForFunction(() => !document.querySelector('#model-refresh').disabled
      && document.querySelector('#model-status').dataset.state !== 'loading');
  };
  const closePicker = async () => { await page.click('#model-close'); await page.waitForSelector('#model-picker[open]', { state: 'hidden' }); };
  const tab = (filter) => page.click(`[data-model-filter="${filter}"]`);
  const model = (id) => page.locator(`#model-list button[data-model-id="${id}"]`);
  const ids = () => page.locator('#model-list button[data-model-id]').evaluateAll((rows) => rows.map((row) => row.dataset.modelId));
  const favorite = async (value = true) => {
    if ((await page.getAttribute('#model-favorite', 'aria-pressed')) !== String(value)) await page.click('#model-favorite');
    await page.waitForFunction((expected) => {
      const button = document.querySelector('#model-favorite');
      return !button.disabled && button.getAttribute('aria-pressed') === String(expected);
    }, value);
  };
  const apply = async () => { await page.click('#model-apply'); await page.waitForSelector('#model-picker[open]', { state: 'hidden' }); };
  const waitRecent = async (id) => page.waitForFunction(async (modelId) => Object.entries(await chrome.storage.local.get(null))
    .some(([key, value]) => key.startsWith('tabagent:model-library:') && key.includes(':r:') && value.model === modelId), id);
  const capture = async (name) => {
    const filename = path.resolve(`tests/connection-library-${name}.png`);
    await page.screenshot({ path: filename, fullPage: true }); screenshots.push(filename);
  };
  const noOverflow = async (selector = 'html') => {
    const result = await page.locator(selector).evaluate((element) => ({
      scroll: element.scrollWidth, client: element.clientWidth,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: innerWidth,
    }));
    assert.ok(result.scroll <= result.client + 1, `${selector} must not scroll horizontally: ${JSON.stringify(result)}`);
    assert.ok(result.left >= -1 && result.right <= result.viewport + 1, `${selector} must remain inside the viewport`);
  };

  await ready();
  assert.equal(requests.length, 0, 'opening settings must not contact a model service');
  await page.check('[name="provider"][value="openai"]');
  await page.fill('#openai-key', 'fixture-official-key');
  await save();
  await page.selectOption('#openai-service', 'custom');
  assert.equal(await page.inputValue('#openai-custom-profile'), 'default');
  assert.equal(await page.inputValue('#openai-key'), '', 'a custom connection cannot inherit the official key');
  assert.equal(await page.isDisabled('#openai-custom-delete'), true, 'the last remaining profile cannot be deleted in the form');
  await page.fill('#openai-url', 'https://fixture.example.invalid/v1');
  await page.fill('#openai-key', 'fixture-work-key');
  await page.fill('#openai-model', 'work-model');
  await page.check('#openai-vision');
  await edit('rename', '工作 API');
  const workId = await page.inputValue('#openai-custom-profile');
  await edit('add', '备用 API');
  const firstBackupId = await page.inputValue('#openai-custom-profile');
  assert.notEqual(firstBackupId, workId);
  assert.equal(await page.inputValue('#openai-key'), '', 'new connection starts without any previous API key');
  assert.equal(await page.inputValue('#openai-url'), '', 'new connection starts without another endpoint');
  assert.equal(await page.isChecked('#openai-vision'), false);
  await page.fill('#openai-url', 'https://fixture.example.invalid/v1');
  await page.fill('#openai-key', 'fixture-backup-key');
  await page.fill('#openai-model', 'backup-model');
  await page.selectOption('#openai-custom-profile', workId);
  assert.equal(await page.inputValue('#openai-key'), 'fixture-work-key');
  assert.equal(await page.inputValue('#openai-model'), 'work-model');
  assert.equal(await page.isChecked('#openai-vision'), true, 'switching profiles preserves that profile vision permission');
  await page.fill('#openai-model', 'work-model-draft');
  await page.selectOption('#openai-custom-profile', firstBackupId);
  assert.equal(await page.inputValue('#openai-key'), 'fixture-backup-key');
  assert.equal(await page.inputValue('#openai-model'), 'backup-model');
  await page.selectOption('#openai-service', 'official');
  assert.equal(await page.inputValue('#openai-key'), 'fixture-official-key');
  await page.selectOption('#openai-service', 'custom');
  assert.equal(await page.inputValue('#openai-custom-profile'), firstBackupId, 'service switches remember the selected custom profile');
  await edit('rename', '备用连接');
  await save(); await reload();
  assert.equal(await page.inputValue('#openai-custom-profile'), firstBackupId);
  let settings = await stored();
  assert.equal(settings.connections.openai.customProfiles[workId].model, 'work-model-draft', 'inactive unsaved model draft must survive save and reload');
  assert.equal(settings.connections.openai.customProfiles[firstBackupId].name, '备用连接');
  assert.equal(settings.connections.openai.customProfiles[workId].apiKey, 'fixture-work-key');
  assert.equal(settings.connections.openai.customProfiles[firstBackupId].apiKey, 'fixture-backup-key');

  await edit('delete');
  assert.equal(await page.inputValue('#openai-custom-profile'), workId);
  assert.equal(await page.inputValue('#openai-key'), 'fixture-work-key');
  assert.equal(await page.locator('#openai-custom-profile option').count(), 1);
  await page.click('#discard-changes');
  await page.waitForFunction((id) => document.querySelector('#openai-custom-profile').value === id, firstBackupId);
  assert.equal(await page.locator('#openai-custom-profile option').count(), 2, 'discard restores a deleted profile');
  await edit('rename', '不应保存的名字');
  await page.click('#discard-changes');
  await page.waitForFunction(() => document.querySelector('#openai-custom-profile option:checked').textContent === '备用连接');
  await edit('delete'); await save(); await reload();
  assert.equal(await page.locator('#openai-custom-profile option').count(), 1);
  assert.equal((await stored()).connections.openai.customProfiles[firstBackupId], undefined, 'saved deletion must persist');
  await edit('add', '备用连接');
  const backupId = await page.inputValue('#openai-custom-profile');
  assert.notEqual(backupId, firstBackupId, 'recreated profile gets a new library identity');
  assert.equal(await page.inputValue('#openai-key'), '');
  await page.fill('#openai-url', 'https://fixture.example.invalid/v1');
  await page.fill('#openai-key', 'fixture-backup-key');
  await page.fill('#openai-model', 'backup-model');
  await save();
  console.log('PASS custom connection drafts, empty-key isolation, rename/delete, discard, and reload');

  await page.selectOption('#openai-service', 'aitransx');
  await page.fill('#openai-key', 'fixture-aitransx-key');
  await picker();
  await model('openai/gpt-alpha').click();
  await page.selectOption('#model-supplier', 'relay@openai/gpt-alpha');
  await favorite();
  await page.selectOption('#model-supplier', 'openai/gpt-alpha');
  await favorite(); // Base is deliberately more recent than the exact supplier route.
  await page.selectOption('#model-supplier', 'relay@openai/gpt-alpha');
  await tab('favorites');
  assert.deepEqual(await ids(), ['openai/gpt-alpha', 'relay@openai/gpt-alpha']);
  assert.equal(await model('relay@openai/gpt-alpha').getAttribute('aria-pressed'), 'true', 'favorites must retain the exact supplier route even when its base was favorited later');
  assert.equal(await page.inputValue('#model-supplier'), 'relay@openai/gpt-alpha');
  await capture('supplier-favorites');
  await apply();
  assert.equal(await page.inputValue('#openai-model'), 'relay@openai/gpt-alpha');
  await picker(); await tab('recent');
  assert.deepEqual(await ids(), [], 'browsing and applying an unsaved model must not mark it as used');
  await closePicker();
  await save(); await waitRecent('relay@openai/gpt-alpha');
  await reload(); await picker(); await tab('recent');
  await model('relay@openai/gpt-alpha').waitFor();
  await model('relay@openai/gpt-alpha').click();
  assert.equal(await page.inputValue('#model-supplier'), 'relay@openai/gpt-alpha');
  await closePicker();
  const publicRequests = requests.filter((request) => new URL(request.url).hostname === 'api.aitransx.com');
  assert.ok(publicRequests.length > 0);
  assert.ok(publicRequests.every((request) => !request.headers.authorization), 'public model discovery must not receive the API key');
  console.log('PASS exact supplier favorites and recent models only after saving');

  await page.selectOption('#openai-service', 'custom');
  await page.selectOption('#openai-custom-profile', workId);
  await picker(); await tab('favorites');
  assert.deepEqual(await ids(), [], 'custom and AITransX favorites are isolated');
  await tab('all'); await model('custom-one').click(); await favorite(); await apply();
  await save(); await waitRecent('custom-one');
  await page.selectOption('#openai-custom-profile', backupId);
  await picker(); await tab('favorites');
  assert.deepEqual(await ids(), [], 'two profiles using the same endpoint still have separate favorites');
  await tab('recent');
  assert.equal((await ids()).includes('custom-one'), false, 'recent models are scoped to the selected connection');
  await tab('all'); await model('custom-two').click(); await favorite(); await apply();
  await save(); await waitRecent('custom-two');
  await page.selectOption('#openai-custom-profile', workId);
  await picker(); await tab('favorites');
  await model('custom-one').waitFor();
  assert.deepEqual(await ids(), ['custom-one']);
  await closePicker();
  await page.selectOption('#openai-custom-profile', backupId);
  await page.fill('#openai-url', 'https://fixture.example.invalid/other/v1');
  await picker(); await tab('favorites');
  assert.deepEqual(await ids(), [], 'changing a connection endpoint cannot expose the old endpoint favorites');
  await closePicker();
  await page.click('#discard-changes');
  await page.waitForFunction(() => document.querySelector('#openai-url').value === 'https://fixture.example.invalid/v1');
  offline = true;
  await picker();
  assert.equal(await page.getAttribute('#model-status', 'data-state'), 'error');
  await tab('favorites'); await model('custom-two').waitFor();
  await model('custom-two').click();
  assert.equal(await page.isDisabled('#model-apply'), false, 'saved favorites remain selectable while discovery is offline');
  await apply();
  assert.equal(await page.inputValue('#openai-model'), 'custom-two');
  console.log('PASS per-profile and per-endpoint model isolation, offline favorites');

  await page.setViewportSize({ width: 320, height: 840 });
  await noOverflow();
  await capture('options-narrow');
  await page.click('#openai-custom-rename');
  await noOverflow('#connection-editor');
  await capture('connection-dialog-narrow');
  await page.click('#connection-editor-cancel');
  await picker(); await tab('favorites'); await model('custom-two').click();
  await noOverflow('#model-picker'); await noOverflow();
  await capture('favorites-offline-narrow');
  await closePicker();
  await page.evaluate(() => document.documentElement.style.fontSize = '24px');
  await noOverflow();
  await page.click('#openai-custom-rename');
  await noOverflow('#connection-editor');
  await page.click('#connection-editor-cancel');
  await picker(); await tab('favorites'); await model('custom-two').click();
  await noOverflow('#model-picker');
  await capture('favorites-large-text-narrow');
  await closePicker();
  await page.evaluate(() => document.documentElement.style.fontSize = '');
  await page.setViewportSize({ width: 1040, height: 1100 });
  offline = false;
  await capture('options-wide');
  console.log('PASS 320px settings and dialogs, including large text');

  // A sidebar or another settings window may save while this form has drafts.
  await page.fill('#max-steps', '61');
  const externalModel = 'externally-switched-model';
  await page.evaluate(async (newModel) => {
    const key = 'tabagent:settings';
    const value = (await chrome.storage.local.get(key))[key];
    value.openaiModel = newModel;
    value.openaiVision = false;
    value.connections.openai.profiles.custom.model = newModel;
    value.connections.openai.profiles.custom.vision = false;
    value.connections.openai.customProfiles[value.connections.openai.selectedCustomId].model = newModel;
    value.connections.openai.customProfiles[value.connections.openai.selectedCustomId].vision = false;
    await chrome.storage.local.set({ [key]: value });
  }, externalModel);
  await page.click('#save-button');
  await page.waitForSelector('#retry-load:not([hidden])');
  assert.equal((await stored()).openaiModel, externalModel, 'saving a stale draft must not overwrite another window model change');
  assert.equal(await page.inputValue('#max-steps'), '61', 'a conflict preserves the local draft until explicitly discarded');
  await page.click('#retry-load'); await ready();
  assert.equal(await page.inputValue('#openai-model'), externalModel);
  assert.notEqual(await page.inputValue('#max-steps'), '61', 'load latest explicitly discards the conflicting local edit');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  const libraryRecords = await page.evaluate(async () => Object.entries(await chrome.storage.local.get(null))
    .filter(([key]) => key.startsWith('tabagent:model-library:')));
  assert.equal(JSON.stringify(libraryRecords).includes('fixture-'), false, 'model library must not store credentials or endpoint details');
  console.log('PASS external settings conflict preserves newer configuration');
  console.log(JSON.stringify({ screenshots, requests: requests.length }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.resolve('tests/connection-library-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-connection-library-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
