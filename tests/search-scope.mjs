// Run the production search transport with controlled browser API timing.
// These checks do not open a browser or contact a search/model service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const source = compile(await fs.readFile(new URL('../lib/tool-policy.ts', import.meta.url), 'utf8'))
  + compile(await fs.readFile(new URL('../lib/tools.ts', import.meta.url), 'utf8'));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const calls = { create: [], update: [], remove: [], get: [], windows: 0 };
  const tabs = new Map([
    [1, { id: 1, windowId: 9, url: 'https://example.test/', active: false }],
    [7, { id: 7, windowId: 9, url: 'chrome://newtab/', active: true }],
  ]);
  const created = deferred();
  const browser = {
    tabs: {
      query: async () => [tabs.get(7)],
      create: async (options) => { calls.create.push(options); return created.promise; },
      get: async (id) => { calls.get.push(id); if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); },
      update: async (id, options) => { calls.update.push({ id, ...options }); throw new Error('This test must never navigate'); },
      remove: async (id) => { calls.remove.push(id); tabs.delete(id); },
    },
    windows: { getAll: async () => { calls.windows++; return []; } },
  };
  const runtime = vm.createContext({ browser, URL, DOMException, AbortController, setTimeout, clearTimeout, crypto: webcrypto });
  vm.runInContext(`${source}\nglobalThis.Subject = BrowserContext;`, runtime);
  const finishCreation = (overrides = {}) => {
    const tab = { id: 88, windowId: 9, url: 'about:blank', active: false, ...overrides };
    tabs.set(tab.id, tab);
    created.resolve(tab);
  };
  return { calls, tabs, browser, Subject: runtime.Subject, finishCreation };
}

// Stop while tabs.create is pending: a late result may only be an empty tab.
// The query must never be delivered after the task has been stopped.
for (const placeholder of [{}, { url: '', pendingUrl: 'about:blank' }]) {
  const h = harness();
  const ctx = new h.Subject(-1, [], 9);
  const controller = new AbortController();
  const task = ctx.execute('search_web', { query: 'AITransX' }, controller.signal);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.create[0].url, 'about:blank');
  assert.equal(h.calls.create[0].active, false);
  assert.equal(h.calls.create[0].windowId, 9);
  controller.abort();
  h.finishCreation(placeholder);
  await assert.rejects(task, { name: 'AbortError' });
  assert.deepEqual(h.calls.update, []);
  assert.deepEqual(h.calls.remove, [88]);
  assert.equal(ctx.currentTabId, -1);
  assert.equal(ctx.tabIds.length, 0);
}

// An adopted tab belongs to the user even when the task that created it stops.
for (const adopted of [
  { active: true },
  { url: 'https://user-navigation.test/' },
  { pendingUrl: 'https://user-navigation.test/' },
  { url: '', pendingUrl: 'https://user-navigation.test/' },
  { url: '', pendingUrl: '' },
]) {
  const h = harness();
  const ctx = new h.Subject(-1, [], 9);
  const controller = new AbortController();
  const task = ctx.execute('search_web', { query: 'AITransX' }, controller.signal);
  controller.abort();
  h.finishCreation(adopted);
  await assert.rejects(task, { name: 'AbortError' });
  assert.deepEqual(h.calls.update, []);
  assert.deepEqual(h.calls.remove, []);
  assert.equal(h.tabs.has(88), true);
}

// A confirmed pending about:blank is safe to navigate before it has committed.
{
  const h = harness();
  const task = new h.Subject(-1, [], 9).execute('search_web', { query: 'AITransX' }, new AbortController().signal);
  h.finishCreation({ url: '', pendingUrl: 'about:blank' });
  await assert.rejects(task, /This test must never navigate/);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.update[0].id, 88);
  assert.equal(h.calls.update[0].url, 'https://www.bing.com/search?q=AITransX');
  assert.deepEqual(h.calls.remove, []);
}

// Stop after creation, while the final blank-page guard is still in flight.
{
  const h = harness();
  const checked = deferred();
  const guardRead = deferred();
  const originalGet = h.browser.tabs.get;
  let firstRead = true;
  h.browser.tabs.get = async (id) => {
    if (id === 88 && firstRead) { firstRead = false; guardRead.resolve(); return checked.promise; }
    return originalGet(id);
  };
  const controller = new AbortController();
  const task = new h.Subject(-1, [], 9).execute('search_web', { query: 'AITransX' }, controller.signal);
  h.finishCreation();
  await guardRead.promise;
  controller.abort();
  checked.resolve(h.tabs.get(88));
  await assert.rejects(task, { name: 'AbortError' });
  assert.deepEqual(h.calls.update, []);
  assert.deepEqual(h.calls.remove, [88]);
}

// Empty default scope must not become implicit permission to read other tabs.
{
  const h = harness();
  const ctx = await h.Subject.fromScope();
  assert.equal(ctx.tabIds.length, 0);
  assert.equal(ctx.currentTabId, -1);
  await assert.rejects(ctx.execute('read_page', {}, new AbortController().signal), /当前没有可读取/);
  await assert.rejects(ctx.execute('read_page', { tab_id: 1 }, new AbortController().signal), /不在本次任务范围/);
  assert.deepEqual(h.calls.get, []);
  await assert.rejects(h.Subject.fromScope([]), /1 到 50/);
  await assert.rejects(h.Subject.fromScope([7]), /不是可操作的普通网页/);
}

// Resource boundaries fail before any browser tab is created.
{
  const h = harness();
  const ctx = new h.Subject(1, Array.from({ length: 50 }, (_, index) => index + 1), 9);
  await assert.rejects(ctx.execute('search_web', { query: 'AITransX' }, new AbortController().signal), /50 个标签页/);
  assert.deepEqual(h.calls.create, []);
}
{
  const h = harness();
  await assert.rejects(new h.Subject(-1, []).execute('search_web', { query: 'AITransX' }, new AbortController().signal), /普通浏览器窗口/);
  assert.equal(h.calls.windows, 1);
  assert.deepEqual(h.calls.create, []);
}
{
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new h.Subject(-1, [], 9).execute('search_web', { query: 'AITransX' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(h.calls.create, []);
}

console.log('✓ 搜索范围与取消：新标签页空范围、显式范围限制、延迟创建/导航前停止、保留用户接管页、50页上限与无窗口边界');
