// Capture guards use browser API mocks; image decoding/resizing uses real Chromium codecs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = await fs.readFile(new URL('../lib/vision.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const chromiumBrowser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await chromiumBrowser.newPage();
  await page.addScriptTag({ content: `(() => {
    const event = () => {
      const listeners = new Set();
      return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (...args) => { for (const listener of [...listeners]) listener(...args); }, size: () => listeners.size };
    };
    const events = { activated: event(), updated: event(), removed: event(), focused: event() };
    const canvas = document.createElement('canvas');
    canvas.width = 3200; canvas.height = 1800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e8f3ee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#17745d'; ctx.font = '120px sans-serif'; ctx.fillText('Screenshot evidence', 120, 240);
    const original = canvas.toDataURL('image/png');
    const state = { tab: {}, focused: true, captures: [], capture: async () => original, activeIds: [1] };
    const browser = { tabs: {
      get: async () => ({ ...state.tab }),
      query: async () => state.activeIds.map((id) => ({ id })),
      captureVisibleTab: async (windowId, options) => { state.captures.push({ at: performance.now(), windowId, options }); return state.capture(); },
      onActivated: events.activated, onUpdated: events.updated, onRemoved: events.removed,
    }, windows: { get: async () => ({ id: 10, focused: state.focused }), onFocusChanged: events.focused } };
    ${compiled}
    window.visionHarness = { state, events, original, capturePageScreenshot,
      countListeners: () => Object.values(events).reduce((sum, entry) => sum + entry.size(), 0),
      reset: () => {
        nextCaptureAt = 0;
        state.tab = { id: 1, windowId: 10, active: true, title: '图片测试', url: 'https://example.com/article', status: 'complete' };
        state.focused = true; state.activeIds = [1]; state.captures = []; state.capture = async () => original;
      },
    };
  })();` });

  const success = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    const result = await h.capturePageScreenshot(1, new AbortController().signal);
    const decoded = await createImageBitmap(await (await fetch(`data:${result.image.mediaType};base64,${result.image.data}`)).blob());
    const dimensions = [decoded.width, decoded.height]; decoded.close();
    return { width: result.image.width, height: result.image.height, mediaType: result.image.mediaType, bytes: atob(result.image.data).length, dimensions, title: result.title, url: result.url, captures: h.state.captures, listeners: h.countListeners() };
  });
  assert.deepEqual([success.width, success.height], [1600, 900]);
  assert.deepEqual(success.dimensions, [1600, 900]);
  assert.equal(success.mediaType, 'image/jpeg');
  assert.ok(success.bytes > 0 && success.bytes <= 1024 * 1024);
  assert.equal(success.url, 'https://example.com/article');
  assert.equal(success.title, '图片测试');
  assert.deepEqual(success.captures.map(({ windowId, options }) => ({ windowId, options })), [{ windowId: 10, options: { format: 'jpeg', quality: 80 } }]);
  assert.equal(success.listeners, 0);

  const noisy = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(1600, 1600);
    for (let offset = 0; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
    for (let offset = 3; offset < pixels.data.length; offset += 4) pixels.data[offset] = 255;
    ctx.putImageData(pixels, 0, 0);
    h.state.capture = async () => canvas.toDataURL('image/png');
    const result = await h.capturePageScreenshot(1, new AbortController().signal);
    return { bytes: atob(result.image.data).length, width: result.image.width, height: result.image.height, listeners: h.countListeners() };
  });
  assert.ok(noisy.bytes <= 1024 * 1024);
  assert.ok(noisy.width < 1600 && noisy.height < 1600, 'large noisy images should trigger extra downscaling');
  assert.equal(noisy.listeners, 0);

  for (const scenario of ['inactive', 'not-focused', 'loading', 'pending-navigation', 'restricted', 'internal', 'file', 'credentials', 'multiple-active']) {
    const result = await page.evaluate(async (scenario) => {
      const h = window.visionHarness; h.reset();
      if (scenario === 'inactive') h.state.tab.active = false;
      if (scenario === 'not-focused') h.state.focused = false;
      if (scenario === 'loading') h.state.tab.status = 'loading';
      if (scenario === 'pending-navigation') h.state.tab.pendingUrl = 'https://other.example/';
      if (scenario === 'restricted') h.state.tab.url = 'https://chromewebstore.google.com/detail/extension';
      if (scenario === 'internal') h.state.tab.url = 'chrome://settings/';
      if (scenario === 'file') h.state.tab.url = 'file:///private/document.html';
      if (scenario === 'credentials') h.state.tab.url = 'https://private:secret@example.com/';
      if (scenario === 'multiple-active') h.state.activeIds = [1, 2];
      let error = '';
      try { await h.capturePageScreenshot(1, new AbortController().signal); } catch (caught) { error = caught.message; }
      return { error, captures: h.state.captures.length, listeners: h.countListeners() };
    }, scenario);
    assert.ok(result.error, `${scenario}: must be rejected`);
    assert.equal(result.captures, 0, `${scenario}: must not capture another page`);
    assert.equal(result.listeners, 0, `${scenario}: listeners must be released`);
  }

  for (const scenario of ['tab-switch-and-back', 'same-url-reload', 'window-focus', 'closed', 'changed-url-without-event', 'moved-window']) {
    const result = await page.evaluate(async (scenario) => {
      const h = window.visionHarness; h.reset();
      h.state.capture = async () => {
        if (scenario === 'tab-switch-and-back') { h.events.activated.emit({ tabId: 2, windowId: 10 }); h.events.activated.emit({ tabId: 1, windowId: 10 }); }
        if (scenario === 'same-url-reload') { h.events.updated.emit(1, { status: 'loading' }); h.events.updated.emit(1, { status: 'complete' }); }
        if (scenario === 'window-focus') { h.events.focused.emit(11); h.events.focused.emit(10); }
        if (scenario === 'closed') h.events.removed.emit(1);
        if (scenario === 'changed-url-without-event') h.state.tab.url = 'https://other.example/';
        if (scenario === 'moved-window') h.state.tab.windowId = 11;
        return h.original;
      };
      let error = '';
      try { await h.capturePageScreenshot(1, new AbortController().signal); } catch (caught) { error = caught.message; }
      return { error, captures: h.state.captures.length, listeners: h.countListeners() };
    }, scenario);
    assert.ok(result.error, `${scenario}: captured bytes must be discarded`);
    assert.equal(result.captures, 1);
    assert.equal(result.listeners, 0);
  }

  const late = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    const controller = new AbortController();
    let release;
    h.state.capture = () => new Promise((resolve) => { release = resolve; });
    const work = h.capturePageScreenshot(1, controller.signal).catch((error) => error.name);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    const name = await work;
    release(h.original);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { name, listeners: h.countListeners() };
  });
  assert.equal(late.name, 'AbortError');
  assert.equal(late.listeners, 0);

  const decoding = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    const controller = new AbortController();
    const nativeBitmap = window.createImageBitmap;
    let release; let closed = false;
    window.createImageBitmap = async (...args) => {
      const bitmap = await nativeBitmap(...args);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { closed = true; close(); };
      await new Promise((resolve) => { release = resolve; });
      return bitmap;
    };
    try {
      const work = h.capturePageScreenshot(1, controller.signal).catch((error) => error.name);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.abort(); const name = await work; release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { name, closed, listeners: h.countListeners() };
    } finally { window.createImageBitmap = nativeBitmap; }
  });
  assert.equal(decoding.name, 'AbortError');
  assert.equal(decoding.closed, true, 'late decoded bitmap must be released after cancellation');
  assert.equal(decoding.listeners, 0);

  const spacing = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    await Promise.all([h.capturePageScreenshot(1, new AbortController().signal), h.capturePageScreenshot(1, new AbortController().signal)]);
    return { delay: h.state.captures[1].at - h.state.captures[0].at, listeners: h.countListeners() };
  });
  assert.ok(spacing.delay >= 550, `captures should be spaced to respect browser quota, got ${spacing.delay}`);
  assert.equal(spacing.listeners, 0);

  const timeout = await page.evaluate(async () => {
    const h = window.visionHarness; h.reset();
    h.state.capture = () => new Promise(() => {});
    const started = performance.now(); let error = '';
    try { await h.capturePageScreenshot(1, new AbortController().signal); } catch (caught) { error = caught.message; }
    return { error, duration: performance.now() - started, listeners: h.countListeners() };
  });
  assert.match(timeout.error, /超时/);
  assert.ok(timeout.duration < 14000, 'hung browser capture must have a deadline');
  assert.equal(timeout.listeners, 0);
  console.log('✓ 截图回归：真实压缩、尺寸/体积限制、可见页面校验、切页/重载/失焦丢弃、取消与资源释放、限频和超时');
} finally { await chromiumBrowser.close(); }
