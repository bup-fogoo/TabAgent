import { browser } from 'wxt/browser';
import { PANEL_PORT_NAME, type AgentEvent, type PanelRequest, type TaskMode, type ConversationSummary, type ConversationState, type ApprovalRequest, type SourceReference } from '@/lib/protocol';
import { renderMarkdown } from '@/lib/markdown';
import { isConnectionConfigured, loadSettings, saveSettings, getConnectionTargets, getActiveConnectionTarget, activateConnection, type ConnectionTarget } from '@/lib/settings';
import { MODEL_LIBRARY_PREFIX, getModelScope, loadModelLibrary, setModelFavorite, recordRecentModel } from '@/lib/model-library';
import { FOLLOW_PAGES_KEY, loadFollowPages, saveFollowPages, AUTO_CLOSE_PAGES_KEY, loadAutoClosePages, saveAutoClosePages } from '@/lib/view-preferences';
import { DraftStore } from '@/lib/drafts';
import { isExportEvent, serializeConversation } from '@/lib/export';
import { createIcon, mountIcons, type IconName } from '@/lib/icons';

mountIcons();

const log = document.getElementById('log')!;
const empty = document.getElementById('empty')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;
const sendLabel = document.getElementById('send-label')!;
const sendIcon = document.getElementById('send-icon')!;
const newChat = document.getElementById('new-chat') as HTMLButtonElement;
const latest = document.getElementById('scroll-latest')!;
const status = document.getElementById('task-status')!;
const statusDot = document.getElementById('status-dot')!;
const elapsed = document.getElementById('elapsed')!;
const connectionBanner = document.getElementById('connection-banner')!;
const taskMode = document.getElementById('task-mode') as HTMLSelectElement;
const historyDialog = document.getElementById('history-dialog') as HTMLDialogElement;
const scopeDialog = document.getElementById('scope-options') as HTMLDialogElement;
const approvalCard = document.getElementById('approval-card')!;
const approveAction = document.getElementById('approve-action') as HTMLButtonElement;
const rejectAction = document.getElementById('reject-action') as HTMLButtonElement;
const DRAFT_KEY = 'tabagent:panel-draft';
const historySearch = document.getElementById('history-search') as HTMLInputElement;
const exportDialog = document.getElementById('export-dialog') as HTMLDialogElement;
const contextPicker = document.getElementById('context-picker') as HTMLButtonElement;
const followPagesButton = document.getElementById('follow-pages') as HTMLButtonElement;
const keepPageButton = document.getElementById('keep-page') as HTMLButtonElement;
const autoClosePagesInput = document.getElementById('auto-close-pages') as HTMLInputElement;
const scopeSearch = document.getElementById('scope-search') as HTMLInputElement;
const quickModelDialog = document.getElementById('quick-model-dialog') as HTMLDialogElement;
const quickModelConnection = document.getElementById('quick-model-connection') as HTMLSelectElement;
const quickModelSearch = document.getElementById('quick-model-search') as HTMLInputElement;
const quickModelList = document.getElementById('quick-model-list')!;
const quickModelStatus = document.getElementById('quick-model-status')!;
let quickModelTargets: ConnectionTarget[] = [];
let quickModelItems: Array<{ model: string; favorite: boolean; current: boolean; saved: boolean }> = [];
let quickModelVersion = 0;
let quickModelBusy = false;
let quickModelScope = '';
let quickModelActiveId = '';
let quickModelActiveModel = '';
let quickModelFocus: { id?: string; className?: string; model?: string } | undefined;

const TOOL_LABELS: Record<string, string> = {
  search_web: '搜索网页', open_search_result: '读取搜索结果',
  capture_page: '查看网页截图',
  list_tabs: '查看标签页', read_page: '读取页面', click: '点击元素', type_text: '填写内容',
  select_option: '选择选项', hover: '悬停', press_key: '按键', scroll: '滚动页面',
  extract: '提取数据', navigate: '打开网址', go_back: '后退', open_tab: '新建标签页',
  switch_tab: '切换标签页', close_tab: '关闭标签页', wait: '等待页面',
};

