// Launch Chromium directly, WITHOUT Playwright/CDP/debugger attachment. Attaching
// to an extension service worker would hide the exact idle-termination bug here.
// The temporary harness reports events to a local server; all model calls are local.
// Build first. Optional baseline: --extension <old-build> --expect-interruption
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const expectedInterruption = process.argv.includes('--expect-interruption');
const extensionArg = process.argv.indexOf('--extension');
const source = path.resolve(extensionArg < 0 ? '.output/chrome-mv3' : process.argv[extensionArg + 1]);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-lifetime-browser-'));
const extension = path.join(temporary, 'extension');
const profile = path.join(temporary, 'profile');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reports = [];
const timers = new Set();
const sockets = new Set();
let calls = 0;
let started;
let child;
let timeout;
let stderr = '';
let complete;
const completion = new Promise((resolve) => { complete = resolve; });
const server = http.createServer((req, res) => {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  let body = '';
  req.on('data', (part) => { body += part; });
  req.on('end', () => {
    if (req.url === '/report') {
      const report = JSON.parse(body);
      reports.push(report);
      res.writeHead(200, headers); res.end('{}');
      if (report.type === 'complete') complete(report);
      return;
    }
    if (req.url === '/v1/chat/completions') {
      calls++;
      started = Date.now();
      console.log('… 已进入无调试器的40秒静默模型请求');
      // No response headers, chunks, page events or extension calls for 40s.
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '长请求完成，任务保持运行。' }, finish_reason: 'stop' }] }));
      }, 40000);
      timers.add(timer);
      return;
    }
    res.writeHead(404, headers); res.end('{}');
  });
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  await fs.cp(source, extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' });
  manifest.key = key.toString('base64');
  const id = [...createHash('sha256').update(key).digest('hex').slice(0, 32)]
    .map((hex) => String.fromCharCode(97 + parseInt(hex, 16))).join('');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  // Starting an extension URL on the very first browser launch can race the
  // unpacked extension registration. Open the harness after installation.
  const backgroundPath = path.join(extension, manifest.background.service_worker);
  const background = await fs.readFile(backgroundPath, 'utf8');
  await fs.writeFile(backgroundPath, `chrome.runtime.onInstalled.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('/lifetime-test.html') }); });\n${background}`);
  await fs.writeFile(path.join(extension, 'lifetime-test.html'), '<!doctype html><meta charset="utf-8"><title>Task lifetime test</title><script src="lifetime-test.js" defer></script>');
  await fs.writeFile(path.join(extension, 'lifetime-test.js'), `
    const origin = ${JSON.stringify(origin)};
    const report = (value) => fetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }).catch(() => {});
    let sent = false, done = false, reconnected = false, port;
    const events = [];
    const finish = async (reason) => {
      if (done) return;
      done = true;
      await report({ type: 'complete', reason, events });
    };
    function connect() {
      port = chrome.runtime.connect({ name: 'tabagent:panel' });
      port.onMessage.addListener((event) => {
        events.push(event);
        if (event.type === 'history') {
          if (reconnected) { void finish('reconnected'); return; }
          if (!sent) {
            sent = true;
            port.postMessage({ type: 'run', text: '长模型请求生命周期回归', mode: 'read-only' });
          }
        }
        if (event.type === 'status' && !event.running && events.some((item) => item.type === 'status' && item.running)) void finish('idle');
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        events.push({ type: 'disconnect', error });
        if (!done && !reconnected) { reconnected = true; setTimeout(connect, 250); }
      });
    }
    (async () => {
      await chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: origin + '/v1', openaiApiKey: 'fake', openaiModel: 'mock', maxSteps: 2 } });
      await report({ type: 'ready' });
      connect();
      setTimeout(() => void finish('harness-timeout'), 65000);
    })().catch((error) => void report({ type: 'complete', reason: 'harness-error', error: error.message, events }));
  `);
  // windowsHide keeps the disposable browser out of the user's desktop. The
  // browser has no remote debugging port/pipe and is never connected to CDP.
  child = spawn(chromium.executablePath(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--disable-features=AutoDeElevate', '--no-sandbox',
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-4000); });
  child.on('error', (error) => complete({ reason: 'launch-error', error: error.message }));
  child.on('exit', (code) => complete({ reason: 'browser-exit', code }));
  const result = await Promise.race([completion, new Promise((resolve) => { timeout = setTimeout(() => resolve({ reason: 'runner-timeout' }), 80000); })]);
  assert.equal(calls, 1, `model request count; result=${JSON.stringify(result)}; reports=${JSON.stringify(reports)}; stderr=${stderr}`);
  assert.ok(started);
  if (expectedInterruption) {
    assert.ok(result.events?.some((event) => event.type === 'disconnect'), JSON.stringify(result));
    assert.ok(result.events?.some((event) => event.type === 'history' && event.state === 'interrupted'), JSON.stringify(result));
    assert.ok(!result.events?.some((event) => event.type === 'assistant' && event.text.includes('长请求完成')), JSON.stringify(result));
    console.log('✓ 旧版真实复现：无调试器，40秒静默模型请求期间后台终止，重连后任务为interrupted');
  } else {
    assert.equal(result.reason, 'idle', JSON.stringify(result));
    assert.ok(Date.now() - started >= 39000, 'the real request must cross the 30-second idle window');
    assert.ok(result.events?.some((event) => event.type === 'assistant' && event.text.includes('长请求完成')), JSON.stringify(result));
    assert.ok(!result.events?.some((event) => event.type === 'disconnect' || (event.type === 'history' && event.state === 'interrupted')), JSON.stringify(result));
    assert.ok(!result.events?.some((event) => event.type === 'error'), JSON.stringify(result));
    console.log('✓ 任务后台存活：无CDP/Playwright附加，真实40秒静默模型请求完成且无后台中断');
  }
} finally {
  clearTimeout(timeout);
  for (const timer of timers) clearTimeout(timer);
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(5000)]);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  if (path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('tabagent-lifetime-browser-')) {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
