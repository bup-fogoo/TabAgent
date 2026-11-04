import { browser } from 'wxt/browser';
import type { AgentEvent, ConversationState, ConversationSummary } from './protocol';
import { validReference } from './references';

export const LEGACY_CONVERSATIONS_KEY = 'tabagent:conversations:v1';
export const CONVERSATIONS_KEY = 'tabagent:conversations:v2';
export const CONVERSATION_PREFIX = 'tabagent:conversation:';
export type SavedEvent = Extract<AgentEvent, { type: 'user' | 'assistant' | 'tool' | 'tool_result' | 'error' | 'notice' | 'sources' }>;
export interface Conversation {
  id: string;
  title: string;
  titleEdited?: boolean;
  createdAt: number;
  updatedAt: number;
  state: ConversationState;
  events: SavedEvent[];
  pendingReply?: { id: string; text: string };
}
interface Archive { activeId: string; items: Conversation[] }
interface Index { version: 2; activeId: string; ids: string[] }
const states = new Set<ConversationState>(['idle', 'running', 'waiting', 'completed', 'stopped', 'interrupted', 'error']);

export function newConversation(): Conversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: '新对话', createdAt: now, updatedAt: now, state: 'idle', events: [] };
}

export function isSavedEvent(event: AgentEvent): event is SavedEvent {
  return ['user', 'assistant', 'tool', 'tool_result', 'error', 'notice', 'sources'].includes(event.type);
}

function validEvent(value: unknown): value is SavedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.type === 'sources') return typeof event.taskId === 'string' && event.taskId.length <= 100 &&
    Array.isArray(event.pages) && event.pages.length <= 100 && event.pages.every(validReference);
  if (event.type === 'user' || event.type === 'assistant') return typeof event.text === 'string';
  if (event.type === 'error' || event.type === 'notice') return typeof event.message === 'string';
  if (event.type === 'tool') return typeof event.id === 'string' && typeof event.name === 'string';
  if (event.type === 'tool_result') return typeof event.id === 'string' && typeof event.ok === 'boolean' && typeof event.summary === 'string';
  return false;
}

export async function loadConversations(): Promise<Archive> {
  const stored = await browser.storage.local.get([CONVERSATIONS_KEY, LEGACY_CONVERSATIONS_KEY]);
  const index = stored[CONVERSATIONS_KEY] as Index | undefined;
  let raw = stored[LEGACY_CONVERSATIONS_KEY] as Partial<Archive> | undefined;
  if (index !== undefined) {
    if (index.version !== 2 || !Array.isArray(index.ids) || index.ids.some((id) => typeof id !== 'string') || typeof index.activeId !== 'string') {
      throw new Error('历史索引无法读取');
    }
    const ids = [...new Set(index.ids)];
    const records = await browser.storage.local.get(ids.map((id) => CONVERSATION_PREFIX + id));
    const items = ids.map((id) => records[CONVERSATION_PREFIX + id] as Conversation | undefined);
    // A missing record must not turn a read problem into a destructive overwrite.
    if (items.some((item, i) => !item || item.id !== ids[i] || !Array.isArray(item.events) ||
      typeof item.title !== 'string' || !states.has(item.state) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt))) {
      throw new Error('历史会话无法读取');
    }
    raw = { activeId: index.activeId, items: items as Conversation[] };
  }
  const items = Array.isArray(raw?.items) ? raw.items.filter((item): item is Conversation =>
    Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' &&
      Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && states.has(item.state) && Array.isArray(item.events)),
  ) : [];
  const seen = new Set<string>();
  const clean = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    item.events = item.events.filter(validEvent);
    const partial = item.pendingReply;
    if (partial && typeof partial.id === 'string' && typeof partial.text === 'string' && partial.text.trim() &&
      !item.events.some((event) => event.type === 'assistant' && event.id === partial.id)) {
      item.events.push({ type: 'assistant', id: partial.id, text: partial.text, interrupted: true });
    }
    delete item.pendingReply;
    if (item.state === 'running' || item.state === 'waiting') {
      item.state = 'interrupted';
      item.events.push({ type: 'notice', message: '上次任务因后台关闭而中断。记录已恢复；请先确认网页现状，再发送“继续”或新的指令。尚未确认的操作不会自动执行。' });
    }
    return true;
  });
  if (!clean.length) clean.push(newConversation());
  return { activeId: clean.some((item) => item.id === raw?.activeId) ? raw!.activeId! : clean[0]!.id, items: clean };
}

