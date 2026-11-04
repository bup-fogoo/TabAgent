// Exercise the production content handler on a local page; no model or external service is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';

const content = ts.transpileModule(
  (await fs.readFile(new URL('../entrypoints/content.ts', import.meta.url), 'utf8'))
    .replace(/^import[^\n]+\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>搜索结果回归</title><style>a{display:block}</style><body></body>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: `(() => {
    const CONTENT_MESSAGE_TAG = 'tabagent:content';
    let listener;
    const browser = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
    const defineContentScript = (definition) => definition.main();
    ${content}
    window.searchLinksRequest = (request) => new Promise((resolve) => listener({ tag: CONTENT_MESSAGE_TAG, request }, {}, resolve));
  })();` });
  const longUrl = `https://example.com/result?query=${'word%20'.repeat(450)}&last=complete#details`;
  const wrapperUrl = `https://www.google.com/url?q=${encodeURIComponent(longUrl)}&source=web`;
  await page.evaluate(({ longUrl, wrapperUrl }) => {
    window.clicked = 0;
    const link = (href, title, parent = document.body) => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      anchor.textContent = title;
      anchor.onclick = () => { window.clicked++; };
      parent.append(anchor);
      return anchor;
    };
    link('/navigation', '普通导航');
    link('/duplicate', '重复的普通链接');
    const firstHeading = link(longUrl, '');
    firstHeading.innerHTML = '<h3>完整长网址结果</h3>';
    const secondHeading = document.createElement('h2');
    document.body.append(secondHeading);
    link('/duplicate', '标题结果优先', secondHeading);
    link('/relative?value=a%20b#part', '相对网址');
    link(wrapperUrl, 'Google 跳转链接');
    link('https://example.com/title', '长'.repeat(205));
    link('/accessible', '').setAttribute('aria-label', '无文本的可访问标签');
    const labelled = document.createElement('span');
    labelled.id = 'link-label';
    labelled.textContent = '关联的链接标签';
    document.body.append(labelled);
    link('/labelled', '').setAttribute('aria-labelledby', labelled.id);
    link('/tooltip', '').setAttribute('title', '链接标题');
    // Empty anchors still have layout, so they must be filtered by their label.
    for (const anchor of document.querySelectorAll('a')) { anchor.style.minHeight = '20px'; }
    for (const [href, title] of [['javascript:window.clicked++', '脚本'], ['mailto:test@example.com', '邮箱'],
      ['data:text/html,example', '数据'], ['https://user:pass@example.com/private', '凭据'],
      ['#section', '本页锚点'], [location.href + '#other', '本页绝对锚点'], ['', '空网址'],
      ['https://example.com/' + 'a'.repeat(8192), '过长网址']]) link(href, title);
    link('/unlabelled', '').style.cssText = 'height:20px;width:100px';
    link('/download', '下载').setAttribute('download', 'result.html');
    link('/hidden-attribute', '隐藏属性').hidden = true;
    link('/hidden-style', '隐藏样式').style.display = 'none';
    link('/hidden-visibility', '隐藏可见性').style.visibility = 'hidden';
    for (const [attribute, value] of [['aria-hidden', 'true'], ['inert', ''], ['style', 'opacity:0']]) {
      const parent = document.createElement('div');
      parent.setAttribute(attribute, value);
      document.body.append(parent);
      link('/hidden-parent-' + attribute, '隐藏父级', parent);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowHeading = document.createElement('h3');
    shadow.append(shadowHeading);
    link('/shadow', 'Shadow 搜索结果', shadowHeading);
    const hiddenHost = document.createElement('div');
    hiddenHost.setAttribute('aria-hidden', 'true');
    document.body.append(hiddenHost);
    link('/hidden-shadow', '隐藏 Shadow 结果', hiddenHost.attachShadow({ mode: 'open' }));
  }, { longUrl, wrapperUrl });
  const response = await page.evaluate(() => window.searchLinksRequest({ action: 'search_links' }));
  assert.equal(response.ok, true);
  assert.equal(response.result.title, '搜索结果回归');
  assert.equal(response.result.url, origin + '/');
  const links = response.result.links;
  assert.deepEqual(links.slice(0, 3), [
    { title: '完整长网址结果', url: longUrl },
    { title: '标题结果优先', url: origin + '/duplicate' },
    { title: 'Shadow 搜索结果', url: origin + '/shadow' },
  ]);
  assert.equal(links.find((link) => link.title === '相对网址').url, origin + '/relative?value=a%20b#part');
  assert.equal(links.find((link) => link.title === 'Google 跳转链接').url, wrapperUrl);
  assert.equal(links.find((link) => link.url === 'https://example.com/title').title.length, 200);
  assert.equal(links.filter((link) => link.url === origin + '/duplicate').length, 1);
  assert.deepEqual(links.map((link) => link.url).sort(), [
    longUrl, origin + '/duplicate', origin + '/shadow', origin + '/navigation', origin + '/relative?value=a%20b#part',
    wrapperUrl, 'https://example.com/title', origin + '/accessible', origin + '/labelled', origin + '/tooltip',
  ].sort(), '过滤隐藏、空标签、危险协议、凭据、下载和本页锚点，保留普通链接作为补充');
  assert.equal(await page.evaluate(() => window.clicked), 0, '读取链接不点击或执行链接脚本');

  await page.evaluate(() => {
    document.body.replaceChildren();
    for (let index = 0; index < 90; index++) {
      const anchor = document.createElement('a');
      anchor.href = '/many/' + index;
      anchor.innerHTML = index < 20 ? '普通链接 ' + index : '<h3>结果 ' + index + '</h3>';
      document.body.append(anchor);
    }
  });
  const capped = await page.evaluate(() => window.searchLinksRequest({ action: 'search_links' }));
  assert.equal(capped.result.links.length, 60);
  assert.equal(new Set(capped.result.links.map((link) => link.url)).size, 60);
  assert.equal(capped.result.links[0].url, origin + '/many/20');
  assert.equal(capped.result.links[59].url, origin + '/many/79');

  const envelopes = await page.evaluate(async () => {
    const cancelledId = crypto.randomUUID();
    await window.searchLinksRequest({ action: 'cancel', requestId: cancelledId });
    const cancelled = await window.searchLinksRequest({ action: 'search_links', requestId: cancelledId, deadline: Date.now() + 12000 });
    const expired = await window.searchLinksRequest({ action: 'search_links', requestId: crypto.randomUUID(), deadline: Date.now() - 1 });
    const request = { action: 'search_links', requestId: crypto.randomUUID(), deadline: Date.now() + 12000 };
    const complete = await window.searchLinksRequest(request);
    const duplicate = await window.searchLinksRequest(request);
    document.body.replaceChildren();
    const empty = await window.searchLinksRequest({ action: 'search_links' });
    return { cancelled, expired, complete, duplicate, empty };
  });
  assert.equal(envelopes.cancelled.ok, false);
  assert.match(envelopes.cancelled.error, /取消/);
  assert.equal(envelopes.expired.ok, false);
  assert.match(envelopes.expired.error, /过期/);
  assert.equal(envelopes.complete.ok, true);
  assert.equal(envelopes.duplicate.ok, false);
  assert.deepEqual(envelopes.empty.result.links, []);
  console.log('search links: full URLs, result priority, visibility, filtering, limits and cancellation passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
