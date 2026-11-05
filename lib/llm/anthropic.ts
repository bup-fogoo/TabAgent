import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '@/lib/settings';
import type { ChatSession, SessionOptions, StepResult, ToolResult } from './types';
import { asModelError, ModelRequestError, withModelDeadline } from './diagnostics';
import { anthropicStreamFetch } from './streaming';
import { compactHistory, contextNotice, CONTEXT_CHAR_BUDGET, collectToolImages, imageEvidenceText, type ToolImageEvidence } from './context';

// 这些模型支持服务端拒答回退（fallbacks: "default"）
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// 这些模型支持 output_config.effort
const EFFORT_MODEL = /opus|fable|mythos|sonnet-5|haiku-5/;

export class AnthropicSession implements ChatSession {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private summary = '';
  private pendingImages: ToolImageEvidence[] = [];

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
      maxRetries: 1,
      timeout: 90000,
      fetch: anthropicStreamFetch,
    });
  }

  addUserMessage(text: string) {
    this.pendingImages = [];
    const last = this.messages.at(-1);
    if (last?.role === 'user' && typeof last.content === 'string') last.content += `\n\n${text}`;
    else this.messages.push({ role: 'user', content: text });
  }

  restoreHistory(messages: Array<{ role: 'user' | 'assistant'; text: string }>) {
    this.pendingImages = [];
    this.messages = [];
    this.summary = '';
    for (const message of messages) {
      if (!message.text.trim()) continue;
      if (!this.messages.length && message.role !== 'user') continue;
      const last = this.messages.at(-1);
      if (last?.role === message.role && typeof last.content === 'string') last.content += `\n\n${message.text}`;
      else this.messages.push({ role: message.role, content: message.text });
    }
    this.compact();
  }

  addToolResults(results: ToolResult[]) {
    this.pendingImages = [...this.pendingImages, ...collectToolImages(results)].slice(-2);
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

  private compact() {
    const compacted = compactHistory(this.messages, this.summary, CONTEXT_CHAR_BUDGET - this.options.system.length - JSON.stringify(this.options.tools).length - 512);
    this.messages = compacted.messages;
    this.summary = compacted.summary;
  }

  async step(signal: AbortSignal, onText?: (delta: string) => void): Promise<StepResult> {
    const images = this.pendingImages;
    this.pendingImages = [];
    this.compact();
    const model = this.settings.anthropicModel;
    const baseUrl = this.settings.anthropicBaseUrl.trim();
    const official = !baseUrl || new URL(baseUrl).href.replace(/\/+$/, '') === 'https://api.anthropic.com';
    const useFallbacks = FALLBACK_MODELS.has(model) && official;
    const remaining = new Map(images.map((image) => [image.id, image]));
    const imageBlocks = (evidence: ToolImageEvidence): Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> => [
      { type: 'text', text: imageEvidenceText(evidence) },
      { type: 'image', source: { type: 'base64', media_type: evidence.image.mediaType, data: evidence.image.data } },
    ];
    const messages = this.messages.map((message): Anthropic.Beta.BetaMessageParam => ({
      ...message,
      content: typeof message.content === 'string' ? message.content : message.content.map((block) => {
        const evidence = block.type === 'tool_result' ? remaining.get(block.tool_use_id) : undefined;
        if (!evidence || block.type !== 'tool_result') return block;
        remaining.delete(evidence.id);
        return { ...block, content: imageBlocks(evidence) };
      }),
    }));
    // An oversized complete exchange can be summarized by text compaction.
    // Keep its fresh screenshot as attributed data, without an orphan result.
    if (remaining.size) {
      const evidence = [...remaining.values()].flatMap(imageBlocks);
      const last = messages.at(-1);
      if (last?.role === 'user') last.content = [...(typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content), ...evidence];
      else messages.push({ role: 'user', content: evidence });
    }
    if (this.summary) {
      const first = messages[0];
      const notice = contextNotice(this.summary);
      if (first?.role === 'user') messages[0] = { ...first, content: typeof first.content === 'string' ? `${notice}\n\n${first.content}` : [{ type: 'text', text: notice }, ...first.content] };
      else messages.unshift({ role: 'user', content: notice });
    }
    const response = await withModelDeadline(signal, async (requestSignal) => {
      let stopped = false;
      const unfinished = new Set<number>();
      const toolJson = new Map<number, string>();
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: this.options.system,
          tools: this.options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages,
          // 自动缓存不变的前缀（工具、系统提示、历史），降低多轮调用成本
          cache_control: { type: 'ephemeral' },
          ...(EFFORT_MODEL.test(model) ? { output_config: { effort: this.settings.effort } } : {}),
          ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: requestSignal },
      );
      stream.on('text', (delta) => { requestSignal.throwIfAborted(); onText?.(delta); });
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_stop') stopped = true;
        if (event.type === 'content_block_start') {
          unfinished.add(event.index);
          if (event.content_block.type === 'tool_use') toolJson.set(event.index, '');
        }
        if (event.type === 'content_block_stop') unfinished.delete(event.index);
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          toolJson.set(event.index, (toolJson.get(event.index) ?? '') + event.delta.partial_json);
        }
      });
      const final = await stream.finalMessage();
      if (!stopped || !final.stop_reason || unfinished.size) throw new ModelRequestError('format', '模型回复未完整接收，请重试。未执行未完成的工具调用。');
      for (const json of toolJson.values()) {
        if (!json) continue;
        try {
          const input = JSON.parse(json);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
        } catch { throw new ModelRequestError('format', '模型返回的工具参数不完整，未执行。请重试。'); }
      }
      return final;
    }).catch((error: unknown) => {
      const diagnostic = asModelError(error, signal);
      if (images.length && [400, 415, 422].includes(diagnostic.status ?? 0)) {
        throw new ModelRequestError('request', '模型服务未接受图片请求，请在设置中关闭“图片识别”后继续文字分析，或更换支持图片的模型。', diagnostic.status);
      }
      throw diagnostic;
    });
    signal.throwIfAborted();

    if (!Array.isArray(response?.content)) throw new ModelRequestError('format', '服务返回格式不符合 Anthropic Messages 接口，请检查接口类型。');

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

    if (toolCalls.some((call) => !call.id || !call.name || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) || (response.stop_reason === 'max_tokens' && toolCalls.length)) {
      throw new ModelRequestError('format', '模型返回的工具调用不完整，未执行。请缩小任务范围后重试。');
    }
    // 保留最近完整的原生 content（包括 thinking 签名），压缩时只移除整个旧轮次。
    this.messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (response.stop_reason === 'max_tokens' && !toolCalls.length) {
      return { text: text + '\n（回复因长度上限被截断）', toolCalls };
    }
    return { text, toolCalls };
  }
}
