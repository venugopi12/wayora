import { vi } from 'vitest';
import {
  ROLE_PERMISSIONS,
  adminReviewListSchema,
  adminReviewSchema,
  adminReviewSubjectsSchema,
  bookingReviewStateSchema,
  destinationReviewStateSchema,
  ownReviewListSchema,
  ownReviewSchema,
  reviewListSchema,
  reviewMetricsSchema,
  type AdminReview,
  type BookingReviewState,
  type OwnReview,
  type PublicReview,
  type RatingSummary,
  type ReviewSubject,
  type UserRole,
} from '@wayora/contracts';

/*
 * A stand-in for the reviews API (Phase 28), installed over another fake's
 * `fetch`. Responses are validated against the shared contract. The
 * server's own rules (eligibility, aggregates, moderation) are tested in
 * apps/api; this fake only answers with what it was given.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, status = 200) =>
  json(status, { data, meta: { requestId: 'req-reviews' } });
const fail = (status: number, code: string, message: string, details: unknown[] = []) =>
  json(status, { error: { code, message, details, requestId: 'req-reviews' } });

export const HOTEL: ReviewSubject = { type: 'hotel', key: 'demo-hotels:goa-casa-lagoa' };
export const REVIEW_ID = '01890000-0000-7000-8000-00000000c001';
const T0 = '2026-11-01T10:00:00.000Z';

export function publicReview(i: number, over: Partial<PublicReview> = {}): PublicReview {
  return {
    id: `01890000-0000-7000-8000-${String(0xd000 + i).padStart(12, '0')}`,
    subject: { type: 'destination', key: 'goa' },
    author: ['Asha R.', 'Ravi K.', 'Lena', 'Kabir S.'][i % 4]!,
    verification: 'unverified',
    rating: 4,
    aspects: {},
    title: `Review number ${i}`,
    body: 'Lovely beaches, friendly people and plenty to do in the evenings.',
    travelled: null,
    visitedMonth: null,
    publishedAt: T0,
    edited: false,
    helpful: 0,
    viewer: null,
    ...over,
  };
}

export function summaryOf(subject: ReviewSubject, items: PublicReview[]): RatingSummary {
  const distribution = [1, 2, 3, 4, 5].map(
    (r) => items.filter((i) => i.rating === r).length,
  ) as RatingSummary['distribution'];
  const count = items.length;
  const sum = items.reduce((a, i) => a + i.rating, 0);
  return {
    subject,
    count,
    average: count >= 3 ? Math.round((sum * 10) / count) / 10 : null,
    distribution,
    aspects:
      subject.type === 'hotel'
        ? (['cleanliness', 'location', 'service', 'comfort', 'value'] as const).map((aspect) => ({
            aspect,
            count: 0,
            average: null,
          }))
        : [],
    byVerification: {
      verified_booking: items.filter((i) => i.verification === 'verified_booking').length,
      demo_booking: items.filter((i) => i.verification === 'demo_booking').length,
      unverified: items.filter((i) => i.verification === 'unverified').length,
    },
    minimumForAverage: 3,
  };
}

export function ownReview(over: Partial<OwnReview> = {}): OwnReview {
  return ownReviewSchema.parse({
    ...publicReview(1, { subject: HOTEL, verification: 'demo_booking' }),
    id: REVIEW_ID,
    subjectName: 'Casa Lagoa (demo), Goa',
    status: 'pending',
    moderationNote: null,
    bookingReference: 'WYD-7KQ2-M9XD',
    travelled: { from: '2026-10-20', to: '2026-10-23' },
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    publishedAt: null,
    editableUntil: '2026-12-01T10:00:00.000Z',
    ...over,
  });
}

export interface FakeReviewsOptions {
  /** Published reviews per subject key. */
  published?: Record<string, PublicReview[]>;
  mine?: OwnReview[];
  bookingStates?: BookingReviewState[];
}

