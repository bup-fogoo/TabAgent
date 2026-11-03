import { browser } from 'wxt/browser';

export type Provider = 'anthropic' | 'openai';
export type Effort = 'low' | 'medium' | 'high';

export interface Settings {
  provider: Provider;
  anthropicApiKey: string;
  anthropicModel: string;
  /** 留空使用官方地址 https://api.anthropic.com */
  anthropicBaseUrl: string;
  openaiApiKey: string;
  /** 任何兼容 OpenAI Chat Completions 的地址，如 https://api.openai.com/v1、DeepSeek、通义、Ollama 等 */
  openaiBaseUrl: string;
  openaiModel: string;
  effort: Effort;
  /** 单个任务最多执行的工具调用轮数，防止失控 */
  maxSteps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  anthropicBaseUrl: '',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  effort: 'medium',
  maxSteps: 40,
};

const KEY = 'tabagent:settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings>) ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