let running = false;
let pending = false;
let stopping = false;
let connected = false;
let configured = false;
let settingsLoaded = false;
let replaying = false;
let followLatest = true;
let followPages = true;
let followPagesLoaded = false;
let followPagesSaving = false;
let followPagesVersion = 0;
let autoClosePages = true;
let autoClosePagesLoaded = false;
let autoClosePagesSaving = false;
let autoClosePagesVersion = 0;
let keepPendingTabId: number | undefined;
let currentTaskId = '';
let legacyTaskNumber = 0;
const referenceCards = new Map<string, HTMLDetailsElement>();
const taskReplyAnchors = new Map<string, HTMLElement>();
let taskFailed = false;
let lastUserText = '';
let taskStarted = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 500;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let port: ReturnType<typeof browser.runtime.connect> | null = null;
let conversationId = '';
let conversationState: ConversationState = 'idle';
let conversations: ConversationSummary[] = [];
const deletedConversations = new Set<string>();
const requestedDeletions = new Set<string>();
let deletingId = '';
let renamingId = '';
let searchResults: ConversationSummary[] | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let displayedEvents: AgentEvent[] = [];
let draftConflict = false;
const streams = new Map<string, ReturnType<typeof createReply>>();
let selectedTabIds: number[] | undefined;
let approval: ApprovalRequest | null = null;
let approvalPending = false;
let currentStep = 0;
let taskTarget: Extract<AgentEvent, { type: 'target' }> | null = null;
let switchingConversation = false;
let newConversationRequested = false;
const toolRows = new Map<string, HTMLDetailsElement>();
interface ExecutionGroup {
  node: HTMLDetailsElement; items: HTMLDivElement; count: HTMLSpanElement; state: HTMLSpanElement;
  total: number; done: number; failed: number; touched: boolean;
}
let currentExecution: ExecutionGroup | null = null;
let taskGroups: ExecutionGroup[] = [];
const toolGroups = new Map<string, ExecutionGroup>();
const drafts = new DraftStore((text, conflict, remote) => {
  if (input.value !== text) input.value = text;
  draftConflict = conflict;
  document.getElementById('draft-conflict')!.hidden = !conflict;
  document.getElementById('draft-remote')!.textContent = remote || '（空草稿）';
  resizeInput();
  syncControls();
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconLabel(button: HTMLElement, name: IconName, label: string, iconOnly = false) {
  button.replaceChildren(createIcon(name, name === 'loader' ? 'is-spinning' : ''), el('span', iconOnly ? 'sr-only' : '', label));
}

function toast(message: string) {
  const node = document.getElementById('toast')!;
  clearTimeout(toastTimer);
  node.textContent = message;
  node.hidden = false;
  toastTimer = setTimeout(() => (node.hidden = true), 3000);
}

function renderFollowPages() {
  followPagesButton.disabled = !followPagesLoaded || followPagesSaving;
  followPagesButton.setAttribute('aria-pressed', String(followPages));
  followPagesButton.setAttribute('aria-busy', String(followPagesSaving));
  followPagesButton.title = followPages
    ? '正在跟随任务页面，点击切换为后台执行'
    : '当前在后台执行，点击跟随任务页面';
  iconLabel(followPagesButton, followPagesSaving ? 'loader' : followPages ? 'eye' : 'eye-off', followPages ? '跟随' : '后台');
}

async function refreshFollowPages() {
  const version = ++followPagesVersion;
  try {
    const enabled = await loadFollowPages();
    if (version !== followPagesVersion) return;
    followPages = enabled;
    followPagesLoaded = true;
    renderFollowPages();
  } catch {
    if (version !== followPagesVersion) return;
    toast('跟随设置读取失败，请重新打开侧栏。');
  }
}

followPagesButton.addEventListener('click', async () => {
  if (!followPagesLoaded || followPagesSaving) return;
  const enabled = !followPages;
  const version = followPagesVersion;
  followPagesSaving = true;
  renderFollowPages();
  try {
    await saveFollowPages(enabled);
    // Another panel may have updated the preference while this write finished.
    // A received storage event is newer evidence than the captured click state.
    if (version === followPagesVersion) followPages = enabled;
  } catch {
    toast('跟随设置未保存，请重试。');
  } finally {
    followPagesSaving = false;
    renderFollowPages();
  }
});

function renderAutoClosePages() {
  autoClosePagesInput.checked = autoClosePages;
  autoClosePagesInput.disabled = !autoClosePagesLoaded || autoClosePagesSaving;
}

async function refreshAutoClosePages() {
  const version = ++autoClosePagesVersion;
  try {
    const enabled = await loadAutoClosePages();
    if (version !== autoClosePagesVersion) return;
    autoClosePages = enabled;
    autoClosePagesLoaded = true;
    renderAutoClosePages();
  } catch {
    if (version === autoClosePagesVersion) toast('临时页面设置读取失败，请重新打开侧栏。');
  }
}

autoClosePagesInput.addEventListener('change', async () => {
  if (!autoClosePagesLoaded || autoClosePagesSaving) return;
  const enabled = autoClosePagesInput.checked;
  const version = autoClosePagesVersion;
  autoClosePagesSaving = true;
  renderAutoClosePages();
  try {
    await saveAutoClosePages(enabled);
    if (version === autoClosePagesVersion) autoClosePages = enabled;
  } catch { toast('临时页面设置未保存，请重试。'); }
  finally { autoClosePagesSaving = false; renderAutoClosePages(); }
});

function renderKeepPage() {
  const target = taskTarget;
  keepPageButton.hidden = !(running || pending) || !target?.temporary;
  keepPageButton.disabled = !connected || stopping || !!target?.kept || keepPendingTabId === target?.tabId;
  keepPageButton.title = target?.kept ? '此页面已保留，任务完成后不会自动关闭' : '保留此页面，任务完成后不自动关闭';
  iconLabel(keepPageButton, target?.kept ? 'check' : keepPendingTabId === target?.tabId ? 'loader' : 'bookmark', target?.kept ? '已保留' : '保留');
  keepPageButton.setAttribute('aria-label', keepPageButton.title);
}

keepPageButton.addEventListener('click', () => {
  if (!taskTarget?.temporary || taskTarget.kept || !running || keepPageButton.disabled) return;
  if (post({ type: 'keep_page', tabId: taskTarget.tabId })) {
    keepPendingTabId = taskTarget.tabId;
    renderKeepPage();
  }
});

function syncReferenceControls() {
  for (const card of referenceCards.values()) {
    for (const button of card.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = !connected || running || pending || switchingConversation;
    }
  }
}

function placeReferenceCard(taskId: string) {
  const card = referenceCards.get(taskId);
  if (!card) return;
  const anchor = taskReplyAnchors.get(taskId);
  if (anchor?.isConnected) {
    if (anchor.nextElementSibling !== card) anchor.after(card);
  } else if (!card.isConnected) append(card);
}

function safeReferences(pages: SourceReference[]): SourceReference[] {
  if (!Array.isArray(pages)) return [];
  const seen = new Set<string>();
  return pages.slice(0, 100).filter((page) => {
    if (!page || typeof page.id !== 'string' || !page.id || typeof page.url !== 'string' || typeof page.title !== 'string' || seen.has(page.id)) return false;
    try {
      const url = new URL(page.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    } catch { return false; }
    seen.add(page.id);
    return true;
  });
}

function renderReferences(event: Extract<AgentEvent, { type: 'sources' }>) {
  const pages = safeReferences(event.pages);
  let card = referenceCards.get(event.taskId);
  if (!pages.length) {
    card?.remove();
    referenceCards.delete(event.taskId);
    return;
  }
  if (!card) {
    card = el('details', 'reference-pages');
    card.dataset.taskId = event.taskId;
    referenceCards.set(event.taskId, card);
  }
  const focused = card.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusedSourceId = focused?.dataset.sourceId;
  const focusedSummary = focused?.matches('summary');
  const focusedOpenAll = focused?.classList.contains('reference-open-all');
  const summary = el('summary', 'reference-summary');
  summary.append(createIcon('page'), el('span', '', `参考页面 · ${pages.length}`), createIcon('chevron-down', 'disclosure-icon'));
  const list = el('ul', 'reference-list');
  for (const page of pages) {
    const item = el('li', 'reference-page');
    const button = el('button', 'reference-open');
    button.type = 'button';
    button.dataset.sourceId = page.id;
    button.title = page.url;
    button.setAttribute('aria-label', `重新打开：${page.title || new URL(page.url).hostname}`);
    const text = el('span', 'reference-text');
    text.append(el('span', 'reference-title', page.title || page.url), el('span', 'reference-site', `${new URL(page.url).hostname}${page.kind === 'search' ? ' · 搜索' : ''}`));
    button.append(text, createIcon('arrow-up-right'));
    button.addEventListener('click', () => {
      if (running || pending || switchingConversation) return;
      post({ type: 'sources_open', taskId: event.taskId, sourceIds: [page.id] });
    });
    item.append(button);
    list.append(item);
  }
  const openAll = el('button', 'reference-open-all', '全部打开');
  openAll.type = 'button';
  openAll.hidden = pages.length < 2;
  openAll.addEventListener('click', () => {
    if (running || pending || switchingConversation) return;
    post({ type: 'sources_open', taskId: event.taskId, sourceIds: pages.map((page) => page.id) });
  });
  card.replaceChildren(summary, list, openAll);
  placeReferenceCard(event.taskId);
  syncReferenceControls();
  if (focusedSummary) summary.focus({ preventScroll: true });
  else if (focusedOpenAll && !openAll.hidden && !openAll.disabled) openAll.focus({ preventScroll: true });
  else if (focusedSourceId) card.querySelector<HTMLButtonElement>(`[data-source-id="${CSS.escape(focusedSourceId)}"]:enabled`)?.focus({ preventScroll: true });
  scrollIfFollowing();
}

function syncControls() {
  send.disabled = !connected || stopping || pending || switchingConversation || (!running && !input.value.trim());
  send.classList.toggle('stop', running);
  sendLabel.textContent = stopping ? '停止中' : running ? '停止' : pending ? '发送中' : '发送';
  const sendAction = stopping ? '正在停止任务' : running ? '停止当前任务' : pending ? '正在发送指令' : '发送指令';
  send.setAttribute('aria-label', sendAction);
  send.title = sendAction;
  sendIcon.replaceChildren(...createIcon(stopping || pending ? 'loader' : running ? 'stop' : 'arrow-up').children);
  sendIcon.classList.toggle('is-spinning', stopping || pending);
  newChat.disabled = !connected || switchingConversation;
  input.readOnly = switchingConversation;
  taskMode.disabled = running || pending || switchingConversation;
  contextPicker.disabled = running || pending || switchingConversation;
  document.getElementById('history-running')!.hidden = !running;
  document.getElementById('quick-model-running')!.hidden = !(running || pending);
  (document.getElementById('history-new') as HTMLButtonElement).disabled = !connected || switchingConversation;
  historyDialog.querySelectorAll<HTMLButtonElement>('[data-conversation-action]').forEach((button) => { button.disabled = running || pending || switchingConversation || !connected; });
  approveAction.disabled = rejectAction.disabled = !approval || approvalPending || !connected || stopping;
  (document.getElementById('open-export') as HTMLButtonElement).disabled = !displayedEvents.some((event) => event.type === 'assistant' || event.type === 'user');
  input.placeholder = running ? '下一条任务…' : '输入任务或搜索内容…';
  status.parentElement!.hidden = !running && !empty.hidden;
  renderKeepPage();
  syncReferenceControls();
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function saveDraft() {
  if (!deletedConversations.has(conversationId)) drafts.edit(input.value);
  resizeInput();
  syncControls();
}

function switchDraft(id: string) {
  if (id === conversationId) return;
  const initial = !conversationId;
  conversationId = id;
  drafts.open(id, initial ? input.value : '');
  if (initial) {
    void drafts.flush().then(() => {
      if (drafts.hasSaved(id)) {
        try { localStorage.removeItem(`${DRAFT_KEY}:pending`); localStorage.removeItem(DRAFT_KEY); } catch { /* Optional migration. */ }
      }
    });
  }
}

const STATE_LABELS: Record<ConversationState, string> = {
  idle: '新会话', running: '执行中', waiting: '等待确认', completed: '已完成',
  stopped: '已停止', interrupted: '已中断', error: '遇到问题',
};

function renderConversations() {
  const list = document.getElementById('history-list')!;
  const editing = list.querySelector<HTMLInputElement>('.history-rename-form input');
  const editingName = editing?.closest<HTMLElement>('.history-item')?.dataset.conversationId === renamingId ? editing.value : undefined;
  const editingFocused = document.activeElement === editing;
  const selection = editing ? [editing.selectionStart, editing.selectionEnd] : [0, 0];
  list.replaceChildren();
  const query = historySearch.value.trim();
  const shown = query ? searchResults ?? [] : conversations;
  document.getElementById('history-empty')!.hidden = shown.length > 0;
  document.getElementById('history-empty')!.textContent = query ? searchResults === null ? '正在搜索…' : '没有找到匹配的会话。' : '还没有历史会话。';
  for (const item of shown) {
    let draft = item.id === conversationId ? input.value.trim() : '';
    if (item.id !== conversationId) {
      draft = drafts.preview(item.id).trim();
    }
    const title = item.messageCount === 0 && item.title === '新对话' ? draft ? draft.slice(0, 48) : '空白会话' : item.title || '新会话';
    const row = el('article', 'history-item');
    row.classList.toggle('active', item.id === conversationId);
    row.dataset.conversationId = item.id;
    const open = el('button', 'history-open');
    open.dataset.conversationAction = 'open';
    open.dataset.conversationId = item.id;
    open.setAttribute('aria-label', `打开会话：${title}`);
    if (item.id === conversationId) open.setAttribute('aria-current', 'true');
    open.append(el('strong', '', title));
    const when = new Date(item.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    open.append(el('span', 'history-meta', `${when} · ${draft ? '草稿 · ' : ''}${STATE_LABELS[item.state]} · ${item.messageCount} 条消息`));
    open.addEventListener('click', () => {
      if (running || pending) return;
      if (item.id === conversationId) { historyDialog.close(); return; }
      if (post({ type: 'conversation_open', id: item.id })) {
        switchingConversation = true;
        syncControls();
        historyDialog.close();
      }
    });
    const remove = el('button', 'history-delete');
    iconLabel(remove, 'trash', '删除', true);
    remove.title = '删除会话';
    remove.dataset.conversationAction = 'delete';
    remove.setAttribute('aria-label', `删除会话：${title}`);
    remove.addEventListener('click', () => { deletingId = deletingId === item.id ? '' : item.id; renderConversations(); });
    const rename = el('button', 'history-rename');
    iconLabel(rename, 'edit', '重命名', true);
    rename.title = '重命名会话';
    rename.dataset.conversationAction = 'rename';
    rename.setAttribute('aria-label', `重命名会话：${title}`);
    rename.addEventListener('click', () => { renamingId = item.id; deletingId = ''; renderConversations(); });
    const actions = el('div', 'history-actions');
    actions.append(rename, remove);
    row.append(open, actions);
    if (renamingId === item.id) {
      const form = el('form', 'history-rename-form');
      const field = el('input', '');
      field.value = editingName ?? item.title; field.maxLength = 80; field.required = true;
      field.setAttribute('aria-label', '会话名称');
      const save = el('button', 'text-button', '保存'); save.type = 'submit'; save.dataset.conversationAction = 'save-name';
      const cancel = el('button', 'text-button', '取消'); cancel.type = 'button';
      cancel.addEventListener('click', () => { renamingId = ''; renderConversations(); });
      form.append(field, save, cancel);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!field.value.trim()) { field.setCustomValidity('请输入会话名称'); field.reportValidity(); return; }
        if (post({ type: 'conversation_rename', id: item.id, title: field.value.trim() })) { renamingId = ''; renderConversations(); }
      });
      field.addEventListener('input', () => field.setCustomValidity(''));
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        renamingId = ''; renderConversations();
        list.querySelector<HTMLButtonElement>(`[data-conversation-id="${CSS.escape(item.id)}"] .history-rename`)?.focus();
      });
      row.append(form);
      requestAnimationFrame(() => {
        if (!field.isConnected || !historyDialog.open) return;
        if (editingName === undefined || editingFocused) {
          field.focus();
          if (editingName === undefined) field.select();
          else field.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
        }
      });
    }
    if (deletingId === item.id) {
      const confirmation = el('div', 'history-delete-confirm');
      confirmation.append(el('span', '', '删除后无法恢复此会话。'));
      const cancel = el('button', '', '保留');
      cancel.addEventListener('click', () => { deletingId = ''; renderConversations(); });
      const confirm = el('button', 'danger-text', '确认删除');
      confirm.dataset.conversationAction = 'confirm-delete';
      confirm.addEventListener('click', () => {
        if (running || pending) return;
        if (post({ type: 'conversation_delete', id: item.id })) {
          requestedDeletions.add(item.id);
          deletingId = '';
          // The record list from the background acknowledges deletion.
          confirmation.replaceChildren(el('span', '', '正在删除…'));
        }
      });
      confirmation.append(cancel, confirm);
      row.append(confirmation);
    }
    list.append(row);
  }
  syncControls();
}

