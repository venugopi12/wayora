import { useSyncExternalStore } from 'react';

/*
 * Connection state (docs/pwa.md#offline). `navigator.onLine === false` is
 * reliable (no network at all); `true` only means "some network", so requests
 * can still fail and pages handle that as before.
 */

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** True while the browser reports no network connection. */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, isOffline, () => false);
}
