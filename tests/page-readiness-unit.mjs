// Exercise the production readiness policy with controlled document transitions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = ts.transpileModule((await fs.readFile(new URL('../lib/tools.ts', import.meta.url), 'utf8'))
  .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const page = (extra = {}) => ({ url: 'https://example.test/result', title: '结果', documentId: 'new',
  readyState: 'interactive', hasContent: true, text: '已渲染的正文', resultUrls: [], ...extra });
function harness({ get, probe, injected } = {}) {
  let reads = 0;
  let probes = 0;
  const browser = {
    tabs: { get: async () => get ? get(++reads) : ({ url: page().url, status: 'loading' }) },
    scripting: { executeScript: async (options) => {
      assert.equal(options.injectImmediately, true, '探针不应等待 document_idle');
      if (injected) return [{ result: await injected(options.func) }];
      return [{ result: probe ? await probe(++probes) : page() }];
    } },
  };
  const context = vm.createContext({ browser, URL, DOMException, AbortController, setTimeout, clearTimeout });
  vm.runInContext(`${source}\nglobalThis.subject = { waitForLoad, isSearchResultCandidate };`, context);
  return { ...context.subject, probes: () => probes };
}

// Slow images must not prevent reading a committed, visible document.
{
  const h = harness();
  const start = Date.now();
  await h.waitForLoad(1, new AbortController().signal);
  assert.ok(Date.now() - start < 1000);
}

// A pending main-document navigation cannot reuse the old, complete page.
{
  let ready = false;
  const h = harness({
    get: (read) => { ready = read > 1; return { url: page().url, status: 'complete', ...(!ready ? { pendingUrl: page().url } : {}) }; },
    probe: () => { assert.equal(ready, true); return page(); },
  });
  await h.waitForLoad(1, new AbortController().signal);
  assert.equal(h.probes(), 1);
}

// Same-address reloads must produce a different document identity.
{
  const h = harness({ probe: (count) => page({ documentId: count === 1 ? 'old' : 'new' }) });
  await h.waitForLoad(1, new AbortController().signal, 2000, { previousDocumentId: 'old', previousUrl: page().url });
  assert.equal(h.probes(), 2);
}

// A navigation that destroys the first execution context is retried briefly.
{
  const h = harness({ probe: (count) => { if (count === 1) throw new Error('Execution context was destroyed'); return page(); } });
  await h.waitForLoad(1, new AbortController().signal);
  assert.equal(h.probes(), 2);
}

// Browser error documents and verification pages have distinct actionable errors.
{
  const h = harness({ probe: () => { throw new Error('Frame with ID 0 is showing error page'); } });
  await assert.rejects(h.waitForLoad(1, new AbortController().signal), /网络错误页/);
  assert.equal(h.probes(), 1);
}
{
  const url = 'https://wappass.baidu.com/static/captcha/tuxing_v2.html';
  const h = harness({ get: () => ({ url, status: 'loading' }), probe: () => page({ url, title: '百度安全验证', hasContent: false, text: '' }) });
  await assert.rejects(h.waitForLoad(1, new AbortController().signal), /验证码或安全验证/);
  assert.equal(h.probes(), 1);
}
{
  const h = harness({ probe: () => { throw new Error('Cannot access contents of url'); } });
  await assert.rejects(h.waitForLoad(1, new AbortController().signal), /网站访问权限/);
}

// Tutorials and search snippets may mention verification without being gates.
for (const url of ['https://example.test/tutorial', 'https://developers.google.com/tutorial', 'https://www.baidu.com/s?wd=captcha']) {
  const h = harness({ get: () => ({ url, status: 'complete' }),
    probe: () => page({ url, title: '人机验证原理', text: '教程示例：请输入验证码，完成安全验证。', hasChallenge: false }) });
  await h.waitForLoad(1, new AbortController().signal);
}
for (const url of ['https://www.google.com/sorry/index', 'https://wappass.baidu.com/static/captcha/tuxing_v2.html']) {
  const h = harness({ get: () => ({ url, status: 'loading' }),
    probe: () => page({ url, title: '', hasContent: false, text: '', hasChallenge: false }) });
  await assert.rejects(h.waitForLoad(1, new AbortController().signal), /验证码或安全验证/);
}

// Run the actual injected probe against text-free image/SVG documents, without
// any external requests. Such pages remain available for vision analysis.
const imageBrowser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const imagePage = await imageBrowser.newPage();
  await imagePage.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await imagePage.goto(page().url);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>';
  for (const html of [`<img src="data:image/svg+xml,${encodeURIComponent(svg)}">`, svg]) {
    await imagePage.setContent(html);
    const h = harness({ injected: (fn) => imagePage.evaluate(`(${fn.toString()})()`) });
    await h.waitForLoad(1, new AbortController().signal, 2000);
    assert.equal(await imagePage.locator('body').innerText(), '');
  }
} finally { await imageBrowser.close(); }

// Visible local header links alone are not proof that search results have arrived.
{
  const h = harness();
  assert.equal(h.isSearchResultCandidate('https://example.test/help', page()), false);
  assert.equal(h.isSearchResultCandidate('https://example.test/article', page({ resultUrls: ['https://example.test/article'] })), true);
  assert.equal(h.isSearchResultCandidate('https://www.google.com/preferences', page()), false);
  assert.equal(h.isSearchResultCandidate('https://www.baidu.com/link?url=actual-result', page()), true);
  assert.equal(h.isSearchResultCandidate('javascript:alert(1)', page()), false);
}
console.log('✓ 页面就绪策略：慢资源、待提交导航、同地址换文档、跳转重试、网络错误/验证码/权限分类与真实结果筛选');
