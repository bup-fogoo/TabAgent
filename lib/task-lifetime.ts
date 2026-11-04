import { browser } from 'wxt/browser';

/** Long model requests may be silent beyond MV3's idle timeout. Keep only the
 * current user task alive; the idle background must remain free to suspend.
 * https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive
 */
export function keepTaskAlive(signal: AbortSignal): () => void {
  if (signal.aborted || browser.runtime.getManifest().manifest_version !== 3) return () => {};
  let stopped = false;
  const pulse = () => {
    if (stopped || signal.aborted) return;
    // The API call resets Chrome's inactivity timer. Its value is unused.
    // Extension shutdown may reject it; never create an unhandled rejection.
    try { void browser.runtime.getPlatformInfo().catch(() => {}); } catch { /* Context was invalidated. */ }
  };
  const timer = setInterval(pulse, 20_000);
  const release = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener('abort', release);
  };
  signal.addEventListener('abort', release, { once: true });
  pulse();
  return release;
}
