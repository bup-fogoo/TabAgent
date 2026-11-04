// Execute the production content/transport code against disposable Chromium pages.
// No model service, extension profile or browser permissions are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';

const compile = (source) => ts.transpileModule(source.replace(/^import[^\n]+\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const content = compile(await fs.readFile(new URL('../entrypoints/content.ts', import.meta.url), 'utf8'));
const tools = compile(await fs.readFile(new URL('../lib/tools.ts', import.meta.url), 'utf8'));
const fixture = `<!doctype html><meta charset="utf-8"><title>动作回归</title>
<button id="button" onclick="document.querySelector('#count').value++">增加一次</button><output id="count">0</output>
<form id="form" action="/submit" onsubmit="event.preventDefault();document.querySelector('#submitted').value++">
<label for="input">名称</label><input id="input" name="name"><button id="submit">提交</button></form><output id="submitted">0</output>
<a id="link" href="/original" onclick="event.preventDefault();document.querySelector('#count').value++">原始链接</a>`;
const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(fixture); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-proxy-server'] });
  page = await browser.newPage();
  const reset = async () => {
    await page.goto(origin);
    await page.addScriptTag({ content: `(() => {
      const CONTENT_MESSAGE_TAG = 'tabagent:content';
      let listener;
      const browser = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
      const defineContentScript = (definition) => definition.main();
      ${content}
      window.pageActions = {
        id: (selector) => idFor(document.querySelector(selector)),
        send: (request) => new Promise((resolve) => listener({ tag: CONTENT_MESSAGE_TAG, request }, {}, resolve)),
        records: () => requests.size,
      };
    })();` });
    await page.addScriptTag({ content: `(() => {
      const CONTENT_MESSAGE_TAG = 'tabagent:content';
      const requiresApproval = (name) => !['list_tabs', 'read_page', 'extract', 'wait'].includes(name);
      window.sentRequests = [];
      const browser = { tabs: {
        get: async () => ({ id: 1, title: document.title, url: location.href, status: 'complete' }),
        sendMessage: async (_tab, message) => {
          window.sentRequests.push(message.request.action);
          const response = window.pageActions.send(message.request);
          window.onPageRequest?.(message.request);
          return response;
        },
      } };
      ${tools}
      window.toolActions = { BrowserContext, withTimeout };
      window.approved = async (selector, action = 'click', extra = {}) => {
        const id = window.pageActions.id(selector);
        const response = await window.pageActions.send({ action: 'describe', id });
        if (!response.ok) throw new Error(response.error);
        return { action, id, guard: response.result.guard, ...extra };
      };
      window.envelope = (request, requestId = crypto.randomUUID(), lifetime = 12000) => ({ ...request, requestId, deadline: Date.now() + lifetime });
    })();` });
  };

  // Exercise the real BrowserContext.content transport: cancel is sent, and its
  // acknowledgement is awaited before the background promise rejects.
  for (const action of ['click', 'type']) {
    await reset();
    const result = await page.evaluate(async (action) => {
      const request = await window.approved(action === 'click' ? '#button' : '#input', action, action === 'type' ? { text: '不应填写' } : {});
      const controller = new AbortController();
      window.onPageRequest = (sent) => { if (sent.action === action) setTimeout(() => controller.abort(), 5); };
      let error;
      try { await new window.toolActions.BrowserContext(1, [1]).content(1, request, controller.signal); }
      catch (caught) { error = caught.name; }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { error, count: document.querySelector('#count').value, value: document.querySelector('#input').value, cancels: window.sentRequests.filter((item) => item === 'cancel').length };
    }, action);
    assert.equal(result.error, 'AbortError');
    assert.equal(result.cancels, 1);
    assert.equal(result.count, '0');
    assert.equal(result.value, '');
  }

  await reset();
  const stoppedSubmit = await page.evaluate(async () => {
    const request = await window.approved('#input', 'type', { text: '已填写', submit: true });
    const controller = new AbortController();
    document.querySelector('#input').addEventListener('input', () => setTimeout(() => controller.abort(), 5), { once: true });
    try { await new window.toolActions.BrowserContext(1, [1]).content(1, request, controller.signal); } catch { /* Expected cancellation. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { value: document.querySelector('#input').value, submitted: document.querySelector('#submitted').value };
  });
  assert.deepEqual(stoppedSubmit, { value: '已填写', submitted: '0' }, '停止不撤销已填写内容，但必须取消尚未发生的提交');

  await reset();
  const timeout = await page.evaluate(async () => {
    const request = window.envelope(await window.approved('#button'));
    let error;
    try {
      await window.toolActions.withTimeout(window.pageActions.send(request), undefined, 5, '测试超时',
        () => window.pageActions.send({ action: 'cancel', requestId: request.requestId }));
    } catch (caught) { error = caught.message; }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { error, count: document.querySelector('#count').value };
  });
  assert.deepEqual(timeout, { error: '测试超时', count: '0' });

  // If the cancellation channel fails, do not announce stopped while the
  // original content request can still finish later. Simulate a delayed page.
  await reset();
  const lostCancellation = await page.evaluate(async () => {
    const nativeTimer = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeTimer(callback, delay === 50 ? 1300 : delay, ...args);
    const originalSend = window.pageActions.send;
    window.pageActions.send = (request) => request.action === 'cancel' ? new Promise(() => {}) : originalSend(request);
    const controller = new AbortController();
    window.onPageRequest = (request) => { if (request.action === 'click') nativeTimer(() => controller.abort(), 5); };
    const request = await window.approved('#button');
    let error;
    try { await new window.toolActions.BrowserContext(1, [1]).content(1, request, controller.signal); }
    catch (caught) { error = caught.name; }
    const whenStopped = document.querySelector('#count').value;
    await new Promise((resolve) => nativeTimer(resolve, 150));
    return { error, whenStopped, afterStopped: document.querySelector('#count').value };
  });
  assert.deepEqual(lostCancellation, { error: 'AbortError', whenStopped: '1', afterStopped: '1' }, '取消确认丢失时，应等待原动作结束或到期，再宣布停止');

  await reset();
  const delivery = await page.evaluate(async () => {
    const before = window.envelope(await window.approved('#button'));
    await window.pageActions.send({ action: 'cancel', requestId: before.requestId });
    const cancelled = await window.pageActions.send(before);
    const request = window.envelope(await window.approved('#button'));
    const first = window.pageActions.send(request);
    const duplicate = await window.pageActions.send(request);
    const completed = await first;
    const replay = await window.pageActions.send(request);
    const expired = await window.pageActions.send(window.envelope(await window.approved('#button'), crypto.randomUUID(), -1));
    const deadline = await window.pageActions.send(window.envelope(await window.approved('#button'), crypto.randomUUID(), 10));
    return { cancelled, duplicate, completed, replay, expired, deadline, count: document.querySelector('#count').value };
  });
  assert.equal(delivery.cancelled.ok, false);
  assert.equal(delivery.duplicate.ok, false);
  assert.equal(delivery.completed.ok, true);
  assert.equal(delivery.replay.ok, false);
  assert.equal(delivery.expired.ok, false);
  assert.equal(delivery.deadline.ok, false);
  assert.equal(delivery.count, '1');

  await reset();
  const cosmetic = await page.evaluate(async () => {
    for (const selector of ['#button', '#input']) document.querySelector(selector).addEventListener('focus', (event) => {
      event.target.classList.add('focused'); event.target.style.outline = '2px solid teal'; event.target.dataset.focused = 'true';
    });
    const click = await window.pageActions.send(window.envelope(await window.approved('#button')));
    const type = await window.pageActions.send(window.envelope(await window.approved('#input', 'type', { text: '正常填写', submit: true })));
    return { click, type, count: document.querySelector('#count').value, submitted: document.querySelector('#submitted').value };
  });
  assert.equal(cosmetic.click.ok, true);
  assert.equal(cosmetic.type.ok, true);
  assert.equal(cosmetic.count, '1');
  assert.equal(cosmetic.submitted, '1', '表单只能提交一次');

  for (const mutation of ['text', 'label', 'href', 'form', 'disabled', 'value']) {
    await reset();
    const changed = await page.evaluate(async (mutation) => {
      const selector = mutation === 'href' ? '#link' : mutation === 'value' ? '#input' : mutation === 'form' ? '#submit' : '#button';
      const request = await window.approved(selector, mutation === 'value' ? 'type' : 'click', { text: '不应覆盖' });
      document.querySelector(selector).addEventListener('focus', (event) => {
        if (mutation === 'text') event.target.textContent = '新操作';
        if (mutation === 'label') event.target.setAttribute('aria-label', '新操作');
        if (mutation === 'href') event.target.href = '/different';
        if (mutation === 'form') document.querySelector('#form').action = '/different';
        if (mutation === 'disabled') event.target.disabled = true;
        if (mutation === 'value') event.target.value = '用户的新值';
      }, { once: true });
      const response = await window.pageActions.send(window.envelope(request));
      return { response, count: document.querySelector('#count').value, submitted: document.querySelector('#submitted').value, value: document.querySelector('#input').value };
    }, mutation);
    assert.equal(changed.response.ok, false, `${mutation} 变化必须重新确认`);
    assert.match(changed.response.error, /变化/);
    assert.equal(changed.count, '0');
    assert.equal(changed.submitted, '0');
    if (mutation === 'value') assert.equal(changed.value, '用户的新值');
  }
  console.log('✓ 动作回归通过：停止/超时取消、提交前取消、取消先到、重复投递、过期、焦点样式兼容、关键语义变化拦截');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
