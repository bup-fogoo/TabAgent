// Real storage helpers with two isolated module instances representing windows.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const data = {};
const storage = {
  async get(keys) {
    if (keys === null) return structuredClone(data);
    const wanted = Array.isArray(keys) ? keys : [keys];
    return structuredClone(Object.fromEntries(wanted.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])));
  },
  async set(values) { Object.assign(data, structuredClone(values)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
};
async function load(name) {
  const source = await fs.readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    assert.equal(id, 'wxt/browser'); return { browser: { storage: { local: storage } } };
  }, module, module.exports);
  return module.exports;
}
const settings = await load('settings');
const { DEFAULT_SETTINGS, getServiceConnections, applyServiceConnections, createCustomConnection, selectCustomConnection,
  renameCustomConnection, removeCustomConnection, getConnectionTargets, getActiveConnectionTarget, activateConnection } = settings;
const old = { ...DEFAULT_SETTINGS, provider: 'openai', openaiApiKey: 'legacy-key', openaiBaseUrl: 'https://legacy.invalid/v1', openaiModel: 'legacy-model', openaiVision: true };
const original = getServiceConnections(old);
assert.equal(original.openai.selectedCustomId, 'default');
assert.equal(original.openai.customProfiles.default.apiKey, 'legacy-key');
let connections = createCustomConnection(original, 'openai', '本地模型');
const localId = connections.openai.selectedCustomId;
assert.notEqual(localId, 'default');
assert.equal(connections.openai.profiles.custom.apiKey, '', 'new connections never copy old credentials');
assert.equal(connections.openai.profiles.custom.baseUrl, '');
assert.equal(connections.openai.profiles.custom.vision, false);
assert.equal(original.openai.selectedCustomId, 'default', 'helpers do not mutate their input');
connections.openai.profiles.custom = { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'local-chat', vision: true };
connections = createCustomConnection(connections, 'openai', '第二个服务');
const secondId = connections.openai.selectedCustomId;
assert.equal(connections.openai.customProfiles[localId].model, 'local-chat', 'switching saves the outgoing draft');
connections = renameCustomConnection(connections, 'openai', secondId, '备用服务');
assert.equal(connections.openai.customProfiles[secondId].name, '备用服务');
connections.openai.profiles.custom = { apiKey: 'second-key', baseUrl: 'https://second.invalid/v1', model: 'second-model', vision: false };
connections = selectCustomConnection(connections, 'openai', 'default');
assert.equal(connections.openai.profiles.custom.apiKey, 'legacy-key');
assert.equal(connections.openai.customProfiles[secondId].apiKey, 'second-key');
connections.openai.selected = 'official';
const saved = applyServiceConnections(old, connections);
const roundtrip = getServiceConnections(saved);
assert.equal(roundtrip.openai.selected, 'official');
assert.equal(roundtrip.openai.selectedCustomId, 'default');
assert.equal(roundtrip.openai.customProfiles[localId].baseUrl, 'http://localhost:11434/v1');
assert.equal(selectCustomConnection(roundtrip, 'openai', localId).openai.profiles.custom.vision, true);
const activated = activateConnection(saved, `openai:custom:${localId}`, 'other-model');
assert.equal(activated.openaiApiKey, '');
assert.equal(activated.openaiBaseUrl, 'http://localhost:11434/v1');
assert.equal(activated.openaiVision, false, 'changing model disables prior image permission');
assert.equal(activated.openaiModel, 'other-model');
assert.equal(getActiveConnectionTarget(activated).id, `openai:custom:${localId}`);
assert.equal(getConnectionTargets(saved).find((target) => target.id === `openai:custom:${secondId}`).profile.apiKey, 'second-key');
assert.throws(() => activateConnection(saved, 'openai:custom:missing'), /删除/);
assert.throws(() => selectCustomConnection(roundtrip, 'openai', 'missing'), /删除/);
assert.throws(() => renameCustomConnection(roundtrip, 'openai', 'default', ' '), /名称/);
assert.throws(() => createCustomConnection(roundtrip, 'openai', 'x'.repeat(61)), /名称/);
let removed = removeCustomConnection(roundtrip, 'openai', 'default');
assert.equal(removed.openai.customProfiles.default, undefined);
for (const id of Object.keys(removed.openai.customProfiles)) removed = removeCustomConnection(removed, 'openai', id);
assert.equal(Object.keys(removed.openai.customProfiles).length, 1);
assert.equal(removed.openai.profiles.custom.apiKey, '');
assert.ok(!['default', localId, secondId].includes(removed.openai.selectedCustomId), 'deleting the final connection gives its replacement a new identity');
let full = getServiceConnections(DEFAULT_SETTINGS);
for (let i = 1; i < 20; i++) full = createCustomConnection(full, 'openai', `连接 ${i}`);
assert.throws(() => createCustomConnection(full, 'openai', '第21个'), /20/);
assert.deepEqual(original.openai.profiles.custom, { apiKey: 'legacy-key', baseUrl: old.openaiBaseUrl, model: 'legacy-model', vision: true });

