import { browser } from 'wxt/browser';

export type Provider = 'anthropic' | 'openai';
export type Effort = 'low' | 'medium' | 'high';

export interface Settings {
  provider: Provider;
  anthropicApiKey: string;
  anthropicModel: string;
  /** 留空使用官方地址 https://api.anthropic.com */
  anthropicBaseUrl: string;
  anthropicVision: boolean;
  openaiApiKey: string;
  /** 任何兼容 OpenAI Chat Completions 的地址，如 https://api.openai.com/v1、DeepSeek、通义、Ollama 等 */
  openaiBaseUrl: string;
  openaiModel: string;
  openaiVision: boolean;
  effort: Effort;
  /** 单个任务最多执行的工具调用轮数，防止失控 */
  maxSteps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  anthropicBaseUrl: '',
  anthropicVision: false,
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiVision: false,
  effort: 'medium',
  maxSteps: 40,
};

const KEY = 'tabagent:settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  const settings = { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings>) ?? {}) };
  settings.anthropicVision = settings.anthropicVision === true;
  settings.openaiVision = settings.openaiVision === true;
  return settings;
}

export function isVisionEnabled(settings: Settings): boolean {
  return settings.provider === 'anthropic' ? settings.anthropicVision === true : settings.openaiVision === true;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}
