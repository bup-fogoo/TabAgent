// Production temporary-page ownership and cleanup with controlled browser races.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { chromium } from 'playwright';

const compile = (text) => ts.transpileModule(text.replace(/^import[^\n]+\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const toolCode = compile(await fs.readFile(new URL('../lib/tool-policy.ts', import.meta.url), 'utf8'))
  + compile(await fs.readFile(new URL('../lib/tools.ts', import.meta.url), 'utf8'));
const contentCode = compile(await fs.readFile(new URL('../entrypoints/content.ts', import.meta.url), 'utf8'));

async function setup(follow = true) {
  const tabs = new Map([
    [1, { id: 1, windowId: 9, groupId: -1, url: 'https://original.test/', title: 'Original', active: true, pinned: false }],
    [2, { id: 2, windowId: 9, groupId: -1, url: 'https://unrelated.test/', title: 'Unrelated', active: false, pinned: false }],
  ]);
  const states = new Map();
  const calls = { removed: [], updated: [], sources: [], targets: [] };
  const hooks = {};
  let nextId = 10;
  const browser = { tabs: {
    query: async (query) => [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || query.windowId === tab.windowId)),
    get: async (id) => { if (!tabs.has(id)) throw new Error('No tab with id'); return { ...tabs.get(id) }; },
    create: async (options) => {
      const id = nextId++;
      const tab = { id, ...options, groupId: -1, title: 'Read result', pinned: false };
      tabs.set(id, tab);
      states.set(id, { documentId: `document-${id}`, userEdited: false });
      return { ...tab };
    },
    update: async (id, options) => {
      calls.updated.push({ id, ...options });
      if (options.active) for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
      Object.assign(tabs.get(id), options);
      await hooks.update?.(id, options);
      return { ...tabs.get(id) };
    },
    remove: async (id) => { calls.removed.push(id); tabs.delete(id); },
    sendMessage: async (id, message) => {
      const tab = tabs.get(id), state = states.get(id);
      const action = message.request.action;
      if (action === 'ping') return { ok: true, result: 'pong' };
      if (action === 'research_status') {
        await hooks.status?.(id);
        if (state.missing) throw new Error('Receiving end does not exist');
        return { ok: true, result: { url: tab.url, documentId: state.documentId, userEdited: state.userEdited } };
      }
      if (action === 'snapshot') return { ok: true, result: { url: tab.url, title: tab.title, documentId: state?.documentId ?? `document-${id}`, text: 'Actual page text', textOffset: 0, nextOffset: null, totalTextChars: 16, scroll: '无需滚动' } };
      if (action === 'extract') return { ok: true, result: { url: tab.url, title: tab.title, documentId: state?.documentId ?? `document-${id}`, items: ['Actual item'] } };
      throw new Error(`Unexpected action ${action}`);
    },
  }, windows: { get: async (id) => ({ id, focused: true }) } };
  const capturePageScreenshot = async (id) => {
    await hooks.capture?.(id);
    const tab = tabs.get(id);
    return { title: tab.title, url: tab.url, image: { width: 100, height: 100, mediaType: 'image/jpeg', data: 'mock' } };
  };
  const runtime = vm.createContext({ browser, capturePageScreenshot, URL, DOMException, AbortController, setTimeout, clearTimeout, crypto: webcrypto, TextEncoder, CONTENT_MESSAGE_TAG: 'tabagent:content' });
  vm.runInContext(`${toolCode}\nwaitForLoad = async (_id, signal) => { signal.throwIfAborted(); }; globalThis.Subject = BrowserContext;`, runtime);
  const view = { followPages: () => follow, onSource: (source) => calls.sources.push(source), onTarget: (target) => calls.targets.push(target) };
  const ctx = await runtime.Subject.fromScope([1], view);
  const signal = new AbortController().signal;
  const create = async (kind = 'open_search_result', read = true) => {
    const id = await ctx.createResearchTab(`https://result.test/${nextId}`, signal, kind);
    if (read) await ctx.execute('read_page', { tab_id: id, text_only: true }, signal);
    return id;
  };
  return { ctx, browser, tabs, states, calls, hooks, create, signal, setFollow: (enabled) => { follow = enabled; } };
}

{
  const h = await setup();
  const search = await h.create('search_web');
  const article = await h.create();
  assert.equal(h.calls.sources[0].kind, 'search');
  assert.equal(h.calls.sources[1].kind, 'page');
  assert.equal(h.calls.targets.at(-1).temporary, true);
  const result = await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.deepEqual({ ...result }, { closed: 2, kept: 0 });
  assert.deepEqual(h.calls.removed, [search, article]);
  assert.equal(h.tabs.get(1).active, true, 'the view returns to the original tab');
  assert.equal(h.tabs.has(2), true, 'pre-existing unrelated tabs survive');
}

for (const reason of ['explicit', 'edited', 'pinned', 'grouped', 'moved', 'reloaded', 'navigated', 'pending', 'unobserved', 'unread', 'viewing-background']) {
  const h = await setup();
  const id = await h.create('open_search_result', reason !== 'unread');
  const tab = h.tabs.get(id), state = h.states.get(id);
  if (reason === 'explicit') {
    assert.equal(h.ctx.keepTemporaryPage(id), true);
    assert.equal(h.calls.targets.at(-1).kept, true);
    assert.equal(h.ctx.keepTemporaryPage(2), false);
  }
  if (reason === 'edited') state.userEdited = true;
  if (reason === 'pinned') tab.pinned = true;
  if (reason === 'grouped') tab.groupId = 42;
  if (reason === 'moved') tab.windowId = 77;
  if (reason === 'reloaded') state.documentId = 'new-document';
  if (reason === 'navigated') tab.url = 'https://user-navigation.test/';
  if (reason === 'pending') tab.pendingUrl = 'https://next.test/';
  if (reason === 'unobserved') state.missing = true;
  if (reason === 'viewing-background') h.setFollow(false);
  const result = await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.deepEqual(h.calls.removed, [], reason);
  assert.equal(result.kept, 1, reason);
}

{
  const h = await setup();
  const id = await h.create();
  await h.browser.tabs.update(2, { active: true });
  const updates = h.calls.updated.length;
  await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.deepEqual(h.calls.removed, [id]);
  assert.equal(h.calls.updated.length, updates, 'cleanup does not steal focus from a manually chosen unrelated page');
  assert.equal(h.tabs.get(2).active, true);
}
{
  const h = await setup(false);
  const id = await h.create();
  assert.equal(h.tabs.get(1).active, true);
  await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.deepEqual(h.calls.removed, [id], 'background temporary pages can close without switching tabs');
}
for (const race of ['stop', 'keep', 'edit-on-restore']) {
  const h = await setup();
  const id = await h.create();
  const controller = new AbortController();
  h.hooks.status = () => {
    if (race === 'stop') controller.abort();
    if (race === 'keep') h.ctx.keepTemporaryPage(id);
  };
  h.hooks.update = (tabId) => { if (race === 'edit-on-restore' && tabId === 1) h.states.get(id).userEdited = true; };
  if (race === 'stop') await assert.rejects(h.ctx.cleanupTemporaryTabs(controller.signal), { name: 'AbortError' });
  else await h.ctx.cleanupTemporaryTabs(controller.signal);
  assert.deepEqual(h.calls.removed, [], `late ${race} must prevent closure`);
}
{
  const h = await setup();
  const id = await h.create();
  h.states.get(id).documentId = 'refreshed';
  await h.ctx.execute('read_page', { tab_id: id }, h.signal);
  await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.equal(h.tabs.has(id), true, 'reading again cannot make a user-refreshed page disposable');
  assert.equal(h.calls.sources.length, 2, 'actual reads still report sources; the parent deduplicates them');
}
{
  const h = await setup();
  const id = await h.create();
  const url = h.tabs.get(id).url;
  const approval = { tabId: id, url, title: 'Read result', description: 'Approved edit', fingerprint: 'same', guard: { url, documentId: h.states.get(id).documentId } };
  h.ctx.describeAction = async () => approval;
  h.ctx.content = async () => 'Filled';
  await h.ctx.execute('type_text', { tab_id: id, element_id: 1, text: 'Approved text' }, h.signal, approval);
  await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.equal(h.tabs.has(id), true, 'an approved synthetic form edit also makes the page permanent');
}
{
  const h = await setup();
  await h.ctx.execute('read_page', { tab_id: 1 }, h.signal);
  const result = await h.ctx.cleanupTemporaryTabs(h.signal);
  assert.equal(result.closed, 0);
  assert.equal(h.tabs.has(1), true, 'reading an existing tab never makes it temporary');
  assert.equal(h.calls.sources[0].url, 'https://original.test/');
}

for (const name of ['read_page', 'extract', 'capture_page']) {
  for (const reload of [false, true]) {
    const h = await setup();
    const id = await h.create('open_search_result', false);
    if (reload) {
      if (name === 'capture_page') h.hooks.capture = () => { h.states.get(id).documentId = 'refreshed-after-capture-started'; };
      else {
        let firstStatus = true;
        h.hooks.status = () => {
          if (firstStatus) { h.states.get(id).documentId = 'refreshed-after-first-read'; firstStatus = false; }
        };
      }
    }
    await h.ctx.execute(name, { tab_id: id, ...(name === 'extract' ? { selector: 'p' } : {}) }, h.signal);
    const result = await h.ctx.cleanupTemporaryTabs(h.signal);
    assert.equal(result.closed, reload ? 0 : 1, `${name}: a same-URL reload after the first read must not register its unread replacement document`);
    assert.equal(h.tabs.has(id), reload);
    assert.equal(h.calls.sources.length, 1, 'the completed read still contributes its source');
  }
}

// The real content observer must see trusted edits/clicks, not synthetic events.
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<input id="field"><button id="button">Action</button>' }));
  const reset = async () => {
    await page.goto('https://fixture.test/');
    await page.addScriptTag({ content: `(() => { const CONTENT_MESSAGE_TAG='tabagent:content'; let handler; const browser={runtime:{onMessage:{addListener(fn){handler=fn;}}}};const defineContentScript=d=>d.main();${contentCode}\nwindow.contentRequest=request=>new Promise(resolve=>handler({tag:CONTENT_MESSAGE_TAG,request},{},resolve)); window.researchStatus=()=>window.contentRequest({action:'research_status'}); })();` });
  };
  await reset();
  assert.equal((await page.evaluate(() => window.researchStatus())).result.userEdited, false);
  const readDocumentIds = await page.evaluate(async () => ({
    status: (await window.researchStatus()).result.documentId,
    snapshot: (await window.contentRequest({ action: 'snapshot' })).result.documentId,
    extract: (await window.contentRequest({ action: 'extract', selector: '#button' })).result.documentId,
  }));
  assert.ok(readDocumentIds.status);
  assert.equal(readDocumentIds.snapshot, readDocumentIds.status, 'snapshots carry the document they actually read');
  assert.equal(readDocumentIds.extract, readDocumentIds.status, 'extraction carries the document it actually read');
  await page.evaluate(() => document.querySelector('#field').dispatchEvent(new Event('input', { bubbles: true })));
  assert.equal((await page.evaluate(() => window.researchStatus())).result.userEdited, false);
  await page.locator('#field').fill('User input');
  assert.equal((await page.evaluate(() => window.researchStatus())).result.userEdited, true);
  await reset();
  await page.locator('#button').click();
  assert.equal((await page.evaluate(() => window.researchStatus())).result.userEdited, true);
} finally { await browser.close(); }
console.log('✓ 临时标签页：只关闭已读且未接管的本轮检索页、回原页不抢焦点、保留/编辑/跳转/停止竞态、真实用户编辑保护与来源采集');
