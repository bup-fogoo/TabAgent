// Real extension, generated PDFs and local model: no private documents or API keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

function makePdf(pages, encrypted = false) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const pageId = objects.length + 1, streamId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const stream = lines.map((line, index) => `BT /F1 9 Tf 24 ${760 - index * 12} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let encrypt = '';
  if (encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'01'.repeat(32)}> /U <${'02'.repeat(32)}> /P -4 >>`);
    encrypt = ` /Encrypt ${objects.length} 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]`;
  }
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
const pdf = makePdf([
  ['PAGE_ONE_BEGIN', ...Array.from({ length: 55 }, (_, i) => `Page one row ${i}: ${'alpha evidence '.repeat(5)}`), 'PAGE_ONE_END'],
  ['PAGE_TWO_BEGIN', ...Array.from({ length: 55 }, (_, i) => `Page two row ${i}: ${'beta evidence '.repeat(5)}`), 'END_OF_PDF_PAGE_TWO'],
]);
const blankPdf = makePdf([[]]), encryptedPdf = makePdf([['PASSWORD_PROTECTED']], true);
const html = '<!doctype html><meta charset="utf-8"><title>HTML despite PDF suffix</title><h1>HTML_CAPABILITY_SENTINEL</h1>';
let scenario, tabId, outsideTabId, serverFailure;
let toolNumber = 0, mode = 'normal', modelRequests = 0;
const reports = [], heldResponses = new Set(), sockets = new Set();
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') {
    if (req.url === '/html.pdf') { res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url === '/controlled.pdf' && mode !== 'normal') {
      if (mode === 'unauthorized') { res.writeHead(401, { ...cors, 'content-type': 'text/html' }); res.end('Login required'); return; }
      if (mode === 'login') { res.writeHead(200, { ...cors, 'content-type': 'text/html' }); res.end('<h1>Login required</h1>'); return; }
      if (mode === 'invalid') { res.writeHead(200, { ...cors, 'content-type': 'application/pdf' }); res.end('%PDF-1.7\nnot a PDF body'); return; }
      if (mode === 'large' || mode === 'slow') {
        res.writeHead(200, { ...cors, 'content-type': 'application/pdf', 'content-length': mode === 'large' ? 30 * 1024 * 1024 : pdf.length });
        if (mode === 'slow') res.write(pdf.subarray(0, 64)); else res.flushHeaders();
        heldResponses.add(res); res.on('close', () => heldResponses.delete(res)); return;
      }
    }
    const data = req.url === '/scan.pdf' ? blankPdf : req.url === '/encrypted.pdf' ? encryptedPdf : pdf;
    res.writeHead(200, { ...cors, 'content-type': 'application/pdf', 'content-length': data.length }); res.end(data); return;
  }
  let raw = ''; req.on('data', (part) => raw += part);
  req.on('end', () => {
    modelRequests++;
    try {
      const body = JSON.parse(raw);
      const userIndex = body.messages.findLastIndex((message) => message.role === 'user' && typeof message.content === 'string');
      const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool');
      const imageCount = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((item) => item.type === 'image_url') : []).length;
      if (results.length) reports.push({ scenario, results: results.map((item) => item.content), imageCount });
      const last = results.at(-1)?.content ?? '', next = last.match(/next_offset:\s*(\d+)/)?.[1];
      const name = scenario === 'capture' ? 'capture_page' : ['extract', 'html-extract'].includes(scenario) ? 'extract' : 'read_page';
      let message;
      if (!results.length || scenario === 'summary' && next) {
        if (scenario === 'summary') assert.ok(!body.tools.some((tool) => tool.function.name === 'capture_page'), 'PDF全文总结不需要图片模型');
        const args = { tab_id: scenario === 'outside' ? outsideTabId : tabId,
          ...(name === 'read_page' ? { text_only: true, ...(scenario === 'summary' ? { max_text_chars: 3200, text_offset: Number(next ?? 0) } : {}) } : name === 'extract' ? { selector: 'h1' } : {}),
        };
        message = { role: 'assistant', content: null, tool_calls: [{ id: `pdf_${++toolNumber}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      } else {
        if (scenario === 'summary') {
          const joined = results.map((item) => item.content).join('\n');
          assert.ok(joined.includes('PAGE_ONE_BEGIN') && joined.includes('END_OF_PDF_PAGE_TWO'), '总结必须基于整份PDF，不只是首屏/首页');
          assert.match(joined, /第\s*1\s*页/); assert.match(joined, /第\s*2\s*页/);
          assert.ok(last.includes('next_offset: null'), '完成前应读到最后一段');
        }
        message = { role: 'assistant', content: scenario === 'summary' ? '总结：第1页为 alpha evidence，第2页为 beta evidence，已读至 END_OF_PDF_PAGE_TWO。' : '本地验证结束' };
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    } catch (error) { serverFailure = error; res.writeHead(500, cors); res.end('Local fixture failed'); }
  });
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-pdf-capability-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let context, harness, target;
const events = async () => harness.evaluate(() => window.pdfEvents);
const waitIdle = async () => {
  await harness.waitForFunction(() => window.pdfEvents.some((event) => event.type === 'user') && window.pdfEvents.some((event) => event.type === 'status' && !event.running), null, { timeout: 45000 });
  if (serverFailure) throw serverFailure;
  return events();
};
const start = async (value) => {
  scenario = value;
  await target.bringToFront();
  await harness.evaluate(({ text, tabId }) => { window.pdfEvents = []; window.pdfPort.postMessage({ type: 'run', text, mode: 'read-only', tabIds: [tabId] }); }, { text: `PDF regression ${value} ${Date.now()}`, tabId });
};
const run = async (value) => { await start(value); return waitIdle(); };
const open = async (pathname) => {
  mode = 'normal'; await target.goto(`${origin}${pathname}`, { waitUntil: 'load' });
  tabId = await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${origin}${pathname}`);
  assert.ok(Number.isInteger(tabId));
  await harness.waitForFunction(async (id) => { const tab = await chrome.tabs.get(id); return tab.status === 'complete' && !tab.pendingUrl; }, tabId);
};
const assertFailed = (log, pattern) => {
  const result = log.find((event) => event.type === 'tool_result');
  assert.ok(result); assert.equal(result.ok, false, JSON.stringify(result)); assert.match(result.summary, pattern);
  assert.ok(!log.some((event) => event.type === 'sources'), '失败读取不能被记录为已读参考');
};
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await harness.evaluate(async (origin) => {
    await chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${origin}/v1`, openaiModel: 'pdf-probe', openaiApiKey: 'local-fake', openaiVision: false, maxSteps: 10 }, 'tabagent:follow-pages': true });
    window.pdfEvents = []; window.pdfPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.pdfPort.onMessage.addListener((event) => window.pdfEvents.push(event));
  }, origin);
  await harness.waitForFunction(() => window.pdfEvents.some((event) => event.type === 'history'));
  target = await context.newPage();
  for (const pathname of ['/sample.pdf', '/download']) {
    await open(pathname); assert.equal(await target.evaluate(() => document.contentType), 'application/pdf');
    const log = await run('summary'), results = log.filter((event) => event.type === 'tool_result');
    assert.ok(results.length >= 3, '全文应跨多段读取'); assert.ok(results.every((event) => event.ok), JSON.stringify(results));
    assert.ok(log.some((event) => event.type === 'assistant' && event.text.includes('END_OF_PDF_PAGE_TWO')));
    const source = log.filter((event) => event.type === 'sources').at(-1);
    assert.equal(source.pages.length, 1, '多段PDF读取应去重来源'); assert.ok(source.pages[0].url.startsWith(`${origin}${pathname}`));
    assert.equal(reports.at(-1).imageCount, 0);
  }
  console.log('✓ PDF全文：无需图片模型、2页多段读取到末尾、页码、无后缀识别与来源去重');
  assertFailed(await run('extract'), /PDF/);
  await harness.evaluate(async () => { const result = await chrome.storage.local.get('tabagent:settings'); await chrome.storage.local.set({ 'tabagent:settings': { ...result['tabagent:settings'], openaiVision: true } }); });
  const capture = await run('capture'); assert.equal(capture.find((event) => event.type === 'tool_result').ok, true);
  assert.equal(reports.at(-1).imageCount, 1, 'PDF截图功能应保持可用');
  await open('/html.pdf');
  for (const value of ['html-read', 'html-extract']) {
    const log = await run(value); assert.equal(log.find((event) => event.type === 'tool_result').ok, true);
    assert.ok(reports.at(-1).results.some((value) => value.includes('HTML_CAPABILITY_SENTINEL')));
  }
  await open('/scan.pdf'); assertFailed(await run('scan'), /扫描|OCR|文字识别|可提取/);
  await open('/encrypted.pdf'); assertFailed(await run('encrypted'), /密码|加密/);
  for (const [value, pattern] of [['unauthorized', /401|登录|授权|权限/], ['login', /PDF|登录|格式/], ['invalid', /PDF|损坏|解析|格式/], ['large', /20|大小|过大|上限|MB/]]) {
    await open('/controlled.pdf'); mode = value; assertFailed(await run(value), pattern);
    for (const response of heldResponses) response.destroy();
  }
  console.log('✓ PDF边界：截图保留、HTML扩展名不误判、扫描/加密/登录失效/损坏/超限明确失败');
  await open('/controlled.pdf');
  const outside = await context.newPage(); await outside.goto(`${origin}/outside.pdf`);
  outsideTabId = await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, `${origin}/outside.pdf`);
  assertFailed(await run('outside'), /不在.*范围/);
  mode = 'slow'; await start('cancel');
  for (let attempt = 0; !heldResponses.size && attempt < 150; attempt++) await sleep(50);
  assert.ok(heldResponses.size, '取消应发生在实际PDF下载期间');
  const requestsAtStop = modelRequests;
  await harness.evaluate(() => window.pdfPort.postMessage({ type: 'stop' }));
  const stopped = await waitIdle();
  for (const response of heldResponses) if (!response.destroyed) response.end(pdf.subarray(64));
  await sleep(250);
  assert.equal(modelRequests, requestsAtStop, '停止后不得继续发送PDF正文到模型');
  assert.ok(!stopped.some((event) => event.type === 'sources'));
  assert.equal(await harness.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId), true, '原页面保持打开');
  mode = 'normal';
  const resumed = await run('resumed');
  assert.equal(resumed.find((event) => event.type === 'tool_result').ok, true, '停止后新任务可以重新解析PDF');
  mode = 'slow'; await start('same-url-reload');
  for (let attempt = 0; !heldResponses.size && attempt < 150; attempt++) await sleep(50);
  assert.ok(heldResponses.size, '刷新应发生在实际PDF下载期间');
  mode = 'normal';
  await target.reload({ waitUntil: 'load' });
  for (const response of heldResponses) if (!response.destroyed) response.end(pdf.subarray(64));
  assertFailed(await waitIdle(), /页面|文档|刷新|变化|跳转/);
  console.log('✓ PDF范围与停止：范围外下载被拦截、下载中停止无后续发送、下一任务可恢复、同URL刷新拒绝旧结果');
} finally {
  await context?.close();
  for (const response of heldResponses) response.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(profile), temp = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('tabagent-pdf-capability-')) throw new Error('Unsafe profile cleanup');
  await fs.rm(resolved, { recursive: true, force: true });
}
