import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appManifest, shellAssets, shellPrecacheTransform, THEME_COLOR } from '../config/pwa';
import { RECENT_SEARCHES_KEY } from '../src/features/search/recent-key';
import { ApiClientError, createApiClient } from '../src/lib/api-client';
import { createQueryClient } from '../src/lib/query-client';
import {
  CACHE_NAMES,
  CACHE_VERSION,
  PUBLIC_API_PATTERNS,
  classify,
  isCurrentCache,
  mayStore,
} from '../src/pwa/cache-policy';
import {
  DISMISS_DAYS,
  installMethod,
  recentlyDismissed,
  rememberDismissal,
  resetInstallState,
} from '../src/pwa/install';
import { notificationTarget, parsePushPayload } from '../src/pwa/push-payload';
import { base64UrlToBytes, pushAvailability } from '../src/pwa/push';
import { forgetDeviceData } from '../src/pwa/device-data';

/*
 * PWA building blocks (docs/pwa.md): the manifest, what the service worker
 * may cache, offline protection for changes, install detection, push
 * message handling, and what a shared device forgets on sign-out.
 */

const PUBLIC = resolve(__dirname, '../public');
const SITE = 'https://www.wayora.example';
const API = 'https://api.wayora.example';
const ctx = { origin: SITE, apiOrigin: API };
const nav = (path: string) => ({ url: `${SITE}${path}`, method: 'GET', mode: 'navigate' });
const get = (url: string) => ({ url, method: 'GET', mode: 'cors' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetInstallState();
});

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('web app manifest', () => {
  it('has what browsers need to install the app', () => {
    expect(appManifest).toMatchObject({
      id: '/',
      name: expect.stringContaining('Wayora'),
      short_name: 'Wayora',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: THEME_COLOR,
      background_color: THEME_COLOR,
    });
    expect(appManifest.short_name!.length).toBeLessThanOrEqual(12);
    // start_url and every shortcut are inside the scope.
    for (const url of [appManifest.start_url!, ...appManifest.shortcuts!.map((s) => s.url)]) {
      expect(url.startsWith(appManifest.scope!)).toBe(true);
    }
  });

  it('lists 192 and 512 icons and a maskable one, and every icon file exists at its size', () => {
    const icons = appManifest.icons!;
    const sizes = icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']),
    );
    for (const icon of [...icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
      const file = resolve(PUBLIC, icon.src.slice(1));
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = icon.sizes!.split('x').map(Number);
      expect(pngSize(file)).toEqual({ width: w, height: h });
    }
  });

  it('index.html links the manifest prerequisites and keeps zoom available', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain(`name="theme-color" content="${THEME_COLOR}"`);
  });

  it('ships an offline page that works without the app', () => {
    const html = readFileSync(resolve(PUBLIC, 'offline.html'), 'utf8');
    expect(html).toContain("<h1>You're offline</h1>");
    expect(html).toContain('noindex');
    expect(html).toMatch(/nothing is queued/i);
    // No inline scripts (the site's CSP allows only same-origin script files).
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).toContain('<script src="/offline.js"></script>');
  });
});

describe('precache', () => {
  it('keeps only the start-up page’s assets, plus icons and the offline page', () => {
    const html =
      '<script type="module" src="/assets/index-1.js"></script><link rel="modulepreload" href="/assets/react-2.js"><link rel="stylesheet" href="/assets/index-3.css">';
    expect([...shellAssets(html)]).toEqual([
      'assets/index-1.js',
      'assets/react-2.js',
      'assets/index-3.css',
    ]);
    const all = [
      { url: 'assets/index-1.js', revision: null, size: 1 },
      { url: 'assets/react-2.js', revision: null, size: 1 },
      { url: 'assets/admin-9.js', revision: null, size: 1 },
      { url: 'icons/icon-192.png', revision: 'r1', size: 1 },
      { url: 'offline.html', revision: 'r2', size: 1 },
    ];
    // Without the built index.html: everything, with a warning.
    expect(shellPrecacheTransform(mkdtempSync(join(tmpdir(), 'pwa-')))(all).warnings).toHaveLength(
      1,
    );
    const dir = mkdtempSync(join(tmpdir(), 'pwa-'));
    writeFileSync(join(dir, 'index.html'), html);
    const { manifest, warnings } = shellPrecacheTransform(dir)(all);
    expect(warnings).toEqual([]);
    expect(manifest.map((e) => e.url)).toEqual([
      'assets/index-1.js',
      'assets/react-2.js',
      'icons/icon-192.png',
      'offline.html',
    ]);
  });
});

