// Real-extension search regressions. All search and model responses are local fixtures.
// Build first: node node_modules/wxt/bin/wxt.mjs build && node tests/search.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const query = 'AITransX 图片识别 + C++ & x=1/中文?#';
const modelRequests = [];
const mockErrors = [];
const pageRequests = [];
const searches = [];
let callNumber = 0;
let outsideTabId;
let articleUrl;
let origin;
const toolCall = (name, input) => ({ content: null, tool_calls: [{ id: `search_${++callNumber}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const done = (content = '搜索验证完成') => ({ content });
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/v1/chat/completions') {
    pageRequests.push(req.url);
    const pathname = new URL(req.url, origin).pathname;
    const body = pathname === '/secret'
      ? '<title>不在范围的秘密页面</title><main>PRIVATE_OUTSIDE_CONTENT</main>'
      : pathname === '/article'
        ? '<meta charset="utf-8"><title>AITransX 使用文档</title><main><h1>AITransX 图片识别</h1><p>ARTICLE_RESEARCH_BODY 已核对的网页正文。</p></main>'
        : '<meta charset="utf-8"><title>原来的工作页面</title><main><button id="increment" onclick="document.querySelector(\'#count\').textContent=String(+document.querySelector(\'#count\').textContent+1)">增加一次</button><output id="count">0</output></main>';
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end(body); return;
  }
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    let reply;
    try {
      const body = JSON.parse(raw);
      modelRequests.push(body);
      const messages = body.messages;
      const current = messages.filter((message) => message.role === 'user').at(-1).content;
      const lastUser = messages.map((message) => message.role).lastIndexOf('user');
      const toolMessages = messages.slice(lastUser + 1).filter((message) => message.role === 'tool');
      const lastTool = toolMessages.at(-1)?.content ?? '';
      const step = toolMessages.length;
      if (current.startsWith('新标签搜索')) {
        if (!step) {
          const definitions = new Map(body.tools.map((tool) => [tool.function.name, tool.function]));
          assert.ok(definitions.has('search_web') && definitions.has('open_search_result'), '只读模型必须获得搜索工具');
          assert.equal(definitions.has('click'), false);
          assert.deepEqual(definitions.get('search_web').parameters.required, ['query']);
          assert.deepEqual(definitions.get('search_web').parameters.properties.engine.enum, ['bing', 'google', 'baidu']);
          assert.deepEqual(definitions.get('open_search_result').parameters.required, ['url']);
          reply = toolCall('search_web', { query });
        } else if (step === 1) {
          assert.ok(lastTool.includes('SERP_FIXTURE_CONTENT'), '搜索应返回页面正文');
          assert.ok(lastTool.includes(articleUrl), '完整搜索链接不得因长度被截断');
          reply = toolCall('read_page', { tab_id: outsideTabId });
        } else if (step === 2) {
          assert.ok(lastTool.includes('不在本次任务范围'));
          reply = toolCall('list_tabs', {});
        } else if (step === 3) {
          assert.ok(lastTool.includes('搜索结果'));
          assert.ok(!lastTool.includes('秘密页面'));
          assert.ok(!lastTool.includes('原来的工作页面'));
          reply = toolCall('open_search_result', { url: articleUrl });
        } else if (step === 4) {
          assert.ok(lastTool.includes('ARTICLE_RESEARCH_BODY'), '打开搜索结果应直接返回正文');
          assert.ok(lastTool.includes(articleUrl), '正文应附完整来源');
          reply = toolCall('read_page', { text_only: true });
        } else {
          assert.ok(lastTool.includes('ARTICLE_RESEARCH_BODY'));
          assert.ok(lastTool.includes(articleUrl));
          reply = done('已读取搜索结果正文和来源');
        }
      } else if (current.startsWith('扩展页搜索') || current.startsWith('普通页搜索')) {
        if (!step) reply = toolCall('search_web', { query, engine: current.startsWith('扩展页搜索') ? 'google' : 'baidu' });
        else { assert.ok(lastTool.includes(articleUrl)); reply = done(); }
      } else if (current.startsWith('非法链接')) {
        const calls = [
          ['search_web', { query: 'allowlist-fixture' }],
          ['open_search_result', { url: `${origin}/unreturned` }],
          ['open_search_result', { url: 'javascript:alert(1)' }],
          ['open_search_result', { url: 'data:text/html,unsafe' }],
          ['open_search_result', { url: 'chrome://settings/' }],
        ];
        reply = step < calls.length ? toolCall(...calls[step]) : done();
      } else if (current.startsWith('上一轮链接')) {
        reply = !step ? toolCall('open_search_result', { url: articleUrl }) : done();
      } else if (current.startsWith('非法搜索参数')) {
        const calls = [
          ['search_web', { query: '' }],
          ['search_web', { query: ' '.repeat(3) }],
          ['search_web', { query: 'x'.repeat(501) }],
          ['search_web', { query: 'fixture', engine: 'unknown' }],
          ['search_web', { query: 'fixture', tab_id: outsideTabId }],
          ['search_web', { query: 'fixture', background: false }],
        ];
        reply = step < calls.length ? toolCall(...calls[step]) : done();
      } else if (current.startsWith('检索页面上限')) {
        reply = step < 9 ? toolCall('search_web', { query: `limit-fixture-${step}` }) : done();
      } else if (current.startsWith('只读点击')) {
        assert.equal(body.tools.some((tool) => tool.function.name === 'click'), false);
        reply = toolCall('click', { element_id: 1 });
      } else if (current.startsWith('加载中停止')) {
        reply = !step ? toolCall('search_web', { query: 'stop-fixture' }) : toolCall('open_search_result', { url: articleUrl });
      } else throw new Error(`Unexpected scenario: ${current}`);
    } catch (error) {
      mockErrors.push(error);
      reply = done(`MOCK_ASSERTION_FAILED: ${error.message}`);
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...reply }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
articleUrl = `${origin}/article?source=search&long=${'complete-link-'.repeat(16)}&query=${encodeURIComponent('图片识别 + 中文')}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-search-'));
const extensionPath = path.resolve('.output/chrome-mv3');
let context;
let harness;
let base;
let releaseSlow;
let reportSlow;
const slowRequested = new Promise((resolve) => { reportSlow = resolve; });
const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const searchFixture = () => `<!doctype html><meta charset="utf-8"><title>搜索结果</title><main><h1>搜索结果</h1><p>SERP_FIXTURE_CONTENT 搜索摘要不代表已阅读完整文章。</p><article><a href="${escapeHtml(articleUrl)}">AITransX 图片识别使用文档</a></article><a href="javascript:alert(1)">不安全链接</a><a href="${origin}/hidden" style="display:none">隐藏结果</a></main>`;
const send = (request) => harness.evaluate((value) => window.agentPort.postMessage(value), request);
const events = () => harness.evaluate(() => window.agentEvents);
const clear = () => harness.evaluate(() => { window.agentEvents = []; });
const waitEvents = (predicate, arg, timeout = 20000) => harness.waitForFunction(predicate, arg, { polling: 100, timeout });
const finished = () => waitEvents(() => window.agentEvents.some((event) => event.type === 'status' && event.running) && window.agentEvents.some((event) => event.type === 'status' && !event.running), undefined, 45000);
const reset = async () => {
  await clear(); await send({ type: 'reset' });
  await waitEvents(() => window.agentEvents.some((event) => event.type === 'history') && window.agentEvents.some((event) => event.type === 'status' && !event.running));
  await clear();
};
const tabs = () => harness.evaluate(async () => (await chrome.tabs.query({})).map(({ id, url, active }) => ({ id, url, active })));
const activeTab = () => harness.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
const activate = (tabId) => harness.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
const getTabId = (url) => harness.evaluate(async (value) => (await chrome.tabs.query({})).find((tab) => tab.url === value).id, url);
const run = async (text, tabIds) => {
  await reset();
  await send({ type: 'run', text, mode: 'read-only', ...(tabIds === undefined ? {} : { tabIds }) });
  await finished();
  assert.deepEqual(mockErrors, [], '本地模型对工具响应的断言应全部通过');
  const result = await events();
  assert.ok(!result.some((event) => event.type === 'approval' && event.request), '只读搜索不能请求页面操作审批');
  return result;
};
let failed = false;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const isSearch = ((url.hostname === 'www.bing.com' || url.hostname === 'www.google.com') && url.pathname === '/search') || (url.hostname === 'www.baidu.com' && url.pathname === '/s');
    if (isSearch) {
      searches.push(url.href);
      if (url.searchParams.get('q') === 'stop-fixture') { reportSlow(); await slowGate; }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: searchFixture() }).catch(() => {});
    } else if (url.origin === origin || ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(url.protocol)) await route.continue();
    else await route.abort(); // Never contact a real search provider or other external site.
  });
  const isOurs = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(isOurs) ?? await context.waitForEvent('serviceworker', { predicate: isOurs });
  base = `chrome-extension://${new URL(worker.url()).host}`;
  harness = await context.newPage();
  await harness.goto(`${base}/options.html`);
  await harness.evaluate(() => {
    window.agentEvents = [];
    window.agentPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.agentPort.onMessage.addListener((event) => window.agentEvents.push(event));
  });
  await waitEvents(() => window.agentEvents.some((event) => event.type === 'history'));
  // This suite verifies the optional background mode. Default visible following
  // and changing the preference during a task are covered in follow-pages.mjs.
  await harness.evaluate(async (url) => chrome.storage.local.set({ 'tabagent:auto-close-pages': false, 'tabagent:follow-pages': false, 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${url}/v1`, openaiApiKey: 'fake', openaiModel: 'mock', maxSteps: 20 } }), origin);
  const page = await context.newPage(); await page.goto(`${origin}/form`);
  const secret = await context.newPage(); await secret.goto(`${origin}/secret`);
  const formId = await getTabId(`${origin}/form`);
  outsideTabId = await getTabId(`${origin}/secret`);
  const harnessId = await getTabId(`${base}/options.html`);
  const newTabId = await harness.evaluate(async () => (await chrome.tabs.create({ url: 'chrome://newtab/', active: true })).id);

  let before = await tabs();
  let result = await run('新标签搜索');
  assert.ok(result.some((event) => event.type === 'assistant' && event.text === '已读取搜索结果正文和来源'));
  assert.equal(await activeTab(), newTabId, '后台搜索和打开结果不能切换当前新标签页');
  assert.equal(new URL(searches[0]).hostname, 'www.bing.com');
  assert.equal(new URL(searches[0]).searchParams.get('q'), query, '搜索词特殊字符须正确编码');
  const added = (await tabs()).filter((tab) => !before.some((item) => item.id === tab.id));
  assert.equal(added.length, 2, '一次搜索和一次打开结果应创建两个后台标签页');
  assert.ok(added.every((tab) => !tab.active));
  const linkSnapshot = await harness.evaluate((id) => chrome.tabs.sendMessage(id, { tag: 'tabagent:content', request: { action: 'search_links' } }), added.find((tab) => tab.url === searches[0]).id);
  assert.deepEqual(linkSnapshot, { ok: true, result: { title: '搜索结果', url: searches[0], links: [{ title: 'AITransX 图片识别使用文档', url: articleUrl }] } }, '搜索快照应保留完整URL且排除隐藏和非网页链接');
  const targets = result.filter((event) => event.type === 'target');
  assert.ok(targets.some((event) => event.url === searches[0] && event.tabIds.length === 1));
  const finalTarget = targets.at(-1);
  assert.equal(finalTarget.url, articleUrl);
  assert.deepEqual([...finalTarget.tabIds].sort(), added.map((tab) => tab.id).sort());
  assert.equal(result.filter((event) => event.type === 'tool_result' && !event.ok).length, 1, '只应拒绝刻意发起的范围外读取');
  assert.equal(page.url(), `${origin}/form`);
  assert.equal(secret.url(), `${origin}/secret`);
  assert.equal(pageRequests.filter((url) => url === '/secret').length, 1, '不可为了检索重新导航已有秘密标签页');
  assert.ok(!JSON.stringify(modelRequests).includes('PRIVATE_OUTSIDE_CONTENT'));

  await activate(harnessId);
  result = await run('扩展页搜索');
  assert.equal(await activeTab(), harnessId);
  assert.equal(new URL(searches.at(-1)).hostname, 'www.google.com');
  assert.equal(new URL(searches.at(-1)).searchParams.get('q'), query);
  assert.ok(!result.some((event) => event.type === 'error'));

  await activate(formId);
  result = await run('普通页搜索', [formId]);
  assert.equal(await activeTab(), formId);
  assert.equal(page.url(), `${origin}/form`);
  assert.equal(new URL(searches.at(-1)).hostname, 'www.baidu.com');
  assert.equal(new URL(searches.at(-1)).searchParams.get('wd'), query);
  assert.ok(result.filter((event) => event.type === 'target').at(-1).tabIds.includes(formId));

  before = await tabs();
  result = await run('非法链接', [formId]);
  assert.equal(result.filter((event) => event.type === 'tool_result' && !event.ok).length, 4);
  assert.equal((await tabs()).length, before.length + 1, '被拒绝的链接不得创建新标签页');
  assert.ok(!pageRequests.some((url) => url.startsWith('/unreturned')));
  before = await tabs();
  result = await run('上一轮链接', [formId]);
  assert.equal(result.filter((event) => event.type === 'tool_result' && !event.ok).length, 1);
  assert.equal((await tabs()).length, before.length, '搜索链接许可不得跨任务沿用');

  const beforeInvalidSearches = searches.length;
  result = await run('非法搜索参数', [formId]);
  assert.equal(result.filter((event) => event.type === 'tool_result' && !event.ok).length, 6);
  assert.equal(searches.length, beforeInvalidSearches);
  assert.equal((await tabs()).length, before.length);
  for (const invalidScope of [[], [-1], [987654321], [newTabId], [harnessId]]) {
    const requestsBefore = modelRequests.length;
    result = await run('显式非法范围', invalidScope);
    assert.ok(result.some((event) => event.type === 'error'), `显式非法范围须被拒绝: ${JSON.stringify(invalidScope)}`);
    assert.equal(modelRequests.length, requestsBefore, '非法显式范围不得发送模型请求');
  }

  result = await run('只读点击', [formId]);
  assert.ok(result.some((event) => event.type === 'error' && event.message.includes('只读模式')));
  assert.equal(await page.textContent('#count'), '0');

  before = await tabs();
  const beforeLimitSearches = searches.length;
  result = await run('检索页面上限', [formId]);
  assert.equal(searches.length - beforeLimitSearches, 8);
  assert.equal((await tabs()).length - before.length, 8);
  assert.equal(result.filter((event) => event.type === 'tool_result' && !event.ok).length, 1);
  assert.equal(result.filter((event) => event.type === 'target').at(-1).tabIds.length, 9);
  assert.equal(await activeTab(), formId);

  await reset();
  const beforeStopRequests = modelRequests.length;
  const beforeStopArticles = pageRequests.filter((url) => url.startsWith('/article')).length;
  await send({ type: 'run', text: '加载中停止', mode: 'read-only', tabIds: [formId] });
  let slowTimeout;
  try {
    await Promise.race([slowRequested, new Promise((_, reject) => { slowTimeout = setTimeout(() => reject(new Error('未发起停止测试搜索')), 15000); })]);
  } finally { clearTimeout(slowTimeout); }
  await send({ type: 'stop' });
  await finished();
  const tabsAtStop = (await tabs()).length;
  releaseSlow();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(modelRequests.length, beforeStopRequests + 1, '停止后不得继续请求模型');
  assert.equal((await tabs()).length, tabsAtStop, '停止后不得再打开结果页面');
  assert.equal(pageRequests.filter((url) => url.startsWith('/article')).length, beforeStopArticles);
  assert.ok(!(await events()).some((event) => event.type === 'tool' && event.name === 'open_search_result'));
  assert.equal(await activeTab(), formId);
  assert.ok(!JSON.stringify(modelRequests).includes('PRIVATE_OUTSIDE_CONTENT'));
  console.log('✓ 搜索回归通过：受限页起步、三引擎编码、后台标签页、完整链接与来源、范围隔离、链接许可、只读拦截、页面上限和停止');
} catch (error) {
  failed = true;
  console.error('✗ 搜索回归失败：', error);
  if (mockErrors.length) console.error('本地模型断言：', mockErrors);
  if (harness && !harness.isClosed()) console.error('事件：', JSON.stringify(await events(), null, 2));
} finally {
  releaseSlow();
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tabagent-search-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
process.exitCode = failed ? 1 : 0;