export function conversationSummaries(items: Conversation[]): ConversationSummary[] {
  return items.map((item) => ({
    id: item.id, title: item.title, updatedAt: item.updatedAt, state: item.state,
    messageCount: item.events.filter((event) => event.type === 'user' || event.type === 'assistant').length,
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Coalesce bursts, clone only changed conversations, and serialize writes. The index
// and changed records are written together; deleted records are cleaned up afterwards.
export class ConversationStorage {
  private pending: { activeId: string; items: Conversation[]; waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> } | null = null;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private committed = new Map<string, string>();
  private committedIndex = '';
  private garbage = new Set<string>();
  private legacyRemoved = false;
  private flushWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  save(activeId: string, items: Conversation[]): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      const waiters = this.pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      this.pending = { activeId, items: [...items], waiters };
    });
    if (!this.writing && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 25);
    return promise;
  }

  private async drain() {
    if (this.writing || !this.pending) return;
    this.writing = true;
    let lastError: unknown;
    while (this.pending) {
      const batch = this.pending;
      this.pending = null;
      try {
        const index: Index = { version: 2, activeId: batch.activeId, ids: batch.items.map((item) => item.id) };
        const indexSignature = JSON.stringify(index);
        const signatures = new Map<string, string>();
        const updates: Record<string, unknown> = {};
        for (const item of batch.items) {
          // Ordinary events are append-only, but source lists are updated and
          // moved below the final reply. A millisecond timestamp is not a revision.
          const sources = item.events.flatMap((event, index) => event.type === 'sources' ? [[index, event]] : []);
          const signature = JSON.stringify([item.title, item.titleEdited, item.createdAt, item.updatedAt, item.state, item.events.length, item.pendingReply?.id, item.pendingReply?.text.length, sources]);
          signatures.set(item.id, signature);
          if (this.committed.get(item.id) !== signature) updates[CONVERSATION_PREFIX + item.id] = structuredClone(item);
        }
        if (indexSignature !== this.committedIndex) updates[CONVERSATIONS_KEY] = index;
        if (Object.keys(updates).length) await browser.storage.local.set(updates);
        for (const id of this.committed.keys()) if (!signatures.has(id)) this.garbage.add(CONVERSATION_PREFIX + id);
        this.committed = signatures;
        this.committedIndex = indexSignature;
        for (const id of signatures.keys()) this.garbage.delete(CONVERSATION_PREFIX + id);
        if (!this.legacyRemoved) this.garbage.add(LEGACY_CONVERSATIONS_KEY);
        // A cleanup failure leaves an unreachable backup, never rolls back a durable deletion.
        if (this.garbage.size) {
          const keys = [...this.garbage];
          try {
            await browser.storage.local.remove(keys);
            for (const key of keys) this.garbage.delete(key);
            this.legacyRemoved = true;
          } catch { /* Retry cleanup on the next save. */ }
        }
        lastError = undefined;
        for (const waiter of batch.waiters) waiter.resolve();
      } catch (error) {
        lastError = error;
        for (const waiter of batch.waiters) waiter.reject(error);
      }
    }
    this.writing = false;
    for (const waiter of this.flushWaiters.splice(0)) lastError ? waiter.reject(lastError) : waiter.resolve();
  }

  flush(): Promise<void> {
    if (!this.pending && !this.writing) return Promise.resolve();
    const done = new Promise<void>((resolve, reject) => this.flushWaiters.push({ resolve, reject }));
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    void this.drain();
    return done;
  }
}