describe('cache policy', () => {
  it('never handles changes (no caching, no queueing)', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(classify({ url: `${API}/api/v1/bookings`, method }, ctx).kind).toBe('bypass');
      expect(classify({ url: `${API}/api/v1/payments/x`, method }, ctx).kind).toBe('bypass');
    }
  });

  it('never caches personal API answers', () => {
    for (const path of [
      '/api/v1/auth/session',
      '/api/v1/bookings',
      '/api/v1/bookings/WYD-1',
      '/api/v1/payments/p1',
      '/api/v1/notifications',
      '/api/v1/notifications/preferences',
      '/api/v1/rewards',
      '/api/v1/profile',
      '/api/v1/admin/content',
      '/api/v1/support/tickets',
      '/api/v1/planner/trips',
      '/api/v1/assistant/conversations',
      '/api/v1/search/flights',
    ]) {
      expect(classify(get(`${API}${path}`), ctx).kind, path).toBe('bypass');
    }
  });

  it('caches public API reads only (published content, popular destinations, catalogue)', () => {
    for (const path of [
      '/api/v1/content?destination=goa',
      '/api/v1/content/guides/goa-in-monsoon',
      '/api/v1/discover/popular',
      '/api/v1/catalog/categories',
    ]) {
      expect(classify(get(`${API}${path}`), ctx).kind, path).toBe('public-api');
    }
    expect(classify(get(`${API}/api/v1/content/feed`), ctx).kind).toBe('bypass');
    expect(PUBLIC_API_PATTERNS.length).toBe(4);
  });

  it('caches public pages, never private ones', () => {
    for (const path of ['/', '/discover/goa', '/guides/x', '/help/articles/cookies', '/flights']) {
      expect(classify(nav(path), ctx).kind, path).toBe('public-page');
    }
    for (const path of [
      '/trips',
      '/trips/WYD-1',
      '/trips/WYD-1/pay',
      '/book/flights/r1',
      '/profile',
      '/notifications',
      '/admin',
      '/login',
      '/offers/hotels/x',
      '/support/new',
      '/rewards',
    ]) {
      expect(classify(nav(path), ctx).kind, path).toBe('private-page');
    }
  });

  it('assets cache first, images refresh in the background, other files pass through', () => {
    expect(classify(get(`${SITE}/assets/index-abc.js`), ctx).kind).toBe('asset');
    expect(classify(get(`${SITE}/media/artwork/destination-goa.svg`), ctx).kind).toBe('media');
    expect(classify(get(`${SITE}/icons/icon-192.png`), ctx).kind).toBe('media');
    for (const path of ['/sw.js', '/manifest.webmanifest', '/sitemap.xml', '/robots.txt']) {
      expect(classify(get(`${SITE}${path}`), ctx).kind, path).toBe('bypass');
    }
    expect(classify(get('https://cdn.other.example/x.js'), ctx).kind).toBe('bypass');
  });

  it('stores only successful, shareable responses (respecting the server)', () => {
    const res = (status: number, headers: Record<string, string> = {}, type = 'basic') => ({
      status,
      type,
      headers: new Headers(headers),
    });
    const api = { kind: 'public-api' } as const;
    expect(mayStore(api, res(200, { 'Cache-Control': 'public, max-age=60' }))).toBe(true);
    expect(mayStore(api, res(200, {}))).toBe(false);
    expect(mayStore(api, res(200, { 'Cache-Control': 'no-store' }))).toBe(false);
    expect(mayStore(api, res(200, { 'Cache-Control': 'public', 'Set-Cookie': 'a=b' }))).toBe(false);
    expect(mayStore(api, res(404, { 'Cache-Control': 'public' }))).toBe(false);
    const page = { kind: 'public-page' } as const;
    expect(mayStore(page, res(200, { 'Cache-Control': 'no-cache' }))).toBe(true);
    expect(mayStore(page, res(200, { 'Cache-Control': 'private' }))).toBe(false);
    expect(mayStore(page, res(200, {}, 'opaqueredirect'))).toBe(false);
    expect(mayStore({ kind: 'private-page' }, res(200))).toBe(false);
  });

  it('versions every cache, so a new version drops the old ones', () => {
    for (const name of Object.values(CACHE_NAMES)) {
      expect(name.startsWith('wayora-')).toBe(true);
      expect(name.endsWith(`-${CACHE_VERSION}`)).toBe(true);
      expect(isCurrentCache(name)).toBe(true);
    }
    expect(isCurrentCache('wayora-pages-v0')).toBe(false);
  });
});

