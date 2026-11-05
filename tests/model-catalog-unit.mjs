import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../lib/model-catalog.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const load = (fetch, timers = {}) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'fetch', 'setTimeout', 'clearTimeout', compiled)(module, module.exports, fetch, timers.setTimeout ?? setTimeout, clearTimeout);
  return module.exports;
};
const connection = { provider: 'openai', service: 'custom', baseUrl: 'https://models.example/v1/', apiKey: 'private-key' };
const signal = () => new AbortController().signal;
const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const rows = (data) => json({ object: 'list', data });

let calls = [];
let api = load(async (url, init) => {
  calls.push({ url, init });
  return rows([
    { id: 'anthropic/claude-a', owned_by: 'aitransx' },
    { id: 'relay@anthropic/claude-a', actual_model: 'anthropic/claude-a', owned_by: 'relay' },
    { id: 'openrouter@anthropic/claude-a', actual_model: 'anthropic/claude-a', owned_by: 'openrouter' },
    { id: 'only@openai/route-only', actual_model: 'openai/route-only', owned_by: 'only' },
    { id: 'openai/gpt-image-2', owned_by: 'aitransx' },
    { id: 'relay@openai/gpt-image-2', actual_model: 'openai/gpt-image-2', owned_by: 'relay' },
    { id: 'qwen/tts-model' }, { id: 'deepseek-search' }, { id: 'auto' },
  ]);
});
const ait = { ...connection, service: 'aitransx', baseUrl: 'https://api.aitransx.com/v1' };
const catalog = await api.listModels(ait, signal());
assert.deepEqual(catalog, [
  { id: 'anthropic/claude-a', name: 'anthropic/claude-a', vendor: 'anthropic', routes: [
    { id: 'relay', name: 'relay', modelId: 'relay@anthropic/claude-a' },
    { id: 'openrouter', name: 'openrouter', modelId: 'openrouter@anthropic/claude-a' },
  ] },
  { id: 'only@openai/route-only', name: 'only@openai/route-only', vendor: 'openai' },
]);
assert.equal(calls[0].url, 'https://api.aitransx.com/v1/models');
assert.equal(calls[0].init.headers.Authorization, undefined, 'public AITransX catalogue must not send even a provided key');
assert.equal(calls[0].init.redirect, 'error');
assert.equal(calls[0].init.credentials, 'omit');
assert.equal('tools' in catalog[0], false, 'the API provides no tool metadata');
assert.equal('vision' in catalog[0], false, 'image capability is not inferred from brand or name');
assert.equal(catalog.some((item) => item.id === 'openai/route-only'), false, 'an automatic route must never be invented');
assert.equal(api.isAITransXConnection({ ...ait, service: 'custom' }), true);
assert.equal(api.isAITransXConnection({ ...ait, baseUrl: 'https://api.aitransx.com.evil/v1' }), false);

api = load(async (url, init) => {
  assert.equal(url, 'https://models.example/v1/models');
  assert.equal(init.headers.Authorization, 'Bearer private-key');
  return rows([
    { id: 'image-understanding-chat', name: 'Image Reader', owned_by: 'example', context_length: 100000, supports_vision: true, supports_tools: false },
    { id: 'audio-maker', type: 'audio' }, { id: 'embedding', model_type: 'embedding' },
    { id: 'images', architecture: { output_modalities: ['image'] } },
    { id: 'multi', architecture: { output_modalities: ['text', 'image'] } },
    { id: 'retired', lifecycle: 'retired' }, { id: '' }, { id: 'x'.repeat(300) },
    { id: 'multi' }, { id: 'control\u0000value' }, null,
  ]);
});
assert.deepEqual(await api.listModels(connection, signal()), [
  { id: 'image-understanding-chat', name: 'Image Reader', vendor: 'example', contextWindow: 100000, vision: true, tools: false },
  { id: 'multi', name: 'multi' },
], 'only known non-chat metadata is filtered outside AITransX');

calls = [];
api = load(async (url, init) => {
  calls.push({ url, init });
  return calls.length === 1 ? json({ data: [{ id: 'claude-first', display_name: 'Claude First', max_input_tokens: 200000, capabilities: { image_input: { supported: true }, server_tools: { supported: true } } }], has_more: true, last_id: 'claude-first' })
    : json({ data: [{ id: 'claude-second' }], has_more: false });
});
const native = await api.listModels({ ...connection, provider: 'anthropic', baseUrl: '' }, signal());
assert.equal(calls.length, 2);
assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
assert.equal(calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-first');
assert.equal(calls[0].init.headers['x-api-key'], 'private-key');
assert.equal(calls[0].init.headers.Authorization, undefined);
assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
assert.equal(native[0].name, 'Claude First');
assert.equal(native[0].vision, true);
assert.equal(native[0].contextWindow, 200000);
assert.equal(native[0].tools, undefined, 'server tools do not prove client function calling');

for (const baseUrl of ['file:///secret', 'https://user:pass@example.com', 'https://models.example/v1?api_key=secret', 'https://models.example/v1#fragment', 'not-url']) {
  await assert.rejects(load(() => { throw new Error('must not fetch'); }).listModels({ ...connection, baseUrl }, signal()), /地址/);
}
await assert.rejects(load(() => { throw new Error('must not fetch'); }).listModels({ ...ait, baseUrl: connection.baseUrl }, signal()), /AITransX/);
for (const status of [401, 403, 404, 405, 429, 500]) {
  await assert.rejects(load(async () => new Response('private-key', { status })).listModels(connection, signal()), (error) => !error.message.includes('private-key'));
}
await assert.rejects(load(async () => new Response('bad json private-key')).listModels(connection, signal()), /格式/);
await assert.rejects(load(async () => json({ models: [] })).listModels(connection, signal()), /格式/);
await assert.rejects(load(async () => rows(Array.from({ length: 5001 }, (_, i) => ({ id: `m${i}` })))).listModels(connection, signal()), /条目过多/);
await assert.rejects(load(async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } })).listModels(connection, signal()), /过大/);
await assert.rejects(load(async () => new Response(' '.repeat(8 * 1024 * 1024 + 1))).listModels(connection, signal()), /过大/);
await assert.rejects(load(async () => json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })).listModels({ ...connection, provider: 'anthropic' }, signal()), /分页无效/);

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(load(() => { throw new Error('must not fetch'); }).listModels(connection, cancelled.signal), { name: 'AbortError' });
let requestSignal;
const stalled = load(async (_url, init) => {
  requestSignal = init.signal;
  return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-key')), { once: true }));
});
const stop = new AbortController();
const pending = stalled.listModels(connection, stop.signal);
stop.abort();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(requestSignal.aborted, true);

const timed = load(async (_url, init) => new Response(new ReadableStream({
  start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('private-key')), { once: true }); },
})), { setTimeout: (fn) => setTimeout(fn, 1) });
await assert.rejects(timed.listModels(connection, signal()), /超时/, 'deadline covers a stalled response body');
console.log('✓ 模型目录：原始供应商路由、无虚构自动ID、能力未知、类型过滤、原生分页、凭据隔离、响应限额与取消超时');
