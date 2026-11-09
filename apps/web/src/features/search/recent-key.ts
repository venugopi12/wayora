/*
 * Where recent searches live in this browser, on its own so sign-out can
 * forget them without loading the search code (pwa/device-data.ts).
 */
export const RECENT_SEARCHES_KEY = 'wayora:recent-searches:v1';

/** Forgets every recent search in this browser (sign-out on a shared device, docs/pwa.md#shared-devices). */
export function clearAllRecentSearches(
  store: Pick<Storage, 'removeItem'> | null = typeof window === 'undefined' ? null : safeStorage(),
): void {
  try {
    store?.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    // Storage unavailable: nothing was saved either.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
