// Service migration and credential isolation, using the real settings helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

let data = {};
let writes = 0;
const source = await fs.readFile(new URL('../lib/settings.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  assert.equal(name, 'wxt/browser');
  return { browser: { storage: { local: {
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { writes++; Object.assign(data, structuredClone(values)); },
  } } } };
}, module, module.exports);
const { DEFAULT_SETTINGS, SERVICE_URLS, getServiceConnections, applyServiceConnections, loadSettings, saveSettings, requiresConnectionKey, isConnectionConfigured } = module.exports;
const defaults = structuredClone(DEFAULT_SETTINGS);
const services = getServiceConnections(defaults);
assert.equal(services.anthropic.selected, 'official');
assert.equal(services.openai.selected, 'official');
assert.equal(services.openai.profiles.aitransx.baseUrl, 'https://api.aitransx.com/v1');
assert.equal(services.openai.profiles.aitransx.model, 'openai/gpt-6.1-terra');
assert.equal(SERVICE_URLS.anthropic.aitransx, '', 'no invented Anthropic Messages endpoint');

// Legacy empty-key presets and hand-entered official URLs must not appear ready.
assert.equal(isConnectionConfigured(defaults), false);
assert.equal(isConnectionConfigured({ ...defaults, anthropicApiKey: 'claude-key' }), true, 'blank native address still means the official service');
for (const baseUrl of ['https://api.openai.com/v1', 'https://API.OPENAI.COM:443/v1/', 'https://api.aitransx.com/v1/']) {
  assert.equal(requiresConnectionKey('openai', baseUrl, 'custom'), true);
  const settings = { ...defaults, provider: 'openai', openaiBaseUrl: baseUrl, openaiApiKey: '' };
  assert.equal(isConnectionConfigured(settings), false);
  assert.equal(isConnectionConfigured({ ...settings, openaiApiKey: '  ' }), false);
  assert.equal(isConnectionConfigured({ ...settings, openaiApiKey: 'hosted-key' }), true);
}
assert.equal(requiresConnectionKey('openai', 'http://localhost:11434/v1', 'custom'), false);
assert.equal(requiresConnectionKey('anthropic', 'http://localhost:1234', 'custom'), true);
const local = { ...defaults, provider: 'openai', openaiBaseUrl: 'http://localhost:11434/v1', openaiApiKey: '' };
assert.equal(isConnectionConfigured(local), true, 'keyless custom services stay supported');
assert.equal(isConnectionConfigured({ ...local, openaiModel: '  ' }), false);
for (const invalid of ['', 'not-a-url', 'file:///tmp/model', 'javascript:alert(1)']) {
  assert.equal(isConnectionConfigured({ ...local, openaiBaseUrl: invalid }), false);
  if (invalid) assert.equal(isConnectionConfigured({ ...defaults, anthropicApiKey: 'key', anthropicBaseUrl: invalid }), false);
}

const legacy = {
  ...defaults,
  anthropicBaseUrl: '', anthropicApiKey: 'official-claude-key', anthropicModel: 'original-claude', anthropicVision: true,
  openaiBaseUrl: 'https://custom.example/api/v1/', openaiApiKey: 'custom-key', openaiModel: 'original-custom', openaiVision: true,
};
const migrated = applyServiceConnections(legacy, getServiceConnections(legacy));
for (const key of Object.keys(defaults)) assert.deepEqual(migrated[key], legacy[key], `migration must preserve ${key}`);
assert.equal(migrated.connections.anthropic.selected, 'official');
assert.equal(migrated.connections.openai.selected, 'custom');
assert.equal(migrated.connections.openai.profiles.official.apiKey, '');
assert.equal(migrated.connections.openai.profiles.aitransx.apiKey, '');
assert.equal(migrated.connections.anthropic.profiles.custom.apiKey, '');

const switchTo = (settings, provider, service) => {
  const connections = getServiceConnections(settings);
  connections[provider].selected = service;
  return applyServiceConnections(settings, connections);
};
const official = switchTo(migrated, 'openai', 'official');
assert.equal(official.openaiApiKey, '');
assert.equal(official.openaiBaseUrl, SERVICE_URLS.openai.official);
assert.equal(official.openaiVision, false);
assert.equal(official.anthropicApiKey, legacy.anthropicApiKey);
assert.equal(switchTo(official, 'openai', 'custom').openaiApiKey, 'custom-key');
assert.equal(switchTo(official, 'openai', 'custom').openaiModel, 'original-custom');
assert.equal(switchTo(official, 'openai', 'custom').openaiVision, true);

