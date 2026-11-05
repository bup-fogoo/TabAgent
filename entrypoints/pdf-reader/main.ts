import { browser } from 'wxt/browser';
import { extractPdfText } from '@/lib/pdf-parser';

const id = new URL(location.href).searchParams.get('request');
if (id && /^[a-f\d-]{36}$/i.test(id)) {
  const port = browser.runtime.connect({ name: `tabagent:pdf-reader:${id}` });
  const controller = new AbortController();
  let started = false;
  const post = (value: unknown) => { try { port.postMessage(value); } catch { controller.abort(); } };
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const request = message as { type?: string; data?: unknown };
    if (request.type === 'cancel') { controller.abort(); return; }
    if (request.type !== 'parse' || started) return;
    started = true;
    void (async () => {
      try {
        if (typeof request.data !== 'string' || !request.data.length || request.data.length > 28 * 1024 * 1024 || !/^[A-Za-z\d+/]*={0,2}$/.test(request.data)) throw new Error('PDF 数据无效或超过 20 MB 上限。');
        const decoded = atob(request.data);
        if (decoded.length > 20 * 1024 * 1024) throw new Error('PDF 超过 20 MB 上限。');
        const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        const result = await extractPdfText(bytes, controller.signal);
        controller.signal.throwIfAborted();
        post({ type: 'result', ok: true, result });
      } catch (error) {
        if (!controller.signal.aborted) post({ type: 'result', ok: false, error: error instanceof Error ? error.message : 'PDF 解析失败，请检查文件。' });
      }
    })();
  });
  post({ type: 'ready' });
}
