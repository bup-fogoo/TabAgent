import type { Provider, ServiceSource } from './settings';

export interface CatalogConnection {
  provider: Provider;
  service: ServiceSource;
  baseUrl: string;
  apiKey: string;
}

export interface CatalogRoute { id: string; name: string; modelId: string }
export interface CatalogModel {
  id: string;
  name: string;
  vendor?: string;
  contextWindow?: number;
  vision?: boolean;
  tools?: boolean;
  routes?: CatalogRoute[];
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5000;
const MAX_PAGES = 20;
const TIMEOUT_MS = 20000;
type Row = Record<string, unknown>;

class CatalogError extends Error {}

function baseAddress(connection: CatalogConnection): URL {
  let url: URL;
  try { url = new URL(connection.baseUrl.trim() || (connection.provider === 'anthropic' ? 'https://api.anthropic.com' : '')); }
  catch { throw new CatalogError('请先填写有效的模型服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CatalogError('模型服务地址须为 HTTP 或 HTTPS 基础地址，不能包含账号、查询参数或锚点。');
  }
  return url;
}

export function isAITransXConnection(connection: CatalogConnection): boolean {
  try {
    const url = baseAddress(connection);
    return connection.provider === 'openai' && url.origin === 'https://api.aitransx.com' && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch { return false; }
}

function string(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string') return;
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) return;
  return clean;
}

function object(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function capability(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const supported = object(value)?.supported;
  return typeof supported === 'boolean' ? supported : undefined;
}

function listedChatModel(row: Row): boolean {
  if (row.lifecycle === 'retired') return false;
  const type = string(row.model_type ?? row.task_type ?? row.type)?.toLowerCase();
  if (type && ['image', 'image-generation', 'image_generation', 'audio', 'speech', 'tts', 'embedding', 'embeddings', 'rerank', 'video', 'tool'].includes(type)) return false;
  const architecture = object(row.architecture);
  const outputs = row.output_modalities ?? architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length > 0 && outputs.every((item) => typeof item === 'string') && !outputs.includes('text')) return false;
  return true;
}

// Matches AITransX's public workbench classification (playground.go), only for
// its verified endpoint. /models itself does not expose capability metadata.
function aitransxChatModel(id: string): boolean {
  const model = id.trim().toLowerCase();
  return model !== 'auto' && model !== 'deepseek-search' && model !== 'deepseek-fetch'
    && !['nanobanana', 'nano-banana', 'nano_banana'].includes(model)
    && !model.includes('image') && !model.includes('tts')
    && !model.includes('text-to-speech') && !model.includes('text_to_speech');
}

function modelFrom(row: Row): CatalogModel | undefined {
  const id = string(row.id);
  if (!id || !listedChatModel(row)) return;
  const capabilities = object(row.capabilities);
  const context = row.context_length ?? row.max_input_tokens ?? row.context_window;
  const model: CatalogModel = { id, name: string(row.display_name ?? row.name) ?? id };
  const vendor = string(row.owned_by);
  if (vendor && vendor !== 'aitransx') model.vendor = vendor;
  if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) model.contextWindow = context;
  const vision = capability(capabilities?.image_input ?? capabilities?.vision ?? row.supports_vision);
  const tools = capability(capabilities?.tool_calling ?? capabilities?.tools ?? row.supports_tools);
  if (vision !== undefined) model.vision = vision;
  if (tools !== undefined) model.tools = tools;
  return model;
}

function catalog(rows: Row[], aitransx: boolean): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  const raw = new Map<string, Row>();
  for (const row of rows) {
    const model = modelFrom(row);
    if (!model || models.has(model.id)) continue;
    if (aitransx) {
      const actual = string(row.actual_model) ?? model.id.split('@').at(-1)!;
      if (!aitransxChatModel(actual)) continue;
      // The namespace labels the model family in the picker, never its route.
      // Supplier routing exclusively uses owned_by and the returned wire ID below.
      const namespace = actual.includes('/') ? actual.split('/')[0] : undefined;
      delete model.vendor;
      if (namespace) model.vendor = namespace;
    }
    models.set(model.id, model);
    raw.set(model.id, row);
  }
  if (aitransx) {
    for (const [id, row] of raw) {
      const actual = string(row.actual_model);
      const group = actual ? models.get(actual) : undefined;
      // Only attach routes to a returned automatic ID; never invent a model ID.
      if (!actual || actual === id || !group || string(raw.get(actual)?.actual_model)) continue;
      const supplier = string(row.owned_by) ?? id.split('@')[0] ?? id;
      (group.routes ??= []).push({ id: supplier, name: supplier, modelId: id });
      models.delete(id);
    }
  }
  return [...models.values()];
}