const first = await load('model-library');
const second = await load('model-library');
const scope = first.getModelScope('openai', 'custom', 'https://API.example:443/v1/', 'one');
assert.equal(scope, first.getModelScope('openai', 'custom', 'https://api.example/v1', 'one'));
assert.notEqual(scope, first.getModelScope('openai', 'custom', 'https://api.example/v1', 'two'));
assert.notEqual(scope, first.getModelScope('openai', 'custom', 'https://other.example/v1', 'one'));
const cleanScope = first.getModelScope('openai', 'custom', 'https://username:secret@example.com/v1?token=secret#secret', 'one');
assert.equal(cleanScope.includes('secret'), false, 'connection metadata never stores URL credentials or tokens');
assert.equal(cleanScope.includes('username'), false);
assert.deepEqual(await first.loadModelLibrary(scope), { favorites: [], recent: [] });
await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).setModelFavorite(scope, `model-${i}`, true)));
assert.deepEqual(new Set((await first.loadModelLibrary(scope)).favorites), new Set(Array.from({ length: 20 }, (_, i) => `model-${i}`)), 'different windows must not lose independent favorites');
await first.setModelFavorite(scope, 'model-3', false);
assert.equal((await second.loadModelLibrary(scope)).favorites.includes('model-3'), false);
for (let i = 20; i < 31; i++) await first.setModelFavorite(scope, `model-${i}`, true);
assert.equal((await first.loadModelLibrary(scope)).favorites.length, 30);
await assert.rejects(first.setModelFavorite(scope, 'one-too-many', true), /30/);
for (let i = 0; i < 14; i++) await first.recordRecentModel(scope, `recent-${i}`);
assert.deepEqual((await second.loadModelLibrary(scope)).recent, Array.from({ length: 10 }, (_, i) => `recent-${13 - i}`));
await first.recordRecentModel(scope, 'recent-8');
assert.equal((await first.loadModelLibrary(scope)).recent[0], 'recent-8');
await first.setModelFavorite(cleanScope, 'separate-model', true);
assert.deepEqual((await first.loadModelLibrary(cleanScope)).favorites, ['separate-model']);
assert.equal((await first.loadModelLibrary(scope)).favorites.includes('separate-model'), false);
await assert.rejects(first.recordRecentModel(scope, 'bad\nmodel'), /无效/);
const metadata = Object.entries(data).filter(([key]) => key.startsWith(first.MODEL_LIBRARY_PREFIX));
assert.ok(metadata.length <= 72, 'obsolete immutable operations are pruned');
for (const [, value] of metadata) {
  assert.equal(Object.hasOwn(value, 'apiKey'), false);
  assert.ok(Object.keys(value).every((key) => ['model', 'at', 'favorite'].includes(key)));
}
console.log('✓ 连接档案与模型库：旧配置迁移、草稿隔离/增删改切换、模型权限重置、双窗口收藏、最近使用及元数据边界');
