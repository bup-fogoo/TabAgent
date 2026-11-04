// Native-PDF boundary regression: a built extension, generated PDF, local model.
// No external API, personal profile, or user document is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

function minimalPdf() {
  const stream = 'BT /F1 24 Tf 70 700 Td (PDF_CAPABILITY_SENTINEL) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
const pdf = minimalPdf();
let scenario = 'read_page';
let documentCase = '';
let tabId;
const reports = [];
let serverFailure;
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== 'POST') {
    if (req.url === '/html.pdf') {
      res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>HTML despite PDF suffix</title><h1>HTML_CAPABILITY_SENTINEL</h1>');
    } else {
      res.writeHead(200, { ...cors, 'content-type': 'application/pdf', 'content-length': pdf.length }); res.end(pdf);
    }
    return;
  }
  let raw = ''; req.on('data', (part) => raw += part);
  req.on('end', () => {
    try {
    const body = JSON.parse(raw);
    const userIndex = body.messages.findLastIndex((message) => message.role === 'user' && typeof message.content === 'string');
    const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool');
    const imageCount = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((item) => item.type === 'image_url') : []).length;
    if (results.length) reports.push({ documentCase, scenario, results: results.map((item) => item.content), imageCount });
    const message = results.length ? { role: 'assistant', content: '本地验证结束' } : { role: 'assistant', content: null, tool_calls: [{ id: `pdf-${scenario}`, type: 'function', function: { name: scenario, arguments: JSON.stringify({ tab_id: tabId, ...(scenario === 'read_page' ? { text_only: true } : scenario === 'extract' ? { selector: 'h1' } : {}) }) } }] };
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: results.length ? 'stop' : 'tool_calls' }] }));
    } catch (error) {
      serverFailure = error;
      res.writeHead(500, cors); res.end('Local fixture failed');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-pdf-capability-'));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const ours = (worker) => worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(ours) ?? await context.waitForEvent('serviceworker', { predicate: ours });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await harness.evaluate(async (origin) => {
    await chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${origin}/v1`, openaiModel: 'pdf-probe', openaiApiKey: 'local-fake', openaiVision: true, maxSteps: 4 }, 'tabagent:follow-pages': true });
    window.pdfEvents = [];
    window.pdfPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.pdfPort.onMessage.addListener((event) => window.pdfEvents.push(event));
  }, origin);
  await harness.waitForFunction(() => window.pdfEvents.some((event) => event.type === 'history'));
  const target = await context.newPage();
  for (const pathname of ['/sample.pdf', '/download', '/html.pdf']) {
    documentCase = pathname;
    const nativePdf = pathname !== '/html.pdf';
    const url = `${origin}${pathname}`;
    await target.goto(url, { waitUntil: 'load' });
    assert.equal(await target.evaluate(() => document.contentType), nativePdf ? 'application/pdf' : 'text/html');
    tabId = await harness.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, url);
    assert.ok(Number.isInteger(tabId));
    await harness.waitForFunction(async (tabId) => {
      const tab = await chrome.tabs.get(tabId); return tab.status === 'complete' && !tab.pendingUrl;
    }, tabId);
    for (const tool of nativePdf ? ['read_page', 'extract', 'capture_page'] : ['read_page', 'extract']) {
      scenario = tool;
      const reportCount = reports.length;
      await target.bringToFront();
      await harness.evaluate(({ tool, tabId, pathname }) => {
        window.pdfEvents = [];
        window.pdfPort.postMessage({ type: 'run', text: `PDF regression ${pathname} ${tool}`, mode: 'read-only', tabIds: [tabId] });
      }, { tool, tabId, pathname });
      await harness.waitForFunction(() => window.pdfEvents.some((event) => event.type === 'user') && window.pdfEvents.some((event) => event.type === 'status' && !event.running), null, { timeout: 25000 });
      if (serverFailure) throw serverFailure;
      const events = await harness.evaluate(() => window.pdfEvents);
      assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events));
      const result = events.find((event) => event.type === 'tool_result');
      assert.ok(result, `${pathname} ${tool} must execute`);
      assert.equal(reports.length, reportCount + 1, 'one result round trip per task');
      const report = reports.at(-1);
      assert.equal(report.documentCase, pathname);
      if (tool === 'capture_page') {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(report.imageCount, 1, 'native PDF viewport can still be sent as an image');
        assert.ok(report.results.some((text) => text.includes('仅当前可视区域')));
      } else if (nativePdf) {
        assert.equal(result.ok, false, 'native PDF must not claim empty text was successfully read');
        assert.match(result.summary, /PDF/i, 'native PDF failure must identify the document limitation');
        assert.equal(report.imageCount, 0);
        assert.ok(report.results.every((text) => !text.includes('已读到正文末尾')));
        assert.ok(!events.some((event) => event.type === 'sources'), 'failed PDF text read must not add an actual-read source');
      } else {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(report.results.some((text) => text.includes('HTML_CAPABILITY_SENTINEL')), '.pdf suffix must not block genuine HTML');
        assert.equal(report.imageCount, 0);
      }
      assert.equal(await harness.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId), true, 'original PDF/HTML tab stays active and open');
    }
  }
  console.log('✓ PDF边界：原生PDF正文/提取明确失败、可见区域截图可用、无扩展名PDF识别、.pdf后缀HTML正常读取');
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(profile), temp = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('tabagent-pdf-capability-')) throw new Error('Unsafe profile cleanup');
  await fs.rm(resolved, { recursive: true, force: true });
}
