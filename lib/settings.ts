import { browser } from 'wxt/browser';

export type Provider = 'anthropic' | 'openai';
export type Effort = 'low' | 'medium' | 'high';
export type ServiceSource = 'official' | 'aitransx' | 'custom';
export interface ConnectionProfile {
  apiKey: string;
  baseUrl: string;
  model: string;
  vision: boolean;
}
export interface NamedConnectionProfile extends ConnectionProfile { name: string }
export type ServiceConnections = Record<Provider, {
  selected: ServiceSource;
  profiles: Record<ServiceSource, ConnectionProfile>;
  customProfiles?: Record<string, NamedConnectionProfile>;
  selectedCustomId?: string;
}>;
export interface ConnectionTarget {
  id: string;
  provider: Provider;
  service: ServiceSource;
  customId?: string;
  name: string;
  profile: ConnectionProfile;
}

// AITransX exposes OpenAI Chat Completions, not Anthropic Messages.
export const SERVICE_URLS: Record<Provider, Record<'official' | 'aitransx', string>> = {
  anthropic: { official: 'https://api.anthropic.com', aitransx: '' },
  openai: { official: 'https://api.openai.com/v1', aitransx: 'https://api.aitransx.com/v1' },
};

export interface Settings {
  provider: Provider;
  anthropicApiKey: string;
  anthropicModel: string;
  /** 留空使用官方地址 https://api.anthropic.com */
  anthropicBaseUrl: string;
  anthropicVision: boolean;
  openaiApiKey: string;
  /** 任何兼容 OpenAI Chat Completions 的地址，如 https://api.openai.com/v1、DeepSeek、通义、Ollama 等 */
  openaiBaseUrl: string;
  openaiModel: string;
  openaiVision: boolean;
  effort: Effort;
  /** 单个任务最多执行的工具调用轮数，防止失控 */
  maxSteps: number;
  /** Separate credentials and model preferences for each service. */
  connections?: ServiceConnections;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  anthropicBaseUrl: '',
  anthropicVision: false,
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiVision: false,
  effort: 'medium',
  maxSteps: 40,
};

const KEY = 'tabagent:settings';
const PROVIDERS: Provider[] = ['anthropic', 'openai'];
const SOURCES: ServiceSource[] = ['official', 'aitransx', 'custom'];

export function isServiceSupported(provider: Provider, source: ServiceSource): boolean {
  return source === 'custom' || Boolean(SERVICE_URLS[provider][source]);
}

function freshProfile(provider: Provider, source: ServiceSource): ConnectionProfile {
  return {
    apiKey: '',
    baseUrl: source === 'custom' ? '' : SERVICE_URLS[provider][source],
    model: source === 'aitransx' ? 'openai/gpt-6.1-terra' : DEFAULT_SETTINGS[`${provider}Model`],
    vision: false,
  };
}

function endpoint(url: string, provider: Provider): string {
  const value = url.trim();
  if (!value && provider === 'anthropic') return SERVICE_URLS.anthropic.official;
  try { return new URL(value).href.replace(/\/+$/, ''); }
  catch { return value; }
}

function inferSource(provider: Provider, url: string): ServiceSource {
  for (const source of ['official', 'aitransx'] as const) {
    if (isServiceSupported(provider, source) && endpoint(url, provider) === endpoint(SERVICE_URLS[provider][source], provider)) return source;
  }
  return 'custom';
}

/** Custom endpoints may be local servers without authentication. Known hosted
 * endpoints still require a key when selected through the custom editor. */
export function requiresConnectionKey(provider: Provider, baseUrl: string, service?: ServiceSource): boolean {
  return provider === 'anthropic' || service === 'official' || service === 'aitransx'
    || inferSource(provider, baseUrl) !== 'custom';
}

/** Shared by the settings form, side panel and task entry point. This checks
 * configuration completeness, not whether the remote service accepts the key. */
export function isConnectionConfigured(settings: Settings): boolean {
  const provider = settings.provider;
  if (provider !== 'anthropic' && provider !== 'openai') return false;
  const model = settings[`${provider}Model`];
  const address = settings[`${provider}BaseUrl`];
  const key = settings[`${provider}ApiKey`];
  if (typeof model !== 'string' || !model.trim() || typeof address !== 'string') return false;
  const baseUrl = address.trim();
  if (baseUrl || provider === 'openai') {
    try { if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) return false; }
    catch { return false; }
  }
  const service = settings.connections?.[provider]?.selected;
  return !requiresConnectionKey(provider, baseUrl, service) || (typeof key === 'string' && Boolean(key.trim()));
}

function copyProfile(value: Partial<ConnectionProfile> | undefined, fallback: ConnectionProfile): ConnectionProfile {
  return {
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey : fallback.apiKey,
    baseUrl: typeof value?.baseUrl === 'string' ? value.baseUrl : fallback.baseUrl,
    model: typeof value?.model === 'string' ? value.model : fallback.model,
    vision: value?.vision === true,
  };
}