function showApproval(request: ApprovalRequest | null) {
  approval = request;
  approvalPending = false;
  approvalCard.hidden = !request;
  if (request) {
    document.getElementById('approval-description')!.textContent = request.description;
    document.getElementById('approval-title')!.textContent = request.title || '目标页面';
    document.getElementById('approval-url')!.textContent = request.url;
    document.getElementById('approval-input')!.textContent = JSON.stringify(request.input, null, 2);
    approvalCard.querySelector('details')!.open = false;
    iconLabel(approveAction, 'check', '确认执行');
    iconLabel(rejectAction, 'close', '拒绝');
    document.getElementById('reply-announcement')!.textContent = `需要确认：${request.description}。目标页面：${request.title}`;
  }
  syncControls();
  // Showing the next confirmation can shrink the log before a queued scroll
  // event from the previous card is delivered. Anchor synchronously so that
  // layout changes are not mistaken for the reader scrolling away.
  scrollIfFollowing();
}

function progressText() { return currentStep ? ` · 第 ${currentStep} 步` : ''; }
function showTarget(target: Extract<AgentEvent, { type: 'target' }>) {
  const action = target.action && TOOL_LABELS[target.action];
  document.getElementById('context-label')!.textContent = action ? `正在${action}` : '正在处理';
  const title = document.getElementById('page-title')!;
  title.textContent = target.title || target.url;
  title.title = target.url;
  const badge = document.getElementById('page-state')!;
  badge.textContent = `${target.tabIds.length} 页`;
  badge.hidden = false;
  badge.classList.remove('restricted');
  badge.title = '本轮任务的范围已锁定，切换浏览器标签页不会改变目标';
}

