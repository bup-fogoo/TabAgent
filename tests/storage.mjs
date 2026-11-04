// Exercise the real storage implementation with a controllable browser storage boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

let data = {};
let writes = [];
let failWrite = false;
let failRemove = false;
let blockWrite;
const local = {
  async get(keys) {
    return structuredClone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((key) => [key, data[key]])));
  },
  async set(values) {
    writes.push(structuredClone(values));
    if (blockWrite) await blockWrite;
    if (failWrite) throw new Error('Disk unavailable');
    Object.assign(data, structuredClone(values));
  },
  async remove(keys) {
    if (failRemove) throw new Error('Cleanup unavailable');
    for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
  },
};
const source = await fs.readFile(new URL('../lib/conversations.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const referenceModule = { exports: {} };
new Function('exports', ts.transpileModule(await fs.readFile(new URL('../lib/references.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(referenceModule.exports);
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  if (name === './references') return referenceModule.exports;
  assert.equal(name, 'wxt/browser');
  return { browser: { storage: { local } } };
}, module, module.exports);
const { ConversationStorage, loadConversations, newConversation, CONVERSATIONS_KEY: indexKey, LEGACY_CONVERSATIONS_KEY: legacyKey, CONVERSATION_PREFIX: prefix } = module.exports;

// Migration preserves messages and converts pending tasks without automatically resuming them.
const first = newConversation();
first.title = '迁移中的会话';
first.state = 'waiting';
first.events = [{ type: 'user', text: '保留这个问题' }, { type: 'assistant', text: '保留这个回答' }];
first.pendingReply = { id: 'partial-reply', text: '重启前收到的半段回复' };
data[legacyKey] = { version: 1, activeId: first.id, items: [first] };
const loaded = await loadConversations();
assert.equal(loaded.activeId, first.id);
assert.equal(loaded.items[0].state, 'interrupted');
assert.ok(loaded.items[0].events.some((event) => event.text === '保留这个回答'));
assert.ok(loaded.items[0].events.some((event) => event.id === 'partial-reply' && event.interrupted));
const store = new ConversationStorage();
failWrite = true;
await assert.rejects(store.save(loaded.activeId, loaded.items));
assert.ok(data[legacyKey], 'failed migration must retain the old archive');
assert.equal(data[indexKey], undefined);
failWrite = false;
await store.save(loaded.activeId, loaded.items);
assert.equal(data[legacyKey], undefined);
assert.deepEqual(data[indexKey].ids, [first.id]);
assert.equal((await loadConversations()).items[0].events.length, 4);

// Bursts perform a single write, and old large conversations are not copied into it.
const second = newConversation();
const items = [loaded.items[0], second];
await store.save(second.id, items);
writes = [];
const saves = [];
for (let i = 0; i < 20; i++) {
  second.events.push({ type: 'user', text: `消息 ${i}` });
  saves.push(store.save(second.id, items));
}
await store.flush();
await Promise.all(saves);
assert.equal(writes.length, 1);
assert.deepEqual(Object.keys(writes[0]), [prefix + second.id]);
assert.equal(data[prefix + second.id].events.length, 20);
writes = [];
await store.save(first.id, items);
assert.deepEqual(Object.keys(writes[0]), [indexKey], 'switching changes only the index');

// Reference lists update in place. Equal timestamps/event counts must not make
// save() report success while silently retaining an older set of source links.
const sourceIndex = second.events.length;
second.events.push({ type: 'sources', taskId: 'research-task', pages: [{ id: 'source-a', title: '来源 A', url: 'https://example.com/a', kind: 'page' }] });
second.events.push({ type: 'assistant', text: '已完成资料整理' });
await store.save(first.id, items);
const sourceTimestamp = second.updatedAt;
second.events[sourceIndex] = { type: 'sources', taskId: 'research-task', pages: [...second.events[sourceIndex].pages, { id: 'source-b', title: '来源 B', url: 'https://example.com/b', kind: 'page' }] };
await store.save(first.id, items);
assert.equal(second.updatedAt, sourceTimestamp);
assert.equal(data[prefix + second.id].events[sourceIndex].pages.length, 2, 'same-timestamp source updates must be durable');
second.events[sourceIndex].pages[0].title = '标题 A';
await store.save(first.id, items);
assert.equal(data[prefix + second.id].events[sourceIndex].pages[0].title, '标题 A', 'equal-size source edits must be durable');
second.events.push(...second.events.splice(sourceIndex, 1));
await store.save(first.id, items);
assert.equal(data[prefix + second.id].events.at(-1).type, 'sources', 'source ordering must survive reload/export');

// Slow writes hold immutable snapshots, and newer saves commit after them.
let release;
blockWrite = new Promise((resolve) => { release = resolve; });
second.events.push({ type: 'user', text: '慢写入' });
const slow = store.save(first.id, items);
const draining = store.flush();
second.events.push({ type: 'user', text: '后续写入' });
const newer = store.save(first.id, items);
release(); blockWrite = undefined;
await Promise.all([slow, newer, draining]);
assert.equal(data[prefix + second.id].events.at(-1).text, '后续写入');

// A failed write must not poison subsequent attempts or delete old durable data.
failWrite = true;
await assert.rejects(store.save(second.id, [second]));
assert.ok(data[indexKey].ids.includes(first.id));
assert.ok(data[prefix + first.id]);
failWrite = false;
failRemove = true;
await store.save(second.id, [second]);
assert.deepEqual(data[indexKey].ids, [second.id]);
assert.ok(data[prefix + first.id], 'cleanup failure leaves an unreachable backup');
assert.equal((await loadConversations()).items.length, 1);
failRemove = false;
await store.save(second.id, [second]);
assert.equal(data[prefix + first.id], undefined);

// Broken new-format records fail closed, rather than writing an empty archive over them.
delete data[prefix + second.id];
await assert.rejects(loadConversations(), /历史会话无法读取/);
console.log('✓ 历史存储：旧版迁移、失败恢复、按会话写入、来源原位更新与排序、合并写入、有序快照、持久删除及损坏保护');
