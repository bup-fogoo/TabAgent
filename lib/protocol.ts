// 各部分之间传递的消息类型。

/** 侧边栏 → 后台 */
export type PanelRequest =
  | { type: 'run'; text: string }
  | { type: 'stop' }
  | { type: 'reset' };

/** 后台 → 侧边栏 */
export type AgentEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'status'; running: boolean }
  | { type: 'error'; message: string }
  | { type: 'history'; events: AgentEvent[] };

/** 后台 → 内容脚本 */
export type ContentRequest =
  | { action: 'ping' }
  | { action: 'snapshot'; maxTextChars?: number; textOnly?: boolean }
  | { action: 'click'; id: number }
  | { action: 'type'; id: number; text: string; clear?: boolean; submit?: boolean }
  | { action: 'select'; id: number; option: string }
  | { action: 'press_key'; key: string; id?: number }
  | { action: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; id?: number }
  | { action: 'extract'; selector: string; attribute?: string; limit?: number }
  | { action: 'hover'; id: number };

export type ContentResponse = { ok: true; result: unknown } | { ok: false; error: string };

export const CONTENT_MESSAGE_TAG = 'tabagent:content';
export const PANEL_PORT_NAME = 'tabagent:panel';
