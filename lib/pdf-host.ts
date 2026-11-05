import { browser } from 'wxt/browser';
import type { ParsedPdf } from './pdf-parser';

type ParserPort = ReturnType<typeof browser.runtime.connect>;
type Offscreen = {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
};
let queue: Promise<void> = Promise.resolve();

/** One disposable parser document at a time. Calls do not depend on a side panel
 * remaining open, and neither document bytes nor extracted text are persisted. */
export function parsePdfBytes(data: Uint8Array, signal: AbortSignal): Promise<ParsedPdf> {
  signal.throwIfAborted();
  if (!data.length || data.byteLength > 20 * 1024 * 1024) return Promise.reject(new Error('PDF 文件为空或超过 20 MB 上限，请拆分后再读。'));
  const work = queue.then(() => runParser(data, signal));
  queue = work.then(() => {}, () => {});
  return abortable(work, signal);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('PDF 读取已停止', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function runParser(data: Uint8Array, signal: AbortSignal): Promise<ParsedPdf> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const relative = `/pdf-reader.html?request=${id}`;
  const url = new URL(relative, browser.runtime.getURL('/options.html')).href;
  const offscreen = (browser as unknown as { offscreen?: Offscreen }).offscreen;
  let frame: HTMLIFrameElement | undefined;
  let port: ParserPort | undefined;
  let created = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectResult!: (reason: unknown) => void;
  let resolveResult!: (value: ParsedPdf) => void;
  const response = new Promise<ParsedPdf>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void response.catch(() => {});
  const stop = () => {
    try { port?.postMessage({ type: 'cancel' }); } catch { /* Port already closed. */ }
    port?.disconnect();
    rejectResult(signal.reason ?? new DOMException('PDF 读取已停止', 'AbortError'));
  };
  const listener = (incoming: ParserPort) => {
    if (incoming.name !== `tabagent:pdf-reader:${id}` || incoming.sender?.id !== browser.runtime.id || incoming.sender?.url !== url) return;
    if (port) { incoming.disconnect(); return; }
    port = incoming;
    let sent = false;
    incoming.onDisconnect.addListener(() => rejectResult(new Error('PDF 解析页面已关闭，请重试。')));
    incoming.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object' || signal.aborted) return;
      const value = message as { type?: string; ok?: boolean; error?: unknown; result?: ParsedPdf };
      if (value.type === 'ready' && !sent) {
        sent = true;
        let binary = '';
        for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
        try { incoming.postMessage({ type: 'parse', data: btoa(binary) }); }
        catch { rejectResult(new Error('无法传送 PDF 数据到本机解析器。')); }
      } else if (value.type === 'result') {
        if (!value.ok) { rejectResult(new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : 'PDF 解析失败。')); return; }
        const result = value.result;
        if (!result || typeof result.text !== 'string' || result.text.length > 1_000_000 || !Number.isInteger(result.pages) || result.pages < 1 || result.pages > 300 || !Array.isArray(result.emptyPages) || result.emptyPages.some((page) => !Number.isInteger(page) || page < 1 || page > result.pages)) {
          rejectResult(new Error('PDF 解析器返回了无效结果。')); return;
        }
        resolveResult(result);
      }
    });
  };
  browser.runtime.onConnect.addListener(listener);
  signal.addEventListener('abort', stop, { once: true });
  timer = setTimeout(() => {
    try { port?.postMessage({ type: 'cancel' }); } catch { /* Already closed. */ }
    port?.disconnect();
    rejectResult(new Error('PDF 解析超过 60 秒，请拆分文件后重试。'));
  }, 60_000);
  try {
    if (offscreen && typeof document === 'undefined') {
      // A previous service-worker termination can leave its parser document.
      // This extension uses its sole offscreen document only for this parser.
      try { await offscreen.closeDocument(); } catch { /* No existing document. */ }
      signal.throwIfAborted();
      await offscreen.createDocument({ url: relative.slice(1), reasons: ['WORKERS'], justification: '在本机解析用户选中的 PDF 文本，使用随扩展打包的 PDF 工作线程。' });
      created = true;
    } else if (typeof document !== 'undefined') {
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = url;
      (document.body ?? document.documentElement).append(frame);
    } else throw new Error('当前浏览器不支持后台 PDF 解析，请更新浏览器后重试。');
    signal.throwIfAborted();
    return await response;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    browser.runtime.onConnect.removeListener(listener);
    port?.disconnect();
    frame?.remove();
    if (created) try { await offscreen!.closeDocument(); } catch { /* Already closed. */ }
  }
}
