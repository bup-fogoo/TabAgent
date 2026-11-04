// Real Chromium extension checks. Search/model data are local and the main
// documents stay pending until the test confirms the user can see each target.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const FOLLOW_KEY = 'tabagent:follow-pages';
const requests = [];
const modelRequests = [];
const modelErrors = [];
const pending = new Map();
const held = new Set();
let origin;
let originalId;
let secondId;
let outsideId;
let callId = 0;
const articleUrl = (scenario) => `${origin}/article?scenario=${scenario}`;
const call = (name, input) => ({ role: 'assistant', content: null, tool_calls: [{ id: `follow-${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const answer = (scenario) => ({ role: 'assistant', content: `${scenario} complete` });
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><meta charset="utf-8">${body}`); };
const holdDocument = (res, key, body) => {
  held.add(res); res.on('close', () => held.delete(res));
  pending.set(key, () => { pending.delete(key); html(res, body); });
};
const server = http.createServer((req, res) => {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  const url = new URL(req.url, origin);
  if (url.pathname !== '/v1/chat/completions') {
    requests.push(req.url);
    const scenario = url.searchParams.get('scenario');
    if (url.pathname === '/serp') {
      holdDocument(res, `search-${scenario}`, `<title>搜索结果 ${scenario}</title><main><h2><a href="${articleUrl(scenario)}">本地搜索原文</a></h2><p>SEARCH_BODY_${scenario} 用户需要看到搜索与原文的处理过程。</p></main>`);
    } else if (url.pathname === '/article') {
      holdDocument(res, `article-${scenario}`, `<title>搜索原文 ${scenario}</title><main>ARTICLE_BODY_${scenario} 已读取搜索结果正文。</main>`);
    } else if (url.pathname === '/outside') {
      html(res, '<title>范围外页面</title><main>PRIVATE_OUTSIDE_CONTENT</main>');
    } else {
      html(res, `<title>${url.pathname === '/second' ? '第二个任务页面' : '原来的页面'}</title><main>${url.pathname === '/second' ? 'SECOND_PAGE_BODY' : 'ORIGINAL_PAGE_BODY'}</main>`);
    }
    return;
  }
  let raw = '';
  req.on('data', (data) => { raw += data; });
  req.on('end', () => {
    let message;
    try {
      const body = JSON.parse(raw);
      modelRequests.push(body);
      const lastUser = body.messages.map((item) => item.role).lastIndexOf('user');
      const scenario = body.messages[lastUser].content.split('\n')[0];
      const results = body.messages.slice(lastUser + 1).filter((item) => item.role === 'tool');
      const last = results.at(-1)?.content ?? '';
      if (scenario === 'outside-only') {
        if (!results.length) message = call('read_page', { tab_id: outsideId });
        else { assert.ok(last.includes('不在本次任务范围')); message = answer(scenario); }
      } else if (!results.length) message = call('search_web', { query: scenario });
      else if (results.length === 1) {
        assert.ok(last.includes(`SEARCH_BODY_${scenario}`));
        assert.ok(last.includes(articleUrl(scenario)));
        message = call('open_search_result', { url: articleUrl(scenario) });
      } else if (results.length === 2) {
        assert.ok(last.includes(`ARTICLE_BODY_${scenario}`));
        message = scenario === 'follow' ? call('read_page', { tab_id: secondId, text_only: true }) : answer(scenario);
      } else if (results.length === 3) {
        assert.ok(last.includes('SECOND_PAGE_BODY'));
        message = call('read_page', { tab_id: outsideId });
      } else {
        assert.ok(last.includes('不在本次任务范围'));
        message = answer(scenario);
      }
    } catch (error) {
      modelErrors.push(error.message);
      message = answer(`MOCK_ASSERTION_FAILED: ${error.message}`);
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-follow-'));
let context;
let harness;
let panel;
let base;
let failed = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await wait(40); } while (Date.now() < deadline);
  throw new Error(message);
};
const events = () => harness.evaluate(() => window.events);
const send = (request) => harness.evaluate((value) => window.port.postMessage(value), request);
const activeId = () => harness.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }))[0]?.id);
const activate = (tabId) => harness.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
const allTabs = () => harness.evaluate(() => chrome.tabs.query({}));
const tabId = (url) => harness.evaluate(async (value) => (await chrome.tabs.query({})).find((tab) => tab.url === value)?.id, url);
const reset = async () => {
  await harness.evaluate(() => { window.events = []; }); await send({ type: 'reset' });
  await until(async () => (await events()).some((item) => item.type === 'history'), '重置未完成');
  await harness.evaluate(() => { window.events = []; });
};
const start = async (scenario) => {
  await reset(); await activate(originalId);
  await send({ type: 'run', text: scenario, mode: 'read-only', tabIds: [originalId, secondId] });
};
const finish = () => until(async () => {
  const value = await events();
  return value.some((item) => item.type === 'status' && item.running) && value.some((item) => item.type === 'status' && !item.running);
}, '任务未结束');
const pendingTarget = async (key, action) => {
  await until(() => pending.has(key), `没有发起 ${key}`);
  await until(async () => (await events()).some((item) => item.type === 'target' && item.action === action), `${action} 在加载前没有公布目标`);
  const target = (await events()).filter((item) => item.type === 'target' && item.action === action).at(-1);
  assert.ok(target.tabIds.includes(target.tabId), '展示目标必须属于锁定任务范围');
  return target;
};
const release = (key) => { assert.ok(pending.has(key), `Missing document gate: ${key}`); pending.get(key)(); };
const assertComplete = async (scenario) => {
  await finish();
  assert.deepEqual(modelErrors, []);
  assert.ok((await events()).some((item) => item.type === 'assistant' && item.text === `${scenario} complete`));
  assert.ok(!(await events()).some((item) => item.type === 'approval' && item.request), '视图跟随不应请求网页修改审批');
};
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.bing.com' && url.pathname === '/search') {
      await route.fulfill({ status: 302, headers: { location: `${origin}/serp?scenario=${url.searchParams.get('q')}` }, body: '' });
    } else if (url.origin === origin || ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(url.protocol)) await route.continue();
    else await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  base = `chrome-extension://${new URL(worker.url()).host}`;
  harness = await context.newPage(); await harness.goto(`${base}/options.html`);
  await harness.evaluate(async (url) => {
    await chrome.storage.local.set({ 'tabagent:auto-close-pages': false, 'tabagent:settings': { provider: 'openai', openaiApiKey: 'fake', openaiModel: 'mock', openaiBaseUrl: `${url}/v1`, maxSteps: 8 } });
    window.events = []; window.port = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.port.onMessage.addListener((event) => window.events.push(event));
  }, origin);
  await until(async () => (await events()).some((item) => item.type === 'history'), '后台连接失败');
  const original = await context.newPage(); await original.goto(`${origin}/original`);
  const second = await context.newPage(); await second.goto(`${origin}/second`);
  const outside = await context.newPage(); await outside.goto(`${origin}/outside`);
  originalId = await tabId(`${origin}/original`); secondId = await tabId(`${origin}/second`); outsideId = await tabId(`${origin}/outside`);
  panel = await context.newPage(); await panel.setViewportSize({ width: 320, height: 740 }); await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForSelector('#follow-pages:enabled');
  assert.equal(await panel.getAttribute('#follow-pages', 'aria-pressed'), 'true', '全新配置默认跟随任务页面');
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '320px宽度不能出现横向溢出');

  await start('follow');
  const searchTarget = await pendingTarget('search-follow', 'search_web');
  assert.equal(await activeId(), searchTarget.tabId, '搜索页面加载期间就应切到前台');
  assert.ok(!(await events()).some((item) => item.type === 'tool_result'), '目标展示不能等到搜索完成才发生');
  await until(async () => /搜索/.test(await panel.textContent('#context-label')), '侧栏未同步显示搜索动作');
  release('search-follow');
  const resultTarget = await pendingTarget('article-follow', 'open_search_result');
  assert.equal(await activeId(), resultTarget.tabId, '原文加载期间就应切到前台');
  assert.equal(resultTarget.url, articleUrl('follow'));
  assert.ok(resultTarget.tabIds.includes(searchTarget.tabId));
  release('article-follow');
  await assertComplete('follow');
  assert.equal(await activeId(), secondId, '读取指定任务页面应同步切到该页面，范围外调用不能抢焦点');
  assert.ok((await events()).some((item) => item.type === 'target' && item.action === 'read_page' && item.tabId === secondId));
  assert.ok(!(await events()).some((item) => item.type === 'target' && item.tabId === outsideId));
  assert.ok(!JSON.stringify(modelRequests).includes('PRIVATE_OUTSIDE_CONTENT'));
  console.log('✓ 默认跟随：搜索/原文加载前可见、指定任务页同步切换、范围外不切换');

  await start('toggle');
  const toggleTarget = await pendingTarget('search-toggle', 'search_web');
  assert.equal(await activeId(), toggleTarget.tabId);
  await panel.locator('#follow-pages').click();
  await panel.waitForFunction(() => document.querySelector('#follow-pages').getAttribute('aria-pressed') === 'false' && !document.querySelector('#follow-pages').disabled, undefined, { polling: 100 });
  assert.equal(await harness.evaluate(async (key) => (await chrome.storage.local.get(key))[key], FOLLOW_KEY), false);
  await activate(originalId);
  release('search-toggle');
  const backgroundResult = await pendingTarget('article-toggle', 'open_search_result');
  assert.equal(await activeId(), originalId, '执行中关闭跟随后，下一页面应保持后台');
  assert.notEqual(backgroundResult.tabId, originalId);
  release('article-toggle');
  await assertComplete('toggle');
  assert.equal(await activeId(), originalId);
  await panel.close();
  panel = await context.newPage(); await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForSelector('#follow-pages:enabled');
  assert.equal(await panel.getAttribute('#follow-pages', 'aria-pressed'), 'false', '重开侧栏保留后台模式');
  console.log('✓ 任务中可关闭跟随，新页保持后台，重开侧栏保留偏好');

  await start('background');
  await pendingTarget('search-background', 'search_web');
  assert.equal(await activeId(), originalId, '关闭偏好的下一任务也应后台执行');
  release('search-background');
  await pendingTarget('article-background', 'open_search_result');
  assert.equal(await activeId(), originalId);
  release('article-background');
  await assertComplete('background');
  assert.equal(await activeId(), originalId);

  await panel.locator('#follow-pages').click();
  await panel.waitForFunction(() => document.querySelector('#follow-pages').getAttribute('aria-pressed') === 'true' && !document.querySelector('#follow-pages').disabled, undefined, { polling: 100 });
  await start('outside-only');
  await assertComplete('outside-only');
  assert.equal(await activeId(), originalId, '开启跟随也不能激活范围外页面');
  assert.equal((await events()).filter((item) => item.type === 'tool_result' && !item.ok).length, 1);

  await start('stop');
  const stopTarget = await pendingTarget('search-stop', 'search_web');
  assert.equal(await activeId(), stopTarget.tabId);
  const modelCount = modelRequests.length;
  await send({ type: 'stop' }); await finish();
  const countAtStop = (await allTabs()).length;
  await activate(originalId); release('search-stop'); await wait(700);
  assert.equal(await activeId(), originalId, '停止后迟到的页面加载不能再次抢焦点');
  assert.equal((await allTabs()).length, countAtStop, '停止后不能新建结果标签页');
  assert.equal(modelRequests.length, modelCount, '停止后不能继续请求模型');
  assert.ok(!requests.some((url) => url.startsWith('/article?scenario=stop')));
  assert.deepEqual(modelErrors, []);
  console.log('✓ 停止后不再切页或打开结果；视图跟随保持只读和范围限制');
} catch (error) {
  failed = true;
  console.error('✗ 页面跟随回归失败:', error);
  if (harness && !harness.isClosed()) console.error('事件:', (await events()).filter((item) => ['target', 'tool_result', 'error'].includes(item.type)));
} finally {
  await context?.close();
  for (const response of held) response.destroy();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tabagent-follow-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
