import {
  API_V1_PREFIX,
  adminContentListSchema,
  adminContentSchema,
  contentStatsSchema,
  popularDestinationsSchema,
  publicContentListSchema,
  publicContentSchema,
  type AdminContent,
  type AdminContentList,
  type AdminContentListQuery,
  type AnalyticsEvent,
  type ContentInput,
  type ContentStats,
  type ContentUpdate,
  type PopularDestinations,
  type PublicContent,
  type PublicContentList,
  type PublicContentListQuery,
} from '@wayora/contracts';
import { publicEnv } from '../lib/env';
import { api } from './api';

/*
 * Content (Phase 29, docs/seo.md#api): published guides, collections and
 * landing pages; the admin workspace; first-party page-view counts.
 */

const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

export type ContentSection = 'guides' | 'collections' | 'explore';

export const getPublishedContent = (
  section: ContentSection,
  slug: string,
  signal?: AbortSignal,
): Promise<PublicContent> =>
  api.request(`/content/${section}/${encodeURIComponent(slug)}`, {
    schema: publicContentSchema,
    ...opts(signal),
  });

export const listPublishedContent = (
  params: PublicContentListQuery,
  signal?: AbortSignal,
): Promise<PublicContentList> =>
  api.request(`/content${query(params)}`, { schema: publicContentListSchema, ...opts(signal) });

export const getPopularDestinations = (signal?: AbortSignal): Promise<PopularDestinations> =>
  api.request('/discover/popular', { schema: popularDestinationsSchema, ...opts(signal) });

// ─── First-party counts ──────────────────────────────────────────────────

/** Whether the visitor asked not to be tracked (Do Not Track or Global Privacy Control). */
export function trackingDeclined(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  if (!nav) return true;
  const n = nav as Navigator & { globalPrivacyControl?: boolean; doNotTrack?: string | null };
  return n.globalPrivacyControl === true || n.doNotTrack === '1' || n.doNotTrack === 'yes';
}

/**
 * Adds one to today's total for a page view or click (docs/seo.md#analytics).
 * No cookie, identifier or account is sent (credentials are omitted), nothing
 * is sent when the visitor declined tracking, and failures are ignored.
 */
export function track(event: AnalyticsEvent): void {
  if (trackingDeclined()) return;
  try {
    void fetch(`${publicEnv.apiBaseUrl}${API_V1_PREFIX}/analytics/events`, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(() => undefined);
  } catch {
    // Counting is best effort; never break the page.
  }
}

// ─── Admin ───────────────────────────────────────────────────────────────

export const adminContentList = (
  params: AdminContentListQuery,
  signal?: AbortSignal,
): Promise<AdminContentList> =>
  api.request(`/admin/content${query(params)}`, {
    schema: adminContentListSchema,
    ...opts(signal),
  });

export const adminContent = (id: string, signal?: AbortSignal): Promise<AdminContent> =>
  api.request(`/admin/content/${encodeURIComponent(id)}`, {
    schema: adminContentSchema,
    ...opts(signal),
  });

export const adminCreateContent = (body: ContentInput): Promise<AdminContent> =>
  api.request('/admin/content', { method: 'POST', body, schema: adminContentSchema });

export const adminUpdateContent = (id: string, body: ContentUpdate): Promise<AdminContent> =>
  api.request(`/admin/content/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: adminContentSchema,
  });

export const adminContentStatus = (
  id: string,
  body: { action: 'publish' | 'archive' | 'restore'; revision: number },
): Promise<AdminContent> =>
  api.request(`/admin/content/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body,
    schema: adminContentSchema,
  });

export const adminContentStats = (days: number, signal?: AbortSignal): Promise<ContentStats> =>
  api.request(`/admin/content/stats${query({ days })}`, {
    schema: contentStatsSchema,
    ...opts(signal),
  });
