import { useSyncExternalStore } from 'react';
import type { WorkerMessage } from './cache-policy';

/*
 * Service worker registration and updates (docs/pwa.md#updates).
 *
 * - Production builds only, on secure origins with service worker support.
 *   Development never registers one (and the app works the same without it).
 * - A new version installs in the background and waits. The page offers
 *   "Reload to update"; only then does the new worker take over and the page
 *   reload, so an open tab never mixes old and new code.
 * - If registration fails (old browser, blocked, a broken deploy), the app
 *   carries on without a service worker.
 * - The worker is checked for updates hourly and when the tab comes back.
 */

export type UpdateState = 'none' | 'ready' | 'applying';

let state: UpdateState = 'none';
let applyFn: (() => void) | null = null;
let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<() => void>();
const set = (next: UpdateState) => {
  state = next;
  listeners.forEach((l) => l());
};

export function serviceWorkerSupported(w: Window = window): boolean {
  return 'serviceWorker' in w.navigator && w.isSecureContext;
}

export async function registerServiceWorker(
  url = '/sw.js',
): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported()) return null;
  try {
    const { Workbox } = await import('workbox-window');
    const wb = new Workbox(url, { scope: '/' });
    wb.addEventListener('waiting', () => {
      applyFn = () => {
        set('applying');
        // Reload once the new worker controls the page.
        wb.addEventListener('controlling', () => window.location.reload());
        wb.messageSkipWaiting();
      };
      set('ready');
    });
    registration = (await wb.register()) ?? null;
    const check = () => void registration?.update().catch(() => undefined);
    window.setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    return registration;
  } catch {
    // Unsupported, blocked or a broken deploy: the app works the same without it.
    return null;
  }
}

/** Reloads into the waiting version (after the person chose to). */
export function applyUpdate(): void {
  applyFn?.();
}

/** Asks the active worker to drop saved pages and API answers (sign-out, account change). */
export function clearRuntimeCaches(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const message: WorkerMessage = { type: 'CLEAR_RUNTIME_CACHES' };
  navigator.serviceWorker.controller?.postMessage(message);
}

export function currentRegistration(): ServiceWorkerRegistration | null {
  return registration;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => 'none',
  );
}

/** For tests only. */
export function setUpdateStateForTests(next: UpdateState, apply: (() => void) | null = null): void {
  applyFn = apply;
  set(next);
}