export function installFakeReviewsApi(options: FakeReviewsOptions = {}) {
  const next = globalThis.fetch;
  const published = options.published ?? {};
  const mine = [...(options.mine ?? [])];
  const states = options.bookingStates ?? [];
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/reviews')) return next(input, init);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method === 'GET') reads.push(`${path}${url.search}`);
      else writes.push({ method, path, body });

      if (path === '/reviews' && method === 'GET') {
        const type = url.searchParams.get('type')!;
        const key = url.searchParams.get('key')!;
        const all = published[key] ?? [];
        const sort = url.searchParams.get('sort') ?? 'recent';
        const rating = Number(url.searchParams.get('rating') ?? 0);
        const page = Number(url.searchParams.get('page') ?? 1);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
        let items = rating ? all.filter((r) => r.rating === rating) : [...all];
        if (sort === 'highest') items.sort((a, b) => b.rating - a.rating);
        if (sort === 'lowest') items.sort((a, b) => a.rating - b.rating);
        const total = items.length;
        items = items.slice((page - 1) * pageSize, page * pageSize);
        return ok(
          reviewListSchema.parse({
            summary: summaryOf({ type: type as ReviewSubject['type'], key }, all),
            items,
            pagination: {
              page,
              pageSize,
              totalResults: total,
              totalPages: Math.ceil(total / pageSize),
            },
          }),
        );
      }
      if (path === '/reviews/mine') {
        return ok(
          ownReviewListSchema.parse({
            items: mine,
            pagination: {
              page: 1,
              pageSize: 20,
              totalResults: mine.length,
              totalPages: mine.length ? 1 : 0,
            },
          }),
        );
      }
      const own = /^\/reviews\/mine\/(.+)$/.exec(path);
      if (own) {
        const r = mine.find((m) => m.id === own[1]);
        return r ? ok(r) : fail(404, 'NOT_FOUND', "We couldn't find that review.");
      }
      if (path === '/reviews/bookings') return ok({ items: states });
      const bookingState = /^\/reviews\/bookings\/(.+)$/.exec(path);
      if (bookingState) {
        const s = states.find((b) => b.bookingReference === decodeURIComponent(bookingState[1]!));
        return s
          ? ok(bookingReviewStateSchema.parse(s))
          : fail(404, 'NOT_FOUND', "We couldn't find that booking in your trips.");
      }
      const destination = /^\/reviews\/destinations\/(.+)$/.exec(path);
      if (destination) {
        const slug = destination[1]!;
        const existing = mine.find(
          (m) => m.subject.type === 'destination' && m.subject.key === slug,
        );
        return ok(
          destinationReviewStateSchema.parse({
            destination: slug,
            name: slug.charAt(0).toUpperCase() + slug.slice(1),
            reviewId: existing?.id ?? null,
          }),
        );
      }
      if (path === '/reviews' && method === 'POST') {
        if (String(body.body ?? '').includes('server says no')) {
          return fail(400, 'VALIDATION_FAILED', 'The request is invalid.', [
            { path: 'body.body', message: 'Remove control characters.', code: 'custom' },
          ]);
        }
        const created = ownReview({
          rating: Number(body.rating),
          title: String(body.title).trim(),
          body: String(body.body).trim(),
          aspects: body.aspects as OwnReview['aspects'],
        });
        mine.unshift(created);
        return ok(created, 201);
      }
      const patch = /^\/reviews\/([^/]+)$/.exec(path);
      if (patch && method === 'PATCH') {
        const i = mine.findIndex((m) => m.id === patch[1]);
        if (i < 0) return fail(404, 'NOT_FOUND', "We couldn't find that review.");
        if (body.revision !== mine[i]!.revision)
          return fail(409, 'CONFLICT', 'This review changed since you opened it.');
        mine[i] = ownReview({
          ...mine[i],
          rating: Number(body.rating),
          title: String(body.title),
          body: String(body.body),
          status: 'pending',
          revision: mine[i]!.revision + 1,
          edited: true,
        });
        return ok(mine[i]);
      }
      const helpful = /^\/reviews\/([^/]+)\/helpful$/.exec(path);
      if (helpful) return ok({ helpful: method === 'PUT' ? 1 : 0, votedHelpful: method === 'PUT' });
      if (/^\/reviews\/[^/]+\/reports$/.test(path)) {
        return ok({ reported: true }, 201);
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { writes, reads, mine };
}

// ─── Admin ────────────────────────────────────────────────────────────────

export function adminReview(over: Partial<AdminReview> = {}): AdminReview {
  return adminReviewSchema.parse({
    id: REVIEW_ID,
    subject: HOTEL,
    subjectName: 'Casa Lagoa (demo), Goa',
    status: 'pending',
    verification: 'demo_booking',
    rating: 2,
    title: 'Noisy at night',
    author: 'Asha Rao',
    openReports: 1,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    authorId: '01890000-0000-7000-8000-000000000002',
    aspects: { cleanliness: 3 },
    body: 'The room was fine but the bar next door played music until 2 am.',
    bookingReference: 'WYD-7KQ2-M9XD',
    bookingStatus: 'confirmed',
    travelled: { from: '2026-10-20', to: '2026-10-23' },
    visitedMonth: null,
    helpful: 0,
    publishedAt: null,
    moderationNote: null,
    revisions: [
      {
        revision: 1,
        rating: 2,
        aspects: { cleanliness: 3 },
        title: 'Noisy at night',
        body: 'The room was fine but the bar next door played music until 2 am.',
        createdAt: T0,
      },
    ],
    history: [
      {
        at: T0,
        actor: { kind: 'author', name: 'Author' },
        event: 'submitted',
        from: null,
        to: 'pending',
        reason: null,
      },
    ],
    reports: [
      {
        id: '01890000-0000-7000-8000-00000000e001',
        reason: 'irrelevant',
        details: 'About the bar, not the hotel.',
        status: 'open',
        createdAt: T0,
        resolvedAt: null,
      },
    ],
    allowed: {
      actions: ['publish', 'reject', 'flag', 'remove'],
      dismissReports: true,
      ownReview: false,
    },
    ...over,
  });
}

/** Admin review endpoints over the admin fake, with the role's real permissions. */
export function installFakeAdminReviewsApi(role: UserRole, over: Partial<AdminReview> = {}) {
  const next = globalThis.fetch;
  const can = (p: string) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(p);
  let current = adminReview({
    ...(can('admin.reviews.remove')
      ? {}
      : {
          allowed: {
            actions: ['publish', 'reject', 'flag'],
            dismissReports: true,
            ownReview: false,
          },
        }),
    ...over,
  });
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/v1', '');
      if (!path.startsWith('/admin/reviews')) return next(input, init);
      const method = init?.method ?? 'GET';
      if (!can(method === 'GET' ? 'admin.reviews.read' : 'admin.reviews.moderate')) {
        return fail(403, 'FORBIDDEN', 'You don’t have access to this.');
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method !== 'GET') writes.push({ path, body });
      const page = { page: 1, pageSize: 25, totalResults: 1, totalPages: 1 };
      if (path === '/admin/reviews/metrics') {
        return ok(
          reviewMetricsSchema.parse({
            range: url.searchParams.get('range') ?? '30d',
            generatedAt: T0,
            byStatus: { pending: 4, published: 12, rejected: 2, flagged: 1, removed: 1 },
            publishedByVerification: { verified_booking: 0, demo_booking: 7, unverified: 5 },
            openReports: 3,
            reviewsWithOpenReports: 2,
            pending: { count: 4, oldestAt: T0, olderThan48h: 1 },
            distribution: [1, 1, 2, 3, 5],
            submissions: [{ day: '2026-11-01', count: 4 }],
            moderators: [{ name: 'Meera Admin', decisions: 9, published: 7 }],
          }),
        );
      }
      if (path === '/admin/reviews/subjects') {
        return ok(
          adminReviewSubjectsSchema.parse({
            items: [
              {
                subject: HOTEL,
                subjectName: 'Casa Lagoa (demo), Goa',
                published: 2,
                average: null,
                pending: 1,
                flagged: 0,
              },
            ],
            pagination: page,
          }),
        );
      }
      if (path === '/admin/reviews') {
        return ok(
          adminReviewListSchema.parse({
            items: [
              {
                id: current.id,
                subject: current.subject,
                subjectName: current.subjectName,
                status: current.status,
                verification: current.verification,
                rating: current.rating,
                title: current.title,
                author: 'Asha R.',
                openReports: current.openReports,
                revision: current.revision,
                createdAt: current.createdAt,
                updatedAt: current.updatedAt,
              },
            ],
            pagination: page,
          }),
        );
      }
      if (path === `/admin/reviews/${REVIEW_ID}` && method === 'GET') return ok(current);
      if (path === `/admin/reviews/${REVIEW_ID}/moderate`) {
        const to = { publish: 'published', reject: 'rejected', flag: 'flagged', remove: 'removed' }[
          String(body.action) as 'publish'
        ] as AdminReview['status'];
        current = adminReview({
          ...current,
          status: to,
          revision: current.revision + 1,
          openReports: 0,
          allowed: {
            ...current.allowed,
            actions: to === 'removed' ? [] : current.allowed.actions,
            dismissReports: false,
          },
        });
        return ok(current);
      }
      return fail(404, 'NOT_FOUND', 'Not found.');
    }),
  );
  return { writes };
}
