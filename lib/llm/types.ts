import type { ToolDef } from '@/lib/tools';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

/** Ephemeral screenshot evidence; never persisted in conversation events. */
export interface VisionImage {
  mediaType: 'image/jpeg' | 'image/png';
  /** Base64 image bytes without the data URL prefix. */
  data: string;
  width: number;
  height: number;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
  image?: VisionImage;
}

export interface StepResult {
  /** 模型本轮写给用户的文字 */
  text: string;
  /** 本轮要执行的工具；为空表示任务结束、等待用户 */
  toolCalls: ToolCall[];
}

/** 一段对话。每家模型服务各自保存原生格式的历史记录。 */
export interface ChatSession {
  restoreHistory(messages: Array<{ role: 'user' | 'assistant'; text: string }>): void;
  addUserMessage(text: string): void;
  addToolResults(results: ToolResult[]): void;
  step(signal: AbortSignal, onText?: (delta: string) => void): Promise<StepResult>;
}

export interface SessionOptions {
  system: string;
  tools: ToolDef[];
}
