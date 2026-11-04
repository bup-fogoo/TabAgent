import { browser } from 'wxt/browser';
import type { VisionImage } from '@/lib/llm/types';

const MAX_EDGE = 1600;
const MAX_IMAGE_BYTES = 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 12000;
let nextCaptureAt = 0;

function ordinaryCaptureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !(
      url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) ||
      url.hostname === 'addons.mozilla.org' ||
      (url.hostname === 'microsoftedge.microsoft.com' && url.pathname.startsWith('/addons'))
    );
  } catch { return false; }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The browser's capture API targets a window, not a tab. Never activate a tab
 * for a read-only screenshot, and discard it if the visible document changes. */
export async function capturePageScreenshot(tabId: number, signal: AbortSignal): Promise<{ image: VisionImage; title: string; url: string }> {
  signal.throwIfAborted();
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('截图目标无效，请重新选择页面。');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new DOMException('任务已停止', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('网页截图超时，请稍后重试。')), CAPTURE_TIMEOUT_MS);
  const activeSignal = controller.signal;
  let windowId: number | undefined;
  const changed = () => controller.abort(new Error('截图期间页面或窗口已切换，请回到目标页面后重试。'));
  const onActivated = (info: { tabId: number; windowId: number }) => {
    if (info.windowId === windowId) changed();
  };
  const onUpdated = (id: number, info: { url?: string; status?: string; discarded?: boolean }) => {
    if (id === tabId && (info.url !== undefined || info.status === 'loading' || info.discarded === true)) changed();
  };
  const onRemoved = (id: number) => { if (id === tabId) changed(); };
  const onFocusChanged = (id: number) => { if (windowId !== undefined && id !== windowId) changed(); };
  browser.tabs.onActivated.addListener(onActivated);
  browser.tabs.onUpdated.addListener(onUpdated);
  browser.tabs.onRemoved.addListener(onRemoved);
  browser.windows.onFocusChanged.addListener(onFocusChanged);
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(activeSignal.reason);
    activeSignal.addEventListener('abort', rejectAborted, { once: true });
  });
  const inspect = async (expectedUrl?: string) => {
    activeSignal.throwIfAborted();
    const tab = await browser.tabs.get(tabId).catch(() => { throw new Error('截图页面已关闭，请重新选择。'); });
    activeSignal.throwIfAborted();
    if (!ordinaryCaptureUrl(tab.url ?? '')) throw new Error('此页面不支持截图，请选择普通网页。');
    if (tab.status === 'loading' || tab.pendingUrl) throw new Error('页面仍在加载，请加载完成后再截图。');
    if (windowId !== undefined && tab.windowId !== windowId) throw new Error('页面所在窗口已变化，请重新截图。');
    windowId = tab.windowId;
    const [window, tabs] = await Promise.all([
      browser.windows.get(windowId), browser.tabs.query({ active: true, windowId }),
    ]);
    activeSignal.throwIfAborted();
    if (!tab.active || !window.focused || tabs.length !== 1 || tabs[0]?.id !== tabId) {
      throw new Error('请切换到目标网页并保持窗口在前台，再进行截图分析。');
    }
    if (expectedUrl !== undefined && tab.url !== expectedUrl) throw new Error('截图期间页面已跳转，请重新截图。');
    return { title: tab.title || '未命名页面', url: tab.url! };
  };
  const work = async () => {
    const target = await inspect();
    // Chrome allows at most two captures per second. Reserve a slot before the
    // abortable wait so concurrent requests cannot claim the same slot.
    const captureAt = Math.max(Date.now(), nextCaptureAt);
    nextCaptureAt = captureAt + 600;
    if (captureAt > Date.now()) await wait(captureAt - Date.now(), activeSignal);
    await inspect(target.url);
    const dataUrl = await browser.tabs.captureVisibleTab(windowId!, { format: 'jpeg', quality: 80 }).catch(() => {
      activeSignal.throwIfAborted();
      throw new Error('无法截取网页，请保持目标页面可见后重试。');
    });
    activeSignal.throwIfAborted();
    await inspect(target.url);
    const image = await compressScreenshot(dataUrl, activeSignal);
    const latest = await inspect(target.url);
    return { image, ...latest };
  };
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    activeSignal.removeEventListener('abort', rejectAborted);
    browser.tabs.onActivated.removeListener(onActivated);
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.tabs.onRemoved.removeListener(onRemoved);
    browser.windows.onFocusChanged.removeListener(onFocusChanged);
  }
}

/** Use browser image codecs locally; neither the original nor the resized
 * screenshot is persisted. Image data never goes through the text budget. */
async function compressScreenshot(dataUrl: string, signal: AbortSignal): Promise<VisionImage> {
  signal.throwIfAborted();
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2]!.length > 24 * 1024 * 1024) throw new Error('网页截图格式或大小不受支持。');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('当前浏览器不支持截图压缩，请更新浏览器后重试。');
  }
  const bytes = Uint8Array.from(atob(match[2]!), (value) => value.charCodeAt(0));
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: match[1] }));
    signal.throwIfAborted();
    if (!bitmap.width || !bitmap.height) throw new Error('网页截图为空，请重试。');
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    for (let attempt = 0; attempt < 5; attempt++) {
      signal.throwIfAborted();
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法处理网页截图，请重试。');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: attempt ? .68 : .8 });
      signal.throwIfAborted();
      if (blob.size && blob.size <= MAX_IMAGE_BYTES && ['image/jpeg', 'image/png'].includes(blob.type)) {
        const output = new Uint8Array(await blob.arrayBuffer());
        signal.throwIfAborted();
        let binary = '';
        for (let offset = 0; offset < output.length; offset += 8192) binary += String.fromCharCode(...output.subarray(offset, offset + 8192));
        return { mediaType: blob.type as VisionImage['mediaType'], data: btoa(binary), width, height };
      }
      width = Math.max(1, Math.round(width * .75));
      height = Math.max(1, Math.round(height * .75));
    }
    throw new Error('网页截图仍然过大，请缩小浏览器窗口后重试。');
  } finally { bitmap?.close(); }
}