const relay = switchTo(official, 'openai', 'aitransx');
relay.openaiApiKey = 'relay-key';
relay.openaiModel = 'anthropic/claude-opus-5.5';
relay.openaiVision = true;
const updated = applyServiceConnections(relay, getServiceConnections(relay));
assert.equal(updated.connections.openai.profiles.aitransx.apiKey, 'relay-key');
assert.equal(updated.connections.openai.profiles.custom.apiKey, 'custom-key');
assert.equal(switchTo(updated, 'openai', 'custom').openaiBaseUrl, legacy.openaiBaseUrl);
const freshRead = getServiceConnections(updated);
freshRead.openai.profiles.aitransx.apiKey = 'edited-draft';
assert.equal(updated.connections.openai.profiles.aitransx.apiKey, 'relay-key', 'drafts must be independent');
const appliedDraft = applyServiceConnections(updated, freshRead);
freshRead.openai.profiles.aitransx.model = 'changed-again';
assert.equal(appliedDraft.connections.openai.profiles.aitransx.model, 'anthropic/claude-opus-5.5');

// Already configured AITransX migrates without changing its model or address spelling.
const oldRelay = { ...defaults, openaiBaseUrl: 'https://api.aitransx.com/v1/', openaiApiKey: 'old-relay', openaiModel: 'my-model' };
const oldRelayResult = applyServiceConnections(oldRelay, getServiceConnections(oldRelay));
assert.equal(oldRelayResult.connections.openai.selected, 'aitransx');
assert.equal(oldRelayResult.openaiBaseUrl, oldRelay.openaiBaseUrl);
assert.equal(oldRelayResult.openaiModel, 'my-model');
assert.equal(oldRelayResult.connections.openai.profiles.official.apiKey, '');

// Flat data from an older client stays authoritative when metadata has become stale.
const oldClientUpdate = { ...updated, openaiBaseUrl: 'https://another.example/v1', openaiApiKey: 'new-custom-key' };
const oldClientResult = applyServiceConnections(oldClientUpdate, getServiceConnections(oldClientUpdate));
assert.equal(oldClientResult.connections.openai.selected, 'custom');
assert.equal(oldClientResult.openaiBaseUrl, oldClientUpdate.openaiBaseUrl);
assert.equal(oldClientResult.openaiApiKey, 'new-custom-key');
assert.equal(oldClientResult.connections.openai.profiles.aitransx.apiKey, 'relay-key');

// An explicit custom selection can use an official URL without transferring its key.
const explicit = getServiceConnections(defaults);
explicit.openai.selected = 'custom';
explicit.openai.profiles.custom = { apiKey: 'custom-official', baseUrl: SERVICE_URLS.openai.official, model: 'manual', vision: false };
const explicitSettings = applyServiceConnections(defaults, explicit);
assert.equal(getServiceConnections(explicitSettings).openai.selected, 'custom');
assert.equal(getServiceConnections(explicitSettings).openai.profiles.official.apiKey, '');

// Corrupted preset metadata must not redirect old credentials to an official endpoint.
const damaged = structuredClone(explicitSettings);
damaged.openaiBaseUrl = 'https://relay.example/v1';
damaged.openaiApiKey = 'relay-only';
damaged.connections.openai.selected = 'official';
damaged.connections.openai.profiles.official = { baseUrl: damaged.openaiBaseUrl, apiKey: 'relay-only', model: 'relay', vision: true };
const repaired = getServiceConnections(damaged);
assert.equal(repaired.openai.selected, 'custom');
assert.equal(repaired.openai.profiles.custom.apiKey, 'relay-only');
assert.equal(repaired.openai.profiles.official.apiKey, '');
const unsupported = getServiceConnections(defaults);
unsupported.anthropic.selected = 'aitransx';
assert.throws(() => applyServiceConnections(defaults, unsupported), /OpenAI 兼容/);
const unsupportedSaved = { ...defaults, connections: unsupported, anthropicBaseUrl: SERVICE_URLS.openai.aitransx };
assert.equal(getServiceConnections(unsupportedSaved).anthropic.selected, 'custom');

data['tabagent:settings'] = structuredClone(legacy);
const loaded = await loadSettings();
assert.equal(writes, 0, 'opening settings must not silently rewrite saved data');
assert.deepEqual(data['tabagent:settings'], legacy);
assert.deepEqual(loaded, migrated);
await saveSettings(updated);
assert.equal(writes, 1);
assert.deepEqual(await loadSettings(), updated);
assert.equal(writes, 1);
assert.deepEqual(DEFAULT_SETTINGS, defaults);
console.log('✓ 服务预设：旧配置迁移、按服务隔离密钥/模型/图片识别、回切恢复、草稿隔离、过期元数据与协议校验');
