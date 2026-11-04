// Layout-only checks use shipped markup/CSS and local fixture content. No model or user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';

const output = path.resolve('.output/chrome-mv3');
const icons = ts.transpileModule((await fs.readFile('lib/icons.ts', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(output, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(output + path.sep)) throw new Error('Outside fixture');
    let body = await fs.readFile(file);
    if (file.endsWith('.html')) body = body.toString().replace(/<script[\s\S]*?<\/script>/g, '');
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const problems = [];
let checks = 0;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/sidepanel.html`);
  await page.addScriptTag({ content: icons + '\nmountIcons();' });
  await page.evaluate(() => {
    window.auditInitial = document.body.innerHTML;
    window.auditFixture = (state) => {
      document.body.innerHTML = window.auditInitial;
      const byId = (id) => document.getElementById(id);
      byId('page-title').textContent = '这里是完整的长页面标题：网页搜索与参考资料整理，显示当前正在处理的页面';
      byId('page-state').hidden = false; byId('page-state').textContent = '受限页面';
      byId('model-name').textContent = 'openai/long-model-name-with-reasoning';
      byId('follow-pages').disabled = false;
      byId('send').disabled = false;
      if (state === 'welcome') return;
      byId('empty').hidden = true;
      byId('log').insertAdjacentHTML('beforeend', '<div class="msg user">查找有关浏览器助手的资料，比较页面功能。</div><div class="msg assistant"><div class="assistant-heading">TabAgent</div><div class="message-content"><p>已查看相关网页，下面是整理后的结果。</p><p>较长的链接应正常换行：https://example.com/research/' + 'long-path-'.repeat(15) + '</p></div></div>');
      if (state === 'running' || state === 'kept' || state === 'approval') {
        byId('keep-page').hidden = false;
        byId('context-label').textContent = '正在读取';
        byId('page-state').textContent = '临时页面';
        byId('task-status').textContent = '正在处理';
        document.querySelector('.task-status').hidden = false;
        byId('send').classList.add('stop');
      }
      if (state === 'kept') { byId('keep-page').disabled = true; byId('keep-page').innerHTML = '<span data-icon="check"></span><span>已保留</span>'; }
      if (state === 'error') byId('log').insertAdjacentHTML('beforeend', '<div class="msg error"><strong>这一步没有完成</strong><p>网页暂时不可读取，请重新选择页面。</p><div class="error-actions"><button>编辑指令</button><button>检查设置</button></div></div>');
      if (state === 'references') byId('log').insertAdjacentHTML('beforeend', '<details class="reference-pages" open><summary class="reference-summary"><span data-icon="page"></span><span>参考页面 · 3</span><span data-icon="chevron-down" class="disclosure-icon"></span></summary><ul class="reference-list">' + [1, 2, 3].map((id) => '<li class="reference-page"><button class="reference-open"><span class="reference-text"><span class="reference-title">' + id + '. 很长的参考页面标题：搜索、阅读和重新打开页面</span><span class="reference-site">example.com · 搜索</span></span><span data-icon="arrow-up-right"></span></button></li>').join('') + '</ul><button class="reference-open-all">全部打开</button></details>');
      if (state === 'approval') {
        byId('approval-card').hidden = false;
        byId('approval-description').textContent = '填写目标页面中的表单，并提交搜索请求。';
        byId('approval-title').textContent = '表单页面';
        byId('approval-url').textContent = 'https://example.com/' + 'long-path-'.repeat(20);
      }
      if (state === 'scope') {
        byId('scope-current').checked = false; byId('scope-selected').checked = true;
        byId('scope-list').hidden = false; byId('scope-search-wrap').hidden = false;
        byId('scope-list').innerHTML = [1, 2, 3, 4].map((id) => '<label class="scope-tab"><input type="checkbox"><span class="scope-tab-text"><strong>参考网页 ' + id + ' - 较长的网页标题和名称</strong><small>https://example.com/' + 'long-path-'.repeat(15) + '</small></span></label>').join('');
        byId('scope-options').showModal();
      }
      if (state === 'history') {
        byId('history-empty').hidden = true;
        byId('history-list').innerHTML = [1, 2, 3].map((id) => '<div class="history-item"><button class="history-open"><strong>查找和整理浏览器相关参考资料与详细内容 ' + id + '</strong><span class="history-meta">11月4日 · 已完成</span></button><div class="history-actions"><button class="history-rename" aria-label="重命名"><span data-icon="edit"></span></button><button class="history-delete" aria-label="删除"><span data-icon="trash"></span></button></div></div>').join('');
        byId('history-dialog').showModal();
      }
      if (state === 'export') byId('export-dialog').showModal();
      mountIcons();
    };
  });
  for (const width of [260, 320, 360, 420]) for (const height of [480, 760]) for (const font of [16, 24, 32]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((size) => document.documentElement.style.fontSize = `${size}px`, font);
    for (const state of ['welcome', 'running', 'kept', 'references', 'error', 'approval', 'scope', 'history', 'export']) {
      await page.evaluate((value) => window.auditFixture(value), state);
      const faults = await page.evaluate((state) => {
        const issues = [];
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('document overflows horizontally');
        const title = rect('#page-title');
        if (title.width < Math.min(70, innerWidth * .25)) issues.push(`page title squeezed to ${Math.round(title.width)}px`);
        const controls = rect('.context-controls');
        for (const selector of ['#context-picker', '#follow-pages', '#keep-page']) {
          if (document.querySelector(selector).hidden) continue;
          const box = rect(selector);
          if (box.left < controls.left - 1 || box.right > controls.right + 1 || box.top < controls.top - 1 || box.bottom > controls.bottom + 1) issues.push(`${selector} outside page toolbar`);
        }
        const dialog = document.querySelector('dialog[open]');
        if (dialog && dialog.scrollWidth > dialog.clientWidth + 1) issues.push('dialog overflows horizontally');
        if (state !== 'welcome') {
          if (document.documentElement.scrollHeight > innerHeight + 1) issues.push('conversation document overflows vertically');
          if (rect('#log').height < 64) issues.push(`conversation viewport only ${Math.round(rect('#log').height)}px`);
          const composer = rect('.composer-area');
          if (composer.bottom > innerHeight + 1) issues.push('composer below screen');
        }
        if (state === 'approval') {
          const description = rect('#approval-description'), actions = rect('.approval-actions');
          if (actions.top < description.bottom && actions.bottom > description.top) issues.push('approval buttons cover operation description');
        }
        return issues;
      }, state);
      checks++;
      if (faults.length) problems.push({ width, height, font, theme, state, faults });
      if ((width === 360 && height === 760 && font === 16 && ['running', 'references'].includes(state)) || (width === 320 && height === 480 && font === 32 && theme === 'dark' && ['running', 'scope', 'approval'].includes(state))) {
        await page.screenshot({ path: `tests/audit-${state}-${width}-${height}-${font}-${theme}.png`, animations: 'disabled' });
      }
    }
  }
  console.log(JSON.stringify({ checks, problems }, null, 2));
  assert.equal(problems.length, 0, '视觉矩阵中存在溢出或不可用布局');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
}
