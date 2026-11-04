import { browser } from 'wxt/browser';
import { CONTENT_MESSAGE_TAG, type ContentRequest, type ContentResponse, type PageGuard } from '@/lib/protocol';

// 页面里的“手和眼”：把页面整理成带编号的可交互元素列表，并按编号执行点击、输入等操作。
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_end',
  main() {
    const w = window as unknown as { __tabagentLoaded?: boolean };
    if (w.__tabagentLoaded) return;
    w.__tabagentLoaded = true;

    // Trusted user interaction adopts the temporary page. Synthetic tool
    // actions are handled separately by the background's approval path.
    const adopt = (event: Event) => { if (event.isTrusted) userEdited = true; };
    for (const type of ['input', 'change', 'pointerdown', 'keydown']) {
      document.addEventListener(type, adopt, { capture: true, passive: true });
    }

    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (!message || message.tag !== CONTENT_MESSAGE_TAG) return;
      dispatchRequest(message.request as ContentRequest)
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
const documentScope = globalThis as unknown as { __tabagentDocumentId?: string };
const documentId = documentScope.__tabagentDocumentId ??= crypto.randomUUID();
let userEdited = false;

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

function snapshot(maxTextChars = 6000, textOnly = false, textOffset = 0) {
  if (!Number.isInteger(maxTextChars) || maxTextChars < 0 || maxTextChars > 20000) {
    throw new Error('max_text_chars 须为 0 到 20000 之间的整数');
  }
  if (!Number.isInteger(textOffset) || textOffset < 0) throw new Error('text_offset 须为非负整数');
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
  if (textOffset > text.length) {
    throw new Error(`text_offset 超出正文长度（${text.length}），页面可能已更新，请从 text_offset=0 重新读取`);
  }
  // Keep Unicode surrogate pairs intact, while retaining offsets into the original text.
  if (textOffset > 0 && /[\uDC00-\uDFFF]/.test(text[textOffset] ?? '') && /[\uD800-\uDBFF]/.test(text[textOffset - 1] ?? '')) textOffset--;
  let end = Math.min(textOffset + maxTextChars, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  if (maxTextChars > 0 && end === textOffset && end < text.length) end = Math.min(end + 2, text.length);
  const scrollable = document.documentElement.scrollHeight - innerHeight;
  return {
    url: location.href,
    documentId,
    title: document.title,
    scroll: scrollable > 0 ? `${Math.round((scrollY / scrollable) * 100)}%` : '无需滚动',
    elements: textOnly
      ? undefined
      : lines.join('\n') + (total > MAX_ELEMENTS ? `\n…（还有 ${total - MAX_ELEMENTS} 个元素未列出，可滚动后重新读取）` : ''),
    text: text.slice(textOffset, end),
    textOffset,
    nextOffset: end < text.length ? end : null,
    totalTextChars: text.length,
  };
}

function searchLinks(check: () => void) {
  const candidates = new Map<string, { title: string; url: string; heading: boolean }>();
  const currentUrl = new URL(location.href);
  currentUrl.hash = '';
  for (const root of walkRoots(document)) {
    check();
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      check();
      if (anchor.hasAttribute('download') || !isVisible(anchor)) continue;
      // Visibility also follows ancestors across open shadow roots. In
      // particular, an opaque child may still sit inside an invisible host.
      let hidden = false;
      for (let ancestor: Element | null = anchor; ancestor; ) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hasAttribute('hidden') || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) {
          hidden = true;
          break;
        }
        const tree = ancestor.getRootNode();
        ancestor = ancestor.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null);
      }
      if (hidden) continue;
      const href = anchor.getAttribute('href')?.trim();
      if (!href) continue;
      let destination: URL;
      try { destination = new URL(href, document.baseURI); } catch { continue; }
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.href.length > 8192) continue;
      const withoutHash = new URL(destination.href);
      withoutHash.hash = '';
      if (withoutHash.href === currentUrl.href) continue;
      const heading = anchor.querySelector<HTMLElement>('h2, h3') ?? anchor.closest<HTMLElement>('h2, h3');
      const labelledBy = (anchor.getAttribute('aria-labelledby') ?? '').split(/\s+/)
        .map((id) => root.getElementById(id)?.textContent ?? '').join(' ');
      let title = [heading?.innerText, anchor.getAttribute('aria-label'), labelledBy, anchor.innerText,
        anchor.getAttribute('title'), anchor.querySelector('img')?.getAttribute('alt')]
        .find((text) => text?.trim())?.replace(/\s+/g, ' ').trim() ?? '';
      if (!title) continue;
      if (title.length > 200) title = title.slice(0, 199).replace(/[\uD800-\uDBFF]$/, '') + '…';
      const previous = candidates.get(destination.href);
      if (!previous || (heading && !previous.heading)) {
        if (previous) candidates.delete(destination.href);
        candidates.set(destination.href, { title, url: destination.href, heading: !!heading });
      }
    }
  }
  check();
  return {
    title: document.title,
    url: location.href,
    links: [...candidates.values()].sort((a, b) => Number(b.heading) - Number(a.heading))
      .slice(0, 60).map(({ title, url }) => ({ title, url })),
  };
}

