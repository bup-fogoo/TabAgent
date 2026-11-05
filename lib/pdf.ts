import { parsePdfBytes } from '@/lib/pdf-host';

export interface PdfText { text: string; pages: number; emptyPages: number[] }
const MAX_BYTES = 20 * 1024 * 1024;

/** Only called after BrowserContext has verified this task's tab and document. */
export async function readOnlinePdf(url: string, signal: AbortSignal): Promise<PdfText> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('只能读取本轮页面中的在线 PDF。');
  target.hash = '';
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(target.href, { credentials: 'include', redirect: 'error', signal, headers: { Accept: 'application/pdf' } });
  } catch {
    signal.throwIfAborted();
    throw new Error('无法下载此 PDF，请确认页面可访问。需要重新登录或跳转的链接，请先在浏览器打开最终 PDF 页面后重试。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`PDF 下载失败（HTTP ${response.status}），请检查登录状态或文件权限。`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('PDF 超过 20 MB，请拆分文件后再总结。');
  }
  if (!response.body) throw new Error('PDF 下载内容为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('PDF 超过 20 MB，请拆分文件后再总结。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
    throw new Error('下载结果不是有效 PDF，可能是登录页面或文件已失效。请重新打开文件。');
  }
  return parsePdfBytes(bytes, signal);
}

export function pdfTextSegment(document: PdfText, offset = 0, limit = 6000) {
  if (!Number.isInteger(offset) || offset < 0 || offset > document.text.length) throw new Error('PDF 正文偏移无效，请从 text_offset=0 重新读取。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('PDF 单段最多读取 20000 字。');
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(document.text[offset] ?? '') && /[\uD800-\uDBFF]/.test(document.text[offset - 1] ?? '')) offset--;
  let end = Math.min(offset + limit, document.text.length);
  if (end < document.text.length && /[\uD800-\uDBFF]/.test(document.text[end - 1] ?? '')) end--;
  if (end === offset && end < document.text.length) end = Math.min(end + 2, document.text.length);
  const text = document.text.slice(offset, end);
  const preceding = document.text.slice(0, offset).match(/\[第 (\d+) 页\]/g)?.at(-1);
  return { text, textOffset: offset, nextOffset: end < document.text.length ? end : null, totalTextChars: document.text.length, precedingPage: preceding };
}
