// 端到端测试：用本地“假模型”按剧本发出工具调用，验证插件能在真实 Chromium 里
// 读取页面、输入、点击、跨标签页提取表格，并把结果显示在侧边栏。
// 运行：npm run build && node tests/e2e.mjs
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = 8787;
const pages = {
  '/form.html': `<!doctype html><meta charset="utf-8"><title>报名表</title>
    <h1>报名</h1><label>姓名 <input id="name" placeholder="姓名"></label>
    <select id="city"><option>北京</option><option>上海</option></select>
    <button id="go" onclick="document.getElementById('result').textContent='你好，'+document.getElementById('name').value+'，城市：'+document.getElementById('city').value">提交</button>
    <p id="result"></p>`,
  '/table.html': `<!doctype html><meta charset="utf-8"><title>价格表</title>
    <table id="prices"><tr><th>商品</th><th>价格</th></tr><tr><td>苹果</td><td>5</td></tr><tr><td>香蕉</td><td>3</td></tr></table>`,
};

let step = 0;
let probeCalls = 0;
let markDelayedRequest;
let markDelayedResponse;
const delayedRequest = new Promise((resolve) => { markDelayedRequest = resolve; });
const delayedResponse = new Promise((resolve) => { markDelayedResponse = resolve; });
const calls = (...c) => c.map(([name, args], i) => ({ id: `call_${step}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
function lastTool(messages) {
  // 只取最近一轮（最后一条 assistant 之后）的工具结果
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  return messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
}
function script(messages) {
  step++;
  const prev = lastTool(messages);
  switch (step) {
    case 1:
      return { content: '我先看看页面。', tool_calls: calls(['read_page', {}]) };
    case 2: {
      const input = prev.match(/\[(\d+)\] <input type=text> "姓名"/)?.[1];
      const select = prev.match(/\[(\d+)\] <select>/)?.[1];
      const button = prev.match(/\[(\d+)\] <button> "提交"/)?.[1];
      if (!input || !select || !button) throw new Error('read_page 输出中找不到元素：\n' + prev);
      return {
        content: null,
        tool_calls: calls(
          ['type_text', { element_id: +input, text: '张三' }],
          ['select_option', { element_id: +select, option: '上海' }],
          ['click', { element_id: +button }],
        ),
      };
    }
    case 3:
      return { content: null, tool_calls: calls(['list_tabs', {}]) };
    case 4: {
      const tab = prev.match(/\[tab (\d+)\] 价格表/)?.[1];
      if (!tab) throw new Error('list_tabs 输出中找不到价格表：\n' + prev);
      return { content: null, tool_calls: calls(['extract', { selector: '#prices', tab_id: +tab }]) };
    }
    case 5: {
      const rows = prev.split('\n\n来源：')[0].replace(/^1\. /, '').split('\n').map((r) => '| ' + r.split('\t').join(' | ') + ' |');
      rows.splice(1, 0, '| --- | --- |');
      return { content: '已提交表单。价格表如下：\n\n' + rows.join('\n') };
    }
    default:
      return { content: '完成' };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    return res.end();
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { messages, tools, model } = JSON.parse(body);
        const respond = (reply) => {
          if (res.destroyed) return;
          const message = { role: 'assistant', ...reply };
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ choices: [{ message }] }));
        };
        if (tools[0]?.function?.name === 'tabagent_connection_probe') {
          probeCalls++;
          assert.equal(tools.length, 1);
          assert.equal(messages.length, 1);
          const probeReply = { tool_calls: [{ id: 'connection_probe', type: 'function', function: { name: 'tabagent_connection_probe', arguments: '{"value":"tabagent-ok"}' } }] };
          if (model === 'slow-probe') setTimeout(() => respond(probeReply), 600);
          else respond(probeReply);
          return;
        }
        if (tools.length < 10) throw new Error('工具定义缺失');
        const userText = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        if (userText.startsWith('延迟任务')) {
          markDelayedRequest();
          setTimeout(() => {
            respond({ content: '这条旧任务结果不应出现在新对话' });
            markDelayedResponse();
          }, 800);
          return;
        }
        if (userText.startsWith('新对话验证')) {
          respond({ content: '新对话任务已完成' });
          return;
        }
        const reply = script(messages);
        // 给输入下一条草稿留下确定的执行窗口，不依赖本机模型/网络速度。
        if (step === 1) setTimeout(() => respond(reply), 350);
        else respond(reply);
      } catch (err) {
        console.error('假模型出错：', err.message);
        res.writeHead(500, { 'access-control-allow-origin': '*' });
        res.end(err.message);
      }
    });
    return;
  }
  if (req.url.startsWith('/v1/messages')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { messages, tools, system } = JSON.parse(body);
      if (tools[0]?.name === 'tabagent_connection_probe') {
        probeCalls++;
        assert.equal(messages.length, 1);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'tabagent_connection_probe', input: { value: 'tabagent-ok' } }] }));
        return;
      }
      const last = messages.at(-1);
      const hasResult = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
      const ok = tools.length >= 10 && system && req.headers['x-api-key'] === 'sk-ant-test';
      const content = !ok
        ? [{ type: 'text', text: '请求格式不对' }]
        : hasResult
          ? [{ type: 'text', text: `Claude 路径正常：读到了「${last.content[0].content.match(/报名表/)?.[0]}」` }]
          : [{ type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { text_only: true } }];
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content,
        stop_reason: hasResult ? 'end_turn' : 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    return;
  }
  const page = pages[req.url];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page ?? 'not found');
});
await new Promise((r) => server.listen(PORT, r));

const extensionPath = path.resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: ['--no-proxy-server', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let failed = false;
try {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
  const sw = context.serviceWorkers().find(isOurs) ?? (await context.waitForEvent('serviceworker', { predicate: isOurs }));
  const base = 'chrome-extension://' + new URL(sw.url()).host;
  // 通过设置页填写配置，和真实用户一样
  const options = await context.newPage();
  await options.setViewportSize({ width: 1100, height: 1400 });
  await options.goto(`${base}/options.html`);
  await options.waitForSelector('#form[aria-busy="false"]');
  await options.check('input[value=openai]');
  await options.selectOption('#openai-service', 'custom');

  // 无效地址和任务步数必须阻止保存，并明确标出对应字段。
  await options.fill('input[name=openaiBaseUrl]', 'not-a-valid-url');
  await options.click('button[type=submit]');
  await options.waitForSelector('#openai-url-error:not([hidden])');
  assert.equal(await options.getAttribute('input[name=openaiBaseUrl]', 'aria-invalid'), 'true');
  assert.equal(await options.locator('#saved').isVisible(), false);
  await options.fill('input[name=openaiBaseUrl]', `http://localhost:${PORT}/v1`);
  for (const value of ['4', '201', '5.5']) {
    await options.fill('input[name=maxSteps]', value);
    await options.click('button[type=submit]');
    await options.waitForSelector('#max-steps-error:not([hidden])');
    assert.equal(await options.getAttribute('input[name=maxSteps]', 'aria-invalid'), 'true');
    assert.equal(await options.locator('#saved').isVisible(), false);
  }
  await options.fill('input[name=maxSteps]', '40');
  await options.fill('input[name=openaiApiKey]', 'x');
  await options.fill('input[name=openaiModel]', 'mock');

  const revealOpenAI = options.locator('.reveal-key[aria-controls="openai-key"]');
  assert.equal(await options.getAttribute('#openai-key', 'type'), 'password');
  await revealOpenAI.click();
  assert.equal(await options.getAttribute('#openai-key', 'type'), 'text');
  assert.equal(await revealOpenAI.getAttribute('aria-pressed'), 'true');
  await revealOpenAI.click();
  assert.equal(await options.getAttribute('#openai-key', 'type'), 'password');
  await revealOpenAI.click();
  await options.check('input[value=anthropic]');
  await options.selectOption('#anthropic-service', 'custom');
  await options.fill('input[name=anthropicApiKey]', 'sk-ant-test');
  await options.fill('input[name=anthropicBaseUrl]', `http://localhost:${PORT}`);
  await options.check('input[value=openai]');
  assert.equal(await options.inputValue('input[name=openaiApiKey]'), 'x', '切换服务后应保留密钥');
  assert.equal(await options.inputValue('input[name=openaiBaseUrl]'), `http://localhost:${PORT}/v1`);
  assert.equal(await options.inputValue('input[name=openaiModel]'), 'mock');
  assert.equal(await options.getAttribute('#openai-key', 'type'), 'password', '切换服务应收起已显示的密钥');
  await options.click('#test-connection');
  await options.waitForSelector('#connection-result[data-state="success"]');
  assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get('tabagent:settings'))['tabagent:settings']), undefined, '测试连接不应自动保存配置');
  await options.fill('input[name=openaiModel]', 'slow-probe');
  await options.waitForSelector('#connection-result[data-state="stale"]');
  await options.click('#test-connection');
  await options.waitForSelector('#connection-result[data-state="testing"]');
  await options.click('#cancel-test');
  await options.waitForSelector('#connection-result[data-state="cancelled"]');
  await options.fill('input[name=openaiModel]', 'mock');
  await options.click('#test-connection');
  await options.waitForSelector('#connection-result[data-state="success"]');
  await options.click('button[type=submit]');
  await options.waitForSelector('#saved:not([hidden])');
  await options.screenshot({ path: 'tests/options.png', fullPage: true });
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '窄屏设置页不应横向溢出');
  await options.screenshot({ path: 'tests/options-narrow.png', fullPage: true });
  await options.setViewportSize({ width: 1100, height: 1400 });
  await options.emulateMedia({ colorScheme: 'dark' });
  await options.screenshot({ path: 'tests/options-dark.png', fullPage: true });
  await options.emulateMedia({ colorScheme: 'light' });

  const tablePage = await context.newPage();
  await tablePage.goto(`http://localhost:${PORT}/table.html`);
  const formPage = (context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage()));
  await formPage.goto(`http://localhost:${PORT}/form.html`);
  await formPage.bringToFront();

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForLoadState();
  panel.on('console', (m) => console.log('[侧边栏]', m.text()));
  panel.on('pageerror', (e) => console.log('[侧边栏错误]', e.message));
  sw.on?.('console', (m) => console.log('[后台]', m.text()));
  await formPage.bringToFront();

  await panel.waitForSelector('#new-chat:enabled');
  await panel.waitForFunction(() => document.getElementById('model-name').textContent === 'mock');
  assert.equal(await panel.locator('#send').isDisabled(), true, '空输入应禁用发送');
  const example = panel.locator('#examples button').first();
  const examplePrompt = await example.getAttribute('data-prompt');
  await example.click();
  assert.equal(await panel.inputValue('#input'), examplePrompt, '示例应填入真实指令而非卡片文案');
  const draft = '这是一条关闭侧栏后还要继续编辑的草稿';
  await panel.fill('#input', draft);
  await panel.reload();
  await panel.waitForSelector('#new-chat:enabled');
  await panel.waitForFunction((expected) => document.getElementById('input').value === expected, draft);
  await panel.fill('#input', '');
  await formPage.bringToFront();
  await panel.waitForFunction(() => document.getElementById('page-title').textContent === '报名表');
  assert.equal(await panel.evaluate(() => document.getElementById('log').scrollTop), 0, '欢迎页应从顶部开始展示');
  await panel.screenshot({ path: 'tests/sidepanel-welcome.png' });

  // 用户明确选择操作模式和两张页面，本轮只能在这些页面内工作。
  assert.equal(await panel.inputValue('#task-mode'), 'read-only', '默认应为只读模式');
  await panel.selectOption('#task-mode', 'confirm');
  const scopedTabs = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => /\/(form|table)\.html$/.test(tab.url ?? '')).map((tab) => ({ id: tab.id, title: tab.title }));
  });
  assert.equal(scopedTabs.length, 2);
  await panel.click('#context-picker');
  await panel.check('#scope-selected');
  for (const tab of scopedTabs) await panel.check(`#scope-list input[value="${tab.id}"]`);
  await panel.click('#scope-apply');
  await panel.waitForFunction(() => document.getElementById('page-state').textContent === '2 页');
  await formPage.bringToFront();

  await panel.fill('#input', '帮我用张三报名，城市选上海，然后把价格表整理出来');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('#send.stop');
  const nextDraft = '下一条指令先写在这里，等当前任务完成';
  await panel.fill('#input', nextDraft);
  await panel.press('#input', 'Enter');
  await panel.waitForFunction(() => !document.getElementById('approval-card').hidden && document.getElementById('approval-description').textContent.startsWith('填写'));
  assert.equal(await formPage.inputValue('#name'), '', '填写操作在确认前不应执行');
  assert.equal(await formPage.inputValue('#city'), '北京');
  assert.equal(await panel.locator('#task-mode').isDisabled(), true, '运行中应锁定模式');
  assert.equal(await panel.locator('#context-picker').isDisabled(), true, '运行中应锁定范围');
  assert.equal(await panel.textContent('#approval-title'), '报名表');
  await panel.screenshot({ path: 'tests/sidepanel-approval.png' });
  await panel.waitForFunction(() => {
    const log = document.getElementById('log');
    return log.scrollHeight - log.scrollTop - log.clientHeight < 2;
  });
  // Reading earlier messages during an approval must survive the next card.
  await panel.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = 0; log.dispatchEvent(new Event('scroll')); });
  await panel.waitForSelector('#scroll-latest:not([hidden])');
  await panel.click('#approve-action');
  await panel.waitForFunction(() => !document.getElementById('approval-card').hidden && document.getElementById('approval-description').textContent.startsWith('选择选项'));
  assert.equal(await formPage.inputValue('#name'), '张三');
  assert.equal(await formPage.inputValue('#city'), '北京', '选择操作在确认前不应执行');
  assert.ok(await panel.evaluate(() => document.getElementById('log').scrollTop <= 1), '确认卡切换不应打断旧消息阅读');
  await panel.click('#scroll-latest');
  await panel.click('#approve-action');
  await panel.waitForFunction(() => !document.getElementById('approval-card').hidden && document.getElementById('approval-description').textContent.startsWith('点击'));
  assert.equal(await formPage.inputValue('#city'), '上海');
  assert.equal(await formPage.textContent('#result'), '', '提交操作在确认前不应执行');
  await panel.waitForFunction(() => {
    const log = document.getElementById('log');
    return log.scrollHeight - log.scrollTop - log.clientHeight < 2 && document.getElementById('scroll-latest').hidden;
  });
  await panel.click('#approve-action');
  await panel.waitForSelector('.msg.assistant table', { timeout: 30000 }).catch(async (err) => {
    console.error('侧边栏内容：', await panel.textContent('#log'));
    console.error('输入框：', JSON.stringify(await panel.inputValue('#input')), '发送按钮：', await panel.textContent('#send'));
    console.error('脚本：', await panel.evaluate(() => [...document.scripts].map((s) => s.src).join(',')));
    throw err;
  });

  const result = await formPage.textContent('#result');
  const tableText = await panel.textContent('.msg.assistant table');
  const toolRows = await panel.$$eval('.tool', (rows) => rows.map((r) => `${r.className}: ${r.textContent}`));
  console.log('工具调用：\n  ' + toolRows.join('\n  '));
  console.log('表单结果：', result);
  console.log('侧边栏表格：', tableText);
  if (result !== '你好，张三，城市：上海') throw new Error('表单没有被正确填写提交');
  if (!tableText.includes('苹果') || !tableText.includes('香蕉')) throw new Error('表格没有被提取');
  if (toolRows.some((r) => r.includes('fail'))) throw new Error('有工具调用失败');
  await panel.waitForSelector('#send:not(.stop)');
  assert.equal(await panel.inputValue('#input'), nextDraft, '执行中按 Enter 应保留草稿并继续当前任务');
  assert.equal((await panel.textContent('#log')).includes('已停止。'), false, '输入草稿不应停止任务');
  const firstTool = panel.locator('details.tool').first();
  const firstExecution = panel.locator('.execution-group').first();
  assert.equal(await firstExecution.getAttribute('open'), null, '完成后应收起执行过程，让结果更突出');
  await firstExecution.locator('.execution-summary').click();
  await firstTool.locator('summary').click();
  assert.equal(await firstTool.getAttribute('open'), '');
  assert.equal(await firstTool.locator('.tool-detail').isVisible(), true, '工具详情应能展开');
  await firstTool.locator('summary').click();
  await panel.bringToFront();
  const copyButton = panel.locator('.msg.assistant').filter({ has: panel.locator('table') }).locator('.copy-button');
  await copyButton.click();
  await panel.waitForFunction(() => [...document.querySelectorAll('.copy-button')].some((button) => button.textContent.includes('已复制')));
  await formPage.bringToFront();
  await panel.waitForFunction((titles) => document.getElementById('context-label').textContent === '本轮任务范围' && titles.every((title) => document.getElementById('page-title').textContent.includes(title)), scopedTabs.map((tab) => tab.title));
  await panel.screenshot({ path: process.env.SCREENSHOT ?? 'tests/sidepanel.png' });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: 'tests/sidepanel-dark.png' });
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.setViewportSize({ width: 320, height: 720 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '320px 侧栏不应横向溢出');
  await panel.screenshot({ path: 'tests/sidepanel-narrow.png' });
  await panel.setViewportSize({ width: 390, height: 844 });

  // reset 必须同步释放旧任务；等待中的旧响应不能进入刚创建的新对话。
  await formPage.bringToFront();
  await panel.click('#new-chat');
  await panel.fill('#input', '延迟任务');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('#send.stop');
  await Promise.race([
    delayedRequest,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('未收到延迟任务请求')), 5000); timer.unref(); }),
  ]);
  await panel.click('#new-chat');
  await panel.waitForSelector('#send:not(.stop)');
  await panel.fill('#input', '新对话验证');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('.msg.assistant:has-text("新对话任务已完成")');
  await delayedResponse;
  await panel.waitForTimeout(100);
  assert.equal((await panel.textContent('#log')).includes('这条旧任务结果不应出现在新对话'), false);
  assert.equal((await panel.textContent('#log')).includes('已停止。'), false, '旧任务停止提示不应进入新对话');
  assert.equal(await panel.locator('.msg.user').count(), 1, '新对话不应残留旧任务消息');

  // 第二段：切换到 Claude（指向本地假接口），验证 Anthropic SDK 在插件后台可用
  await options.bringToFront();
  await options.check('input[value=anthropic]');
  assert.equal(await options.inputValue('input[name=anthropicApiKey]'), 'sk-ant-test', '隐藏服务配置保存后应仍然保留');
  assert.equal(await options.inputValue('input[name=anthropicBaseUrl]'), `http://localhost:${PORT}`);
  await options.fill('input[name=anthropicApiKey]', 'sk-ant-test');
  await options.fill('input[name=anthropicBaseUrl]', `http://localhost:${PORT}`);
  await options.click('#test-connection');
  await options.waitForSelector('#connection-result[data-state="success"]');
  await options.click('button[type=submit]');
  await options.waitForSelector('#saved:not([hidden])');
  await formPage.bringToFront();
  // 不重建对话，验证保存后的 provider 在下一条指令就生效。
  await panel.waitForFunction(() => document.getElementById('model-name').textContent === 'claude-opus-5-5');
  await panel.fill('#input', '读一下这个页面');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('.msg.assistant:has-text("Claude 路径")', { timeout: 30000 }).catch(async (err) => {
    console.error('侧边栏内容：', await panel.textContent('#log'));
    throw err;
  });
  const claudeReply = await panel.textContent('.msg.assistant:has-text("Claude 路径")');
  console.log('Claude 回复：', claudeReply);
  if (!claudeReply.includes('报名表')) throw new Error('Claude 路径没有读到页面');
  await panel.waitForSelector('#send:not(.stop)');

  // 历史任务与每个会话的草稿分开保存，恢复旧会话不会重复执行任务。
  await panel.click('#open-history');
  const firstConversation = panel.locator('.history-item').filter({ hasText: '帮我用张三报名，城市选上海，然后把价格表整理出来' });
  await firstConversation.waitFor();
  const firstConversationId = await firstConversation.getAttribute('data-conversation-id');
  const currentConversation = panel.locator('.history-open[aria-current="true"]');
  const currentConversationId = await currentConversation.getAttribute('data-conversation-id');
  assert.notEqual(firstConversationId, currentConversationId);
  await panel.screenshot({ path: 'tests/sidepanel-history.png' });
  await firstConversation.locator('.history-open').click();
  await panel.waitForSelector('.msg.assistant table');
  await panel.waitForFunction((expected) => document.getElementById('input').value === expected, nextDraft);
  assert.equal((await panel.textContent('#log')).includes('Claude 路径'), false, '旧会话不应混入新会话回复');
  assert.equal(await formPage.textContent('#result'), '你好，张三，城市：上海');
  await panel.click('#open-history');
  await panel.locator(`.history-open[data-conversation-id="${currentConversationId}"]`).click();
  await panel.waitForSelector('.msg.assistant:has-text("Claude 路径")');
  assert.equal(await panel.inputValue('#input'), '', '新会话不应带入旧会话草稿');
  assert.equal(await panel.locator('.msg.assistant table').count(), 0);

  // 删除需要二次确认，首次点击只展示确认入口。
  await panel.click('#open-history');
  const delayedConversation = panel.locator('.history-item').filter({ hasText: '延迟任务' });
  const delayedConversationId = await delayedConversation.getAttribute('data-conversation-id');
  await delayedConversation.locator('.history-delete').click();
  assert.equal(await panel.locator(`.history-item[data-conversation-id="${delayedConversationId}"]`).count(), 1);
  await panel.locator(`.history-item[data-conversation-id="${delayedConversationId}"] [data-conversation-action="confirm-delete"]`).click();
  await panel.waitForSelector(`.history-item[data-conversation-id="${delayedConversationId}"]`, { state: 'detached' });
  await panel.click('#close-history');
  assert.ok(probeCalls >= 3, '两种服务的连接探针均应独立执行');
  console.log('✓ 端到端测试通过');
} catch (err) {
  failed = true;
  console.error('✗ 测试失败：', err);
} finally {
  await context.close();
  server.close();
}
process.exit(failed ? 1 : 0);
