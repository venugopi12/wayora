/*
 * Push message format (docs/pwa.md#push). Shared by the service worker and
 * tests; the API builds the same shape (apps/worker, push channel).
 */

export interface PushPayload {
  title: string;
  body: string;
  /** A path on this site to open when the notification is clicked. */
  url: string;
  /** One per notification, so a repeated delivery replaces instead of duplicating. */
  tag: string;
}

const DEFAULT_TARGET = '/notifications';

/** Only paths on this site: never another origin, a protocol-relative URL or a script URL. */
export function notificationTarget(url: unknown): string {
  if (typeof url !== 'string') return DEFAULT_TARGET;
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return DEFAULT_TARGET;
  return url.slice(0, 500);
}

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export function parsePushPayload(raw: string): PushPayload | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const title = text(data.title, 120);
  const tag = text(data.tag, 120);
  if (!title || !tag) return null;
  return {
    title,
    body: text(data.body, 400) ?? '',
    url: notificationTarget(data.url),
    tag,
  };
}