let scopeLoadVersion = 0;
let scopeLoading = false;
function updateScopeList() {
  const selected = (document.getElementById('scope-selected') as HTMLInputElement).checked;
  const rows = [...scopeDialog.querySelectorAll<HTMLElement>('.scope-tab')];
  const query = scopeSearch.value.trim().toLocaleLowerCase();
  document.getElementById('scope-list')!.hidden = !selected;
  document.getElementById('scope-search-wrap')!.hidden = !selected;
  let visible = 0;
  for (const row of rows) {
    row.hidden = !row.dataset.search!.includes(query);
    if (!row.hidden) visible++;
  }
  const count = scopeDialog.querySelectorAll('#scope-list input:checked').length;
  const feedback = document.getElementById('scope-feedback')!;
  feedback.textContent = scopeLoading ? '加载中…'
    : !selected ? ''
    : !rows.length ? '请先打开一个普通网页，或选择当前页面直接搜索。'
    : count > 50 ? '最多选择 50 页。'
    : `已选 ${count} 页${query ? ` · 找到 ${visible} 页` : ''}${count === 0 ? '，请勾选页面。' : ''}`;
  feedback.hidden = !feedback.textContent;
  (document.getElementById('scope-apply') as HTMLButtonElement).disabled = running || pending || (selected && (scopeLoading || count === 0 || count > 50));
}

async function openScope(forceSelected = false) {
  if (running || pending) return;
  const version = ++scopeLoadVersion;
  const current = document.getElementById('scope-current') as HTMLInputElement;
  const selected = document.getElementById('scope-selected') as HTMLInputElement;
  current.checked = !selectedTabIds && !forceSelected;
  selected.checked = !current.checked;
  scopeSearch.value = '';
  const list = document.getElementById('scope-list')!;
  list.replaceChildren();
  const feedback = document.getElementById('scope-feedback')!;
  scopeLoading = true;
  updateScopeList();
  if (!scopeDialog.open) scopeDialog.showModal();
  if (selected.checked) scopeSearch.focus();
  try {
    const tabs = (await browser.tabs.query({ windowType: 'normal' })).filter((tab) => tab.id !== undefined && /^https?:\/\//i.test(tab.url ?? '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)(\/|$)/i.test(tab.url ?? ''));
    if (version !== scopeLoadVersion || !scopeDialog.open) return;
    for (const tab of tabs) {
      const label = el('label', 'scope-tab');
      label.dataset.search = `${tab.title ?? ''} ${tab.url}`.toLocaleLowerCase();
      const checkbox = el('input', '');
      checkbox.type = 'checkbox';
      checkbox.value = String(tab.id);
      checkbox.checked = selectedTabIds?.includes(tab.id!) ?? false;
      checkbox.addEventListener('change', updateScopeList);
      const text = el('span', 'scope-tab-text');
      text.append(el('strong', '', tab.title || '未命名页面'), el('small', '', new URL(tab.url!).hostname));
      label.append(checkbox, text);
      list.append(label);
    }
    scopeLoading = false;
    updateScopeList();
  } catch {
    if (version !== scopeLoadVersion) return;
    scopeLoading = false;
    updateScopeList();
    feedback.textContent = '加载失败，请重新打开。';
    feedback.hidden = false;
  }
}

function scrollToLatest() {
  followLatest = true;
  log.scrollTop = empty.hidden ? log.scrollHeight : 0;
  latest.hidden = true;
}

function scrollIfFollowing() {
  if (replaying) return;
  if (followLatest) scrollToLatest();
  else latest.hidden = false;
}

function append(node: HTMLElement) {
  if (!empty.hidden) {
    empty.hidden = true;
    window.scrollTo(0, 0);
  }
  log.append(node);
  scrollIfFollowing();
}

function updateExecution(group: ExecutionGroup, finished = false) {
  group.count.textContent = `${group.total} 步`;
  group.state.textContent = group.failed ? `${group.failed} 步未完成`
    : group.done < group.total ? finished ? '结果未确认' : '进行中' : '已完成';
  group.node.classList.toggle('has-errors', group.failed > 0 || (finished && group.done < group.total));
  group.node.classList.toggle('is-running', !finished && group.done < group.total);
  if (group.failed && !group.touched) group.node.open = true;
  else if (finished && group.done === group.total && !group.touched && (followLatest || replaying)) group.node.open = false;
}

function finishExecutions() {
  for (const group of taskGroups) {
    for (const row of group.items.querySelectorAll<HTMLDetailsElement>('.tool:not(.ok):not(.fail):not(.interrupted)')) {
      row.classList.add('interrupted');
      row.querySelector('.tool-indicator')!.replaceChildren(createIcon('pause'));
      row.querySelector('.tool-detail')!.append(el('span', 'result', '未收到此步骤的完整结果。继续前请先检查页面。'));
    }
    updateExecution(group, true);
  }
  currentExecution = null;
}

function executionGroup() {
  if (currentExecution) return currentExecution;
  const node = el('details', 'execution-group');
  node.open = !replaying;
  const summary = el('summary', 'execution-summary');
  const count = el('span', 'execution-count');
  const state = el('span', 'execution-state');
  summary.append(el('span', 'execution-label', '执行过程'), count, state, createIcon('chevron-down', 'disclosure-icon'));
  const items = el('div', 'execution-items');
  const group: ExecutionGroup = { node, items, count, state, total: 0, done: 0, failed: 0, touched: false };
  summary.addEventListener('click', () => { group.touched = true; });
  node.append(summary, items);
  taskGroups.push(group);
  currentExecution = group;
  append(node);
  return group;
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    const next = browser.runtime.connect({ name: PANEL_PORT_NAME });
    port = next;
    next.onMessage.addListener((event: unknown) => {
      if (port !== next) return;
      connected = true;
      connectionBanner.hidden = true;
      reconnectDelay = 500;
      handle(event as AgentEvent);
      syncControls();
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      disconnected();
    });
  } catch {
    port = null;
    disconnected();
  }
}

