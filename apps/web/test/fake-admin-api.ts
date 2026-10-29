import { vi } from 'vitest';
import {
  ROLE_PERMISSIONS,
  adminAuditEntrySchema,
  adminBookingDetailSchema,
  adminBookingSummarySchema,
  adminPaymentSummarySchema,
  type AdminAuditEntry,
  type AdminBookingSummary,
  type AdminPaymentSummary,
  adminHealthSchema,
  adminOverviewSchema,
  adminUserDetailSchema,
  adminUserSummarySchema,
  type AdminHealth,
  type AdminOverview,
  type AdminUserSummary,
  type UserRole,
} from '@wayora/contracts';
import { TEST_USER, installFakeAccountApi } from './fake-account-api';

/*
 * The admin endpoints for web tests, on top of the fake account API. It
 * applies the same rule as the server: the role of the signed-in account
 * decides, and a role without the permission gets 403. The API's real
 * authorization is tested in apps/api/test/integration/admin.test.ts.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown) => json(200, { data, meta: { requestId: 'req-admin' } });
const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: 'req-admin' } });

export const OVERVIEW: AdminOverview = adminOverviewSchema.parse({
  range: '7d',
  from: '2026-10-16T10:00:00.000Z',
  to: '2026-10-23T10:00:00.000Z',
  timezone: 'UTC',
  users: { total: 42, newInRange: 5 },
  bookings: {
    total: 17,
    inRange: 6,
    byStatus: { pending: 1, confirmed: 4, cancelled: 1, failed: 0, expired: 0 },
    demo: 6,
    real: 0,
  },
  payments: {
    attemptsInRange: 7,
    byStatus: {
      created: 0,
      pending: 0,
      succeeded: 4,
      failed: 3,
      cancelled: 0,
      refund_pending: 0,
      refunded: 0,
    },
    byMode: { demo: 7, live: 0 },
    realRevenue: {
      totals: [],
      note: 'Succeeded live payments only. Demo payments are never counted.',
    },
  },
  searches: {
    trackedSince: '2026-10-20T08:00:00.000Z',
    inRange: 30,
    byOutcome: { success: 25, partial: 2, empty: 2, failed: 1 },
  },
  conversion: {
    definition: 'Search sessions that led to a booking.',
    searches: 20,
    searchesWithBooking: 5,
    rate: 0.25,
  },
  recent: [
    {
      kind: 'booking',
      bookingReference: 'WYD-ABCD-EFGH',
      status: 'confirmed',
      demo: true,
      at: '2026-10-23T09:00:00.000Z',
    },
  ],
  unavailable: [
    {
      metric: 'Revenue',
      reason: 'No live payment provider is configured. Demo payments are never counted.',
    },
  ],
});

export const HEALTH: AdminHealth = adminHealthSchema.parse({
  checkedAt: '2026-10-23T10:00:00.000Z',
  maxAgeSeconds: 10,
  api: { status: 'up', uptimeSeconds: 3600 },
  database: { status: 'up', latencyMs: 3 },
  redis: { status: 'down', latencyMs: 2000 },
  worker: {
    status: 'unknown',
    lastHeartbeatAt: null,
    note: 'Redis couldn’t be read, so the worker’s heartbeat is unknown.',
  },
  queue: { status: 'unknown', waiting: null, active: null, delayed: null, failed: null },
  outbox: {
    status: 'up',
    pending: 2,
    failed: 0,
    notConfigured: 9,
    oldestPendingAt: '2026-10-23T09:59:00.000Z',
  },
  payments: { status: 'up', inProgress: 0, oldestInProgressAt: null },
  travelStatus: {
    status: 'up',
    providerName: 'Wayora demo status (simulated)',
    simulated: true,
    failedChecksLastHour: 0,
  },
  assistant: {
    status: 'up',
    providerName: 'Wayora demo assistant (rule-based, not AI)',
    simulated: true,
    failedRequestsLastHour: 0,
  },
  searchProviders: [
    {
      id: 'demo-flights',
      name: 'Wayora demo flights',
      kind: 'demo',
      serviceTypes: ['flights'],
      enabled: true,
      disabledReason: null,
      status: 'up',
      breaker: 'closed',
      callsLastHour: 12,
      failedLastHour: 0,
      revalidates: false,
    },
    {
      id: 'demo-hotels',
      name: 'Wayora demo hotels',
      kind: 'demo',
      serviceTypes: ['hotels'],
      enabled: true,
      disabledReason: null,
      status: 'unknown',
      breaker: 'closed',
      callsLastHour: 0,
      failedLastHour: 0,
      revalidates: false,
    },
  ],
});

const REFS = ['WYD-AAAA-AAAA', 'WYD-BBBB-BBBB', 'WYD-CCCC-CCCC'];
export const BOOKINGS: AdminBookingSummary[] = REFS.map((reference, i) =>
  adminBookingSummarySchema.parse({
    reference,
    serviceType: i === 1 ? 'cabs' : 'hotels',
    status: i === 2 ? 'cancelled' : 'confirmed',
    demo: true,
    paymentMode: i === 1 ? 'none' : 'demo',
    userId: '01890000-0000-7000-b000-000000000001',
    userEmail: 'traveller1@example.com',
    total: i === 1 ? null : { amountMinor: '1170000', currency: 'INR' },
    startsOn: '2026-11-12',
    createdAt: new Date(Date.UTC(2026, 9, 20 - i)).toISOString(),
  }),
);
export const PAYMENTS: AdminPaymentSummary[] = [
  ['succeeded', 0],
  ['failed', 2],
].map(([status, i]) =>
  adminPaymentSummarySchema.parse({
    id: `01890000-0000-7000-a000-00000000000${i}`,
    bookingReference: REFS[i as number],
    userId: '01890000-0000-7000-b000-000000000001',
    attempt: 1,
    status,
    mode: 'demo',
    provider: 'demo',
    amount: { amountMinor: '1170000', currency: 'INR' },
    demoScenario: status === 'failed' ? 'decline' : 'succeed',
    refundRequired: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    completedAt: '2026-10-20T10:00:01.000Z',
  }),
);
const AUDIT: AdminAuditEntry[] = Array.from({ length: 30 }, (_, i) =>
  adminAuditEntrySchema.parse({
    id: `01890000-0000-7000-9000-${String(i).padStart(12, '0')}`,
    at: new Date(Date.UTC(2026, 9, 23, 10) - i * 60_000).toISOString(),
    actorType: 'admin',
    actorId: '01890000-0000-7000-8000-000000000001',
    action: i % 2 ? 'admin.user_viewed' : 'admin.booking_viewed',
    entityType: i % 2 ? 'user' : 'booking',
    entityId: `entity-${i}`,
    requestId: null,
    metadata: { role: 'admin' },
  }),
);

export function adminUser(i: number, overrides: Partial<AdminUserSummary> = {}): AdminUserSummary {
  return adminUserSummarySchema.parse({
    id: `01890000-0000-7000-b000-${String(i).padStart(12, '0')}`,
    name: `Traveller ${String.fromCharCode(64 + (i % 26 || 26))}`,
    email: `traveller${i}@example.com`,
    role: 'user',
    status: 'active',
    createdAt: new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString(),
    bookingCount: i % 3,
    ...overrides,
  });
}

const ENDPOINT_PERMISSION: [RegExp, string][] = [
  [/^\/admin\/me$/, 'admin.overview.read'],
  [/^\/admin\/overview$/, 'admin.overview.read'],
  [/^\/admin\/users/, 'admin.users.read'],
  [/^\/admin\/bookings/, 'admin.bookings.read'],
  [/^\/admin\/payments/, 'admin.payments.read'],
  [/^\/admin\/search-analytics$/, 'admin.search.read'],
  [/^\/admin\/notifications$/, 'admin.notifications.read'],
  [/^\/admin\/audit-logs$/, 'admin.audit.read'],
  [/^\/admin\/health$/, 'admin.health.read'],
];

export function installFakeAdminApi({
  role = 'admin',
  signedIn = true,
  users = Array.from({ length: 30 }, (_, i) => adminUser(i + 1)),
}: { role?: UserRole; signedIn?: boolean; users?: AdminUserSummary[] } = {}) {
  const account = installFakeAccountApi({ signedIn, account: { ...TEST_USER, role } });
  const accountFetch = account.fetch as unknown as typeof fetch;
  const requests: string[] = [];
  const state = { role, failNext: null as null | { path: string; status: number; code: string } };

  const handle = (url: URL): Response => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const page = Number(url.searchParams.get('page') ?? '1');
    requests.push(`${path}${url.search}`);
    if (!account.state.signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (state.failNext?.path === path) {
      const { status, code } = state.failNext;
      state.failNext = null;
      return fail(status, code, 'Failed.');
    }
    const permission = ENDPOINT_PERMISSION.find(([re]) => re.test(path))?.[1];
    if (!permission) return fail(404, 'NOT_FOUND', 'Not found.');
    if (!(ROLE_PERMISSIONS[state.role] as readonly string[]).includes(permission))
      return fail(403, 'FORBIDDEN', 'You don’t have access to this.');

    if (path === '/admin/me')
      return ok({ role: state.role, permissions: ROLE_PERMISSIONS[state.role] });
    if (path === '/admin/overview')
      return ok({ ...OVERVIEW, range: url.searchParams.get('range') ?? '7d' });
    if (path === '/admin/health') return ok(HEALTH);
    if (path === '/admin/users') {
      const q = url.searchParams.get('q')?.toLowerCase();
      const pageSize = 25;
      const matched = users.filter(
        (u) => !q || u.email.includes(q) || (u.name ?? '').toLowerCase().includes(q),
      );
      return ok({
        items: matched.slice((page - 1) * pageSize, page * pageSize),
        pagination: {
          page,
          pageSize,
          totalResults: matched.length,
          totalPages: Math.ceil(matched.length / pageSize),
        },
      });
    }
    const userMatch = /^\/admin\/users\/([^/]+)$/.exec(path);
    if (userMatch) {
      const u = users.find((x) => x.id === userMatch[1]);
      if (!u) return fail(404, 'NOT_FOUND', 'There is no user with that id.');
      return ok(
        adminUserDetailSchema.parse({
          ...u,
          emailVerified: false,
          savedTravellers: 1,
          activeSessions: 1,
          lastActiveAt: u.createdAt,
          bookingsByStatus: {
            pending: 0,
            confirmed: u.bookingCount,
            cancelled: 0,
            failed: 0,
            expired: 0,
          },
          paymentsByStatus: { succeeded: 0 },
          notifications: { total: 0, unread: 0 },
          recentBookings: [],
        }),
      );
    }
    const pageOf = <T>(rows: T[], size = 25) => ({
      items: rows.slice((page - 1) * size, page * size),
      pagination: {
        page,
        pageSize: size,
        totalResults: rows.length,
        totalPages: Math.ceil(rows.length / size),
      },
    });
    if (path === '/admin/audit-logs') return ok(pageOf(AUDIT));
    if (path === '/admin/bookings') {
      const type = url.searchParams.get('serviceType');
      const status = url.searchParams.get('status');
      return ok(
        pageOf(
          BOOKINGS.filter(
            (b) => (!type || b.serviceType === type) && (!status || b.status === status),
          ),
        ),
      );
    }
    const bookingMatch = /^\/admin\/bookings\/([^/]+)$/.exec(path);
    if (bookingMatch) {
      const b = BOOKINGS.find((x) => x.reference === bookingMatch[1]);
      if (!b) return fail(404, 'NOT_FOUND', 'There is no booking with that reference.');
      return ok(
        adminBookingDetailSchema.parse({
          ...b,
          providerName: 'Wayora demo hotels',
          supplierReference: null,
          partySize: 2,
          endsOn: null,
          paymentDueAt: null,
          confirmedAt: b.status === 'confirmed' ? b.createdAt : null,
          cancelledAt: null,
          travellers: [{ firstName: 'Asha', lastName: 'Rao', type: null }],
          contactPhoneMasked: '•••• 3210',
          offerSnapshot: { v: 1 },
          history: [{ status: b.status, at: b.createdAt, by: 'user', note: null }],
          payments: PAYMENTS.filter((p) => p.bookingReference === b.reference),
          notifications: [],
        }),
      );
    }
    if (path === '/admin/payments') {
      const status = url.searchParams.get('status');
      const mode = url.searchParams.get('mode');
      return ok(
        pageOf(
          PAYMENTS.filter((p) => (!status || p.status === status) && (!mode || p.mode === mode)),
        ),
      );
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/api/v1/admin')) return handle(url);
    return accountFetch(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    account,
    requests,
    adminRequests: () => requests,
    /** Change the role the "server" sees (e.g. revoked mid-session). */
    setRole: (next: UserRole) => {
      state.role = next;
    },
    /** Answer the next request for `path` (e.g. "/admin/health") with this error. */
    failNext: (path: string, status: number, code: string) => {
      state.failNext = { path, status, code };
    },
  };
}
