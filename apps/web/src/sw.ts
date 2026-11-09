/// <reference lib="webworker" />
/*
 * Wayora's service worker (docs/pwa.md#service-worker). Built by
 * vite-plugin-pwa (injectManifest): `self.__WB_MANIFEST` is replaced at build
 * time with the app shell's files and their revisions.
 *
 * What it does:
 * - precaches the app shell (the start-up JavaScript and CSS, icons, the
 *   offline page) and drops older precaches when a new version activates;
 * - caches only what's the same for everyone (src/pwa/cache-policy.ts):
 *   hashed build files, public images, public pages people opened, public API
 *   reads marked `Cache-Control: public`;
 * - never intercepts writes and never caches personal API answers, so nothing
 *   is queued for later and one person's data can't be served to another;
 * - shows push notifications and opens the right page when one is clicked.
 *
 * Updates wait until the page asks (SKIP_WAITING), so an open tab never runs
 * a mix of old and new code.
 */
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import type { WorkboxPlugin } from 'workbox-core/types.js';
import {
  CACHE_LIMITS,
  CACHE_NAMES,
  NETWORK_TIMEOUT_SECONDS,
  OFFLINE_PAGE,
  RUNTIME_CACHE_PREFIX,
  classify,
  isCurrentCache,
  mayStore,
  type Route,
  type WorkerMessage,
} from './pwa/cache-policy';
import { notificationTarget, parsePushPayload } from './pwa/push-payload';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const API_ORIGIN = new URL(import.meta.env.VITE_API_BASE_URL || self.location.origin).origin;
const ctx = { origin: self.location.origin, apiOrigin: API_ORIGIN };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/** Stores a response only when the policy allows it (status, Cache-Control, no cookies). */
const policyPlugin = (kind: Route['kind']): WorkboxPlugin => ({
  cacheWillUpdate: async ({ response }) =>
    mayStore({ kind } as Route, response) ? response : null,
});

const matches =
  (kind: Route['kind']) =>
  ({ request }: { request: Request }) =>
    classify(request, ctx).kind === kind;

registerRoute(
  matches('asset'),
  new CacheFirst({
    cacheName: CACHE_NAMES.assets,
    plugins: [policyPlugin('asset'), new ExpirationPlugin(CACHE_LIMITS.assets)],
  }),
);

registerRoute(
  matches('media'),
  new StaleWhileRevalidate({
    cacheName: CACHE_NAMES.media,
    plugins: [
      policyPlugin('media'),
      new ExpirationPlugin({ ...CACHE_LIMITS.media, purgeOnQuotaError: true }),
    ],
  }),
);

registerRoute(
  matches('public-page'),
  new NetworkFirst({
    cacheName: CACHE_NAMES.pages,
    networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
    plugins: [
      policyPlugin('public-page'),
      new ExpirationPlugin({ ...CACHE_LIMITS.pages, purgeOnQuotaError: true }),
    ],
  }),
);

// Personal or non-public pages: always from the network, never stored.
registerRoute(matches('private-page'), new NetworkOnly());

registerRoute(
  matches('public-api'),
  new NetworkFirst({
    cacheName: CACHE_NAMES.publicApi,
    networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
    fetchOptions: { credentials: 'omit' },
    plugins: [
      policyPlugin('public-api'),
      new ExpirationPlugin({ ...CACHE_LIMITS.publicApi, purgeOnQuotaError: true }),
    ],
  }),
);

// Offline (or failing) navigations get the offline page; anything else fails as it would without us.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const offline = await matchPrecache(OFFLINE_PAGE);
    if (offline) return offline;
  }
  return Response.error();
});

self.addEventListener('install', () => {
  // The first version takes over at once; later ones wait for the page (SKIP_WAITING).
  if (!self.registration.active) void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith(RUNTIME_CACHE_PREFIX) && !isCurrentCache(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data as WorkerMessage | undefined;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (data?.type === 'CLEAR_RUNTIME_CACHES') {
    event.waitUntil(
      Promise.all([caches.delete(CACHE_NAMES.pages), caches.delete(CACHE_NAMES.publicApi)]),
    );
  }
});

// ─── Push notifications (docs/pwa.md#push) ──────────────────────────────

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event.data?.text() ?? '');
  if (!payload) return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // One notification per event: a repeated delivery replaces it instead of adding another.
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    notificationTarget((event.notification.data as { url?: unknown } | null)?.url),
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          await w.focus();
          await w.navigate(target).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
