import { browser } from 'wxt/browser';
import type { Provider, ServiceSource } from './settings';

export const MODEL_LIBRARY_PREFIX = 'tabagent:model-library:';
export interface ModelLibrary { favorites: string[]; recent: string[] }
interface Entry { model: string; at: number; favorite?: boolean }
interface StoredEntry extends Entry { key: string; kind: 'favorite' | 'recent' }
const FAVORITE_LIMIT = 30;
const RECENT_LIMIT = 10;
let lastTime = 0;

/** Connection identity contains no authentication. Query/userinfo/fragment data
 * are deliberately excluded, including malformed draft addresses. */
export function getModelScope(provider: Provider, service: ServiceSource, baseUrl: string, customId?: string): string {
  let endpoint = 'invalid';
  try {
    const url = new URL(baseUrl.trim() || (provider === 'anthropic' ? 'https://api.anthropic.com' : ''));
    if (['http:', 'https:'].includes(url.protocol)) endpoint = url.origin + url.pathname.replace(/\/+$/, '');
  } catch { /* Unsaved invalid addresses have no usable catalog. */ }
  return JSON.stringify([provider, service, service === 'custom' ? customId ?? 'default' : '', endpoint]);
}

function checkedModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('模型名称无效。');
  return model;
}

async function scopePrefix(scope: string): Promise<string> {
  if (!scope || scope.length > 8192) throw new Error('模型连接标识无效。');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  return MODEL_LIBRARY_PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') + ':';
}

async function entries(prefix: string): Promise<StoredEntry[]> {
  const storage = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> };
  let values: Record<string, unknown>;
  if (typeof storage.getKeys === 'function') {
    const keys = (await storage.getKeys()).filter((key) => key.startsWith(prefix));
    values = keys.length ? await storage.get(keys) : {};
  } else values = await storage.get(null);
  const result: StoredEntry[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(prefix) || !raw || typeof raw !== 'object') continue;
    const value = raw as Partial<Entry>;
    const kind = key.slice(prefix.length).startsWith('f:') ? 'favorite' : key.slice(prefix.length).startsWith('r:') ? 'recent' : undefined;
    if (!kind || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256
      || /[\u0000-\u001f\u007f]/.test(value.model) || !Number.isSafeInteger(value.at) || value.at! < 0
      || (kind === 'favorite' && typeof value.favorite !== 'boolean')) continue;
    result.push({ key, kind, model: value.model, at: value.at!, ...(kind === 'favorite' ? { favorite: value.favorite } : {}) });
  }
  return result.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
}

function latest(values: StoredEntry[]): StoredEntry[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = `${value.kind}:${value.model}`;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}

function library(values: StoredEntry[]): ModelLibrary {
  const current = latest(values);
  return {
    favorites: current.filter((entry) => entry.kind === 'favorite' && entry.favorite).slice(0, FAVORITE_LIMIT).map((entry) => entry.model),
    recent: current.filter((entry) => entry.kind === 'recent').slice(0, RECENT_LIMIT).map((entry) => entry.model),
  };
}

export async function loadModelLibrary(scope: string): Promise<ModelLibrary> {
  return library(await entries(await scopePrefix(scope)));
}

/** Each operation has its own immutable storage key. Concurrent windows cannot
 * overwrite one another's changes to different models. Cleanup removes only
 * records in its snapshot, never a new operation that arrived while pruning. */
async function prune(prefix: string): Promise<void> {
  const snapshot = await entries(prefix);
  const current = latest(snapshot);
  const keep = new Set([
    ...current.filter((entry) => entry.kind === 'favorite' && entry.favorite).slice(0, FAVORITE_LIMIT),
    ...current.filter((entry) => entry.kind === 'favorite' && !entry.favorite).slice(0, FAVORITE_LIMIT),
    ...current.filter((entry) => entry.kind === 'recent').slice(0, RECENT_LIMIT),
  ].map((entry) => entry.key));
  const remove = snapshot.filter((entry) => !keep.has(entry.key)).map((entry) => entry.key);
  if (remove.length) await browser.storage.local.remove(remove);
}

async function append(prefix: string, kind: 'f' | 'r', value: Omit<Entry, 'at'>): Promise<void> {
  lastTime = Math.max(Date.now(), lastTime + 1);
  const key = `${prefix}${kind}:${lastTime}:${crypto.randomUUID()}`;
  await browser.storage.local.set({ [key]: { ...value, at: lastTime } });
  await prune(prefix);
}

export async function setModelFavorite(scope: string, model: string, favorite: boolean): Promise<void> {
  const id = checkedModel(model);
  const prefix = await scopePrefix(scope);
  if (favorite) {
    const current = library(await entries(prefix));
    if (!current.favorites.includes(id) && current.favorites.length >= FAVORITE_LIMIT) throw new Error('最多收藏 30 个模型，请先取消一个收藏。');
  }
  await append(prefix, 'f', { model: id, favorite: favorite === true });
}

export async function recordRecentModel(scope: string, model: string): Promise<void> {
  await append(await scopePrefix(scope), 'r', { model: checkedModel(model) });
}
