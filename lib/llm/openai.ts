import type { Settings } from '@/lib/settings';
import type { ChatSession, SessionOptions, StepResult, ToolResult } from './types';
import { fetchModelResponse, ModelRequestError } from './diagnostics';
import { readOpenAIResponse } from './streaming';
import { compactHistory, contextNotice, CONTEXT_CHAR_BUDGET, collectToolImages, imageEvidenceText, type ToolImageEvidence } from './context';

// 兼容 OpenAI Chat Completions 接口的服务：OpenAI、DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama 等。

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export class OpenAISession implements ChatSession {
  private messages: Message[];
  private summary = '';
  private pendingImages: ToolImageEvidence[] = [];

  constructor(
    private settings: Settings,
    private options: SessionOptions,
  ) {
    if (!settings.openaiBaseUrl) throw new Error('还没有填写接口地址，请先打开设置页');
    this.messages = [{ role: 'system', content: options.system }];
  }

  addUserMessage(text: string) {
    this.pendingImages = [];
    const last = this.messages.at(-1);
    if (last?.role === 'user') last.content += `\n\n${text}`;
    else this.messages.push({ role: 'user', content: text });
  }

  restoreHistory(messages: Array<{ role: 'user' | 'assistant'; text: string }>) {
    this.pendingImages = [];
    this.summary = '';
    this.messages = [{ role: 'system', content: this.options.system }];
    for (const message of messages) {
      if (!message.text.trim()) continue;
      const last = this.messages.at(-1);
      if (last?.role === message.role) last.content = `${last.content ?? ''}\n\n${message.text}`;
      else this.messages.push({ role: message.role, content: message.text });
    }
    this.compact();
  }

  addToolResults(results: ToolResult[]) {
    this.pendingImages = [...this.pendingImages, ...collectToolImages(results)].slice(-2);
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `错误：${r.content}` : r.content });
    }
  }

  private compact() {
    const compacted = compactHistory(this.messages.slice(1), this.summary, CONTEXT_CHAR_BUDGET - this.options.system.length - JSON.stringify(this.options.tools).length - 512);
    this.summary = compacted.summary;
    this.messages = [{ role: 'system', content: this.options.system }, ...compacted.messages];
  }

  async step(signal: AbortSignal, onText?: (delta: string) => void): Promise<StepResult> {
    const images = this.pendingImages;
    this.pendingImages = [];
    this.compact();
    const url = this.settings.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
    const data = await fetchModelResponse(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.settings.openaiApiKey ? { authorization: `Bearer ${this.settings.openaiApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.settings.openaiModel,
        stream: true,
        messages: [
          this.messages[0], ...(this.summary ? [{ role: 'user', content: contextNotice(this.summary) }] : []), ...this.messages.slice(1),
          // Chat Completions tool messages accept text only. Image evidence is
          // appended after the entire result batch, preserving tool pairing.
          ...(images.length ? [{ role: 'user', content: images.flatMap((evidence) => [
            { type: 'text', text: imageEvidenceText(evidence) },
            { type: 'image_url', image_url: { url: `data:${evidence.image.mediaType};base64,${evidence.image.data}`, detail: 'auto' } },
          ]) }] : []),
        ],
        tools: this.options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
    }, signal, (response, requestSignal) => readOpenAIResponse(response, requestSignal, onText)).catch((error: unknown) => {
      if (images.length && error instanceof ModelRequestError && [400, 415, 422].includes(error.status ?? 0)) {
        throw new ModelRequestError('request', '模型服务未接受图片请求，请在设置中关闭“图片识别”后继续文字分析，或更换支持图片的模型。', error.status);
      }
      throw error;
    });
    signal.throwIfAborted();
    const msg = data?.choices?.[0]?.message;
    if (!msg || (msg.content != null && typeof msg.content !== 'string') || (msg.tool_calls != null && !Array.isArray(msg.tool_calls))) {
      throw new ModelRequestError('format', '服务返回格式不符合 Chat Completions 接口，请检查接口类型。');
    }

    const toolCalls: OpenAIToolCall[] = msg.tool_calls ?? [];
    if (data.choices[0].finish_reason === 'length' && toolCalls.length) throw new ModelRequestError('format', '工具调用因长度上限被截断，未执行。请缩小任务范围后重试。');
    if (toolCalls.some((call) => typeof call?.id !== 'string' || typeof call?.function?.name !== 'string' || typeof call?.function?.arguments !== 'string')) {
      throw new ModelRequestError('format', '模型返回的工具调用格式不完整，请重新尝试或更换模型。');
    }
    this.messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    return {
      text: (msg.content ?? '').trim() + (data.choices[0].finish_reason === 'length' ? '\n（回复因长度上限被截断）' : ''),
      toolCalls: toolCalls.map((c) => {
        let input: Record<string, any> = {};
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          if (!input || typeof input !== 'object' || Array.isArray(input)) input = { __invalid_json: c.function.arguments };
        } catch {
          input = { __invalid_json: c.function.arguments };
        }
        return { id: c.id, name: c.function.name, input };
      }),
    };
  }
}
