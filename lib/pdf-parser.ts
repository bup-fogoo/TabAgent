import { browser } from 'wxt/browser';
import { getDocument, PDFWorker, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface ParsedPdf {
  text: string;
  pages: number;
  emptyPages: number[];
}

const MAX_PAGES = 300;
const MAX_TEXT = 1_000_000;
const extensionUrl = (path: string) => new URL(path, browser.runtime.getURL('/options.html')).href;

/** Runs only in our isolated extension document. No PDF actions, annotations,
 * viewer code or embedded JavaScript are executed; only text is extracted. */
export async function extractPdfText(data: Uint8Array, signal: AbortSignal): Promise<ParsedPdf> {
  signal.throwIfAborted();
  const worker = new Worker(extensionUrl('/pdfjs/pdf.worker.mjs'), { type: 'module' });
  const pdfWorker = PDFWorker.create({ port: worker });
  let loading: PDFDocumentLoadingTask | undefined;
  let rejectFailure!: (reason: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // Attach immediately, including failures before the document promise exists.
  void failure.catch(() => {});
  const abort = () => {
    worker.terminate();
    rejectFailure(signal.reason ?? new DOMException('PDF 读取已停止', 'AbortError'));
  };
  const brokenWorker = () => rejectFailure(new Error('PDF 解析器无法启动，请重新加载扩展后重试。'));
  signal.addEventListener('abort', abort, { once: true });
  worker.addEventListener('error', brokenWorker);
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, failure]);
  try {
    loading = getDocument({
      data,
      worker: pdfWorker,
      cMapUrl: extensionUrl('/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: extensionUrl('/pdfjs/standard_fonts/'),
      useWorkerFetch: true,
      useWasm: false,
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: true,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: 0,
    });
    loading.onPassword = () => rejectFailure(new Error('这份 PDF 需要密码，暂不支持读取加密文档。请先解锁后再试。'));
    const document = await wait(loading.promise);
    signal.throwIfAborted();
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new Error('这份 PDF 没有可读取的页面。');
    if (document.numPages > MAX_PAGES) throw new Error(`这份 PDF 共 ${document.numPages} 页，超过单份 ${MAX_PAGES} 页的上限，请拆分后再读。`);
    const parts: string[] = [];
    const emptyPages: number[] = [];
    let total = 0;
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted();
      const page = await wait(document.getPage(number));
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      const pageParts: string[] = [];
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (typeof item.str !== 'string') continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            total += text.length;
            if (total > MAX_TEXT) throw new Error('PDF 正文超过 100 万字符，请拆分后再读；本次没有截断后冒充全文。');
            pageParts.push(text);
          }
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      const text = pageParts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) emptyPages.push(number);
      const part = `[第 ${number} 页]\n${text || '（本页未提取到文字，可能为空白页或扫描页）'}`;
      parts.push(part);
    }
    if (emptyPages.length === document.numPages) throw new Error('这份 PDF 未提取到可读取的文字，可能是扫描件或图片文档，需要 OCR 文字识别；目前可开启图片识别分析当前可见页面。');
    const text = parts.join('\n\n');
    if (text.length > MAX_TEXT) throw new Error('PDF 正文超过 100 万字符，请拆分后再读。');
    return { text, pages: document.numPages, emptyPages };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && ['PasswordException'].includes(error.name)) throw new Error('这份 PDF 需要密码，暂不支持读取加密文档。');
    if (error instanceof Error && ['InvalidPDFException', 'FormatError'].includes(error.name)) throw new Error('PDF 文件已损坏或格式不受支持，无法读取正文。');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    worker.removeEventListener('error', brokenWorker);
    // A worker stuck in a malformed document must never delay cancellation.
    worker.terminate();
    pdfWorker.destroy();
    if (loading) void loading.destroy().catch(() => {});
  }
}