function profileName(value: unknown, fallback = '自定义连接'): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : fallback;
}

function customState(entry: ServiceConnections[Provider] | undefined, provider: Provider) {
  const customProfiles: Record<string, NamedConnectionProfile> = {};
  const entries = Object.entries(entry?.customProfiles ?? {}).filter(([id, value]) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)
    && !['__proto__', 'constructor', 'prototype'].includes(id) && value && typeof value === 'object');
  // Preserve the active connection even if imported data exceeds the UI limit.
  entries.sort(([a], [b]) => Number(b === entry?.selectedCustomId) - Number(a === entry?.selectedCustomId));
  for (const [id, profile] of entries.slice(0, 20)) {
    customProfiles[id] = { ...copyProfile(profile, freshProfile(provider, 'custom')), name: profileName(profile.name) };
  }
  let selectedCustomId = entry?.selectedCustomId && Object.hasOwn(customProfiles, entry.selectedCustomId)
    ? entry.selectedCustomId : Object.keys(customProfiles)[0] ?? 'default';
  if (!customProfiles[selectedCustomId]) customProfiles[selectedCustomId] = { ...freshProfile(provider, 'custom'), name: '自定义连接' };
  // The legacy slot is also the current form draft, including while on a preset.
  if (entry?.profiles?.custom) customProfiles[selectedCustomId] = {
    ...copyProfile(entry.profiles.custom, customProfiles[selectedCustomId]), name: customProfiles[selectedCustomId].name,
  };
  return { customProfiles, selectedCustomId };
}

function copyConnections(connections: ServiceConnections): ServiceConnections {
  const result = {} as ServiceConnections;
  for (const provider of PROVIDERS) {
    const entry = connections[provider];
    const custom = customState(entry, provider);
    const profiles = {} as Record<ServiceSource, ConnectionProfile>;
    for (const source of SOURCES) profiles[source] = copyProfile(entry.profiles[source], freshProfile(provider, source));
    profiles.custom = copyProfile(custom.customProfiles[custom.selectedCustomId], freshProfile(provider, 'custom'));
    result[provider] = { selected: entry.selected, profiles, ...custom };
  }
  return result;
}

function checkedName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('连接名称需为 1–60 个字符。');
  return value;
}

export function selectCustomConnection(connections: ServiceConnections, provider: Provider, id: string): ServiceConnections {
  const result = copyConnections(connections);
  const entry = result[provider];
  if (!Object.hasOwn(entry.customProfiles!, id)) throw new Error('此连接已删除，请重新选择。');
  entry.selected = 'custom';
  entry.selectedCustomId = id;
  entry.profiles.custom = copyProfile(entry.customProfiles![id], freshProfile(provider, 'custom'));
  return result;
}

export function createCustomConnection(connections: ServiceConnections, provider: Provider, name: string): ServiceConnections {
  const result = copyConnections(connections);
  const entry = result[provider];
  if (Object.keys(entry.customProfiles!).length >= 20) throw new Error('每种接口最多保存 20 个自定义连接。');
  const id = crypto.randomUUID();
  entry.customProfiles![id] = { ...freshProfile(provider, 'custom'), name: checkedName(name) };
  return selectCustomConnection(result, provider, id);
}

export function renameCustomConnection(connections: ServiceConnections, provider: Provider, id: string, name: string): ServiceConnections {
  const result = copyConnections(connections);
  const profile = Object.hasOwn(result[provider].customProfiles!, id) ? result[provider].customProfiles![id] : undefined;
  if (!profile) throw new Error('此连接已删除，请重新选择。');
  profile.name = checkedName(name);
  return result;
}

export function removeCustomConnection(connections: ServiceConnections, provider: Provider, id: string): ServiceConnections {
  const result = copyConnections(connections);
  const entry = result[provider];
  if (!Object.hasOwn(entry.customProfiles!, id)) throw new Error('此连接已删除，请重新选择。');
  delete entry.customProfiles![id];
  if (!Object.keys(entry.customProfiles!).length) {
    const replacement = crypto.randomUUID();
    entry.customProfiles![replacement] = { ...freshProfile(provider, 'custom'), name: '自定义连接' };
  }
  if (entry.selectedCustomId === id) {
    entry.selectedCustomId = Object.keys(entry.customProfiles!)[0]!;
    entry.profiles.custom = copyProfile(entry.customProfiles![entry.selectedCustomId], freshProfile(provider, 'custom'));
  }
  return result;
}

/** Read-only migration: retain the current URL exactly, including legacy blank
 * Anthropic URLs. A service change never copies another service's credentials. */
