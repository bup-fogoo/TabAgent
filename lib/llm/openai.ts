import type { Settings } from '@/lib/settings';
import type { ChatSession, SessionOptions, StepResult, ToolResult } from './types';

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

  constructor(
    private settings: Settings,
    private options: SessionOptions,
  ) {
    if (!settings.openaiBaseUrl) throw new Error('还没有填写接口地址，请先打开设置页');
    this.messages = [{ role: 'system', content: options.system }];
  }

  addUserMessage(text: string) {
    this.messages.push({ role: 'user', content: text });
  }

  addToolResults(results: ToolResult[]) {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `错误：${r.content}` : r.content });
    }
  }

  async step(signal: AbortSignal): Promise<StepResult> {
    const url = this.settings.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.settings.openaiApiKey ? { authorization: `Bearer ${this.settings.openaiApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.settings.openaiModel,
        messages: this.messages,
        tools: this.options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`接口返回 ${res.status}：${(await res.text()).slice(0, 500)}`);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('接口返回格式不正确：' + JSON.stringify(data).slice(0, 300));

    const toolCalls: OpenAIToolCall[] = msg.tool_calls ?? [];
    this.messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    return {
      text: (msg.content ?? '').trim(),
      toolCalls: toolCalls.map((c) => {
        let input: Record<string, any> = {};
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = { __invalid_json: c.function.arguments };
        }
        return { id: c.id, name: c.function.name, input };
      }),
    };
  }
}
