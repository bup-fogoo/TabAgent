// Shared messages between the side panel, background worker and content script.
export type TaskMode = 'read-only' | 'confirm';
export type ConversationState = 'idle' | 'running' | 'waiting' | 'completed' | 'stopped' | 'interrupted' | 'error';
export interface SourceReference {
  id: string;
  title: string;
  url: string;
  kind: 'page' | 'search';
}
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  state: ConversationState;
  messageCount: number;
}
export interface ApprovalRequest {
  id: string;
  name: string;
  input: unknown;
  tabId?: number;
  title: string;
  url: string;
  description: string;
}

export type PanelRequest =
  | { type: 'run'; text: string; mode?: TaskMode; tabIds?: number[] }
  | { type: 'stop' }
  | { type: 'keep_page'; tabId: number }
  | { type: 'sources_open'; taskId: string; sourceIds: string[] }
  | { type: 'reset' }
  | { type: 'approve'; id: string; approved: boolean }
  | { type: 'conversation_list' }
  | { type: 'conversation_open'; id: string }
  | { type: 'conversation_search'; query: string }
  | { type: 'conversation_rename'; id: string; title: string }
  | { type: 'conversation_delete'; id: string };

export type AgentEvent =
  | { type: 'user'; text: string; taskId?: string }
  | { type: 'sources'; taskId: string; pages: SourceReference[] }
  | { type: 'assistant'; text: string; id?: string; interrupted?: boolean }
  | { type: 'assistant_delta'; id: string; text: string }
  | { type: 'assistant_stream_end'; id: string; interrupted: boolean }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'status'; running: boolean; phase?: 'running' | 'waiting' | 'idle'; step?: number; maxSteps?: number }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'history'; events: AgentEvent[]; conversationId: string; state: ConversationState }
  | { type: 'conversations'; activeId: string; items: ConversationSummary[] }
  | { type: 'conversation_search'; query: string; items: ConversationSummary[] }
  | { type: 'approval'; request: ApprovalRequest | null }
  | { type: 'target'; tabId: number; title: string; url: string; tabIds: number[]; mode: TaskMode; action?: string; temporary?: boolean; kept?: boolean };

export interface PageGuard {
  url: string;
  documentId: string;
  elementId?: number;
  elementFingerprint?: string;
}
export type ContentRequest = (
  | { action: 'ping' }
  | { action: 'cancel'; requestId: string }
  | { action: 'snapshot'; maxTextChars?: number; textOnly?: boolean; textOffset?: number }
  | { action: 'search_links' }
  | { action: 'research_status' }
  | { action: 'describe'; id?: number }
  | { action: 'click'; id: number }
  | { action: 'type'; id: number; text: string; clear?: boolean; submit?: boolean }
  | { action: 'select'; id: number; option: string }
  | { action: 'press_key'; key: string; id?: number }
  | { action: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; id?: number }
  | { action: 'extract'; selector: string; attribute?: string; limit?: number }
  | { action: 'hover'; id: number }
) & { guard?: PageGuard; requestId?: string; deadline?: number };

export type ContentResponse = { ok: true; result: unknown } | { ok: false; error: string };
export const CONTENT_MESSAGE_TAG = 'tabagent:content';
export const PANEL_PORT_NAME = 'tabagent:panel';
