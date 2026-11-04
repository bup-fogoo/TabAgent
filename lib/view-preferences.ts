import { browser } from 'wxt/browser';

// Keep view preferences separate from model settings so saving a connection
// cannot overwrite a toggle changed in an open side panel.
export const FOLLOW_PAGES_KEY = 'tabagent:follow-pages';
export const AUTO_CLOSE_PAGES_KEY = 'tabagent:auto-close-pages';

export async function loadFollowPages(): Promise<boolean> {
  const stored = await browser.storage.local.get(FOLLOW_PAGES_KEY);
  return stored[FOLLOW_PAGES_KEY] !== false;
}

export async function saveFollowPages(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [FOLLOW_PAGES_KEY]: enabled });
}

export async function loadAutoClosePages(): Promise<boolean> {
  const stored = await browser.storage.local.get(AUTO_CLOSE_PAGES_KEY);
  return stored[AUTO_CLOSE_PAGES_KEY] !== false;
}

export async function saveAutoClosePages(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [AUTO_CLOSE_PAGES_KEY]: enabled });
}