// ---------- 操作 ----------

const MUTATING_ACTIONS = new Set(['click', 'type', 'select', 'press_key', 'scroll', 'hover']);

// Retain completed/cancelled IDs until their original deadline has passed. A
// delayed message or a duplicate delivery must never replay a page action.
const requests = new Map<string, { controller?: AbortController; expiresAt: number }>();
function rememberRequest(id: string, controller?: AbortController) {
  const record = { controller, expiresAt: Date.now() + 60000 };
  requests.set(id, record);
  setTimeout(() => { if (requests.get(id) === record) requests.delete(id); }, 60000);
  return record;
}

async function dispatchRequest(req: ContentRequest): Promise<unknown> {
  if (!req || typeof req !== 'object' || typeof req.action !== 'string') throw new Error('页面请求格式不正确');
  if (req.action === 'cancel') {
    if (typeof req.requestId !== 'string' || !req.requestId || req.requestId.length > 100) throw new Error('取消请求编号不正确');
    const record = requests.get(req.requestId);
    if (record) record.controller?.abort(new DOMException('页面操作已取消', 'AbortError'));
    else {
      if (requests.size >= 2048) throw new Error('页面请求过于频繁，请稍后重试');
      rememberRequest(req.requestId);
    }
    return '页面已收到取消请求；已完成的操作不会撤销';
  }
  const controller = new AbortController();
  let record: ReturnType<typeof rememberRequest> | undefined;
  if (MUTATING_ACTIONS.has(req.action) || req.requestId !== undefined) {
    if (typeof req.requestId !== 'string' || !req.requestId || req.requestId.length > 100 ||
      !Number.isFinite(req.deadline) || req.deadline! > Date.now() + 15000) throw new Error('页面请求缺少有效的执行期限');
    if (req.deadline! <= Date.now()) throw new Error('页面操作已过期，未执行，请检查页面后重试');
    if (requests.has(req.requestId)) throw new Error('页面请求已取消或已处理，未重复执行');
    // Keep memory bounded without discarding an ID that can still be replayed.
    if (requests.size >= 2048) throw new Error('页面请求过于频繁，请稍后重试');
    record = rememberRequest(req.requestId, controller);
  }
  const check = () => {
    controller.signal.throwIfAborted();
    if (req.deadline !== undefined && req.deadline <= Date.now()) throw new Error('页面操作已过期，未继续执行，请检查页面后重试');
  };
  try { check(); return await handle(req, controller.signal, check); }
  finally { if (record) record.controller = undefined; }
}

function elementFingerprint(el: Element): string {
  const control = el as HTMLInputElement;
  const form = control.form;
  const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  // Cosmetic class/style/focus changes are expected while preparing an action.
  // Keep the identity and meaning of its target, including complete (unclipped)
  // text and labels, so a changed destination or control still needs approval.
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => text(el.getRootNode() instanceof ShadowRoot
      ? (el.getRootNode() as ShadowRoot).getElementById(id)?.textContent : document.getElementById(id)?.textContent));
  const attributes = ['id', 'name', 'type', 'role', 'aria-label', 'aria-labelledby', 'aria-checked', 'aria-selected', 'aria-expanded',
    'aria-disabled', 'aria-readonly', 'placeholder', 'title', 'alt', 'contenteditable', 'target', 'download',
    'formaction', 'formmethod', 'formtarget', 'formnovalidate', 'required', 'min', 'max', 'pattern', 'multiple',
    'onclick', 'oninput', 'onchange', 'onkeydown', 'onkeypress', 'onsubmit'];
  return JSON.stringify({
    id: idFor(el), tag: el.tagName, attributes: attributes.map((name) => [name, el.getAttribute(name)]),
    text: text(el.textContent), labelledBy,
    labels: control.labels ? [...control.labels].map((label) => text(label.textContent)) : [],
    images: [...el.querySelectorAll('img')].map((image) => image.alt),
    value: control.value ?? null, checked: control.checked ?? null,
    disabled: el.matches(':disabled'), readOnly: control.readOnly ?? null, editable: Boolean((el as HTMLElement).isContentEditable),
    inert: Boolean(el.closest('[inert]')), hidden: Boolean(el.closest('[aria-hidden="true"]')),
    href: el instanceof HTMLAnchorElement ? el.href : null,
    form: form ? [idFor(form), form.action, form.method, form.target, form.enctype, form.noValidate] : null,
    options: el instanceof HTMLSelectElement ? [...el.options].map((option) => [option.value, text(option.text), option.disabled, option.selected]) : null,
  });
}

