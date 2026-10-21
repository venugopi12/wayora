import { createApiClient } from '../lib/api-client';
import { publicEnv } from '../lib/env';

type Listener = () => void;
const sessionEndedListeners = new Set<Listener>();

/**
 * Subscribe to "the server says this browser is no longer signed in"
 * (a 401 from an authenticated call). The auth provider uses it to drop the
 * cached user, which sends protected pages to /login. Returns an unsubscribe.
 */
export function onSessionEnded(listener: Listener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

/**
 * Same-origin deployments (API behind the web origin) send cookies with
 * `same-origin`; a separate API origin (localhost:4000 in development, an
 * api. subdomain in production) needs `include`. The API only answers
 * credentialed requests from its CORS allow-list, never `*`.
 */
export function credentialsFor(apiBaseUrl: string, pageOrigin?: string): RequestCredentials {
  if (!pageOrigin) return 'include';
  return new URL(apiBaseUrl).origin === pageOrigin ? 'same-origin' : 'include';
}

/** The app-wide API client. Feature services import this; components never call fetch directly. */
export const api = createApiClient(publicEnv.apiBaseUrl, {
  credentials: credentialsFor(
    publicEnv.apiBaseUrl,
    typeof window === 'undefined' ? undefined : window.location.origin,
  ),
  onSessionEnded: () => {
    for (const listener of sessionEndedListeners) listener();
  },
});
