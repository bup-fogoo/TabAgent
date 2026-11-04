// Real extension + local model stubs: optional vision, scoped screenshots and no image persistence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let scenario = '';
let outsideId;
let allowedId;
let serial = 0;
let requests = [];
let serverFailure;
const imageParts = (body) => body.messages.flatMap((message) => Array.isArray(message.content)
  ? message.content.flatMap((block) => block.type === 'image_url' ? [block.image_url.url]
    : block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter((part) => part.type === 'image').map((part) => `data:${part.source.media_type};base64,${part.source.data}`) : []) : []);
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') {
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>本地图片识别样例</title><h1>季度销售图</h1><canvas id="chart" width="1200" height="700"></canvas><script>const ctx=document.getElementById("chart").getContext("2d");ctx.fillStyle="#17745d";ctx.fillRect(20,180,180,420);ctx.fillStyle="#d78b42";ctx.fillRect(230,80,180,520);ctx.fillStyle="#24342e";ctx.font="32px sans-serif";ctx.fillText("Q1",70,650);ctx.fillText("Q2",280,650);</script>');
    return;
  }
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    try {
      const body = JSON.parse(raw);
      requests.push(body);
      const native = req.url.startsWith('/anthropic/');
      const latestGoal = body.messages.findLastIndex((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(scenario));
      assert.ok(latestGoal >= 0, 'actual user goal remains present');
      const results = body.messages.slice(latestGoal + 1).flatMap((message) => message.role === 'tool' ? [message.content]
        : Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result').map((block) => typeof block.content === 'string' ? block.content : block.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')) : []);
      const visionOff = scenario === 'vision-disabled';
      assert.equal(body.tools.some((tool) => (tool.function?.name ?? tool.name) === 'capture_page'), !visionOff);
      let calls = [];
      let answer = '';
      if (!results.length) {
        if (scenario === 'text-only') answer = '文字任务完成';
        else {
          const input = { tab_id: scenario === 'outside-scope' ? outsideId : allowedId };
          calls = Array.from({ length: scenario === 'capture-limit' ? 3 : 1 }, () => ({ id: `vision_${++serial}`, name: 'capture_page', input }));
          if (scenario === 'openai-image' || scenario === 'anthropic-image') calls.unshift({ id: `vision_${++serial}`, name: 'read_page', input: { tab_id: allowedId, text_only: true } });
        }
      } else {
        const images = imageParts(body);
        if (visionOff) { assert.ok(results.some((text) => text.includes('未开启图片识别'))); assert.equal(images.length, 0); }
        else if (scenario === 'outside-scope') { assert.ok(results.some((text) => text.includes('不在本次任务范围'))); assert.equal(images.length, 0); }
        else if (scenario === 'inactive-page') { assert.equal(images.length, 0); assert.ok(results.some((text) => /切换|当前|可见|激活/.test(text))); }
        else {
          assert.equal(images.length, scenario === 'capture-limit' ? 2 : 1);
          for (const image of images) {
            assert.ok(image.startsWith('data:image/jpeg;base64,'));
            assert.ok(image.length > 1000, 'a real browser screenshot was sent');
            assert.ok(image.length < 1_400_000, 'screenshot compression limit');
          }
          if (scenario === 'capture-limit') assert.ok(results.some((text) => text.includes('两张')));
          if (!native) {
            const imageIndex = body.messages.findIndex((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
            const lastResult = body.messages.findLastIndex((message) => message.role === 'tool');
            assert.ok(imageIndex > lastResult, 'image evidence comes after all tool results');
          }
        }
        answer = `${scenario} 完成`;
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(native ? {
        id: `msg_${++serial}`, type: 'message', role: 'assistant', model: body.model,
        stop_reason: calls.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: calls.length ? calls.map((call) => ({ type: 'tool_use', ...call })) : [{ type: 'text', text: answer }],
      } : { choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: calls.length ? {
        role: 'assistant', content: null, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })),
      } : { role: 'assistant', content: answer } }] }));
    } catch (error) {
      serverFailure = error;
      res.writeHead(500, cors); res.end('Local assertion failed');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-vision-test-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const allowed = await context.newPage(); await allowed.setViewportSize({ width: 1920, height: 1080 }); await allowed.goto(`${origin}/allowed`);
  const outside = await context.newPage(); await outside.goto(`${origin}/outside`);
  const tabs = await harness.evaluate(async () => chrome.tabs.query({}));
  allowedId = tabs.find((tab) => tab.url === `${origin}/allowed`).id;
  outsideId = tabs.find((tab) => tab.url === `${origin}/outside`).id;
  await harness.evaluate(() => {
    window.visionEvents = [];
    window.visionPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.visionPort.onMessage.addListener((event) => window.visionEvents.push(event));
  });
  await harness.waitForFunction(() => window.visionEvents.some((event) => event.type === 'history'));
  const run = async (name, provider = 'openai', active = allowed) => {
    scenario = name; requests = []; serverFailure = undefined;
    const settings = { provider, openaiBaseUrl: `${origin}/openai/v1`, openaiModel: name, openaiApiKey: 'fake', openaiVision: name !== 'vision-disabled',
      anthropicBaseUrl: `${origin}/anthropic`, anthropicModel: name, anthropicApiKey: 'fake', anthropicVision: true, effort: 'medium', maxSteps: 5 };
    await harness.evaluate(async (settings) => chrome.storage.local.set({ 'tabagent:settings': settings, 'tabagent:follow-pages': false }), settings);
    await active.bringToFront();
    await harness.evaluate(({ name, tabId }) => {
      window.visionEvents = [];
      window.visionPort.postMessage({ type: 'run', text: name, mode: 'read-only', tabIds: [tabId] });
    }, { name, tabId: allowedId });
    await harness.waitForFunction(() => window.visionEvents.some((event) => event.type === 'user') && window.visionEvents.some((event) => event.type === 'status' && !event.running), null, { polling: 100, timeout: 20000 });
    if (serverFailure) throw serverFailure;
    const events = await harness.evaluate(() => window.visionEvents);
    assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events.filter((event) => event.type === 'error')));
    assert.ok(events.some((event) => event.type === 'assistant' && event.text.endsWith('完成')));
    assert.equal(events.some((event) => event.type === 'approval' && event.request), false, 'vision works in read-only mode');
    const archive = await harness.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    assert.ok(!archive.includes('data:image/') && !archive.includes('"base64"'), 'screenshot bytes must never enter persisted history');
    return events;
  };
  await run('vision-disabled');
  await run('openai-image');
  // Validate the received screenshot can decode and was bounded to the capture size.
  const dataUrl = requests.flatMap(imageParts)[0];
  const dimensions = await harness.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const dimensions = [bitmap.width, bitmap.height]; bitmap.close(); return dimensions;
  }, dataUrl);
  assert.ok(Math.max(...dimensions) <= 1600 && Math.min(...dimensions) > 0);
  await run('text-only'); assert.equal(requests.flatMap(imageParts).length, 0, 'a new task must not replay images');
  await run('anthropic-image', 'anthropic');
  await run('outside-scope');
  await run('inactive-page', 'openai', outside);
  await run('capture-limit');
  console.log('✓ 图片识别：双接口真实截图传输、尺寸压缩、默认关闭、任务范围、非当前页拦截、截图上限与不持久化');
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('tabagent-vision-test-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
