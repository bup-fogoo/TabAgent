// 端到端测试：用本地“假模型”按剧本发出工具调用，验证插件能在真实 Chromium 里
// 读取页面、输入、点击、跨标签页提取表格，并把结果显示在侧边栏。
// 运行：npm run build && node tests/e2e.mjs
import http from 'node:http';
import path from 'node:path';
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
      const rows = prev.replace(/^1\. /, '').split('\n').map((r) => '| ' + r.split('\t').join(' | ') + ' |');
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
        const { messages, tools } = JSON.parse(body);
        if (tools.length < 10) throw new Error('工具定义缺失');
        const message = { role: 'assistant', ...script(messages) };
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ choices: [{ message }] }));
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
  const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
  const sw = context.serviceWorkers().find(isOurs) ?? (await context.waitForEvent('serviceworker', { predicate: isOurs }));
  const base = 'chrome-extension://' + new URL(sw.url()).host;
  // 通过设置页填写配置，和真实用户一样
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.check('input[value=openai]');
  await options.fill('input[name=openaiBaseUrl]', `http://localhost:${PORT}/v1`);
  await options.fill('input[name=openaiApiKey]', 'x');
  await options.fill('input[name=openaiModel]', 'mock');
  await options.click('button[type=submit]');
  await options.waitForSelector('#saved:not([hidden])');

  const tablePage = await context.newPage();
  await tablePage.goto(`http://localhost:${PORT}/table.html`);
  const formPage = (context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage()));
  await formPage.goto(`http://localhost:${PORT}/form.html`);
  await formPage.bringToFront();

  const panel = await context.newPage();
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForLoadState();
  panel.on('console', (m) => console.log('[侧边栏]', m.text()));
  panel.on('pageerror', (e) => console.log('[侧边栏错误]', e.message));
  sw.on?.('console', (m) => console.log('[后台]', m.text()));
  await formPage.bringToFront();

  await panel.fill('#input', '帮我用张三报名，城市选上海，然后把价格表整理出来');
  await panel.press('#input', 'Enter');
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
  await panel.screenshot({ path: process.env.SCREENSHOT ?? 'tests/sidepanel.png' });

  // 第二段：切换到 Claude（指向本地假接口），验证 Anthropic SDK 在插件后台可用
  await options.bringToFront();
  await options.check('input[value=anthropic]');
  await options.fill('input[name=anthropicApiKey]', 'sk-ant-test');
  await options.fill('input[name=anthropicBaseUrl]', `http://localhost:${PORT}`);
  await options.click('button[type=submit]');
  await formPage.bringToFront();
  await panel.click('#new-chat');
  await panel.fill('#input', '读一下这个页面');
  await panel.press('#input', 'Enter');
  await panel.waitForSelector('.msg.assistant:has-text("Claude 路径")', { timeout: 30000 }).catch(async (err) => {
    console.error('侧边栏内容：', await panel.textContent('#log'));
    throw err;
  });
  const claudeReply = await panel.textContent('.msg.assistant:has-text("Claude 路径")');
  console.log('Claude 回复：', claudeReply);
  if (!claudeReply.includes('报名表')) throw new Error('Claude 路径没有读到页面');
  console.log('✓ 端到端测试通过');
} catch (err) {
  failed = true;
  console.error('✗ 测试失败：', err);
} finally {
  await context.close();
  server.close();
}
process.exit(failed ? 1 : 0);
