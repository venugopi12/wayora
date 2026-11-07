import { vi } from 'vitest';
import {
  ROLE_PERMISSIONS,
  adminContentListSchema,
  adminContentSchema,
  contentStatsSchema,
  popularDestinationsSchema,
  publicContentListSchema,
  publicContentSchema,
  type AdminContent,
  type PopularDestinations,
  type PublicContent,
  type UserRole,
} from '@wayora/contracts';

/*
 * A stand-in for the content API (Phase 29), installed over another fake's
 * `fetch` (or over a rejecting fetch for public pages). Responses are
 * validated against the shared contract; the server's rules (publishing
 * checks, revisions, permissions) are tested in apps/api.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, status = 200) =>
  json(status, { data, meta: { requestId: 'req-content' } });
const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, details: [], requestId: 'req-content' } });

export const CONTENT_ID = '01890000-0000-7000-8000-00000000e001';

export interface FakeContentOptions {
  published?: PublicContent[];
  popular?: PopularDestinations;
}

export function installFakeContentApi(options: FakeContentOptions = {}) {
  const next = globalThis.fetch;
  const published = options.published ?? [];
  const events: unknown[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (path === '/analytics/events') {
        events.push({ body: JSON.parse(String(init?.body)), credentials: init?.credentials });
        return ok({ counted: true }, 202);
      }
      if (path === '/discover/popular') {
        return ok(
          popularDestinationsSchema.parse(
            options.popular ?? {
              basis: 'destination_page_views',
              days: 30,
              minimumViews: 20,
              items: [],
            },
          ),
        );
      }
      if (!path.startsWith('/content')) return next(input, init);
      reads.push(`${path}${url.search}`);
      const entry = path.match(/^\/content\/(guides|collections|explore)\/([^/]+)$/);
      if (entry) {
        const found = published.find((c) => c.path === `/${entry[1]}/${entry[2]}`);
        return found ? ok(publicContentSchema.parse(found)) : fail(404, 'NOT_FOUND', 'Not found.');
      }
      if (path === '/content') {
        const type = url.searchParams.get('type');
        const destination = url.searchParams.get('destination');
        const items = published.filter(
          (c) =>
            (!type ||
              (type === 'guides'
                ? ['guide', 'article', 'tip'].includes(c.type)
                : c.type === type)) &&
            (!destination || c.destinations.includes(destination)),
        );
        return ok(
          publicContentListSchema.parse({
            items: items.map(({ body, ...rest }) =>
              rest.type === 'faq' ? { ...rest, body } : rest,
            ),
            pagination: { page: 1, pageSize: 20, totalResults: items.length, totalPages: 1 },
          }),
        );
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { events, reads };
}

export function adminEntry(preview: PublicContent, over: Partial<AdminContent> = {}): AdminContent {
  return adminContentSchema.parse({
    id: CONTENT_ID,
    type: preview.type,
    slug: preview.slug,
    path: preview.path,
    title: preview.title,
    status: 'draft',
    revision: 2,
    author: 'Asha R.',
    editor: 'Asha R.',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    publishedAt: null,
    views30d: 0,
    fields: {
      type: preview.type,
      slug: preview.slug,
      title: preview.title,
      summary: preview.summary,
      body: preview.body,
      cover: preview.cover ? { media: 'destination-goa', alt: preview.cover.alt } : null,
      seoTitle: preview.seoTitle,
      metaDescription: preview.metaDescription,
      destinations: preview.destinations,
      related: [],
    },
    problems: [],
    firstPublishedAt: null,
    archivedAt: null,
    revisions: [
      {
        revision: 2,
        status: 'draft',
        title: preview.title,
        editor: 'Asha R.',
        note: null,
        createdAt: '2026-11-02T09:00:00.000Z',
      },
      {
        revision: 1,
        status: 'draft',
        title: preview.title,
        editor: 'Asha R.',
        note: null,
        createdAt: '2026-11-01T09:00:00.000Z',
      },
    ],
    preview,
    allowed: { edit: true, publish: true },
    ...over,
  });
}

/** The admin content endpoints, with permissions from the role (as the server enforces them). */
export function installFakeAdminContentApi(role: UserRole, entry: AdminContent) {
  const next = globalThis.fetch;
  const can = (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
  let current = adminContentSchema.parse({
    ...entry,
    allowed: { edit: can('admin.content.edit'), publish: can('admin.content.publish') },
  });
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/admin/content')) return next(input, init);
      const method = init?.method ?? 'GET';
      const needed =
        method === 'GET'
          ? 'admin.content.read'
          : path.endsWith('/status')
            ? 'admin.content.publish'
            : 'admin.content.edit';
      if (!can(needed)) return fail(403, 'FORBIDDEN', 'You don’t have access to this.');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method !== 'GET') writes.push({ method, path, body });

      if (path === '/admin/content/stats') {
        return ok(
          contentStatsSchema.parse({
            days: 30,
            totals: [{ event: 'destination_view', count: 42 }],
            topDestinations: [{ key: 'goa', count: 30 }],
            topContent: [],
            searchClicks: [{ key: 'goa:hotels', count: 4 }],
          }),
        );
      }
      if (path === '/admin/content' && method === 'GET') {
        const {
          fields: _f,
          problems: _p,
          revisions: _r,
          preview: _v,
          allowed: _a,
          firstPublishedAt: _fp,
          archivedAt: _ar,
          ...summary
        } = current;
        return ok(
          adminContentListSchema.parse({
            items: [summary],
            pagination: { page: 1, pageSize: 25, totalResults: 1, totalPages: 1 },
          }),
        );
      }
      if (path === `/admin/content/${CONTENT_ID}` && method === 'GET') return ok(current);
      if (path === `/admin/content/${CONTENT_ID}` && method === 'PATCH') {
        const { revision: _revision, ...changes } = body;
        current = adminContentSchema.parse({
          ...current,
          revision: current.revision + 1,
          title: changes.title,
          fields: { ...current.fields, ...changes, type: current.type },
        });
        return ok(current);
      }
      if (path === `/admin/content/${CONTENT_ID}/status`) {
        const action = body.action as string;
        current = adminContentSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: action === 'publish' ? 'published' : action === 'archive' ? 'archived' : 'draft',
          ...(action === 'publish'
            ? {
                publishedAt: '2026-11-07T10:00:00.000Z',
                firstPublishedAt: '2026-11-07T10:00:00.000Z',
              }
            : {}),
        });
        return ok(current);
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { writes, current: () => current };
}