function friendlyElement(el: Element): string {
  const kind = el instanceof HTMLInputElement ? (['checkbox', 'radio'].includes(el.type) ? '选择控件' : '输入框')
    : el instanceof HTMLTextAreaElement ? '文本框'
    : el instanceof HTMLSelectElement ? '下拉框'
    : el instanceof HTMLButtonElement || el.getAttribute('role') === 'button' ? '按钮'
    : el instanceof HTMLAnchorElement ? '链接' : '页面元素';
  const label = labelFor(el);
  return label ? `${kind}「${label}」` : kind;
}

function guardElement(id: number): Element {
  const target = id === 0 ? document.activeElement ?? document.body : getElement(id);
  if (!target) throw new Error('页面没有可操作的焦点元素，请重新读取页面');
  return target;
}

function assertGuard(guard: PageGuard | undefined, element?: Element, checkFingerprint = true): asserts guard is PageGuard {
  if (!guard || guard.documentId !== documentId || guard.url !== location.href) {
    throw new Error('批准的页面已变化，本次操作未执行，请重新读取页面并确认');
  }
  if (element && (guard.elementId === undefined || guardElement(guard.elementId) !== element || !element.isConnected)) {
    throw new Error('批准的目标元素已变化，请重新读取页面并确认');
  }
  if (guard.elementId !== undefined && checkFingerprint && elementFingerprint(guardElement(guard.elementId)) !== guard.elementFingerprint) {
    throw new Error('批准的元素内容已变化，请重新读取页面并确认');
  }
}

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

type ActionContext = { signal: AbortSignal; check: () => void };

function sleep(ms: number, context: ActionContext): Promise<void> {
  context.check();
  return new Promise((resolve, reject) => {
    const cleanup = () => context.signal.removeEventListener('abort', abort);
    const abort = () => { clearTimeout(timer); cleanup(); reject(context.signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      try { context.check(); resolve(); } catch (error) { reject(error); }
    }, ms);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
  });
}

