import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '@/lib/settings';
import type { ChatSession, SessionOptions, StepResult, ToolResult } from './types';

// 这些模型支持服务端拒答回退（fallbacks: "default"）
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// 这些模型支持 output_config.effort
const EFFORT_MODEL = /opus|fable|mythos|sonnet-5|haiku-5/;

export class AnthropicSession implements ChatSession {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(
    private settings: Settings,
    private options: SessionOptions,
  ) {
    if (!settings.anthropicApiKey) throw new Error('还没有填写 Anthropic API Key，请先打开设置页');
    this.client = new Anthropic({
      apiKey: settings.anthropicApiKey,
      baseURL: settings.anthropicBaseUrl || undefined,
      // 插件直接从浏览器调用 API；Key 只保存在本机浏览器的插件存储里
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
    });
  }

  addUserMessage(text: string) {
    this.messages.push({ role: 'user', content: text });
  }

  addToolResults(results: ToolResult[]) {
    // 并行的多个工具结果必须放在同一条 user 消息里
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError || undefined,
      })),
    });
  }

  async step(signal: AbortSignal): Promise<StepResult> {
    const model = this.settings.anthropicModel;
    const useFallbacks = FALLBACK_MODELS.has(model) && !this.settings.anthropicBaseUrl;
    const response = await this.client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        system: this.options.system,
        tools: this.options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        messages: this.messages,
        // 自动缓存不变的前缀（工具、系统提示、历史），降低多轮调用成本
        cache_control: { type: 'ephemeral' },
        ...(EFFORT_MODEL.test(model) ? { output_config: { effort: this.settings.effort } } : {}),
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal },
    );

    // 原样保存完整的 content（包括 thinking 块），下一轮必须原样回传
    this.messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (response.stop_reason === 'refusal') {
      throw new Error('模型拒绝了这个请求。');
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, any> }));

    if (response.stop_reason === 'max_tokens' && !toolCalls.length) {
      return { text: text + '\n（回复因长度上限被截断）', toolCalls };
    }
    return { text, toolCalls };
  }
}