function disconnected() {
  connected = false;
  pending = false;
  stopping = false;
  switchingConversation = false;
  newConversationRequested = false;
  connectionBanner.hidden = false;
  status.textContent = '连接中…';
  syncControls();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function post(request: PanelRequest): boolean {
  if (!connected || !port) {
    toast('连接中，请稍后重试。');
    return false;
  }
  try {
    port.postMessage(request);
    return true;
  } catch {
    port = null;
    disconnected();
    toast('连接中断，草稿已保留。');
    return false;
  }
}

function describeInput(value: unknown, toolName?: string): string {
  if (!value || typeof value !== 'object') return '';
  const args = value as Record<string, unknown>;
  const parts: string[] = [];
  if (toolName === 'search_web') {
    const engine = typeof args.engine === 'string' ? args.engine : 'bing';
    parts.push(({ bing: 'Bing', google: 'Google', baidu: '百度' } as Record<string, string>)[engine] ?? engine);
  }
  if (args.element_id !== undefined) parts.push(`元素 ${args.element_id}`);
  if (args.text !== undefined) parts.push(`“${String(args.text).slice(0, 45)}”`);
  for (const key of ['query', 'url', 'selector', 'option', 'key', 'direction']) if (args[key]) parts.push(String(args[key]));
  if (args.tab_id !== undefined) parts.push(`标签页 ${args.tab_id}`);
  if (args.seconds !== undefined) parts.push(`${args.seconds} 秒`);
  return parts.join(' · ');
}

function setRunning(value: boolean, phase: 'running' | 'waiting' | 'idle' = value ? 'running' : 'idle', step?: number) {
  const wasRunning = running;
  running = value;
  if (step !== undefined) currentStep = step;
  pending = false;
  stopping = false;
  clearInterval(clockTimer);
  const hasFailedSteps = taskGroups.some((group) => group.failed > 0);
  statusDot.classList.toggle('running', value);
  statusDot.classList.toggle('error', !value && (taskFailed || hasFailedSteps));
  if (value) {
    if (!wasRunning) taskStarted = Date.now();
    status.textContent = (phase === 'waiting' ? '等待确认' : '处理中') + progressText();
    const tick = () => { elapsed.textContent = `${Math.floor((Date.now() - taskStarted) / 1000)} 秒`; };
    tick();
    clockTimer = setInterval(tick, 1000);
    scrollIfFollowing();
  } else {
    finishExecutions();
    status.textContent = conversationState === 'interrupted' ? '已中断'
      : taskFailed ? '任务失败'
      : conversationState === 'stopped' ? '已停止'
      : hasFailedSteps ? '部分步骤未完成'
      : empty.hidden ? '已完成' : '';
    if (!wasRunning || !empty.hidden) elapsed.textContent = '';
    showApproval(null);
    taskTarget = null;
    currentStep = 0;
    void refreshPage();
  }
  syncControls();
}

function createReply(text: string, streaming = false) {
  const node = el('article', 'msg assistant');
  const content = el('div', 'message-content');
  const copy = el('button', 'copy-button');
  iconLabel(copy, 'copy', '复制内容');
  const reply = { node, content, copy, text, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  renderReplyContent(reply, !streaming);
  copy.hidden = streaming;
  copy.setAttribute('aria-label', '复制这条回复');
  copy.addEventListener('click', () => void copyText(reply.text, copy, '复制内容'));
  node.classList.toggle('streaming', streaming);
  node.setAttribute('aria-busy', String(streaming));
  const heading = el('div', 'assistant-heading');
  heading.append(createIcon('sparkles', 'assistant-icon'), el('span', '', 'TabAgent'));
  node.append(heading, content, copy);
  append(node);
  if (currentTaskId) {
    taskReplyAnchors.set(currentTaskId, node);
    placeReferenceCard(currentTaskId);
  }
  return reply;
}

async function copyText(text: string, button: HTMLButtonElement, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    iconLabel(button, 'check', '已复制');
    setTimeout(() => { if (button.isConnected) iconLabel(button, 'copy', label); }, 2000);
  } catch { toast('复制失败，请选中文字后手动复制。'); }
}

function renderReplyContent(reply: { content: HTMLElement; text: string }, interactive: boolean) {
  const scrollPositions = [...reply.content.querySelectorAll('.table-scroll')].map((node) => node.scrollLeft);
  reply.content.innerHTML = renderMarkdown(reply.text);
  reply.content.querySelectorAll('pre').forEach((pre) => {
    const block = el('div', 'code-block');
    const header = el('div', 'code-heading');
    header.append(el('span', '', '代码'));
    if (interactive) {
      const copy = el('button', 'copy-code');
      iconLabel(copy, 'copy', '复制代码');
      copy.setAttribute('aria-label', '复制此代码块');
      copy.addEventListener('click', () => void copyText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '', copy, '复制代码'));
      header.append(copy);
    }
    pre.replaceWith(block);
    block.append(header, pre);
  });
  reply.content.querySelectorAll('table').forEach((table, index) => {
    const region = el('div', 'table-scroll');
    region.tabIndex = 0;
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', '结果表格，可左右滚动查看更多列');
    table.replaceWith(region);
    region.append(table);
    region.scrollLeft = scrollPositions[index] ?? 0;
  });
}

function finishReply(reply: ReturnType<typeof createReply>, interrupted = false) {
  clearTimeout(reply.timer);
  reply.timer = undefined;
  renderReplyContent(reply, true);
  reply.node.classList.remove('streaming');
  reply.node.setAttribute('aria-busy', 'false');
  reply.copy.hidden = !reply.text;
  if (interrupted && !reply.node.querySelector('.stream-interrupted')) {
    reply.node.querySelector('.assistant-heading')!.append(el('span', 'stream-interrupted', '回复未完成'));
    reply.copy.setAttribute('aria-label', '复制已收到的部分回复');
  }
  scrollIfFollowing();
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  const query = historySearch.value.trim();
  if (!query) { searchResults = null; renderConversations(); return; }
  searchTimer = setTimeout(() => { if (connected) post({ type: 'conversation_search', query }); }, 150);
}

function handle(event: AgentEvent) {
  if (!replaying && isExportEvent(event)) {
    const previous = event.type === 'assistant' && event.id
      ? displayedEvents.findIndex((item) => item.type === 'assistant' && item.id === event.id)
      : event.type === 'sources' ? displayedEvents.findIndex((item) => item.type === 'sources' && item.taskId === event.taskId) : -1;
    if (previous >= 0) displayedEvents[previous] = event;
    else displayedEvents.push(event);
  }
  switch (event.type) {
    case 'history': {
      const changed = conversationId !== event.conversationId;
      switchDraft(event.conversationId);
      switchingConversation = false;
      conversationState = event.state;
      if (changed) { followLatest = true; currentStep = 0; taskTarget = null; }
      showApproval(null);
      replaying = true;
      displayedEvents = event.events.filter(isExportEvent);
      for (const stream of streams.values()) clearTimeout(stream.timer);
      streams.clear();
      const previousScroll = log.scrollTop;
      for (const node of [...log.children]) if (node !== empty) node.remove();
      toolRows.clear();
      toolGroups.clear();
      referenceCards.clear();
      taskReplyAnchors.clear();
      currentTaskId = '';
      legacyTaskNumber = 0;
      keepPendingTabId = undefined;
      currentExecution = null;
      taskGroups = [];
      document.getElementById('reply-announcement')!.textContent = '';
      taskFailed = false;
      lastUserText = '';
      const wasEmpty = !empty.hidden;
      empty.hidden = event.events.length > 0;
      if (wasEmpty && empty.hidden) window.scrollTo(0, 0);
      for (const item of event.events) handle(item);
      conversationState = event.state;
      replaying = false;
      if (followLatest) scrollToLatest();
      else log.scrollTop = previousScroll;
      setRunning(event.state === 'running' || event.state === 'waiting', event.state === 'waiting' ? 'waiting' : event.state === 'running' ? 'running' : 'idle');
      renderConversations();
      if (newConversationRequested) {
        newConversationRequested = false;
        input.focus();
      }
      break;
    }
    case 'user': {
      finishExecutions();
      taskGroups = [];
      currentTaskId = event.taskId || `legacy-${++legacyTaskNumber}`;
      keepPendingTabId = undefined;
      lastUserText = event.text;
      taskFailed = false;
      conversationState = 'running';
      statusDot.classList.remove('error');
      if (!replaying) {
        followLatest = true;
        // Clear only the acknowledged instruction; never discard a newer draft.
        if (input.value.trim() === event.text) { input.value = ''; saveDraft(); }
      }
      const user = el('div', 'msg user', event.text);
      append(user);
      taskReplyAnchors.set(currentTaskId, user);
      break;
    }
    case 'assistant_delta': {
      let reply = streams.get(event.id);
      if (!reply) { currentExecution = null; reply = createReply('', true); streams.set(event.id, reply); }
      reply.text += event.text;
      if (!reply.timer) {
        const current = reply;
        current.timer = setTimeout(() => {
          current.timer = undefined;
          renderReplyContent(current, false);
          scrollIfFollowing();
        }, 80);
      }
      if (!stopping) status.textContent = `生成中${progressText()}`;
      break;
    }
    case 'assistant': {
      currentExecution = null;
      const reply = (event.id && streams.get(event.id)) || createReply(event.text);
      reply.text = event.text;
      finishReply(reply, event.interrupted);
      if (currentTaskId) {
        taskReplyAnchors.set(currentTaskId, reply.node);
        placeReferenceCard(currentTaskId);
        if (!replaying) {
          const referenceIndex = displayedEvents.findIndex((item) => item.type === 'sources' && item.taskId === currentTaskId);
          if (referenceIndex >= 0) displayedEvents.push(...displayedEvents.splice(referenceIndex, 1));
        }
      }
      if (event.id) streams.set(event.id, reply);
      if (!replaying) document.getElementById('reply-announcement')!.textContent = `TabAgent：${event.text}`;
      break;
    }
    case 'assistant_stream_end': {
      const reply = streams.get(event.id);
      if (reply) finishReply(reply, event.interrupted);
      break;
    }
    case 'sources':
      renderReferences(event);
      break;
    case 'tool': {
      const row = el('details', 'tool');
      const summary = el('summary', '');
      const label = TOOL_LABELS[event.name] ?? event.name;
      const indicator = el('span', 'tool-indicator');
      indicator.append(createIcon('loader', 'is-spinning'));
      summary.append(indicator, el('span', 'name', label), el('span', 'tool-preview', describeInput(event.input, event.name)), createIcon('chevron-down', 'disclosure-icon'));
      const detail = el('div', 'tool-detail');
      detail.append(el('pre', 'tool-arguments', JSON.stringify(event.input, null, 2)));
      row.append(summary, detail);
      toolRows.set(event.id, row);
      const group = executionGroup();
      group.total++;
      group.items.append(row);
      toolGroups.set(event.id, group);
      updateExecution(group);
      scrollIfFollowing();
      if (!replaying) {
        status.textContent = `${label}${progressText()}`;
      }
      break;
    }
    case 'tool_result': {
      const row = toolRows.get(event.id);
      if (!row) break;
      row.classList.add(event.ok ? 'ok' : 'fail');
      row.querySelector('.tool-indicator')!.replaceChildren(createIcon(event.ok ? 'check' : 'alert-circle'));
      row.querySelector('.tool-detail')!.append(el('span', 'result', event.summary));
      if (!event.ok) row.open = true;
      const group = toolGroups.get(event.id);
      if (group) {
        group.done++;
        if (!event.ok) group.failed++;
        updateExecution(group);
      }
      if (!replaying && !stopping) status.textContent = `处理中${progressText()}`;
      scrollIfFollowing();
      break;
    }
    case 'error': {
      taskFailed = true;
      switchingConversation = false;
      const node = el('div', 'msg error');
      node.setAttribute('role', 'alert');
      node.append(el('strong', '', '这一步没有完成'), el('div', '', event.message));
      const actions = el('div', 'error-actions');
      // Restore for editing, rather than replaying potentially completed actions automatically.
      const retryText = lastUserText;
      const retry = el('button', '', '编辑指令');
      retry.addEventListener('click', () => {
        if (input.value.trim()) { toast('当前草稿已保留，请先发送或清空。'); return; }
        input.value = retryText;
        saveDraft();
        input.focus();
      });
      const settings = el('button', '', '检查设置');
      settings.addEventListener('click', openOptions);
      actions.append(retry, settings);
      node.append(actions);
      append(node);
      break;
    }
    case 'status':
      setRunning(event.running, event.phase ?? (event.running ? 'running' : 'idle'), event.step);
      break;
    case 'notice':
      switchingConversation = false;
      keepPendingTabId = undefined;
      renderKeepPage();
      append(el('div', 'msg notice-message', event.message));
      break;
    case 'conversations':
      for (const item of conversations) {
        if (requestedDeletions.has(item.id) && !event.items.some((current) => current.id === item.id)) {
          requestedDeletions.delete(item.id);
          deletedConversations.add(item.id);
          void drafts.remove(item.id);
        }
      }
      conversations = event.items;
      if (event.activeId === conversationId) conversationState = event.items.find((item) => item.id === conversationId)?.state ?? conversationState;
      renderConversations();
      if (historySearch.value.trim()) scheduleSearch();
      break;
    case 'conversation_search':
      if (event.query !== historySearch.value.trim()) break;
      searchResults = event.items;
      renderConversations();
      break;
    case 'approval':
      showApproval(event.request);
      if (event.request) {
        status.textContent = `等待确认${progressText()}`;
      }
      break;
    case 'target':
      taskTarget = event;
      if (event.kept || keepPendingTabId !== event.tabId) keepPendingTabId = undefined;
      taskMode.value = event.mode;
      if (running || pending) showTarget(event);
      renderKeepPage();
      break;
  }
}