async function prepare(id: number, guard: PageGuard | undefined, context: ActionContext): Promise<HTMLElement> {
  context.check();
  const el = getElement(id) as HTMLElement;
  assertGuard(guard, el);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await sleep(50, context);
  context.check();
  assertGuard(guard, el);
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

async function click(id: number, guard: PageGuard | undefined, context: ActionContext) {
  const el = await prepare(id, guard, context);
  context.check();
  assertGuard(guard, el);
  for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown']) mouse(el, t);
  el.focus?.({ preventScroll: true });
  context.check();
  assertGuard(guard, el);
  for (const t of ['pointerup', 'mouseup']) mouse(el, t);
  context.check();
  assertGuard(guard, el);
  el.click();
  return `已点击 [${id}] "${labelFor(el)}"`;
}

async function hover(id: number, guard: PageGuard | undefined, context: ActionContext) {
  const el = await prepare(id, guard, context);
  context.check();
  assertGuard(guard, el);
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

async function typeText(id: number, text: string, clear: boolean, submit: boolean, guard: PageGuard | undefined, context: ActionContext) {
  const el = await prepare(id, guard, context);
  context.check();
  el.focus();
  context.check();
  assertGuard(guard, el);
  let writtenValue: string;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    writtenValue = clear ? text : el.value + text;
    setNativeValue(el, writtenValue);
  } else if (el.isContentEditable) {
    if (clear) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    if (!document.execCommand('insertText', false, text)) el.textContent = text;
    writtenValue = el.textContent ?? '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else {
    throw new Error(`元素 [${id}] 不是输入框，无法输入文字`);
  }
  if (submit) {
    const ensureWritten = () => {
      context.check();
      assertGuard(guard, el, false);
      const current = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? '';
      if (current !== writtenValue) throw new Error('填写后的内容已变化，未继续提交，请检查页面后重新确认');
    };
    ensureWritten();
    const form = (el as HTMLInputElement).form;
    if (form) {
      const submission = JSON.stringify([form.action, form.method, form.target]);
      await sleep(100, context);
      ensureWritten();
      if (!form.isConnected || (el as HTMLInputElement).form !== form || JSON.stringify([form.action, form.method, form.target]) !== submission) {
        throw new Error('表单目标已变化，未继续提交，请重新读取并确认');
      }
      // Submit once: sending Enter before this fallback could submit the same form twice.
      form.requestSubmit();
    } else { ensureWritten(); key(el, 'Enter'); }
  }
  return `已在 [${id}] 输入 ${text.length} 个字符${submit ? '并提交' : ''}`;
}

async function selectOption(id: number, option: string, guard: PageGuard | undefined, context: ActionContext) {
  const el = await prepare(id, guard, context);
  context.check();
  assertGuard(guard, el);
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

async function pressKey(k: string, id: number | undefined, guard: PageGuard | undefined, context: ActionContext) {
  const el = id !== undefined ? await prepare(id, guard, context) : ((document.activeElement as HTMLElement) ?? document.body);
  context.check();
  assertGuard(guard, el);
  key(el, k);
  return `已按下 ${k}`;
}

async function scroll(direction: 'up' | 'down' | 'top' | 'bottom', id: number | undefined, guard: PageGuard | undefined, context: ActionContext) {
  context.check();
  assertGuard(guard);
  if (id !== undefined) {
    const target = await prepare(id, guard, context);
    context.check();
    assertGuard(guard, target);
    target.scrollIntoView({ block: 'center' });
  } else if (direction === 'top') scrollTo({ top: 0 });
  else if (direction === 'bottom') scrollTo({ top: document.documentElement.scrollHeight });
  else scrollBy({ top: (direction === 'down' ? 1 : -1) * innerHeight * 0.8 });
  await sleep(300, context);
  return `已滚动，当前位置 ${snapshot(0, true).scroll}`;
}

function extract(selector: string, attribute?: string, limit = 50) {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('请提供有效的 CSS 选择器');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 须为 1 到 500 之间的整数');
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

async function handle(req: ContentRequest, signal: AbortSignal, check: () => void): Promise<unknown> {
  const context = { signal, check };
  check();
  if ((req.action === 'snapshot' || req.action === 'extract') && document.contentType === 'application/pdf') {
    throw new Error('当前页面是 PDF，暂不支持 PDF 全文读取或表格提取。支持图片的模型开启“图片识别”后可分析当前可见区域，不代表已读完整份 PDF。');
  }
  if (MUTATING_ACTIONS.has(req.action) || req.guard) assertGuard(req.guard);
  switch (req.action) {
    case 'ping':
      return 'pong';
    case 'snapshot':
      return snapshot(req.maxTextChars, req.textOnly, req.textOffset);
    case 'search_links':
      return searchLinks(check);
    case 'research_status':
      return { documentId, url: location.href, userEdited };
    case 'describe': {
      const target = req.id === undefined ? undefined : guardElement(req.id);
      const fingerprint = target ? elementFingerprint(target) : '';
      const guard: PageGuard = { url: location.href, documentId, ...(target ? { elementId: req.id, elementFingerprint: fingerprint } : {}) };
      return {
        description: target ? friendlyElement(target) : document.title,
        fingerprint,
        guard,
      };
    }
    case 'click':
      return click(req.id, req.guard, context);
    case 'hover':
      return hover(req.id, req.guard, context);
    case 'type':
      return typeText(req.id, req.text, req.clear ?? true, req.submit ?? false, req.guard, context);
    case 'select':
      return selectOption(req.id, req.option, req.guard, context);
    case 'press_key':
      return pressKey(req.key, req.id, req.guard, context);
    case 'scroll':
      return scroll(req.direction, req.id, req.guard, context);
    case 'extract':
      return { items: extract(req.selector, req.attribute, req.limit), title: document.title, url: location.href, documentId };
  }
}
