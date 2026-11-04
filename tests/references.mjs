// Real Chromium/local HTTP/model regressions for temporary research tabs and
// persisted sources. Every final model response is gated so user edits/keep/
// pin/navigation happen before the application decides what may be closed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const gates = new Map();
const responses = new Set();
const modelErrors = [];
const modelRequests = [];
let origin;
let originalId;
let callId = 0;
const articleUrl = (scenario) => `${origin}/article?scenario=${scenario}`;
const searchUrl = (scenario) => `${origin}/serp?scenario=${scenario}`;
const call = (name, input) => ({ role: 'assistant', content: null, tool_calls: [{ id: `reference-${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const answer = (text) => ({ role: 'assistant', content: text });
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><meta charset="utf-8">${body}`); };
const server = http.createServer((req, res) => {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  const url = new URL(req.url, origin);
  if (url.pathname !== '/v1/chat/completions') {
    const scenario = url.searchParams.get('scenario');
    if (url.pathname === '/serp') html(res, `<title>检索页 ${scenario}</title><main><h2><a href="${articleUrl(scenario)}">原文 ${scenario}</a></h2><p>SEARCH_BODY_${scenario} 供实际阅读的检索摘要。</p><h2><a href="${origin}/not-read?scenario=${scenario}">没有打开的候选结果</a></h2></main>`);
    else if (url.pathname === '/article') html(res, `<title>原文 ${scenario}</title><main><h1>参考原文</h1><p>ARTICLE_BODY_${scenario} 这是读取后的来源，不是仅看到的搜索候选。</p><label>笔记<input id="notes" autocomplete="off"></label></main>`);
    else html(res, `<title>${url.pathname === '/original' ? '原来的网页' : '用户保留的页面'}</title><main>EXISTING_PAGE_BODY 页面应由用户管理，不属于任务临时检索页。</main>`);
    return;
  }
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    const reply = (message) => {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    };
    try {
      const body = JSON.parse(raw); modelRequests.push(body);
      const user = body.messages.map((item) => item.role).lastIndexOf('user');
      const scenario = body.messages[user].content.split('\n')[0];
      const results = body.messages.slice(user + 1).filter((item) => item.role === 'tool');
      const last = results.at(-1)?.content ?? '';
      if (!results.length) {
        reply(scenario === 'ordinary-open' ? call('open_tab', { url: articleUrl(scenario) }) : call('search_web', { query: scenario }));
        return;
      }
      if (scenario === 'failed-search') assert.ok(/网络|无法连接|加载失败|无法访问|错误页/.test(last), last);
      else if (scenario === 'ordinary-open') {
        if (results.length === 1) { reply(call('read_page', { text_only: true })); return; }
        assert.ok(last.includes(`ARTICLE_BODY_${scenario}`), last);
      } else if (results.length === 1) {
        assert.ok(last.includes(`SEARCH_BODY_${scenario}`), last);
        reply(call('open_search_result', { url: articleUrl(scenario) })); return;
      } else if (results.length === 2) {
        assert.ok(last.includes(`ARTICLE_BODY_${scenario}`), last);
        reply(call('read_page', { text_only: true })); return;
      } else assert.ok(last.includes(`ARTICLE_BODY_${scenario}`), last);
      responses.add(res); res.on('close', () => responses.delete(res));
      gates.set(scenario, () => { gates.delete(scenario); reply(answer(`${scenario} complete`)); });
    } catch (error) {
      modelErrors.push(error.message); reply(answer(`MOCK_ASSERTION_FAILED: ${error.message}`));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-references-'));
let context;
let harness;
let panel;
let base;
let failed = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await wait(40); } while (Date.now() < deadline);
  throw new Error(label);
};
const events = () => harness.evaluate(() => window.events);
const send = (request) => harness.evaluate((value) => window.port.postMessage(value), request);
const tabs = () => harness.evaluate(() => chrome.tabs.query({}));
const activate = (id) => harness.evaluate((id) => chrome.tabs.update(id, { active: true }), id);
const activeId = () => harness.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }))[0]?.id);
const getTab = async (url) => (await tabs()).find((tab) => tab.url === url);
const reset = async () => {
  await harness.evaluate(() => { window.events = []; }); await send({ type: 'reset' });
  await until(async () => (await events()).some((item) => item.type === 'history'), '会话重置没有完成');
  await harness.evaluate(() => { window.events = []; });
};
const begin = async (scenario) => {
  await reset(); await activate(originalId);
  await send({ type: 'run', text: scenario, mode: scenario === 'ordinary-open' ? 'confirm' : 'read-only', tabIds: [originalId] });
  if (scenario === 'ordinary-open') {
    await until(async () => (await events()).some((item) => item.type === 'approval' && item.request), '新建普通标签页缺少审批');
    const approval = (await events()).findLast((item) => item.type === 'approval' && item.request).request;
    await send({ type: 'approve', id: approval.id, approved: true });
  }
  await until(() => gates.has(scenario) || modelErrors.length, `没有等待 ${scenario} 的最终回复`);
  assert.deepEqual(modelErrors, []);
  return (await events()).filter((item) => item.type === 'target');
};
const finish = async (scenario) => {
  assert.ok(gates.has(scenario)); gates.get(scenario)();
  await until(async () => (await events()).some((item) => item.type === 'status' && !item.running), `${scenario} 没有结束`);
  assert.deepEqual(modelErrors, []);
  const log = await events();
  assert.ok(log.some((item) => item.type === 'assistant' && item.text === `${scenario} complete`));
  assert.ok(!log.some((item) => item.type === 'error'), JSON.stringify(log.filter((item) => item.type === 'error')));
  assert.ok((await tabs()).some((tab) => tab.id === originalId), '已有页面始终保留');
  return log;
};
const archive = () => harness.evaluate(async () => {
  const index = (await chrome.storage.local.get('tabagent:conversations:v2'))['tabagent:conversations:v2'];
  return (await chrome.storage.local.get(`tabagent:conversation:${index.activeId}`))[`tabagent:conversation:${index.activeId}`];
});
const sourceEvent = (log) => log.filter((item) => item.type === 'sources').at(-1);
const assertSources = (source, scenario) => {
  assert.ok(source?.taskId);
  assert.equal(source.pages.length, 2, '重复读取去重，未打开的候选不作为已读参考');
  assert.deepEqual(new Set(source.pages.map((item) => item.url)), new Set([searchUrl(scenario), articleUrl(scenario)]));
  assert.equal(source.pages.find((item) => item.url === searchUrl(scenario)).kind, 'search');
  assert.equal(source.pages.find((item) => item.url === articleUrl(scenario)).kind, 'page');
  assert.ok(source.pages.every((item) => item.id && item.title));
};
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.bing.com' && url.pathname === '/search') {
      if (url.searchParams.get('q') === 'failed-search') await route.abort('connectionrefused');
      else await route.fulfill({ status: 302, headers: { location: searchUrl(url.searchParams.get('q')) }, body: '' });
    } else if (url.origin === origin || ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(url.protocol)) await route.continue();
    else await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  base = `chrome-extension://${new URL(worker.url()).host}`;
  harness = await context.newPage(); await harness.goto(`${base}/options.html`);
  await harness.evaluate(async (url) => {
    await chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiApiKey: 'fake', openaiModel: 'mock', openaiBaseUrl: `${url}/v1`, maxSteps: 8 } });
    window.events = []; window.port = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.port.onMessage.addListener((item) => window.events.push(item));
  }, origin);
  await until(async () => (await events()).some((item) => item.type === 'history'), '后台连接失败');
  const original = await context.newPage(); await original.goto(`${origin}/original`);
  originalId = (await getTab(`${origin}/original`)).id;
  panel = await context.newPage(); await panel.setViewportSize({ width: 320, height: 740 }); await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForSelector('#follow-pages:enabled');

  const firstTargets = await begin('basic');
  const firstCreated = [...new Set(firstTargets.filter((item) => item.temporary).map((item) => item.tabId))];
  assert.equal(firstCreated.length, 2);
  const sourceBeforeClose = sourceEvent(await events()); assertSources(sourceBeforeClose, 'basic');
  const firstLog = await finish('basic');
  assert.ok((await tabs()).every((tab) => !firstCreated.includes(tab.id)), '成功任务的SERP和原文临时页应关闭');
  assert.equal(await activeId(), originalId, '完成后回到任务前的原页面');
  const sources = sourceEvent(firstLog); assertSources(sources, 'basic');
  const saved = await archive();
  assert.equal(saved.events.filter((item) => item.type === 'sources' && item.taskId === sources.taskId).length, 1, '历史只保留每轮来源的最新版本');
  assertSources(sourceEvent(saved.events), 'basic');
  const exportSource = await fs.readFile(new URL('../lib/export.ts', import.meta.url), 'utf8');
  const referenceSource = await fs.readFile(new URL('../lib/references.ts', import.meta.url), 'utf8');
  const compiledExport = ts.transpileModule((referenceSource + '\n' + exportSource).replace(/^import[^\n]+\n/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { serializeConversation } = await import(`data:text/javascript;base64,${Buffer.from(compiledExport).toString('base64')}`);
  for (const format of ['json', 'markdown']) {
    const exported = serializeConversation(saved.id, saved.title, saved.state, saved.events, format);
    assert.ok(exported.includes(articleUrl('basic')), `${format}导出必须保留引用来源`);
    assert.ok(exported.includes(searchUrl('basic')));
  }
  await panel.reload();
  const card = panel.locator(`.reference-pages[data-task-id="${sources.taskId}"]`);
  await card.waitFor(); assert.equal(await card.count(), 1);
  await card.locator('summary').click();
  assert.equal(await card.locator('.reference-page').count(), 2);
  const sourceId = sources.pages.find((item) => item.url === articleUrl('basic')).id;
  await card.locator(`[data-source-id="${sourceId}"]`).click();
  await until(async () => !!await getTab(articleUrl('basic')), '单项来源未重新打开');
  await card.locator('.reference-open-all').click();
  await until(async () => !!await getTab(searchUrl('basic')), '全部来源未恢复检索页');
  const countBeforeInvalid = (await tabs()).length;
  await send({ type: 'sources_open', taskId: sources.taskId, sourceIds: ['javascript:alert(1)', 'unknown-source'] });
  await wait(150);
  assert.equal((await tabs()).length, countBeforeInvalid, '未知来源ID不能打开任意地址');
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await panel.setViewportSize({ width: 320, height: 480 });
  await panel.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '来源卡在大字号窄屏不能横向溢出');
  await panel.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await panel.setViewportSize({ width: 320, height: 740 });
  console.log('✓ 自动清理与来源：回到原页、已读去重、候选排除、历史/导出保存、单个及全部重开');

  for (const scenario of ['kept', 'edited', 'pinned', 'navigated']) {
    const targets = await begin(scenario);
    const article = targets.findLast((item) => item.action === 'open_search_result');
    const search = targets.find((item) => item.action === 'search_web');
    assert.ok(article.temporary && search.temporary);
    if (scenario === 'kept') {
      await panel.waitForSelector('#keep-page:visible'); await panel.locator('#keep-page').click();
      await until(async () => (await events()).some((item) => item.type === 'target' && item.tabId === article.tabId && item.kept), '保留按钮没有生效');
    } else if (scenario === 'edited') {
      const page = context.pages().find((page) => page.url() === articleUrl(scenario));
      assert.ok(page); await page.locator('#notes').fill('用户的未提交内容');
    } else if (scenario === 'pinned') await harness.evaluate((id) => chrome.tabs.update(id, { pinned: true }), article.tabId);
    else {
      const page = context.pages().find((page) => page.url() === articleUrl(scenario));
      await page.goto(`${origin}/user-navigation`);
    }
    await finish(scenario);
    const remaining = await tabs();
    assert.ok(remaining.some((tab) => tab.id === article.tabId), `${scenario}页面必须保留`);
    assert.ok(!remaining.some((tab) => tab.id === search.tabId), `${scenario}不应妨碍清理其它安全临时页`);
    if (scenario === 'edited') assert.equal(await context.pages().find((page) => page.url() === articleUrl(scenario)).inputValue('#notes'), '用户的未提交内容');
  }
  console.log('✓ 保护用户页面：显式保留、真实输入、固定标签页、用户导航都不会被清理');

  await begin('ordinary-open');
  const ordinary = await getTab(articleUrl('ordinary-open'));
  await finish('ordinary-open');
  assert.ok((await tabs()).some((tab) => tab.id === ordinary.id), '用户批准的普通open_tab不是临时检索页');
  const failedTargets = await begin('failed-search');
  const failedTab = failedTargets.find((item) => item.action === 'search_web');
  await finish('failed-search');
  assert.ok((await tabs()).some((tab) => tab.id === failedTab.tabId), '网络错误检索页应保留供检查');
  assert.ok(!sourceEvent(await events())?.pages.length, '未读取的失败页不能当作引用来源');

  await panel.locator('#context-picker').click();
  await panel.locator('#auto-close-pages').uncheck();
  await until(async () => await harness.evaluate(async () => (await chrome.storage.local.get('tabagent:auto-close-pages'))['tabagent:auto-close-pages']) === false, '自动清理偏好未保存');
  await panel.locator('#close-scope').click();
  const disabledTargets = await begin('cleanup-off'); await finish('cleanup-off');
  const disabledIds = [...new Set(disabledTargets.filter((item) => item.temporary).map((item) => item.tabId))];
  assert.equal(disabledIds.length, 2);
  const disabledTabs = await tabs(); assert.ok(disabledIds.every((id) => disabledTabs.some((tab) => tab.id === id)));
  await harness.evaluate(() => chrome.storage.local.set({ 'tabagent:auto-close-pages': true }));

  const stoppedTargets = await begin('stopped');
  const stoppedIds = [...new Set(stoppedTargets.filter((item) => item.temporary).map((item) => item.tabId))];
  const modelCount = modelRequests.length;
  await send({ type: 'stop' });
  await until(async () => (await events()).some((item) => item.type === 'status' && !item.running), '停止没有结束');
  await activate(originalId); gates.get('stopped')(); await wait(400);
  const stoppedTabs = await tabs();
  assert.ok(stoppedIds.every((id) => stoppedTabs.some((tab) => tab.id === id)), '停止后保留已读页面，不迟到关闭');
  assert.equal(await activeId(), originalId);
  assert.equal(modelRequests.length, modelCount);
  assert.deepEqual(modelErrors, []);
  console.log('✓ 普通新页/错误页保留；关闭自动清理生效；停止后不迟关、不重放');
} catch (error) {
  failed = true; console.error('✗ 参考页面回归失败:', error);
  if (harness && !harness.isClosed()) console.error('事件:', (await events()).filter((item) => ['target', 'sources', 'tool_result', 'error', 'notice'].includes(item.type)));
} finally {
  await context?.close();
  for (const res of responses) res.destroy();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tabagent-references-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