function statusError(status: number): CatalogError {
  if (status === 401 || status === 403) return new CatalogError(`无法获取模型（${status}），请检查当前服务的 API Key 和权限。`);
  if (status === 404 || status === 405) return new CatalogError('此服务未提供模型列表，请手动填写模型名。');
  if (status === 429) return new CatalogError('模型列表请求过于频繁，请稍后刷新。');
  return new CatalogError(`获取模型列表失败（${status}），可稍后刷新或手动填写模型名。`);
}

async function readJson(response: Response, budget: { bytes: number }, signal: AbortSignal): Promise<Row> {
  if (Number(response.headers.get('content-length')) + budget.bytes > MAX_BYTES) {
    await response.body?.cancel();
    throw new CatalogError('模型列表过大，请手动填写模型名。');
  }
  if (!response.body) throw new CatalogError('服务返回了空模型列表响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_BYTES) throw new CatalogError('模型列表过大，请手动填写模型名。');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try {
    const result = object(JSON.parse(text));
    if (result) return result;
  } catch { /* Remote response text must never appear in diagnostics. */ }
  throw new CatalogError('服务返回的模型列表格式无效，可手动填写模型名。');
}

/** No storage or background retries. Authentication remains confined to the
 * configured endpoint; AITransX's public catalogue intentionally sends no key. */
export async function listModels(connection: CatalogConnection, signal: AbortSignal): Promise<CatalogModel[]> {
  const controller = new AbortController();
  let timedOut = false;
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const base = baseAddress(connection);
    const aitransx = isAITransXConnection(connection);
    if (connection.service === 'aitransx' && !aitransx) throw new CatalogError('AITransX 模型列表需使用官方 OpenAI 兼容地址。');
    const native = connection.provider === 'anthropic';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!aitransx && connection.apiKey.trim()) {
      if (native) headers['x-api-key'] = connection.apiKey.trim();
      else headers.Authorization = `Bearer ${connection.apiKey.trim()}`;
    }
    if (native) {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/+$/, '') + (native ? '/v1/models' : '/models');
    if (native) url.searchParams.set('limit', '1000');
    const rows: Row[] = [];
    let entries = 0;
    const budget = { bytes: 0 };
    const cursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(url.href, { headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
      const body = await readJson(response, budget, controller.signal);
      controller.signal.throwIfAborted();
      if (!Array.isArray(body.data)) throw new CatalogError('服务返回的模型列表格式无效，可手动填写模型名。');
      entries += body.data.length;
      if (entries > MAX_MODELS) throw new CatalogError('模型列表条目过多，请手动填写模型名。');
      rows.push(...body.data.map(object).filter((row): row is Row => Boolean(row)));
      if (!native || body.has_more !== true) return catalog(rows, aitransx);
      const cursor = string(body.last_id);
      if (!cursor || cursors.has(cursor) || !body.data.length) throw new CatalogError('模型列表分页无效，请刷新或手动填写模型名。');
      cursors.add(cursor);
      url.searchParams.set('after_id', cursor);
    }
    throw new CatalogError('模型列表分页过多，请手动填写模型名。');
  } catch (error) {
    if (signal.aborted) throw new DOMException('已取消模型列表请求。', 'AbortError');
    if (timedOut) throw new CatalogError('获取模型列表超时，请刷新或手动填写模型名。');
    if (error instanceof CatalogError) throw error;
    throw new CatalogError('无法获取模型列表，请检查网络和接口地址，或手动填写模型名。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