function submit() {
  if (running || pending || stopping || switchingConversation) return;
  const text = input.value.trim();
  if (!text) return;
  if (draftConflict) { toast('请先选择草稿版本。'); return; }
  if (!settingsLoaded) { toast('设置加载中…'); return; }
  if (!configured) { openOptions(); return; }
  if (selectedTabIds && !selectedTabIds.length) { toast('请先选择至少一个标签页。'); void openScope(); return; }
  if (post({ type: 'run', text, mode: taskMode.value as TaskMode, ...(selectedTabIds ? { tabIds: [...selectedTabIds] } : {}) })) {
    pending = true;
    followLatest = true;
    syncControls();
  }
}

function openOptions() {
  void browser.runtime.openOptionsPage().catch(() => toast('无法打开设置，请从扩展管理页面进入。'));
}

function targetScope(target: ConnectionTarget) {
  return getModelScope(target.provider, target.service, target.profile.baseUrl, target.customId);
}

function renderQuickModels() {
  const focused = document.activeElement as HTMLElement | null;
  if (focused === quickModelSearch || focused === quickModelConnection) quickModelFocus = { id: focused.id };
  else if (focused?.classList.contains('quick-model-use') || focused?.classList.contains('quick-model-favorite')) {
    quickModelFocus = { className: focused.classList.contains('quick-model-favorite') ? 'quick-model-favorite' : 'quick-model-use', model: focused.dataset.model };
  }
  quickModelList.replaceChildren();
  const targetId = quickModelConnection.value;
  const scope = quickModelScope;
  quickModelConnection.disabled = quickModelBusy || !quickModelTargets.length;
  quickModelSearch.disabled = quickModelBusy;
  document.getElementById('quick-model-running')!.hidden = !(running || pending);
  const query = quickModelSearch.value.trim().toLocaleLowerCase();
  const items = quickModelItems.filter((item) => item.model.toLocaleLowerCase().includes(query));
  if (!items.length && !quickModelBusy) quickModelList.append(el('p', 'dialog-hint', quickModelTargets.length ? '没有匹配的模型，可在设置中添加或收藏。' : '先在设置中添加模型连接。'));
  for (const item of items) {
    const row = el('div', `quick-model-row${item.current ? ' active' : ''}`);
    const button = el('button', 'quick-model-use');
    button.type = 'button';
    button.dataset.model = item.model;
    button.disabled = quickModelBusy;
    if (item.current) button.setAttribute('aria-current', 'true');
    button.append(el('strong', '', item.model), el('small', '', item.current ? '当前模型' : item.favorite ? '收藏' : item.saved ? '此连接模型' : '最近使用'));
    button.addEventListener('click', () => void chooseQuickModel(targetId, item.model, scope));
    const favorite = el('button', 'icon-button quick-model-favorite');
    favorite.type = 'button';
    favorite.disabled = quickModelBusy;
    favorite.dataset.model = item.model;
    favorite.setAttribute('aria-pressed', String(item.favorite));
    favorite.setAttribute('aria-label', item.favorite ? `取消收藏 ${item.model}` : `收藏 ${item.model}`);
    favorite.title = item.favorite ? '取消收藏' : '收藏模型';
    favorite.append(createIcon('star'));
    favorite.addEventListener('click', () => void toggleQuickFavorite(item.model, !item.favorite, scope));
    row.append(button, favorite);
    quickModelList.append(row);
  }
  if (!quickModelBusy && quickModelFocus) {
    // Replacing the list or disabling a busy control must not strand keyboard
    // focus on the document. Respect a move to another control while loading.
    if (document.activeElement === document.body || document.activeElement === quickModelDialog) {
      const remembered = quickModelFocus;
      const target = remembered.id ? document.getElementById(remembered.id)
        : [...quickModelList.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.classList.contains(remembered.className!) && button.dataset.model === remembered.model);
      (target ?? quickModelSearch).focus();
    }
    quickModelFocus = undefined;
  }
}

