import type { Settings } from '@/lib/settings';

export type DiagnosticCode = 'auth' | 'not_found' | 'rate_limit' | 'timeout' | 'network' | 'format' | 'tools' | 'request' | 'server' | 'cancelled';

/** Only our own fixed messages reach the UI; remote bodies can contain credentials. */
export class ModelRequestError extends Error {
  readonly code: DiagnosticCode;
  readonly status?: number;

  constructor(code: DiagnosticCode, message: string, status?: number) {
    super(message);
    this.name = 'ModelRequestError';
    this.code = code;
    this.status = status;
  }
}

export function asModelError(error: unknown, signal?: AbortSignal): ModelRequestError {
  if (signal?.aborted) return new ModelRequestError('cancelled', '已取消请求。');
  if (error instanceof ModelRequestError) return error;
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const name = String(detail.name ?? '');
  if (/timeout/i.test(name)) return new ModelRequestError('timeout', '模型服务响应超时，请稍后重试或检查接口地址。');
  if (/abort/i.test(name)) return new ModelRequestError('cancelled', '已取消请求。');
  const status = Number(detail.status);
  if (Number.isFinite(status) && status >= 400) return httpError(status, String(detail.message ?? ''));
  if (error instanceof SyntaxError) return new ModelRequestError('format', '服务返回的内容不是有效 JSON，请检查是否填写了 API 接口地址。');
  return new ModelRequestError('network', '无法连接模型服务，请检查网络、接口地址或服务的跨域设置。');
}

function httpError(status: number, detail = ''): ModelRequestError {
  if (status === 401 || status === 403) return new ModelRequestError('auth', `鉴权失败（${status}），请检查 API Key 及模型访问权限。`, status);
  if (status === 404) return new ModelRequestError('not_found', '找不到模型或接口（404），请核对模型名称与基础地址。', status);
  if (status === 429) return new ModelRequestError('rate_limit', '请求受限（429），请检查服务额度或稍后重试。', status);
  if (status === 408 || status === 504) return new ModelRequestError('timeout', `模型服务响应超时（${status}），请稍后重试。`, status);
  if (status >= 500) return new ModelRequestError('server', `模型服务暂时不可用（${status}），请稍后重试。`, status);
  if (/tool|function.?call/i.test(detail)) return new ModelRequestError('tools', `服务未接受工具调用参数（${status}），请使用支持工具调用的模型或兼容接口。`, status);
  return new ModelRequestError('request', `请求未被接受（${status}），请检查模型名称、接口类型和配置。`, status);
}

/** The deadline covers both response headers and body, and always releases listeners. */
export async function fetchModelJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = 90000,
): Promise<any> {
  return fetchModelResponse(url, init, signal, (response) => response.json(), timeoutMs);
}

/** Share the same full-response deadline with JSON and streaming transports. */
export async function fetchModelResponse<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  timeoutMs = 90000,
): Promise<T> {
  return withModelDeadline(signal, async (requestSignal) => {
    const response = await fetch(url, { ...init, signal: requestSignal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw httpError(response.status, detail);
    }
    return consume(response, requestSignal);
  }, timeoutMs);
}

export async function withModelDeadline<T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 90000,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw asModelError(error, signal);
    if (timedOut) throw new ModelRequestError('timeout', '模型服务响应超时，请稍后重试或检查接口地址。');
    throw asModelError(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

const PROBE_NAME = 'tabagent_connection_probe';
const PROBE_VALUE = 'tabagent-ok';
const PROBE_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string', enum: [PROBE_VALUE] } },
  required: ['value'],
  additionalProperties: false,
};

export interface ConnectionTestResult {
  elapsedMs: number;
  model: string;
}

/** A user-triggered, fixed-text probe. It never executes the returned tool. */
export async function testModelConnection(settings: Settings, signal: AbortSignal, timeoutMs = 20000): Promise<ConnectionTestResult> {
  const started = performance.now();
  const anthropic = settings.provider === 'anthropic';
  const model = anthropic ? settings.anthropicModel : settings.openaiModel;
  const content = `Connection test only. Call ${PROBE_NAME} once with value "${PROBE_VALUE}". Do not write any other content.`;
  const base = (anthropic ? settings.anthropicBaseUrl || 'https://api.anthropic.com' : settings.openaiBaseUrl).replace(/\/+$/, '');
  const body = anthropic ? {
    model,
    max_tokens: 128,
    messages: [{ role: 'user', content }],
    tools: [{ name: PROBE_NAME, description: 'Return the fixed connection-test value. This tool performs no action.', input_schema: PROBE_SCHEMA }],
    tool_choice: { type: 'tool', name: PROBE_NAME },
  } : {
    model,
    messages: [{ role: 'user', content }],
    tools: [{ type: 'function', function: { name: PROBE_NAME, description: 'Return the fixed connection-test value. This tool performs no action.', parameters: PROBE_SCHEMA } }],
    tool_choice: { type: 'function', function: { name: PROBE_NAME } },
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = settings.anthropicApiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (settings.openaiApiKey) headers.authorization = `Bearer ${settings.openaiApiKey}`;

  const data = await fetchModelJson(`${base}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }, signal, timeoutMs);
  let valid = false;
  if (anthropic) {
    if (!Array.isArray(data?.content)) throw new ModelRequestError('format', '服务返回格式不符合 Anthropic Messages 接口，请检查接口类型。');
    valid = data.content.some((block: any) => block?.type === 'tool_use' && block.name === PROBE_NAME && block.input?.value === PROBE_VALUE);
  } else {
    const message = data?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new ModelRequestError('format', '服务返回格式不符合 Chat Completions 接口，请检查接口类型。');
    valid = Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) => {
      if (call?.function?.name !== PROBE_NAME) return false;
      try { return JSON.parse(call.function.arguments)?.value === PROBE_VALUE; } catch { return false; }
    });
  }
  if (!valid) throw new ModelRequestError('tools', '服务已响应，但未返回有效的工具调用。请确认所选模型和接口支持工具调用。');
  return { elapsedMs: Math.round(performance.now() - started), model };
}
