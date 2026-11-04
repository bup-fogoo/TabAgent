// Real HTTP documents keep subresources or navigation pending. No external
// search/model requests are sent; only the search engine redirect is mocked.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const held = new Set();
const pendingDocuments = new Map();
const requests = [];
const modelRequests = [];
const modelErrors = [];
let origin;
let callId = 0;
let oldPageRequests = 0;
const resultUrl = (scenario) => `${origin}/article?scenario=${scenario}`;
const call = (name, args) => ({ content: null, tool_calls: [{ id: `loading_${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const answer = (content) => ({ content });
const head = '<!doctype html><meta charset="utf-8">';
const resultLink = (scenario) => `<article><h2><a href="${resultUrl(scenario)}">可读取的搜索结果</a></h2><p>SERP_BODY_${scenario}：这是与用户目标相关的搜索结果摘要，后续还会读取原文确认。</p></article>`;
const hold = (res) => { held.add(res); res.on('close', () => held.delete(res)); };
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(head + body); };
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = new URL(req.url, origin);
  if (url.pathname !== '/v1/chat/completions') {
    requests.push(req.url);
    const scenario = url.searchParams.get('scenario');
    if (url.pathname === '/hanging-image') { hold(res); return; }
    if (url.pathname === '/old' && ++oldPageRequests > 1) {
      hold(res);
      pendingDocuments.set('navigation', () => html(res, '<title>同一网址的新页面</title><main>NEW_DOCUMENT_BODY 相同URL的新文档已经提交，旧文档不能被当作新内容。</main>'));
      return;
    }
    if (url.pathname === '/slow-document') {
      hold(res);
      pendingDocuments.set(scenario, () => html(res, '<title>新页面</title><main>NEW_DOCUMENT_BODY 新文档已经提交，旧文档不能被当作新内容。</main>'));
      return;
    }
    if (url.pathname === '/serp') {
      const delayed = scenario === 'dynamic';
      html(res, `<title>搜索结果 ${scenario}</title><nav><a href="${origin}/help">帮助</a></nav><main id="results">${delayed ? '<p>正在加载搜索结果…</p>' : resultLink(scenario)}</main>${delayed
        ? `<script>setTimeout(() => { document.querySelector('#results').innerHTML = ${JSON.stringify(resultLink(scenario))}; }, 1500);</script>`
        : '<img src="/hanging-image?serp" alt="延迟的装饰图片">'}`);
      return;
    }
    if (url.pathname === '/article') {
      html(res, `<title>原文 ${scenario}</title><main><h1>读取结果正文</h1><p>ARTICLE_BODY_${scenario}：页面文字已经可见，挂起的图片不应阻止读取正文。${'这是需要实际读取的原文内容。'.repeat(12)}</p></main><img src="/hanging-image?article" alt="尚未完成的装饰图片">`);
      return;
    }
    html(res, '<title>旧页面</title><main>OLD_DOCUMENT_BODY 仍在原文档中，不能误报新页面已经就绪。</main>');
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
      if (scenario === 'navigation') {
        if (!results.length) message = call('navigate', { url: `${origin}/old` });
        else if (results.length === 1) {
          assert.ok(last.includes(`${origin}/old`), '导航必须等待相同URL的新文档提交');
          message = call('read_page', { text_only: true });
        } else {
          assert.ok(last.includes('NEW_DOCUMENT_BODY'));
          assert.ok(!last.includes('OLD_DOCUMENT_BODY'), '不得把旧文档返回成新页面');
          message = answer('navigation done');
        }
      } else if (!results.length) message = call('search_web', { query: scenario });
      else if (scenario === 'network-error') {
        assert.ok(/网络|无法连接|加载失败|无法访问|错误页/.test(last), `应说明真实网络加载错误: ${last}`);
        assert.ok(!/Frame with ID|Cannot access|chrome-error:\/\//.test(last), '不能把浏览器内部英文异常直接输出给用户');
        assert.ok(!/权限|允许扩展访问/.test(last), '已知网络错误不能误诊为扩展权限问题');
        message = answer('network-error handled');
      } else if (scenario === 'stop-main') {
        // Reaching this branch after Stop would prove an unwanted continuation.
        message = call('open_search_result', { url: resultUrl(scenario) });
      } else if (results.length === 1) {
        assert.ok(last.includes(`SERP_BODY_${scenario}`), `搜索必须读取已显示的正文: ${last}`);
        assert.ok(last.includes(resultUrl(scenario)), '必须等到真实结果，不能只返回导航栏');
        message = call('open_search_result', { url: resultUrl(scenario) });
      } else {
        assert.ok(last.includes(`ARTICLE_BODY_${scenario}`), `图片未完成时仍需读取原文: ${last}`);
        assert.ok(last.includes(resultUrl(scenario)));
        message = answer(`${scenario} done`);
      }
    } catch (error) {
      modelErrors.push(error.message);
      message = answer(`MOCK_ASSERTION_FAILED: ${error.message}`);
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-loading-'));
let context;
let harness;
let failed = false;
const events = () => harness.evaluate(() => window.events);
const send = (request) => harness.evaluate((value) => window.port.postMessage(value), request);
const waitFor = async (predicate, message, timeout = 20000) => {
  const until = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  throw new Error(message);
};
const finished = () => waitFor(async () => {
  const value = await events();
  return value.some((item) => item.type === 'status' && item.running) && value.some((item) => item.type === 'status' && !item.running);
}, '任务未按时结束', 40000);
const reset = async () => {
  await harness.evaluate(() => { window.events = []; });
  await send({ type: 'reset' });
  await waitFor(async () => (await events()).some((item) => item.type === 'history'), '重置未完成');
  await harness.evaluate(() => { window.events = []; });
};
const assertSuccess = async (scenario) => {
  assert.deepEqual(modelErrors, [], '模型收到的工具结果必须包含真实页面内容');
  const value = await events();
  assert.ok(!value.some((item) => item.type === 'tool_result' && !item.ok), JSON.stringify(value.filter((item) => item.type === 'tool_result')));
  assert.ok(value.some((item) => item.type === 'assistant' && item.text === `${scenario} done`));
};
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.bing.com' && url.pathname === '/search') {
      const scenario = url.searchParams.get('q');
      if (scenario === 'network-error') { await route.abort('internetdisconnected'); return; }
      const destination = scenario === 'stop-main' ? '/slow-document' : '/serp';
      await route.fulfill({ status: 302, headers: { location: `${origin}${destination}?scenario=${scenario}` }, body: '' });
    } else if (url.origin === origin || ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(url.protocol)) await route.continue();
    else await route.abort();
  });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  harness = await context.newPage();
  await harness.goto(`${base}/options.html`);
  await harness.evaluate(async (url) => {
    await chrome.storage.local.set({ 'tabagent:auto-close-pages': false, 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${url}/v1`, openaiApiKey: 'fake', openaiModel: 'mock', maxSteps: 6 } });
    window.events = [];
    window.port = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.port.onMessage.addListener((event) => window.events.push(event));
  }, origin);
  await waitFor(async () => (await events()).some((item) => item.type === 'history'), '后台未连接');
  const page = await context.newPage(); await page.goto(`${origin}/old`);
  const tabId = await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, `${origin}/old`);

  for (const scenario of ['hanging', 'dynamic']) {
    await reset();
    const started = Date.now();
    await send({ type: 'run', text: scenario, mode: 'read-only', tabIds: [tabId] });
    if (scenario === 'hanging') {
      const searchUrl = `${origin}/serp?scenario=hanging`;
      await waitFor(() => context.pages().some((item) => item.url() === searchUrl), '搜索页未提交');
      const searchPage = context.pages().find((item) => item.url() === searchUrl);
      assert.ok((await searchPage.textContent('body')).includes('SERP_BODY_hanging'), '复现前提：搜索正文确实已经显示');
      assert.equal(await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).status, searchUrl), 'loading');
    }
    await finished();
    await assertSuccess(scenario);
    const target = (await events()).filter((item) => item.type === 'target').at(-1);
    const state = await harness.evaluate((id) => chrome.tabs.get(id), target.tabId);
    assert.equal(state.status, 'loading', '测试必须确实在子资源挂起时成功，不能先放行图片');
    assert.ok(Date.now() - started < 14000, '可读页面不应拖到旧的15秒整页超时');
    assert.equal(page.url(), `${origin}/old`);
    console.log(`✓ ${scenario}: 搜索和原文可读，子资源仍在加载`);
  }

  await reset();
  assert.ok((await page.textContent('body')).includes('OLD_DOCUMENT_BODY'));
  await send({ type: 'run', text: 'navigation', mode: 'confirm', tabIds: [tabId] });
  await waitFor(async () => (await events()).some((item) => item.type === 'approval' && item.request), '导航没有等待审批');
  const approval = (await events()).find((item) => item.type === 'approval' && item.request).request;
  await send({ type: 'approve', id: approval.id, approved: true });
  await waitFor(() => pendingDocuments.has('navigation'), '新文档请求未发出');
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Playwright DOM locators wait for this pending navigation themselves; inspect
  // browser state instead. The server has not sent the new document headers.
  assert.equal(await harness.evaluate((id) => chrome.tabs.get(id).then((tab) => tab.status), tabId), 'loading');
  assert.ok(!(await events()).some((item) => item.type === 'tool_result'), '新主文档未返回时，不能误读旧complete文档并完成导航');
  pendingDocuments.get('navigation')();
  await finished();
  await assertSuccess('navigation');
  console.log('✓ navigation: 只在新文档提交后读取');

  await reset();
  await send({ type: 'run', text: 'network-error', mode: 'read-only', tabIds: [tabId] });
  await finished();
  assert.deepEqual(modelErrors, []);
  assert.ok((await events()).some((item) => item.type === 'tool_result' && !item.ok), 'Chrome网络错误页不能作为成功搜索结果');
  console.log('✓ network-error: 返回中文网络错误，不误报成功或权限问题');

  await reset();
  const requestCount = modelRequests.length;
  await send({ type: 'run', text: 'stop-main', mode: 'read-only', tabIds: [tabId] });
  await waitFor(() => pendingDocuments.has('stop-main'), '慢主文档请求未发出');
  await send({ type: 'stop' });
  await finished();
  const tabCount = await harness.evaluate(async () => (await chrome.tabs.query({})).length);
  pendingDocuments.get('stop-main')();
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(modelRequests.length, requestCount + 1, '停止后不应继续请求模型');
  assert.equal(await harness.evaluate(async () => (await chrome.tabs.query({})).length), tabCount);
  assert.ok(!requests.some((url) => url.includes('/article?scenario=stop-main')));
  console.log('✓ stop-main: 主文档等待可取消，没有后续模型或结果页操作');
} catch (error) {
  failed = true;
  console.error('✗ 加载回归失败:', error);
  if (harness && !harness.isClosed()) console.error('工具结果:', (await events()).filter((item) => item.type === 'tool_result' || item.type === 'error'));
} finally {
  await context?.close();
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tabagent-loading-')) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