describe('offline protection for changes', () => {
  it('a change made offline is refused at once, with nothing sent', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchImpl = vi.fn();
    const client = createApiClient('https://api.example', { fetchImpl });
    const error = await client
      .request('/bookings', { method: 'POST', body: {}, schema: z.object({}) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('OFFLINE');
    expect((error as ApiClientError).message).toMatch(/nothing was sent/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('React Query runs changes now (never pauses them to send on reconnecting)', async () => {
    const client: QueryClient = createQueryClient();
    expect(client.getDefaultOptions().mutations?.networkMode).toBe('always');
  });
});

describe('install offer', () => {
  const fakeWindow = (
    ua: string,
    opts: { standalone?: boolean; display?: boolean; touch?: number } = {},
  ) =>
    ({
      navigator: { userAgent: ua, standalone: opts.standalone, maxTouchPoints: opts.touch ?? 0 },
      matchMedia: () => ({ matches: opts.display ?? false }),
    }) as unknown as Window;
  const IOS_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const IOS_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

  it('uses the browser prompt when offered, manual steps on Safari, nothing elsewhere', () => {
    expect(installMethod(fakeWindow(ANDROID_CHROME), true)).toBe('prompt');
    // No prompt event (yet): no button that would do nothing.
    expect(installMethod(fakeWindow(ANDROID_CHROME), false)).toBe('unsupported');
    expect(installMethod(fakeWindow(IOS_SAFARI), false)).toBe('ios-share');
    expect(installMethod(fakeWindow(IOS_CHROME), false)).toBe('unsupported');
    expect(installMethod(fakeWindow(MAC_SAFARI), false)).toBe('mac-safari');
    expect(installMethod(fakeWindow(FIREFOX), false)).toBe('unsupported');
  });

  it('offers nothing once installed (standalone)', () => {
    expect(installMethod(fakeWindow(IOS_SAFARI, { standalone: true }), false)).toBe('installed');
    expect(installMethod(fakeWindow(ANDROID_CHROME, { display: true }), true)).toBe('installed');
  });

  it('remembers a dismissal for 30 days', () => {
    const now = Date.UTC(2026, 10, 9);
    expect(recentlyDismissed(now)).toBe(false);
    rememberDismissal(now);
    expect(recentlyDismissed(now + 86_400_000)).toBe(true);
    expect(recentlyDismissed(now + (DISMISS_DAYS + 1) * 86_400_000)).toBe(false);
  });
});

describe('push messages', () => {
  it('parses what the server sends and keeps clicks on this site', () => {
    expect(
      parsePushPayload(
        JSON.stringify({
          title: 'Demo booking confirmed',
          body: 'B',
          url: '/trips/WYD-1',
          tag: 'wayora-1',
        }),
      ),
    ).toEqual({ title: 'Demo booking confirmed', body: 'B', url: '/trips/WYD-1', tag: 'wayora-1' });
    expect(parsePushPayload('not json')).toBeNull();
    expect(parsePushPayload(JSON.stringify({ title: 'No tag' }))).toBeNull();
    for (const bad of [
      'https://evil.example/',
      '//evil.example/x',
      'javascript:alert(1)',
      '/\\evil',
      42,
      null,
    ]) {
      expect(notificationTarget(bad)).toBe('/notifications');
    }
    expect(notificationTarget('/support/SUP-1')).toBe('/support/SUP-1');
  });

  it('decodes the VAPID public key for the browser', () => {
    const bytes = base64UrlToBytes('BAEC_-8');
    expect([...bytes]).toEqual([4, 1, 2, 255, 239]);
  });

  it('says when this browser can’t do push, instead of pretending', () => {
    const w = (ua: string, extra: Record<string, unknown> = {}) =>
      ({
        navigator: { userAgent: ua, serviceWorker: {}, ...extra },
        isSecureContext: true,
        ...extra,
      }) as unknown as Window;
    expect(pushAvailability(w('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'))).toBe(
      'ios-needs-install',
    );
    expect(pushAvailability(w('Mozilla/5.0 (X11; Linux x86_64)'))).toBe('unsupported');
    expect(
      pushAvailability(
        w('Mozilla/5.0 (X11; Linux x86_64)', {
          PushManager: {},
          Notification: { permission: 'denied' },
        }),
      ),
    ).toBe('denied');
    expect(
      pushAvailability(
        w('Mozilla/5.0 (X11; Linux x86_64)', {
          PushManager: {},
          Notification: { permission: 'default' },
        }),
      ),
    ).toBe('available');
  });
});

describe('shared devices', () => {
  it('forgets recent searches and asks the service worker to drop saved copies on sign-out', () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, '{"flights":[]}');
    const postMessage = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage } },
    });
    forgetDeviceData();
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_RUNTIME_CACHES' });
    // @ts-expect-error -- removing the test double
    delete navigator.serviceWorker;
  });
});
