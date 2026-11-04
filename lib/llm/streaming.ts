import { ModelRequestError } from './diagnostics';

const STREAM_LIMIT = 2_000_000;
const formatError = () => new ModelRequestError('format', '模型回复未完整接收，请重试。未执行未完成的工具调用。');

/** SSE framing is independent from network chunks, including split UTF-8 and CRLF. */
export async function* readSSE(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw formatError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fields: string[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      size += value?.byteLength ?? 0;
      if (size > STREAM_LIMIT) throw new ModelRequestError('format', '模型回复过长，请缩小任务范围后重试。');
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line) {
          if (fields.length) yield fields.join('\n');
          fields = [];
        } else if (line.startsWith('data:')) fields.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    // An unterminated final SSE frame is not a completed event.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readOpenAIResponse(response: Response, signal: AbortSignal, onText?: (delta: string) => void): Promise<any> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) onText?.(text);
    return json;
  }
  let content = '';
  let finishReason: string | null = null;
  let completed = false;
  const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  for await (const data of readSSE(response, signal)) {
    signal.throwIfAborted();
    if (data.trim() === '[DONE]') { completed = true; break; }
    let event: any;
    try { event = JSON.parse(data); } catch { throw formatError(); }
    if (event?.error) throw new ModelRequestError('server', '模型服务中断了回复，请稍后重试。');
    if (!Array.isArray(event?.choices)) throw formatError();
    const choice = event.choices.find((item: any) => (item.index ?? 0) === 0);
    if (!choice) continue; // Usage-only frames have an empty choices array.
    const delta = choice.delta ?? {};
    if (delta.content != null && typeof delta.content !== 'string') throw formatError();
    if (delta.content) { content += delta.content; onText?.(delta.content); }
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw formatError();
    for (const piece of delta.tool_calls ?? []) {
      if (!Number.isInteger(piece.index) || piece.index < 0 || piece.index > 100) throw formatError();
      const call = calls.get(piece.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (piece.id != null) {
        if (typeof piece.id !== 'string' || (call.id && call.id !== piece.id)) throw formatError();
        call.id = piece.id;
      }
      if (piece.type != null && piece.type !== 'function') throw formatError();
      for (const key of ['name', 'arguments'] as const) {
        const part = piece.function?.[key];
        if (part != null && typeof part !== 'string') throw formatError();
        if (part) call.function[key] += part;
      }
      calls.set(piece.index, call);
    }
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== 'string') throw formatError();
      finishReason = choice.finish_reason;
    }
  }
  if (!completed || !finishReason) throw formatError();
  const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.length && finishReason !== 'tool_calls' && finishReason !== 'stop') throw formatError();
  for (const call of toolCalls) {
    if (!call.id || !call.function.name) throw formatError();
    try {
      const input = JSON.parse(call.function.arguments || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw formatError();
    } catch { throw formatError(); }
  }
  return { choices: [{ finish_reason: finishReason, message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
}

/** Some compatible proxies ignore stream:true. Adapt their single JSON response
 * to SDK events without retrying the request or re-running model generation. */
export const anthropicStreamFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
  const message = await response.json();
  if (!Array.isArray(message?.content)) throw formatError();
  const events: any[] = [{ type: 'message_start', message: { ...message, type: 'message', role: 'assistant', content: [], stop_reason: null, usage: message.usage ?? { input_tokens: 0, output_tokens: 0 } } }];
  message.content.forEach((block: any, index: number) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : block });
    if (block.type === 'text') events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason ?? (message.content.some((block: any) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: message.stop_sequence ?? null }, usage: message.usage ?? { output_tokens: 0 } });
  events.push({ type: 'message_stop' });
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: response.status, headers: { 'content-type': 'text/event-stream', 'request-id': response.headers.get('request-id') ?? '' },
  });
};
