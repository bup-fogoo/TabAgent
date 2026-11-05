// Legacy stored connections must agree with settings validation and task startup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-readiness-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:/, (route) => route.abort());
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  // No model endpoint may be contacted even if the readiness guard regresses.
  await worker.evaluate(() => {
    globalThis.readinessRequests = [];
    globalThis.fetch = async (input) => {
      globalThis.readinessRequests.push(String(input));
      throw new Error('Network disabled by connection-readiness regression test');
    };
  });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const harness = await context.newPage();
  await harness.goto(`${base}/options.html`);
  await harness.evaluate(() => {
    window.readinessEvents = [];
    window.readinessPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.readinessPort.onMessage.addListener((event) => window.readinessEvents.push(event));
  });
  await harness.waitForFunction(() => window.readinessEvents.some((event) => event.type === 'history'));
  const panel = await context.newPage();
  await panel.goto(`${base}/sidepanel.html`);
  const store = (settings) => harness.evaluate((settings) => chrome.storage.local.set({ 'tabagent:settings': settings }), settings);
  const modelLabel = (expected) => panel.waitForFunction((value) => document.querySelector('#model-name').textContent === value, expected);

  for (const [provider, address, source] of [
    ['openai', 'https://api.openai.com/v1', undefined],
    ['openai', 'https://api.aitransx.com/v1/', undefined],
    ['openai', 'https://api.openai.com/v1', 'custom'],
    ['anthropic', '', undefined],
  ]) {
    const model = `readiness-${provider}-${source ?? 'legacy'}-${address.length}`;
    const configured = { provider, [`${provider}BaseUrl`]: address, [`${provider}ApiKey`]: 'dummy-test-key', [`${provider}Model`]: model };
    if (source) configured.connections = { [provider]: { selected: source, profiles: { custom: {
      apiKey: 'dummy-test-key', baseUrl: address, model, vision: false,
    } } } };
    await store(configured);
    await modelLabel(model);
    assert.equal(await panel.locator('#setup-banner').isHidden(), true);
    const missingKey = structuredClone(configured);
    missingKey[`${provider}ApiKey`] = '';
    if (source) missingKey.connections[provider].profiles.custom.apiKey = '';
    await store(missingKey);
    await modelLabel('连接模型');
    assert.equal(await panel.locator('#setup-banner').isVisible(), true, 'missing required key must reopen setup guidance');

    // Bypass side-panel UI to verify the background independently. The invalid
    // tab ID proves configuration rejection happens before page-scope lookup.
    await harness.evaluate(() => {
      window.readinessEvents = [];
      window.readinessPort.postMessage({ type: 'run', text: 'Readiness regression', mode: 'read-only', tabIds: [-123456] });
    });
    await harness.waitForFunction(() => window.readinessEvents.some((event) => event.type === 'error' && event.message.includes('配置完整')));
    await harness.waitForFunction(() => window.readinessEvents.some((event) => event.type === 'status' && !event.running));
    const events = await harness.evaluate(() => window.readinessEvents);
    assert.equal(events.some((event) => event.type === 'target' || event.type === 'tool'), false);
  }

  await store({ provider: 'openai', openaiBaseUrl: 'http://127.0.0.1:11434/v1', openaiModel: 'local-model', openaiApiKey: '' });
  await modelLabel('local-model');
  assert.equal(await panel.locator('#setup-banner').isHidden(), true, 'custom local servers can remain keyless');
  assert.deepEqual(await worker.evaluate(() => globalThis.readinessRequests), []);
  console.log('✓ 连接就绪：旧官方/AITransX空Key拦截、显式自定义官方地址、后台前置校验与本地免Key兼容');
} finally {
  await context?.close();
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-readiness-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
