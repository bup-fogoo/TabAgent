import { browser } from 'wxt/browser';
import { CONTENT_MESSAGE_TAG, type ContentRequest, type ContentResponse } from '@/lib/protocol';

// 页面里的“手和眼”：把页面整理成带编号的可交互元素列表，并按编号执行点击、输入等操作。
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const w = window as unknown as { __tabagentLoaded?: boolean };
    if (w.__tabagentLoaded) return;
    w.__tabagentLoaded = true;

    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (!message || message.tag !== CONTENT_MESSAGE_TAG) return;
      handle(message.request as ContentRequest)
        .then((result) => sendResponse({ ok: true, result } satisfies ContentResponse))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse),
        );
      return true;
    });
  },
});

// ---------- 元素编号 ----------
// 编号在同一页面内保持稳定：同一个元素多次读取得到同一个编号。

const idByElement = new WeakMap<Element, number>();
const elementById = new Map<number, WeakRef<Element>>();
let nextId = 1;

function idFor(el: Element): number {
  let id = idByElement.get(el);
  if (id === undefined) {
    id = nextId++;
    idByElement.set(el, id);
  }
  elementById.set(id, new WeakRef(el));
  return id;
}

function getElement(id: number): Element {
  const el = elementById.get(id)?.deref();
  if (!el || !el.isConnected) {
    throw new Error(`元素 [${id}] 已不存在（页面可能已变化），请重新调用 read_page 获取最新编号`);
  }
  return el;
}

// ---------- 读取页面 ----------

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=option]',
  '[role=switch]',
  '[role=combobox]',
  '[role=textbox]',
  '[role=searchbox]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const MAX_ELEMENTS = 400;

function* walkRoots(root: Document | ShadowRoot): Generator<Document | ShadowRoot> {
  yield root;
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) yield* walkRoots(el.shadowRoot);
  }
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  return !el.closest('[aria-hidden="true"]') && !(el as HTMLElement).closest('[inert]');
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function clean(text: string | null | undefined, max = 80): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function labelFor(el: Element): string {
  const h = el as HTMLElement;
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (clean(text)) return clean(text);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = el.labels?.[0]?.textContent;
    if (clean(label)) return clean(label);
  }
  const text = el instanceof HTMLSelectElement ? '' : clean(h.innerText);
  if (text) return text;
  return clean(
    el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.querySelector('img')?.getAttribute('alt') ||
      el.getAttribute('name') ||
      '',
  );
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const parts: string[] = [];
  let kind = role ? `${tag} role=${role}` : tag;

  if (el instanceof HTMLInputElement) {
    kind = `input type=${el.type}`;
    if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? '已选中' : '未选中');
    else if (el.type !== 'password' && el.value) parts.push(`当前值="${clean(el.value, 60)}"`);
    if (el.placeholder) parts.push(`placeholder="${clean(el.placeholder, 40)}"`);
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) parts.push(`当前值="${clean(el.value, 60)}"`);
    if (el.placeholder) parts.push(`placeholder="${clean(el.placeholder, 40)}"`);
  } else if (el instanceof HTMLSelectElement) {
    const opts = [...el.options].slice(0, 15).map((o) => clean(o.text, 30));
    parts.push(`选项=[${opts.join(' | ')}${el.options.length > 15 ? ' | …' : ''}]`);
    parts.push(`当前="${clean(el.selectedOptions[0]?.text, 30)}"`);
  } else if (el instanceof HTMLAnchorElement) {
    const href = el.getAttribute('href') ?? '';
    if (href && !href.startsWith('javascript:')) parts.push(`href="${clean(href, 80)}"`);
  }
  if ((el as HTMLButtonElement).disabled) parts.push('禁用');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) parts.push(`展开=${expanded}`);
  if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true') parts.push('已选中');
  if (!inViewport(el)) parts.push('屏幕外');

  const label = labelFor(el);
  return `[${idFor(el)}] <${kind}> "${label}"${parts.length ? ' ' + parts.join(' ') : ''}`;
}

function snapshot(maxTextChars = 6000, textOnly = false) {
  const lines: string[] = [];
  let total = 0;
  if (!textOnly) {
    const seen = new Set<Element>();
    const candidates: Element[] = [];
    for (const root of walkRoots(document)) {
      for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        candidates.push(el);
      }
    }
    total = candidates.length;
    // 屏幕内的元素优先，其次按文档顺序
    const ordered = [...candidates.filter(inViewport), ...candidates.filter((el) => !inViewport(el))].slice(
      0,
      MAX_ELEMENTS,
    );
    const keep = new Set(ordered);
    for (const el of candidates) if (keep.has(el)) lines.push(describe(el));
  }

  const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const scrollable = document.documentElement.scrollHeight - innerHeight;
  return {
    url: location.href,
    title: document.title,
    scroll: scrollable > 0 ? `${Math.round((scrollY / scrollable) * 100)}%` : '无需滚动',
    elements: textOnly
      ? undefined
      : lines.join('\n') + (total > MAX_ELEMENTS ? `\n…（还有 ${total - MAX_ELEMENTS} 个元素未列出，可滚动后重新读取）` : ''),
    text: text.length > maxTextChars ? text.slice(0, maxTextChars) + `\n…（正文已截断，共 ${text.length} 字）` : text,
  };
}