export function getServiceConnections(settings: Settings): ServiceConnections {
  const connections = {} as ServiceConnections;
  for (const provider of PROVIDERS) {
    const existing = settings.connections?.[provider];
    const custom = customState(existing, provider);
    const profiles = {} as Record<ServiceSource, ConnectionProfile>;
    for (const source of SOURCES) {
      const fallback = freshProfile(provider, source);
      const profile = copyProfile(existing?.profiles?.[source], fallback);
      // Never redirect saved preset credentials to a different endpoint when
      // repairing stale or malformed metadata. The active flat fields migrate below.
      profiles[source] = source === 'custom' || (isServiceSupported(provider, source) && inferSource(provider, profile.baseUrl) === source)
        ? profile : fallback;
    }
    profiles.custom = copyProfile(custom.customProfiles[custom.selectedCustomId], profiles.custom);
    const current: ConnectionProfile = {
      apiKey: settings[`${provider}ApiKey`], baseUrl: settings[`${provider}BaseUrl`],
      model: settings[`${provider}Model`], vision: settings[`${provider}Vision`] === true,
    };
    const chosen = existing?.selected;
    const selected = chosen && SOURCES.includes(chosen) && isServiceSupported(provider, chosen)
      && endpoint(profiles[chosen].baseUrl, provider) === endpoint(current.baseUrl, provider)
      ? chosen : inferSource(provider, current.baseUrl);
    profiles[selected] = { ...current };
    custom.customProfiles[custom.selectedCustomId] = { ...profiles.custom, name: custom.customProfiles[custom.selectedCustomId]!.name };
    connections[provider] = { selected, profiles, ...custom };
  }
  return connections;
}

/** Flatten only the selected service for existing model clients. Clone profiles
 * so draft editing cannot mutate saved settings or the other protocol. */
export function applyServiceConnections(settings: Settings, connections: ServiceConnections): Settings {
  connections = copyConnections(connections);
  const result: Settings = { ...settings, connections: {} as ServiceConnections };
  for (const provider of PROVIDERS) {
    const selected = connections[provider].selected;
    if (!SOURCES.includes(selected) || !isServiceSupported(provider, selected)) throw new Error('此服务不支持当前接口协议，请使用 OpenAI 兼容接口。');
    const profiles = {} as Record<ServiceSource, ConnectionProfile>;
    for (const source of SOURCES) profiles[source] = copyProfile(connections[provider].profiles[source], freshProfile(provider, source));
    const profile = profiles[selected];
    if (selected !== 'custom' && inferSource(provider, profile.baseUrl) !== selected) throw new Error('预设地址已变化，请选择自定义服务。');
    result[`${provider}ApiKey`] = profile.apiKey;
    result[`${provider}BaseUrl`] = profile.baseUrl;
    result[`${provider}Model`] = profile.model;
    result[`${provider}Vision`] = profile.vision;
    result.connections![provider] = { ...connections[provider], selected, profiles };
  }
  return result;
}

export function getConnectionTargets(settings: Settings): ConnectionTarget[] {
  const connections = getServiceConnections(settings);
  const targets: ConnectionTarget[] = [];
  for (const provider of PROVIDERS) {
    const label = provider === 'anthropic' ? 'Claude' : 'OpenAI';
    for (const service of ['official', 'aitransx'] as const) {
      if (!isServiceSupported(provider, service)) continue;
      targets.push({ id: `${provider}:${service}`, provider, service,
        name: service === 'official' ? `${label} · 官方` : 'AITransX', profile: { ...connections[provider].profiles[service] } });
    }
    for (const [customId, profile] of Object.entries(connections[provider].customProfiles!)) {
      targets.push({ id: `${provider}:custom:${customId}`, provider, service: 'custom', customId,
        name: `${label} · ${profile.name}`, profile: copyProfile(profile, freshProfile(provider, 'custom')) });
    }
  }
  return targets;
}

export function getActiveConnectionTarget(settings: Settings): ConnectionTarget {
  const entry = getServiceConnections(settings)[settings.provider];
  const id = `${settings.provider}:${entry.selected}${entry.selected === 'custom' ? `:${entry.selectedCustomId}` : ''}`;
  return getConnectionTargets(settings).find((target) => target.id === id)!;
}

export function activateConnection(settings: Settings, targetId: string, model?: string): Settings {
  const target = getConnectionTargets(settings).find((item) => item.id === targetId);
  if (!target) throw new Error('此连接已删除，请重新选择。');
  let connections = getServiceConnections(settings);
  if (target.service === 'custom') connections = selectCustomConnection(connections, target.provider, target.customId!);
  else connections[target.provider].selected = target.service;
  const profile = connections[target.provider].profiles[target.service];
  if (model !== undefined) {
    const value = model.trim();
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('模型名称无效，请重新选择。');
    if (value !== profile.model) profile.vision = false;
    profile.model = value;
  }
  return applyServiceConnections({ ...settings, provider: target.provider }, connections);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const settings = { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings>) ?? {}) };
  settings.anthropicVision = settings.anthropicVision === true;
  settings.openaiVision = settings.openaiVision === true;
  return applyServiceConnections(settings, getServiceConnections(settings));
}

export function isVisionEnabled(settings: Settings): boolean {
  return settings.provider === 'anthropic' ? settings.anthropicVision === true : settings.openaiVision === true;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
