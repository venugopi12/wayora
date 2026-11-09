import { clearAllRecentSearches } from '../features/search/recent-key';
import { clearRuntimeCaches } from './register';

/*
 * What this device keeps between visits, and when it's forgotten
 * (docs/pwa.md#shared-devices). Personal API answers are never stored by the
 * service worker or the browser (`Cache-Control: no-store`), and React Query's
 * in-memory account data is dropped on sign-out (AuthProvider). On sign-out
 * or when another account signs in, this also drops:
 * - the service worker's saved public pages and API answers (defence in depth),
 * - recent searches (routes and dates typed on this device).
 * Push subscriptions are removed before signing out (features/push).
 */
export function forgetDeviceData(): void {
  clearRuntimeCaches();
  clearAllRecentSearches();
}
