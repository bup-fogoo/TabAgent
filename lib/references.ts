import type { SourceReference } from './protocol';

export function referenceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function validReference(value: unknown): value is SourceReference {
  if (!value || typeof value !== 'object') return false;
  const page = value as SourceReference;
  return typeof page.id === 'string' && page.id.length > 0 && page.id.length <= 100 &&
    typeof page.title === 'string' && page.title.length <= 300 && referenceUrl(page.url) !== null &&
    (page.kind === 'page' || page.kind === 'search');
}