// ---------- 操作 ----------

function flash(el: Element) {
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    left: `${r.left - 3}px`,
    top: `${r.top - 3}px`,
    width: `${r.width + 6}px`,
    height: `${r.height + 6}px`,
    border: '2px solid #2563eb',
    borderRadius: '6px',
    background: 'rgba(37,99,235,0.12)',
    zIndex: '2147483647',
    pointerEvents: 'none',
    transition: 'opacity .6s',
  });
  document.documentElement.appendChild(box);
  setTimeout(() => (box.style.opacity = '0'), 600);
  setTimeout(() => box.remove(), 1300);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prepare(id: number): Promise<HTMLElement> {
  const el = getElement(id) as HTMLElement;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await sleep(50);
  flash(el);
  return el;
}

function mouse(el: Element, type: string) {
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    view: window,
  };
  const Ctor = type.startsWith('pointer') && 'PointerEvent' in window ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Ctor(type, { ...init, pointerId: 1, isPrimary: true } as PointerEventInit));
}

async function click(id: number) {
  const el = await prepare(id);
  for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown']) mouse(el, t);
  el.focus?.({ preventScroll: true });
  for (const t of ['pointerup', 'mouseup']) mouse(el, t);
  el.click();
  return `已点击 [${id}] "${labelFor(el)}"`;
}

async function hover(id: number) {
  const el = await prepare(id);
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(el, t);
  return `已悬停在 [${id}] 上`;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // 绕过 React/Vue 等框架对 value 的拦截
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function key(el: Element, k: string) {
  const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
  const init = { key: k, code: k === ' ' ? 'Space' : k, keyCode: codes[k] ?? 0, which: codes[k] ?? 0, bubbles: true, cancelable: true, composed: true };
  const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (k.length === 1 || k === 'Enter') el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return down;
}

async function typeText(id: number, text: string, clear = true, submit = false) {
  const el = await prepare(id);
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, clear ? text : el.value + text);
  } else if (el.isContentEditable) {
    if (clear) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    if (!document.execCommand('insertText', false, text)) el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else {
    throw new Error(`元素 [${id}] 不是输入框，无法输入文字`);
  }
  if (submit) {
    const notCancelled = key(el, 'Enter');
    const form = (el as HTMLInputElement).form;
    if (notCancelled && form) {
      await sleep(100);
      if (el.isConnected) form.requestSubmit();
    }
  }
  return `已在 [${id}] 输入 ${text.length} 个字符${submit ? '并提交' : ''}`;
}

async function selectOption(id: number, option: string) {
  const el = await prepare(id);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`[${id}] 不是原生下拉框；自定义下拉菜单请先 click 展开，再 read_page 并 click 对应选项`);
  }
  const target = [...el.options].find((o) => o.text.trim() === option || o.value === option) ??
    [...el.options].find((o) => o.text.includes(option));
  if (!target) throw new Error(`找不到选项 "${option}"`);
  el.value = target.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return `已选择 "${target.text.trim()}"`;
}

async function pressKey(k: string, id?: number) {
  const el = id !== undefined ? await prepare(id) : ((document.activeElement as HTMLElement) ?? document.body);
  key(el, k);
  return `已按下 ${k}`;
}

async function scroll(direction: 'up' | 'down' | 'top' | 'bottom', id?: number) {
  if (id !== undefined) {
    (await prepare(id)).scrollIntoView({ block: 'center' });
  } else if (direction === 'top') scrollTo({ top: 0 });
  else if (direction === 'bottom') scrollTo({ top: document.documentElement.scrollHeight });
  else scrollBy({ top: (direction === 'down' ? 1 : -1) * innerHeight * 0.8 });
  await sleep(300);
  return `已滚动，当前位置 ${snapshot(0, true).scroll}`;
}

function extract(selector: string, attribute?: string, limit = 50) {
  const nodes = [...document.querySelectorAll(selector)].slice(0, limit);
  if (!nodes.length) throw new Error(`选择器 "${selector}" 没有匹配到元素`);
  return nodes.map((n) => {
    if (attribute) return n.getAttribute(attribute) ?? '';
    if (n instanceof HTMLTableElement) {
      return [...n.rows].map((row) => [...row.cells].map((c) => clean(c.innerText, 200)).join('\t')).join('\n');
    }
    return clean((n as HTMLElement).innerText ?? n.textContent, 2000);
  });
}

async function handle(req: ContentRequest): Promise<unknown> {
  switch (req.action) {
    case 'ping':
      return 'pong';
    case 'snapshot':
      return snapshot(req.maxTextChars, req.textOnly);
    case 'click':
      return click(req.id);
    case 'hover':
      return hover(req.id);
    case 'type':
      return typeText(req.id, req.text, req.clear ?? true, req.submit ?? false);
    case 'select':
      return selectOption(req.id, req.option);
    case 'press_key':
      return pressKey(req.key, req.id);
    case 'scroll':
      return scroll(req.direction, req.id);
    case 'extract':
      return extract(req.selector, req.attribute, req.limit);
  }
}
