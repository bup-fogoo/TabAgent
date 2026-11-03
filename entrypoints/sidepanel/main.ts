import { browser } from 'wxt/browser';
import { PANEL_PORT_NAME, type AgentEvent, type PanelRequest } from '@/lib/protocol';
import { renderMarkdown } from '@/lib/markdown';

const log = document.getElementById('log')!;
const empty = document.getElementById('empty')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;

const TOOL_LABELS: Record<string, string> = {
  list_tabs: '查看标签页',
  read_page: '读取页面',
  click: '点击',
  type_text: '输入',
  select_option: '选择',
  hover: '悬停',
  press_key: '按键',
  scroll: '滚动',
  extract: '提取数据',
  navigate: '打开网址',
  go_back: '后退',
  open_tab: '新建标签页',
  switch_tab: '切换标签页',
  close_tab: '关闭标签页',
  wait: '等待',
};

let running = false;
let thinking: HTMLElement | null = null;
const toolRows = new Map<string, HTMLElement>();

let port = connect();
function connect() {
  const p = browser.runtime.connect({ name: PANEL_PORT_NAME });
  p.onMessage.addListener((e: unknown) => handle(e as AgentEvent));
  // 后台被浏览器休眠后重新连上
  p.onDisconnect.addListener(() => setTimeout(() => (port = connect()), 500));
  return p;
}

function post(req: PanelRequest) {
  try {
    port.postMessage(req);
  } catch {
    port = connect();
    port.postMessage(req);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function append(node: HTMLElement) {
  empty.hidden = true;
  log.insertBefore(node, thinking && thinking.isConnected ? thinking : null);
  log.scrollTop = log.scrollHeight;
}

function describeInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  if (input.element_id !== undefined) parts.push(`[${input.element_id}]`);
  if (input.text !== undefined) parts.push(`"${String(input.text).slice(0, 40)}"`);
  if (input.url) parts.push(input.url);
  if (input.selector) parts.push(input.selector);
  if (input.option) parts.push(input.option);
  if (input.key) parts.push(input.key);
  if (name === 'scroll' && input.direction) parts.push(input.direction);
  if (input.tab_id !== undefined) parts.push(`tab ${input.tab_id}`);
  if (input.seconds !== undefined) parts.push(`${input.seconds}s`);
  return parts.join(' ');
}

function handle(event: AgentEvent) {
  switch (event.type) {
    case 'history':
      for (const node of [...log.children]) if (node !== empty) node.remove();
      toolRows.clear();
      empty.hidden = event.events.length > 0;
      for (const e of event.events) handle(e);
      break;
    case 'user':
      append(el('div', 'msg user', event.text));
      break;
    case 'assistant': {
      const node = el('div', 'msg assistant');
      node.innerHTML = renderMarkdown(event.text);
      append(node);
      break;
    }
    case 'tool': {
      const row = el('div', 'tool');
      row.append(el('span', 'name', TOOL_LABELS[event.name] ?? event.name), ` ${describeInput(event.name, event.input)}`);
      toolRows.set(event.id, row);
      append(row);
      break;
    }
    case 'tool_result': {
      const row = toolRows.get(event.id);
      if (!row) break;
      row.classList.add(event.ok ? 'ok' : 'fail');
      row.append(el('span', 'result', event.summary));
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'error':
      append(el('div', 'msg error', event.message));
      break;
    case 'status':
      running = event.running;
      send.textContent = running ? '停止' : '发送';
      send.classList.toggle('stop', running);
      thinking?.remove();
      thinking = null;
      if (running) {
        thinking = el('div', 'thinking', '正在处理');
        log.append(thinking);
        log.scrollTop = log.scrollHeight;
      }
      break;
  }
}

function submit() {
  if (running) {
    post({ type: 'stop' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  post({ type: 'run', text });
}

send.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
document.getElementById('new-chat')!.addEventListener('click', () => post({ type: 'reset' }));
document.getElementById('open-options')!.addEventListener('click', () => browser.runtime.openOptionsPage());
document.querySelectorAll('#examples button').forEach((b) =>
  b.addEventListener('click', () => {
    input.value = b.textContent ?? '';
    input.focus();
  }),
);
