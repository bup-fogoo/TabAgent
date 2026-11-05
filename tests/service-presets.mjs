// Real settings UI: service presets must isolate credentials and preserve drafts.
// All API calls are intercepted; no actual model service or real keys are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-service-presets-'));
const seen = [];
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(request.method(), 'POST', 'the test must never navigate to a real service');
    const body = request.postDataJSON();
    seen.push({ url: request.url(), headers: await request.allHeaders(), body });
    const response = request.url().endsWith('/v1/messages')
      ? { content: [{ type: 'tool_use', name: 'tabagent_connection_probe', input: { value: 'tabagent-ok' } }] }
      : { choices: [{ message: { tool_calls: [{ function: { name: 'tabagent_connection_probe', arguments: '{"value":"tabagent-ok"}' } }] } }] };
    await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(response) });
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1000, height: 1100 });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const ready = () => page.waitForSelector('#form[aria-busy="false"]');
  const stored = () => page.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']);
  const save = async () => { await page.click('#save-button'); await page.waitForSelector('#saved:not([hidden])'); };
  const choose = (provider, service) => page.selectOption(`#${provider}-service`, service);
  const readOnly = (provider) => page.locator(`#${provider}-url`).evaluate((input) => input.readOnly);
  const selectProvider = (provider) => page.check(`[name="provider"][value="${provider}"]`);
  const fillConnection = async (provider, name, vision) => {
    await page.fill(`#${provider}-key`, `${name}-key`);
    await page.fill(`#${provider}-model`, `${name}-model`);
    await page.setChecked(`#${provider}-vision`, vision);
  };
  const expectConnection = async (provider, name, vision) => {
    assert.equal(await page.inputValue(`#${provider}-key`), `${name}-key`);
    assert.equal(await page.inputValue(`#${provider}-model`), `${name}-model`);
    assert.equal(await page.isChecked(`#${provider}-vision`), vision);
  };
  await ready();
  for (const provider of ['anthropic', 'openai']) {
    assert.equal(await page.inputValue(`#${provider}-service`), 'official');
    assert.equal(await readOnly(provider), true);
  }
  assert.match((await page.inputValue('#anthropic-url')) || await page.getAttribute('#anthropic-url', 'placeholder'), /^https:\/\/api\.anthropic\.com\/?$/);
  assert.match(await page.inputValue('#openai-url'), /^https:\/\/api\.openai\.com\/v1\/?$/);
  assert.equal(await stored(), undefined, 'loading defaults must not write settings');

  // Native Claude and OpenAI keep independent official/custom drafts. AITransX
  // uses Chat Completions, so choosing it from Claude changes protocol too.
  for (const provider of ['anthropic', 'openai']) {
    await selectProvider(provider);
    await choose(provider, 'official');
    await fillConnection(provider, `${provider}-official`, true);
    await page.click(`.reveal-key[aria-controls="${provider}-key"]`);
    assert.equal(await page.getAttribute(`#${provider}-key`, 'type'), 'text');
    await choose(provider, 'aitransx');
    assert.equal(await page.inputValue('[name="provider"]:checked'), 'openai', 'AITransX must use its supported OpenAI-compatible protocol');
    assert.equal(await page.inputValue('#openai-service'), 'aitransx');
    assert.equal(await page.inputValue('#openai-key'), '', 'a new service must not inherit the official key');
    assert.equal(await page.getAttribute(`#${provider}-key`, 'type'), 'password', 'switching service must hide a revealed key');
    assert.equal(await page.isChecked('#openai-vision'), false);
    assert.equal(await readOnly('openai'), true);
    const presetUrl = await page.inputValue('#openai-url');
    assert.equal(presetUrl, 'https://api.aitransx.com/v1');
    if (provider === 'anthropic') {
      assert.equal(await page.inputValue('#anthropic-service'), 'official', 'redirecting to AITransX must preserve native Claude selection');
      await selectProvider('anthropic');
      await expectConnection('anthropic', 'anthropic-official', true);
    } else {
      await fillConnection('openai', 'openai-aitransx', false);
      await page.click('#test-connection');
      await page.waitForSelector('#connection-result[data-state="success"]');
      const request = seen.at(-1);
      assert.equal(request.url, `${presetUrl}/chat/completions`);
      assert.equal(request.body.model, 'openai-aitransx-model');
      assert.equal(request.headers.authorization, 'Bearer openai-aitransx-key');
      assert.equal(request.headers['x-api-key'], undefined);
    }
    await choose(provider, 'custom');
    if (provider === 'openai') await page.waitForSelector('#connection-result[data-state="stale"]');
    assert.equal(await page.inputValue(`#${provider}-key`), '', 'custom must not inherit a preset key');
    assert.equal(await readOnly(provider), false);
    await page.fill(`#${provider}-url`, `http://127.0.0.1:37391/${provider}`);
    await fillConnection(provider, `${provider}-custom`, true);
    await choose(provider, 'official');
    await expectConnection(provider, `${provider}-official`, true);
    if (provider === 'openai') {
      await choose(provider, 'aitransx');
      await expectConnection(provider, `${provider}-aitransx`, false);
    }
    await choose(provider, 'custom');
    await expectConnection(provider, `${provider}-custom`, true);
    assert.equal(await page.inputValue(`#${provider}-url`), `http://127.0.0.1:37391/${provider}`);
  }
  assert.equal(await stored(), undefined, 'draft edits and testing must not save settings');
  await save();
  const saved = await stored();
  for (const provider of ['anthropic', 'openai']) {
    assert.equal(saved.connections[provider].selected, 'custom');
    assert.equal(saved[`${provider}ApiKey`], `${provider}-custom-key`, 'active flat fields must match the selected service');
    for (const service of provider === 'anthropic' ? ['official', 'custom'] : ['official', 'aitransx', 'custom']) {
      assert.equal(saved.connections[provider].profiles[service].apiKey, `${provider}-${service}-key`);
      assert.equal(saved.connections[provider].profiles[service].model, `${provider}-${service}-model`);
    }
  }
  await page.reload(); await ready();
  for (const provider of ['anthropic', 'openai']) {
    await selectProvider(provider);
    assert.equal(await page.inputValue(`#${provider}-service`), 'custom');
    await expectConnection(provider, `${provider}-custom`, true);
    await choose(provider, 'official');
    await expectConnection(provider, `${provider}-official`, true);
    if (provider === 'openai') {
      await choose(provider, 'aitransx');
      await expectConnection(provider, `${provider}-aitransx`, false);
    }
  }
  await page.fill('#openai-key', 'discard-this-key');
  await page.click('#discard-changes');
  assert.equal(await page.inputValue('#openai-service'), 'custom');
  assert.equal(await page.inputValue('#anthropic-service'), 'custom');
  assert.equal(await page.isDisabled('#save-button'), true);
  assert.deepEqual(await stored(), saved, 'undo and profile browsing must not overwrite saved settings');
  await choose('openai', 'aitransx');
  await expectConnection('openai', 'openai-aitransx', false);
  await save();
  await page.reload(); await ready();
  assert.equal(await page.inputValue('#openai-service'), 'aitransx', 'the last selected service survives reload');
  await expectConnection('openai', 'openai-aitransx', false);
  await page.fill('#openai-model', 'openai/gpt-6.1-terra');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'tests/service-presets-wide.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'tests/service-presets-narrow.png', fullPage: true, animations: 'disabled' });
  await page.click('#discard-changes');
  await page.setViewportSize({ width: 1000, height: 1100 });

  // Migration classifies old URLs without replacing a working proxy or moving its key.
  const legacy = {
    provider: 'openai', anthropicApiKey: 'legacy-claude-key', anthropicBaseUrl: '', anthropicModel: 'legacy-claude', anthropicVision: true,
    openaiApiKey: 'legacy-proxy-key', openaiBaseUrl: 'https://custom.example.invalid/base/v1', openaiModel: 'legacy-proxy', openaiVision: true,
    effort: 'medium', maxSteps: 40,
  };
  await page.evaluate((settings) => chrome.storage.local.set({ 'tabagent:settings': settings }), legacy);
  await page.reload(); await ready();
  assert.equal(await page.inputValue('#openai-service'), 'custom');
  assert.equal(await page.inputValue('#anthropic-service'), 'official');
  assert.equal(await page.inputValue('#openai-url'), legacy.openaiBaseUrl);
  assert.equal(await page.inputValue('#openai-key'), legacy.openaiApiKey);
  assert.equal(await page.isChecked('#openai-vision'), true);
  assert.deepEqual(await stored(), legacy, 'migration must wait for an explicit save');
  await choose('openai', 'official');
  assert.equal(await page.inputValue('#openai-key'), '', 'legacy custom keys must stay out of official configuration');
  await choose('openai', 'custom');
  assert.equal(await page.inputValue('#openai-key'), legacy.openaiApiKey);
  assert.equal(await page.isDisabled('#save-button'), true, 'switching away and back without edits is not a change');

  // Service controls must fit narrow displays in either theme and at large text sizes.
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const size of [16, 32]) {
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, size);
      await page.setViewportSize({ width: 320, height: 740 });
      for (const provider of ['anthropic', 'openai']) {
        await selectProvider(provider);
        for (const service of provider === 'anthropic' ? ['official', 'custom'] : ['official', 'aitransx', 'custom']) {
          await choose(provider, service);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
            `${provider}/${service} must fit at 320px with ${size}px text in ${colorScheme}`);
          assert.equal(await page.locator(`#${provider}-service`).evaluate((input) => input.getBoundingClientRect().width > 0), true);
        }
      }
    }
  }
  await page.click('#discard-changes');
  console.log('✓ 服务预设：官方默认、独立密钥/模型/图片配置、AITransX 自动选择兼容协议、草稿/保存/撤销、旧配置迁移及窄屏大字布局');
} finally {
  await context?.close();
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-service-presets-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
