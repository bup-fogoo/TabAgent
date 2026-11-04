// Production lifetime helper with deterministic timers; no browser/network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule((await fs.readFile(new URL('../lib/task-lifetime.ts', import.meta.url), 'utf8'))
  .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function runtime(version = 3, outcome = 'success') {
  let calls = 0;
  let nextTimer = 0;
  const timers = new Map();
  const context = vm.createContext({
    browser: { runtime: { getManifest: () => ({ manifest_version: version }), getPlatformInfo: () => {
      calls++;
      if (outcome === 'throw') throw new Error('invalidated');
      return outcome === 'reject' ? Promise.reject(new Error('invalidated')) : Promise.resolve({ os: 'win' });
    } } },
    setInterval: (callback, interval) => { assert.equal(interval, 20000); timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(`${source}\nglobalThis.start = keepTaskAlive;`, context);
  return { start: context.start, timers, calls: () => calls, tick: () => [...timers.values()].forEach((callback) => callback()) };
}

for (const outcome of ['success', 'reject', 'throw']) {
  const h = runtime(3, outcome);
  const signal = new AbortController();
  const release = h.start(signal.signal);
  assert.equal(h.timers.size, 1);
  assert.equal(h.calls(), 1);
  h.tick(); assert.equal(h.calls(), 2);
  release(); release();
  h.tick();
  assert.equal(h.calls(), 2);
  assert.equal(h.timers.size, 0, 'completion or exception finalizer releases the timer');
  await Promise.resolve();
}
{
  const h = runtime();
  const controller = new AbortController();
  h.start(controller.signal);
  controller.abort();
  h.tick();
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.size, 0, 'Stop releases immediately');
  h.start(controller.signal);
  assert.equal(h.calls(), 1, 'an already stopped task cannot restart keep-alive');
}
{
  const h = runtime(2);
  h.start(new AbortController().signal)();
  assert.equal(h.calls(), 0);
  assert.equal(h.timers.size, 0, 'MV2 backgrounds need no MV3 timer');
}
console.log('✓ 任务生命周期：仅MV3活跃任务续命、完成/停止释放、无空闲定时器及API失败无未处理拒绝');