async function loadQuickModels() {
  const target = quickModelTargets.find((item) => item.id === quickModelConnection.value);
  const version = ++quickModelVersion;
  quickModelItems = [];
  quickModelScope = target ? targetScope(target) : '';
  quickModelBusy = true;
  quickModelStatus.textContent = target ? '读取模型…' : '';
  renderQuickModels();
  try {
    if (!target) return;
    const library = await loadModelLibrary(quickModelScope);
    if (version !== quickModelVersion || !quickModelDialog.open) return;
    const models = [...new Set([target.profile.model, ...library.favorites, ...library.recent])].filter(Boolean);
    quickModelItems = models.map((model) => ({ model, favorite: library.favorites.includes(model),
      current: target.id === quickModelActiveId && model === quickModelActiveModel, saved: model === target.profile.model }));
    quickModelStatus.textContent = '';
  } catch {
    if (version === quickModelVersion) {
      quickModelStatus.textContent = '收藏与最近记录读取失败，可使用已保存的模型。';
      if (target?.profile.model) quickModelItems = [{ model: target.profile.model, favorite: false, current: target.id === quickModelActiveId && target.profile.model === quickModelActiveModel, saved: true }];
    }
  } finally {
    if (version === quickModelVersion) { quickModelBusy = false; renderQuickModels(); }
  }
}

async function refreshQuickConnections(preferredId = quickModelConnection.value) {
  const version = ++quickModelVersion;
  quickModelBusy = true;
  quickModelStatus.textContent = '读取连接…';
  renderQuickModels();
  try {
    const settings = await loadSettings();
    if (version !== quickModelVersion || !quickModelDialog.open) return;
    const active = getActiveConnectionTarget(settings);
    quickModelActiveId = active.id;
    quickModelActiveModel = active.profile.model;
    quickModelTargets = getConnectionTargets(settings).filter((target) => isConnectionConfigured(activateConnection(settings, target.id)));
    quickModelConnection.replaceChildren(...quickModelTargets.map((target) => new Option(target.name, target.id)));
    const selected = quickModelTargets.find((target) => target.id === preferredId) ?? quickModelTargets.find((target) => target.id === active.id) ?? quickModelTargets[0];
    quickModelConnection.value = selected?.id ?? '';
    await loadQuickModels();
  } catch {
    if (version === quickModelVersion) {
      quickModelBusy = false;
      quickModelTargets = []; quickModelItems = [];
      quickModelStatus.textContent = '连接读取失败，请关闭后重试。';
      renderQuickModels();
    }
  }
}

async function chooseQuickModel(targetId: string, model: string, expectedScope: string) {
  if (quickModelBusy) return;
  const version = ++quickModelVersion;
  quickModelBusy = true;
  renderQuickModels();
  let saved = false;
  try {
    // Reload at the click boundary: a settings page may have edited a different
    // connection since this dialog opened. Never save our old settings snapshot.
    const latest = await loadSettings();
    if (version !== quickModelVersion || !quickModelDialog.open) return;
    const target = getConnectionTargets(latest).find((item) => item.id === targetId);
    if (!target || targetScope(target) !== expectedScope) throw new Error('连接已更改，请重新选择。');
    const next = activateConnection(latest, targetId, model);
    if (!isConnectionConfigured(next)) throw new Error('这个连接尚未配置完整，请先打开设置。');
    await saveSettings(next);
    saved = true;
    if (version === quickModelVersion) quickModelDialog.close();
    await refreshSettings();
    try { await recordRecentModel(expectedScope, model); }
    catch { toast('模型已切换，但最近记录未保存。'); return; }
    toast(running || pending ? '已设置，下次任务使用所选模型。' : '模型已切换');
  } catch (error) {
    toast(saved ? '模型已切换，请刷新侧栏查看。' : error instanceof Error ? error.message : '切换失败，请重试。');
    if (version === quickModelVersion && quickModelDialog.open) await refreshQuickConnections(targetId);
  } finally { if (version === quickModelVersion) { quickModelBusy = false; if (quickModelDialog.open) renderQuickModels(); } }
}

async function toggleQuickFavorite(model: string, favorite: boolean, scope: string) {
  if (quickModelBusy) return;
  const version = ++quickModelVersion;
  quickModelBusy = true;
  renderQuickModels();
  try {
    await setModelFavorite(scope, model, favorite);
    if (version === quickModelVersion) quickModelItems = quickModelItems.map((item) => item.model === model ? { ...item, favorite } : item);
  } catch { toast('收藏未保存，请重试。'); }
  finally { if (version === quickModelVersion) { quickModelBusy = false; if (quickModelDialog.open) await refreshQuickConnections(); } }
}

document.getElementById('model-settings')!.addEventListener('click', () => {
  if (!quickModelDialog.open) quickModelDialog.showModal();
  quickModelSearch.value = '';
  quickModelSearch.focus();
  void refreshQuickConnections('');
});
document.getElementById('quick-model-close')!.addEventListener('click', () => quickModelDialog.close());
document.getElementById('quick-model-manage')!.addEventListener('click', () => { quickModelDialog.close(); openOptions(); });
quickModelDialog.addEventListener('close', () => { if (!quickModelDialog.open) { quickModelVersion++; quickModelTargets = []; quickModelItems = []; quickModelBusy = false; quickModelFocus = undefined; } });
quickModelConnection.addEventListener('change', () => { quickModelSearch.value = ''; void loadQuickModels(); });
quickModelSearch.addEventListener('input', renderQuickModels);

async function refreshSettings() {
  try {
    const settings = await loadSettings();
    settingsLoaded = true;
    configured = isConnectionConfigured(settings);
    const model = settings.provider === 'anthropic' ? settings.anthropicModel : settings.openaiModel;
    document.getElementById('model-name')!.textContent = configured ? model : '连接模型';
    document.getElementById('model-settings')!.title = configured ? `${running || pending ? '下次任务模型' : '当前模型'}：${model}，点击切换` : '选择已保存连接或打开设置';
    document.getElementById('setup-banner')!.hidden = configured;
  } catch {
    settingsLoaded = false;
    toast('模型设置读取失败，请重新打开侧边栏。');
  }
}

