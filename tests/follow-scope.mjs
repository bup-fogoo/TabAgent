// Production view-following behavior with controlled tab/navigation timing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const compile = (value) => ts.transpileModule(value.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const source = compile(await fs.readFile(new URL('../lib/tool-policy.ts', import.meta.url), 'utf8'))
  + compile(await fs.readFile(new URL('../lib/tools.ts', import.meta.url), 'utf8'));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(initialFollow = true) {
  let follow = initialFollow;
  const calls = { create: [], update: [], focus: [], remove: [], target: [], loads: [] };
  const tabs = new Map([
    [1, { id: 1, url: 'https://first.test/', title: 'First', active: false, windowId: 9 }],
    [2, { id: 2, url: 'https://second.test/', title: 'Second', active: false, windowId: 10 }],
    [3, { id: 3, url: 'chrome://settings/', title: 'Settings', active: true, windowId: 9 }],
    [4, { id: 4, url: 'https://private.test/', title: 'Outside', active: false, windowId: 10 }],
  ]);
  const loaded = deferred();
  const loading = deferred();
  const browser = {
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error('closed'); return { ...tabs.get(id) }; },
      create: async (options) => {
        calls.create.push(options);
        const tab = { id: 88, url: 'about:blank', active: false, windowId: 9 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, options) => {
        calls.update.push({ id, ...options });
        Object.assign(tabs.get(id), options);
        return { ...tabs.get(id) };
      },
      remove: async (id) => { calls.remove.push(id); tabs.delete(id); },
    },
    windows: {
      get: async (id) => ({ id, focused: id === 9 }),
      update: async (id, options) => { calls.focus.push({ id, ...options }); return { id, ...options }; },
    },
  };
  const scope = vm.createContext({ browser, URL, DOMException, setTimeout, clearTimeout });
  vm.runInContext(`${source}\nglobalThis.Subject = BrowserContext;`, scope);
  scope.load = async (id, signal) => {
    calls.loads.push(id);
    loading.resolve();
    await loaded.promise;
    signal.throwIfAborted();
  };
  vm.runInContext('waitForLoad = globalThis.load;', scope);
  const view = { followPages: () => follow, onTarget: (target) => calls.target.push(target) };
  return { Subject: scope.Subject, browser, calls, tabs, view, loaded, loading, setFollow: (value) => { follow = value; } };
}

// Following an existing scoped tab activates it and focuses its window only
// when necessary. Turning following off leaves future targets in the background.
{
  const h = harness();
  const ctx = new h.Subject(1, [1, 2], 9, h.view);
  const signal = new AbortController().signal;
  await ctx.presentTarget(1, signal, 'read_page');
  assert.deepEqual(h.calls.update, [{ id: 1, active: true }]);
  assert.deepEqual(h.calls.focus, []);
  await ctx.presentTarget(2, signal, 'extract');
  assert.deepEqual(h.calls.focus, [{ id: 10, focused: true }]);
  assert.equal(h.calls.target.at(-1).action, 'extract');
  h.setFollow(false);
  h.tabs.get(1).active = false;
  await ctx.presentTarget(1, signal, 'read_page');
  assert.equal(h.calls.update.length, 2);
  assert.equal(h.calls.target.at(-1).tabId, 1, 'background tasks still report their target');
  await assert.rejects(ctx.presentTarget(4, signal), /不在本次任务范围/);
  await assert.rejects(new h.Subject(3, [3], 9, h.view).presentTarget(3, signal), /不是可显示/);
  assert.equal(h.calls.update.length, 2, 'unscoped or internal tabs cannot be shown by this task');
}

// A pending task URL can be shown immediately without making the blank/old
// document readable. This is also used when following is enabled mid-load.
{
  const h = harness();
  h.tabs.set(88, { id: 88, url: 'about:blank', pendingUrl: 'https://loading.test/', active: false, windowId: 9 });
  const ctx = new h.Subject(88, [88], 9, h.view);
  await ctx.presentTarget(88, new AbortController().signal, 'search_web');
  assert.equal(h.calls.target[0].url, 'https://loading.test/');
  assert.equal(h.calls.update[0].active, true);
  await assert.rejects(ctx.describeTarget(88), /不是可操作/);
}

// Navigation and target reporting happen before load completes, including
// pages that later show a network error or verification requirement.
for (const follow of [true, false]) {
  const h = harness(follow);
  const ctx = new h.Subject(-1, [], 9, h.view);
  const task = ctx.createResearchTab('https://search.test/?q=example', new AbortController().signal, 'search_web');
  await h.loading.promise;
  assert.equal(h.calls.create[0].active, false, 'the placeholder always starts in the background');
  assert.equal(h.calls.update[0].url, 'https://search.test/?q=example');
  assert.equal(h.calls.update[0].active, follow ? true : undefined);
  assert.equal(h.calls.target[0].action, 'search_web');
  assert.equal(h.calls.target[0].url, 'https://search.test/?q=example');
  assert.equal(h.calls.target[0].tabIds.includes(88), true);
  h.loaded.resolve();
  assert.equal(await task, 88);
}

// A changed preference or Stop during an awaited browser API must not trigger
// a later focus operation. Already completed activation is not replayed.
for (const interrupt of ['disable', 'abort']) {
  const h = harness();
  const controller = new AbortController();
  const checked = deferred();
  const started = deferred();
  h.browser.windows.get = async (id) => { started.resolve(); return checked.promise; };
  const ctx = new h.Subject(2, [2], 10, h.view);
  const task = ctx.presentTarget(2, controller.signal, 'read_page');
  await started.promise;
  if (interrupt === 'disable') h.setFollow(false); else controller.abort();
  checked.resolve({ id: 10, focused: false });
  if (interrupt === 'abort') await assert.rejects(task, { name: 'AbortError' }); else await task;
  assert.deepEqual(h.calls.focus, []);
}

// Stop during placeholder creation cannot navigate, activate or announce a
// late target; the untouched owned blank tab is removed as before.
{
  const h = harness();
  const created = deferred();
  h.browser.tabs.create = async (options) => { h.calls.create.push(options); return created.promise; };
  const ctx = new h.Subject(-1, [], 9, h.view);
  const controller = new AbortController();
  const task = ctx.createResearchTab('https://search.test/', controller.signal, 'search_web');
  controller.abort();
  const blank = { id: 88, windowId: 9, url: 'about:blank', active: false };
  h.tabs.set(88, blank);
  created.resolve(blank);
  await assert.rejects(task, { name: 'AbortError' });
  assert.deepEqual(h.calls.update, []);
  assert.deepEqual(h.calls.focus, []);
  assert.deepEqual(h.calls.target, []);
  assert.deepEqual(h.calls.remove, [88]);
}

console.log('✓ 页面跟随：范围隔离、加载前可见目标、后台模式、动态关闭、跨窗聚焦与停止竞态');
