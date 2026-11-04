// Real-extension regressions for scope enforcement, approvals, long text and durable history.
// Build first: node node_modules/wxt/bin/wxt.mjs build && node tests/features.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const archiveKey = 'tabagent:conversations:v2';
let requestCount = 0;
let callNumber = 0;
let outsideTabId;
let lastBody;
let streamCancelled = false;
const streamReleases = new Map();
const form = '<!doctype html><meta charset="utf-8"><title>允许页面</title><button id="increment" onclick="document.querySelector(\'#count\').textContent=String(+document.querySelector(\'#count\').textContent+1)">增加一次</button><output id="count">0</output>';
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/v1/chat/completions') {
    const body = req.url === '/secret' ? '<title>不在范围的页面</title>PRIVATE_OUTSIDE_CONTENT' : req.url === '/long' ? `<meta charset="utf-8"><title>长文</title><p>${'前文内容'.repeat(1700)}END_OF_LONG_PAGE</p>` : form;
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }); res.end(body); return;
  }
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    requestCount++;
    try {
      const body = lastBody = JSON.parse(raw);
      const messages = body.messages;
      const current = messages.filter((message) => message.role === 'user').at(-1).content;
      // Restoring an interrupted turn can merge adjacent user messages.
      if (current.includes('验证部分回复恢复')) {
        assert.ok(!messages.some((message) => message.role === 'assistant' && String(message.content).includes('先显示这一段')));
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '未将中断回复作为完整上下文' }, finish_reason: 'stop' }] }));
        return;
      }
      if (current.startsWith('流式')) {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: 'assistant', content: '先显示这一段' });
        let complete = false;
        streamReleases.set(current.split('\n')[0], () => {
          if (res.destroyed) return;
          if (current.startsWith('流式残缺工具')) {
            chunk({ tool_calls: [{ index: 0, id: 'unfinished', type: 'function', function: { name: 'click', arguments: '{"element_id":' } }] });
            res.end();
          } else {
            chunk({ content: '，然后补齐回复。' });
            chunk({}, 'stop');
            complete = true;
            res.end('data: [DONE]\n\n');
          }
        });
        res.on('close', () => { streamReleases.delete(current.split('\n')[0]); if (!complete && current.startsWith('流式停止')) streamCancelled = true; });
        return;
      }
      const lastUser = messages.map((message) => message.role).lastIndexOf('user');
      const toolMessages = messages.slice(lastUser + 1).filter((message) => message.role === 'tool');
      const lastTool = toolMessages.at(-1)?.content ?? '';
      const call = (name, input) => ({ content: null, tool_calls: [{ id: `feature_${++callNumber}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
      let reply;
      if (current.startsWith('只读拦截')) {
        assert.equal(body.tools.some((tool) => tool.function.name === 'click'), false, '只读模式不应向模型提供修改工具');
        reply = call('click', { element_id: 1 }); // Deliberately violate the offered schema.
      } else if (current.startsWith('范围检查')) {
        if (!toolMessages.length) reply = call('list_tabs', {});
        else if (toolMessages.length === 1) {
          assert.ok(lastTool.includes('允许页面'));
          assert.ok(!lastTool.includes('不在范围的页面'));
          reply = call('read_page', { tab_id: outsideTabId });
        } else {
          assert.ok(lastTool.includes('不在本次任务范围'));
          reply = { content: '范围外读取已阻止' };
        }
      } else if (current.startsWith('长文读取')) {
        if (!toolMessages.length) reply = call('read_page', { text_only: true });
        else if (toolMessages.length === 1) {
          assert.ok(!lastTool.includes('END_OF_LONG_PAGE'));
          const offset = Number(lastTool.match(/next_offset: (\d+)/)?.[1]);
          assert.equal(offset, 6000);
          reply = call('read_page', { text_only: true, text_offset: offset });
        } else {
          assert.ok(lastTool.includes('END_OF_LONG_PAGE'));
          assert.ok(lastTool.includes('next_offset: null'));
          assert.ok(lastTool.includes('来源：http://127.0.0.1:'));
          reply = { content: '已读到长文末尾 END_OF_LONG_PAGE' };
        }
      } else if (current.startsWith('恢复上下文')) {
        assert.ok(messages.some((message) => message.role === 'user' && message.content.startsWith('批准操作')));
        assert.ok(messages.some((message) => message.role === 'assistant' && message.content.includes('操作成功完成')));
        assert.ok(current.includes('历史摘要'));
        reply = { content: '已恢复先前会话和已执行步骤' };
      } else if (current.startsWith('关闭最后页面')) {
        if (!toolMessages.length) reply = call('close_tab', { tab_id: Number(current.match(/关闭最后页面 (\d+)/)[1]) });
        else if (toolMessages.length === 1) reply = call('list_tabs', {});
        else {
          assert.equal(new Set(toolMessages.map((message) => message.tool_call_id)).size, toolMessages.length, '每个tool只能有一个结果');
          reply = { content: '最后页面已关闭，范围为空' };
        }
      } else {
        if (!toolMessages.length) reply = call('read_page', {});
        else if (toolMessages.length === 1) {
          const id = Number(lastTool.match(/\[(\d+)\] <button> "增加一次"/)?.[1]);
          assert.ok(id > 0, '应从快照获得真实元素编号');
          reply = call('click', { element_id: id });
        } else reply = { content: lastTool.startsWith('错误：') ? '页面已变化，操作未执行' : '操作成功完成' };
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...reply } }] }));
    } catch (error) {
      res.writeHead(500, cors); res.end(String(error)); console.error('mock assertion:', error);
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-feature-test-'));
const extensionPath = path.resolve('.output/chrome-mv3');
let context;
let harness;
let base;
const launch = async () => {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
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
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'history'));
};
const send = (request) => harness.evaluate((value) => window.agentPort.postMessage(value), request);
const events = () => harness.evaluate(() => window.agentEvents);
const archive = () => harness.evaluate(async (key) => {
  const index = (await chrome.storage.local.get(key))[key];
  const records = await chrome.storage.local.get(index.ids.map((id) => `tabagent:conversation:${id}`));
  return { ...index, items: index.ids.map((id) => records[`tabagent:conversation:${id}`]) };
}, archiveKey);
const waitArchive = async (predicate) => {
  const deadline = Date.now() + 15000;
  do {
    const value = await archive();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('等待持久化历史状态超时');
};
const clear = () => harness.evaluate(() => { window.agentEvents = []; });
const finished = () => harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'status' && event.running) && window.agentEvents.some((event) => event.type === 'status' && !event.running), undefined, { timeout: 15000 });
const waiting = async () => {
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'approval' && event.request));
  return harness.evaluate(() => window.agentEvents.findLast((event) => event.type === 'approval' && event.request).request);
};
const reset = async () => {
  await clear(); await send({ type: 'reset' });
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'history') && window.agentEvents.some((event) => event.type === 'status' && !event.running));
  await clear();
};
const task = async (text, tabId, mode = 'read-only') => { await reset(); await send({ type: 'run', text, mode, tabIds: [tabId] }); };
const getTabId = (url) => harness.evaluate(async (value) => (await chrome.tabs.query({})).find((tab) => tab.url === value).id, url);
let failed = false;
try {
  await launch();
  await harness.evaluate(async (url) => chrome.storage.local.set({ 'tabagent:settings': { provider: 'openai', openaiBaseUrl: `${url}/v1`, openaiApiKey: 'fake', openaiModel: 'mock', maxSteps: 10 } }), origin);
  const page = await context.newPage(); await page.goto(`${origin}/form`);
  const secret = await context.newPage(); await secret.goto(`${origin}/secret`);
  const long = await context.newPage(); await long.goto(`${origin}/long`);
  const tabId = await getTabId(`${origin}/form`);
  outsideTabId = await getTabId(`${origin}/secret`);
  const longId = await getTabId(`${origin}/long`);

  await task('流式正常完成', tabId);
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'assistant_delta' && event.text.includes('先显示')));
  assert.ok(!(await events()).some((event) => event.type === 'assistant'), '首段应在完整回复前到达');
  // Reconnect midway: a snapshot must include the accumulated partial reply.
  await harness.evaluate(() => {
    window.agentPort.disconnect();
    window.agentEvents = [];
    window.agentPort = chrome.runtime.connect({ name: 'tabagent:panel' });
    window.agentPort.onMessage.addListener((event) => window.agentEvents.push(event));
  });
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'assistant_delta') && window.agentEvents.some((event) => event.type === 'status' && event.running));
  streamReleases.get('流式正常完成')();
  await finished();
  assert.ok((await events()).some((event) => event.type === 'assistant_delta' && event.text.includes('先显示')));
  const fullReply = (await events()).filter((event) => event.type === 'assistant');
  assert.equal(fullReply.length, 1);
  assert.equal(fullReply[0].text, '先显示这一段，然后补齐回复。');

  await task('流式停止', tabId);
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'assistant_delta'));
  await send({ type: 'stop' }); await finished();
  const partial = (await events()).filter((event) => event.type === 'assistant');
  assert.equal(partial.length, 1);
  assert.equal(partial[0].text, '先显示这一段');
  assert.equal(partial[0].interrupted, true);
  await waitArchive((value) => value.items.find((item) => item.id === value.activeId).events.some((event) => event.type === 'assistant' && event.interrupted));
  assert.ok(streamCancelled, '停止应中断正在接收的模型响应');

  await task('流式残缺工具', tabId, 'confirm');
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'assistant_delta'));
  streamReleases.get('流式残缺工具')();
  await finished();
  assert.ok((await events()).some((event) => event.type === 'error'));
  assert.ok(!(await events()).some((event) => event.type === 'tool' || (event.type === 'approval' && event.request)), '不完整工具调用不得执行或请求审批');
  assert.equal(await page.textContent('#count'), '0');

  await task('只读拦截', tabId); await finished();
  assert.equal(await page.textContent('#count'), '0');
  assert.ok((await events()).some((event) => event.type === 'error' && event.message.includes('只读模式')));
  assert.ok(!(await events()).some((event) => event.type === 'approval' && event.request));

  await task('范围检查', tabId); await finished();
  assert.ok((await events()).some((event) => event.type === 'assistant' && event.text.includes('范围外读取已阻止')));
  assert.ok(!JSON.stringify(lastBody).includes('PRIVATE_OUTSIDE_CONTENT'));

  await task('长文读取', longId); await finished();
  assert.ok((await events()).some((event) => event.type === 'assistant' && event.text.includes('END_OF_LONG_PAGE')));

  await task('拒绝操作', tabId, 'confirm');
  let approval = await waiting();
  assert.ok(approval.description.includes('增加一次'));
  assert.equal(approval.guard, undefined, '原始DOM守卫不应发送给面板');
  await send({ type: 'approve', id: 'forged-id', approved: true });
  assert.equal(await page.textContent('#count'), '0');
  await send({ type: 'approve', id: approval.id, approved: false }); await finished();
  assert.equal(await page.textContent('#count'), '0');
  assert.ok((await events()).some((event) => event.type === 'notice' && event.message.includes('拒绝')));

  await task('批准操作', tabId, 'confirm'); approval = await waiting();
  assert.equal(await page.textContent('#count'), '0');
  await send({ type: 'approve', id: approval.id, approved: true }); await finished();
  assert.equal(await page.textContent('#count'), '1');
  const approvedId = (await archive()).activeId;

  await page.reload();
  await task('确认期间页面变化', tabId, 'confirm'); approval = await waiting();
  await page.evaluate(() => { document.querySelector('#increment').textContent = '另一个按钮'; });
  await send({ type: 'approve', id: approval.id, approved: true }); await finished();
  assert.equal(await page.textContent('#count'), '0');
  assert.ok((await events()).some((event) => event.type === 'tool_result' && !event.ok && event.summary.includes('变化')));

  await page.reload();
  await page.evaluate(() => document.querySelector('#increment').addEventListener('focus', () => { document.querySelector('#increment').textContent = '焦点触发了变化'; }));
  await task('准备阶段原子校验', tabId, 'confirm'); approval = await waiting();
  await send({ type: 'approve', id: approval.id, approved: true }); await finished();
  assert.equal(await page.textContent('#count'), '0', 'prepare/focus之后必须重新校验批准元素');

  const disposable = await context.newPage(); await disposable.goto(`${origin}/close`);
  const disposableId = await getTabId(`${origin}/close`);
  await task(`关闭最后页面 ${disposableId}`, disposableId, 'confirm'); approval = await waiting();
  await send({ type: 'approve', id: approval.id, approved: true }); await finished();
  assert.equal(disposable.isClosed(), true);
  assert.ok((await events()).some((event) => event.type === 'assistant' && event.text.includes('范围为空')));

  await page.reload();
  await task('重启待确认任务', tabId, 'confirm'); await waiting();
  const interruptedId = (await archive()).activeId;
  await waitArchive((value) => value.items.find((item) => item.id === value.activeId).state === 'waiting');
  const beforeRestart = requestCount;
  await context.close(); context = null;
  await launch();
  const restored = await archive();
  assert.equal(restored.activeId, interruptedId);
  assert.equal(restored.items.find((item) => item.id === interruptedId).state, 'interrupted');
  assert.ok(restored.items.find((item) => item.id === interruptedId).events.some((event) => event.type === 'notice' && event.message.includes('中断')));
  assert.ok(!(await events()).some((event) => event.type === 'approval' && event.request));
  assert.equal(requestCount, beforeRestart, '后台重启不应自行发模型请求或继续审批');

  await clear(); await send({ type: 'conversation_open', id: approvedId });
  await harness.waitForFunction((id) => window.agentEvents.some((event) => event.type === 'history' && event.conversationId === id), approvedId);
  assert.ok((await events()).find((event) => event.type === 'history').events.some((event) => event.type === 'assistant' && event.text.includes('操作成功完成')));
  const fresh = await context.newPage(); await fresh.goto(`${origin}/restored`);
  await clear(); await send({ type: 'run', text: '恢复上下文', mode: 'read-only', tabIds: [await getTabId(`${origin}/restored`)] }); await finished();
  assert.ok((await events()).some((event) => event.type === 'assistant' && event.text.includes('已恢复先前会话')));
  await clear(); await send({ type: 'conversation_rename', id: approvedId, title: '已验证的操作记录' });
  await harness.waitForFunction((id) => window.agentEvents.some((event) => event.type === 'conversations' && event.items.some((item) => item.id === id && item.title === '已验证的操作记录')), approvedId);
  await clear(); await send({ type: 'conversation_search', query: '操作成功完成' });
  await harness.waitForFunction((id) => window.agentEvents.some((event) => event.type === 'conversation_search' && event.query === '操作成功完成' && event.items.some((item) => item.id === id)), approvedId);
  assert.equal((await archive()).items.find((item) => item.id === approvedId).title, '已验证的操作记录');
  await clear(); await send({ type: 'conversation_delete', id: interruptedId });
  await waitArchive((value) => !value.items.some((item) => item.id === interruptedId));
  assert.ok(!(await archive()).items.some((item) => item.id === interruptedId));
  await task('流式重启恢复', await getTabId(`${origin}/restored`));
  await harness.waitForFunction(() => window.agentEvents.some((event) => event.type === 'assistant_delta'));
  const checkpoint = await waitArchive((value) => value.items.find((item) => item.id === value.activeId).pendingReply?.text === '先显示这一段');
  const requestsBeforeStreamRestart = requestCount;
  await context.close(); context = null; await launch();
  const afterStreamRestart = await archive();
  const recoveredReply = afterStreamRestart.items.find((item) => item.id === checkpoint.activeId);
  assert.equal(recoveredReply.state, 'interrupted');
  assert.equal(recoveredReply.pendingReply, undefined);
  assert.equal(recoveredReply.events.filter((event) => event.type === 'assistant' && event.interrupted && event.text === '先显示这一段').length, 1);
  assert.equal(requestCount, requestsBeforeStreamRestart, '流式恢复也不能自动重新请求模型');
  const restoredPage = await context.newPage(); await restoredPage.goto(`${origin}/after-stream-restart`);
  await clear(); await send({ type: 'run', text: '验证部分回复恢复', mode: 'read-only', tabIds: [await getTabId(`${origin}/after-stream-restart`)] }); await finished();
  assert.ok((await events()).some((event) => event.type === 'assistant' && event.text.includes('未将中断回复作为完整上下文')));
  console.log('✓ 功能回归通过：流式/停止/断流/重连与重启、只读/范围、分段来源、审批守卫、历史恢复/搜索/重命名/删除');
} catch (error) {
  failed = true;
  console.error('✗ 功能回归失败：', error);
  if (harness && !harness.isClosed()) console.error('事件：', JSON.stringify(await events(), null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  // Only remove the uniquely-created test profile under the OS temp directory.
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tabagent-feature-test-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
process.exitCode = failed ? 1 : 0;