let pageRefreshId = 0;
async function refreshPage() {
  if ((running || pending) && taskTarget) { showTarget(taskTarget); return; }
  const requestId = ++pageRefreshId;
  const scopeIds = selectedTabIds ? [...selectedTabIds] : undefined;
  try {
    let tabs = await browser.tabs.query(scopeIds ? { windowType: 'normal' } : { active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (!tabs.length && !scopeIds) tabs = await browser.tabs.query({ active: true, windowType: 'normal' });
    if (requestId !== pageRefreshId) return;
    if ((running || pending) && taskTarget) { showTarget(taskTarget); return; }
    const tab = tabs[0];
    const pageTitle = document.getElementById('page-title')!;
    const pageState = document.getElementById('page-state')!;
    if (scopeIds) {
      const chosen = tabs.filter((item) => item.id !== undefined && scopeIds.includes(item.id));
      document.getElementById('context-label')!.textContent = '本轮任务范围';
      pageTitle.textContent = chosen.map((item) => item.title || '未命名页面').join('、') || '所选页面已关闭，请重新选择';
      pageTitle.title = chosen.map((item) => item.url).join('\n');
      pageState.textContent = chosen.length === scopeIds.length ? `${chosen.length} 页` : '需调整';
      pageState.hidden = false;
      pageState.classList.toggle('restricted', chosen.length !== scopeIds.length);
      pageState.title = chosen.length === scopeIds.length ? '点击查看或调整本轮可访问的页面' : '部分所选页面已关闭，点击重新选择';
      return;
    }
    const restricted = !tab?.url || !/^https?:\/\//i.test(tab.url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)(\/|$)/i.test(tab.url);
    document.getElementById('context-label')!.textContent = '当前页面';
    pageTitle.textContent = tab?.title || '可直接搜索新网页';
    pageTitle.title = tab?.url ?? '';
    pageState.textContent = restricted ? '可搜索' : '';
    pageState.hidden = !restricted;
    pageState.classList.toggle('restricted', restricted);
    pageState.title = restricted ? '此页面无法直接读取，可输入关键词搜索新网页。' : '可处理当前页面，也可搜索新网页';
  } catch {
    document.getElementById('page-title')!.textContent = '暂时无法读取当前页面';
  }
}

send.addEventListener('click', () => {
  if (running) {
    if (post({ type: 'stop' })) {
      stopping = true;
      status.textContent = '停止中…';
      syncControls();
    }
  } else submit();
});
input.addEventListener('input', saveDraft);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (running || pending) toast('任务进行中，草稿已保留。');
    else submit();
  }
});
function startNewConversation() {
  saveDraft();
  if (post({ type: 'reset' })) {
    newConversationRequested = true;
    switchingConversation = true;
    followLatest = true;
    historyDialog.close();
    scopeDialog.close();
    syncControls();
    if (running) status.textContent = '正在结束当前任务…';
  }
}
newChat.addEventListener('click', startNewConversation);
document.getElementById('history-new')!.addEventListener('click', startNewConversation);
document.getElementById('open-history')!.addEventListener('click', () => {
  deletingId = '';
  renderConversations();
  historyDialog.showModal();
  historySearch.focus();
  if (connected) post({ type: 'conversation_list' });
  if (historySearch.value.trim()) scheduleSearch();
});
historySearch.addEventListener('input', () => { searchResults = null; deletingId = renamingId = ''; renderConversations(); scheduleSearch(); });
document.getElementById('draft-keep-local')!.addEventListener('click', () => drafts.resolve(true));
document.getElementById('draft-use-remote')!.addEventListener('click', () => drafts.resolve(false));
document.getElementById('open-export')!.addEventListener('click', () => {
  const count = displayedEvents.filter((event) => event.type === 'user' || event.type === 'assistant').length;
  document.getElementById('export-description')!.textContent = `${count} 条消息${running ? ' · 仅导出已收到的内容' : ''}`;
  exportDialog.showModal();
});
document.getElementById('close-export')!.addEventListener('click', () => exportDialog.close());
function exportConversation(format: 'markdown' | 'json') {
  const title = conversations.find((item) => item.id === conversationId)?.title || 'TabAgent 会话';
  const events = [...displayedEvents];
  for (const [id, stream] of streams) {
    if (stream.node.classList.contains('streaming') && stream.text) events.push({ type: 'assistant', id, text: stream.text, interrupted: true });
  }
  const content = serializeConversation(conversationId, title, conversationState, events, format);
  const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 70) || 'TabAgent'}-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  exportDialog.close();
}
document.getElementById('export-markdown')!.addEventListener('click', () => exportConversation('markdown'));
document.getElementById('export-json')!.addEventListener('click', () => exportConversation('json'));
document.getElementById('close-history')!.addEventListener('click', () => historyDialog.close());
contextPicker.addEventListener('click', () => void openScope());
scopeSearch.addEventListener('input', updateScopeList);
scopeDialog.addEventListener('close', () => { scopeLoadVersion++; });
document.getElementById('close-scope')!.addEventListener('click', () => scopeDialog.close());
scopeDialog.querySelectorAll<HTMLInputElement>('input[name="scope"]').forEach((radio) => {
  radio.addEventListener('change', updateScopeList);
});
document.getElementById('scope-apply')!.addEventListener('click', () => {
  if (running || pending) { scopeDialog.close(); return; }
  const selected = (document.getElementById('scope-selected') as HTMLInputElement).checked;
  const ids = [...scopeDialog.querySelectorAll<HTMLInputElement>('#scope-list input:checked')].map((checkbox) => Number(checkbox.value));
  if (selected && !ids.length) {
    document.getElementById('scope-feedback')!.textContent = '请至少选择一页。';
    return;
  }
  selectedTabIds = selected ? ids : undefined;
  scopeDialog.close();
  input.focus();
  void refreshPage();
});
function decideApproval(approved: boolean) {
  if (!approval || approvalPending) return;
  if (post({ type: 'approve', id: approval.id, approved })) {
    approvalPending = true;
    if (approved) iconLabel(approveAction, 'loader', '正在执行…');
    else iconLabel(rejectAction, 'loader', '正在拒绝…');
    status.textContent = approved ? '执行中…' : '正在拒绝…';
    syncControls();
  }
}
approveAction.addEventListener('click', () => decideApproval(true));
rejectAction.addEventListener('click', () => decideApproval(false));
for (const id of ['open-options', 'setup-options']) document.getElementById(id)!.addEventListener('click', openOptions);
document.querySelectorAll<HTMLButtonElement>('#examples button').forEach((button) => {
  button.addEventListener('click', () => {
    if (running || pending || switchingConversation) return;
    if (input.value.trim()) { toast('当前草稿已保留，请先发送或清空。'); input.focus(); return; }
    input.value = button.dataset.prompt ?? '';
    const mode = button.dataset.mode;
    if (mode === 'read-only' || mode === 'confirm') taskMode.value = mode;
    saveDraft();
    input.focus();
    if (button.dataset.scope === 'selected') void openScope(true);
  });
});

// A deliberate backdrop click dismisses a dialog; selecting text or dragging
// inside it does not. Native Escape also restores focus to the opening control.
for (const dialog of [historyDialog, scopeDialog, exportDialog, quickModelDialog]) {
  let backdropPress = false;
  const outside = (event: MouseEvent) => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener('pointerdown', (event) => { backdropPress = outside(event); });
  dialog.addEventListener('click', (event) => { if (backdropPress && outside(event)) dialog.close(); backdropPress = false; });
}
log.addEventListener('scroll', () => {
  if (!empty.hidden) { latest.hidden = true; return; }
  followLatest = log.scrollHeight - log.scrollTop - log.clientHeight < 56;
  latest.hidden = followLatest;
}, { passive: true });
latest.addEventListener('click', scrollToLatest);
// Keep the latest reply in view when the sidebar or multiline composer changes size.
new ResizeObserver(() => {
  if (followLatest) scrollToLatest();
  else latest.hidden = !empty.hidden || log.scrollHeight - log.scrollTop - log.clientHeight < 56;
}).observe(log);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['tabagent:settings']) {
    void refreshSettings();
    if (quickModelDialog.open && !quickModelBusy) void refreshQuickConnections();
  }
  if (area === 'local' && Object.keys(changes).some((key) => key.startsWith(MODEL_LIBRARY_PREFIX)) && quickModelDialog.open && !quickModelBusy) void loadQuickModels();
  if (area === 'local' && changes[FOLLOW_PAGES_KEY]) {
    followPagesVersion++;
    followPages = changes[FOLLOW_PAGES_KEY].newValue !== false;
    followPagesLoaded = true;
    renderFollowPages();
  }
  if (area === 'local' && changes[AUTO_CLOSE_PAGES_KEY]) {
    autoClosePagesVersion++;
    autoClosePages = changes[AUTO_CLOSE_PAGES_KEY].newValue !== false;
    autoClosePagesLoaded = true;
    renderAutoClosePages();
  }
});
browser.tabs.onActivated.addListener(() => void refreshPage());
browser.tabs.onUpdated.addListener((id, changes, tab) => {
  if ((tab.active || selectedTabIds?.includes(id)) && (changes.title !== undefined || changes.url !== undefined || changes.status === 'complete')) void refreshPage();
});
browser.tabs.onRemoved.addListener((id) => { if (selectedTabIds?.includes(id)) void refreshPage(); });
browser.windows.onFocusChanged.addListener(() => void refreshPage());
window.addEventListener('resize', resizeInput);
window.addEventListener('pagehide', () => {
  clearTimeout(reconnectTimer);
  clearInterval(clockTimer);
  const previous = port;
  port = null;
  previous?.disconnect();
});
try { input.value = localStorage.getItem(`${DRAFT_KEY}:pending`) ?? localStorage.getItem(DRAFT_KEY) ?? ''; } catch { /* Optional draft recovery. */ }
resizeInput();
connect();
void refreshSettings();
void refreshFollowPages();
void refreshAutoClosePages();
void refreshPage();
