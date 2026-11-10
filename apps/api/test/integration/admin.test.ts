import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKER_HEARTBEAT_KEY,
  adminAuditListSchema,
  adminBookingDetailSchema,
  adminBookingListSchema,
  adminHealthSchema,
  adminMeSchema,
  adminNotificationHealthSchema,
  adminOverviewSchema,
  adminPaymentDetailSchema,
  adminPaymentListSchema,
  adminSearchAnalyticsSchema,
  adminUserDetailSchema,
  adminUserListSchema,
  bookingRequirementsFor,
  bookingSchema,
  type Booking,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import type { HealthRedis } from '../../src/modules/admin/platform-health.js';
import { RoleChangeError, setUserRole } from '../../src/modules/admin/roles.js';
import { buildTestApp } from '../helpers.js';
import { VALID_INPUTS } from '../search-support.js';
import { ORIGIN, TEST_DATABASE_URL, disconnect, resetAccounts, testPrisma } from './db.js';

/*
 * Admin dashboard against a real PostgreSQL (docs/admin.md): server-side
 * authorization on every endpoint, no self-promotion, read-only views that
 * expose no secrets, metrics that match the database exactly (demo money is
 * never revenue), audited staff activity, and platform health that tells
 * "worker running" from "Redis reachable".
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the admin tests would be skipped.');
}

type Agent = ReturnType<typeof request.agent>;
const PASSWORD = 'blue river morning';

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
};

/** In-memory Redis for the health page: GET, LLEN, ZCARD, PING. */
class HealthFakeRedis implements HealthRedis {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, number>();
  down = false;
  private check() {
    if (this.down) throw new Error('connect ECONNREFUSED redis://:hunter2@10.0.0.9:6379');
  }
  get(key: string) {
    this.check();
    return Promise.resolve(this.values.get(key) ?? null);
  }
  llen(key: string) {
    this.check();
    return Promise.resolve(this.lists.get(key) ?? 0);
  }
  zcard(key: string) {
    this.check();
    return Promise.resolve(this.lists.get(key) ?? 0);
  }
  ping() {
    this.check();
    return Promise.resolve('PONG');
  }
}

function app(options: { redis?: HealthRedis; now?: () => Date } = {}) {
  return buildTestApp({
    prisma: testPrisma(),
    env: BASE_ENV,
    logger: pino({ level: 'silent' }),
    ...(options.redis ? { redis: options.redis } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function register(target: ReturnType<typeof app>, email: string, name = 'Asha Rao') {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

const promote = (email: string, role: 'support' | 'admin' | 'user', reason = 'Test setup') =>
  setUserRole(testPrisma(), { email, role, reason, actor: 'test' });

async function staff(target: ReturnType<typeof app>, email: string, role: 'support' | 'admin') {
  const agent = await register(target, email, 'Staff Member');
  await promote(email, role);
  return agent;
}

async function book(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const search = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
  expect(search.status).toBe(200);
  const offer = search.body.data.results[0] as SearchResult;
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceType: offer.serviceType,
      searchId: search.body.data.searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect(res.status).toBe(201);
  return bookingSchema.parse(res.body.data);
}

const pay = (agent: Agent, booking: Booking, extra: object = {}) =>
  agent
    .post(`/api/v1/bookings/${booking.reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount: booking.payment.amount, ...extra });

/** Search events are written off the request path; wait for them. */
async function searchEvents(expected: number) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await testPrisma().searchEvent.findMany({ orderBy: { createdAt: 'asc' } });
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return testPrisma().searchEvent.findMany({ orderBy: { createdAt: 'asc' } });
}

const ENDPOINTS = [
  '/api/v1/admin/me',
  '/api/v1/admin/overview',
  '/api/v1/admin/users',
  `/api/v1/admin/users/${randomUUID()}`,
  '/api/v1/admin/bookings',
  '/api/v1/admin/bookings/WYD-AAAA-BBBB',
  '/api/v1/admin/payments',
  `/api/v1/admin/payments/${randomUUID()}`,
  '/api/v1/admin/search-analytics',
  '/api/v1/admin/notifications',
  '/api/v1/admin/audit-logs',
  '/api/v1/admin/health',
];

const SECRETS =
  /argon2|password|token_?hash|tokenHash|idempotency|hunter2|postgresql:\/\/|redis:\/\/|wayora_local_dev_only/i;

describe.skipIf(!TEST_DATABASE_URL)('admin dashboard (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('authorization (server-side, every endpoint)', () => {
    it('answers 401 without a session, for every admin endpoint', async () => {
      const target = app();
      for (const path of ENDPOINTS) {
        const res = await request(target).get(path);
        expect(res.status, path).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('answers 403 to an ordinary user, for every endpoint, and audits each denial', async () => {
      const agent = await register(app(), 'user@example.com');
      for (const path of ENDPOINTS) {
        const res = await agent.get(path);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(JSON.stringify(res.body)).not.toMatch(/WYD-|@example\.com/);
      }
      const denied = await testPrisma().auditLog.findMany({
        where: { action: 'admin.access_denied' },
      });
      expect(denied).toHaveLength(ENDPOINTS.length);
      expect(denied[0]).toMatchObject({ actorType: 'USER', entityType: 'admin_permission' });
      expect(denied.map((d) => (d.metadata as { path: string }).path)).toContain(
        '/api/v1/admin/users/:userId',
      );
    });

    it('ignores client-claimed roles in headers, query strings and cookies', async () => {
      const agent = await register(app(), 'user@example.com');
      const res = await agent
        .get('/api/v1/admin/overview?role=admin')
        .set('X-Role', 'admin')
        .set('X-User-Role', 'admin')
        .set('Cookie', 'role=admin');
      // The forged cookie replaces the session cookie, so this is unauthenticated…
      expect([401, 403]).toContain(res.status);
      // …and with the real session, extra parameters can't grant anything.
      const again = await agent.get('/api/v1/admin/overview').set('X-Role', 'admin');
      expect(again.status).toBe(403);
    });

    it('users cannot promote themselves through registration or the profile endpoint', async () => {
      const target = app();
      const sneaky = await request(target)
        .post('/api/v1/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: 'Mallory', email: 'm@example.com', password: PASSWORD, role: 'admin' });
      expect(sneaky.status).toBe(400);

      const agent = await register(target, 'user@example.com');
      for (const body of [
        { name: 'Asha', role: 'admin' },
        { role: 'admin' },
        { name: 'Asha', permissions: ['admin.audit.read'] },
        { name: 'Asha', isAdmin: true },
      ]) {
        const res = await agent.patch('/api/v1/users/me').set('Origin', ORIGIN).send(body);
        expect(res.status).toBe(400);
      }
      const row = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'user@example.com' },
      });
      expect(row.role).toBe('USER');
      expect((await agent.get('/api/v1/auth/me')).body.data.user.role).toBe('user');
      expect((await agent.get('/api/v1/admin/me')).status).toBe(403);
    });

    it('support staff see operations but not the audit log; admins see everything', async () => {
      const target = app();
      const support = await staff(target, 'support@example.com', 'support');
      const admin = await staff(target, 'admin@example.com', 'admin');

      const me = adminMeSchema.parse((await support.get('/api/v1/admin/me')).body.data);
      expect(me.role).toBe('support');
      expect(me.permissions).not.toContain('admin.audit.read');
      for (const path of ENDPOINTS.filter(
        (p) => !p.includes('audit') && !/[0-9a-f-]{36}|WYD-/.test(p),
      )) {
        expect((await support.get(path)).status, path).toBe(200);
      }
      expect((await support.get('/api/v1/admin/audit-logs')).status).toBe(403);
      expect((await admin.get('/api/v1/admin/audit-logs')).status).toBe(200);
      expect(
        adminMeSchema.parse((await admin.get('/api/v1/admin/me')).body.data).permissions,
      ).toContain('admin.audit.read');
    });

    it('a role change applies on the very next request (roles are read from the database)', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const support = await staff(target, 'support@example.com', 'support');
      expect((await support.get('/api/v1/admin/overview')).status).toBe(200);
      await promote('support@example.com', 'user', 'Left the team');
      expect((await support.get('/api/v1/admin/overview')).status).toBe(403);
      expect((await admin.get('/api/v1/admin/overview')).status).toBe(200);
    });

    it('a suspended staff account loses access at once', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      await testPrisma().user.update({
        where: { email: 'admin@example.com' },
        data: { status: 'SUSPENDED' },
      });
      expect((await admin.get('/api/v1/admin/overview')).status).toBe(401);
    });

    it('is read-only: no admin writes exist, and cross-origin writes are refused first', async () => {
      const admin = await staff(app(), 'admin@example.com', 'admin');
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        for (const path of [
          '/api/v1/admin/users',
          '/api/v1/admin/payments',
          '/api/v1/admin/audit-logs',
        ]) {
          const res = await admin[method](path).set('Origin', ORIGIN).send({});
          expect(res.status, `${method} ${path}`).toBe(404);
        }
      }
      const forged = await admin
        .post('/api/v1/admin/payments')
        .set('Origin', 'https://evil.example')
        .send({});
      expect(forged.status).toBe(403);
    });

    it('the general API rate limit applies to admin endpoints', async () => {
      const limited = buildTestApp({
        prisma: testPrisma(),
        env: { ...BASE_ENV, RATE_LIMIT_MAX: 6 },
        logger: pino({ level: 'silent' }),
      });
      const admin = await staff(limited, 'admin@example.com', 'admin'); // 1 request
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1)
        statuses.push((await admin.get('/api/v1/admin/overview')).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });

    it('responses are no-store and queries are validated strictly', async () => {
      const admin = await staff(app(), 'admin@example.com', 'admin');
      const ok = await admin.get('/api/v1/admin/users');
      expect(ok.headers['cache-control']).toBe('no-store');
      for (const path of [
        '/api/v1/admin/users?pageSize=1000',
        '/api/v1/admin/users?page=0',
        '/api/v1/admin/users?orderBy=passwordHash',
        '/api/v1/admin/overview?range=all',
        '/api/v1/admin/bookings?from=2026-01-01&to=2028-01-01',
        '/api/v1/admin/bookings?from=2026-02-01&to=2026-01-01',
        '/api/v1/admin/audit-logs?action=DROP%20TABLE',
        '/api/v1/admin/me?debug=1',
      ]) {
        const res = await admin.get(path);
        expect(res.status, path).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect((await admin.get('/api/v1/admin/users/not-a-uuid')).status).toBe(400);
      expect((await admin.get(`/api/v1/admin/users/${randomUUID()}`)).status).toBe(404);
      expect((await admin.get('/api/v1/admin/bookings/WYD-ZZZZ-ZZZZ')).status).toBe(404);
    });
  });

  describe('users', () => {
    it('lists, filters and pages accounts without credentials or unnecessary personal data', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      for (const [i, n] of ['A', 'B', 'C', 'D'].entries())
        await register(target, `traveller${i + 1}@example.com`, `Traveller ${n}`);
      await testPrisma().user.update({
        where: { email: 'traveller1@example.com' },
        data: { phoneE164: '+919876543210' },
      });

      const page1 = adminUserListSchema.parse(
        (await admin.get('/api/v1/admin/users?pageSize=2')).body.data,
      );
      expect(page1.pagination).toEqual({ page: 1, pageSize: 2, totalResults: 5, totalPages: 3 });
      expect(page1.items).toHaveLength(2);
      const page3 = adminUserListSchema.parse(
        (await admin.get('/api/v1/admin/users?pageSize=2&page=3')).body.data,
      );
      expect(page3.items).toHaveLength(1);
      const seen = new Set([...page1.items, ...page3.items].map((u) => u.id));
      expect(seen.size).toBe(3);

      const byText = adminUserListSchema.parse(
        (await admin.get('/api/v1/admin/users?q=TRAVELLER3')).body.data,
      );
      expect(byText.items.map((u) => u.email)).toEqual(['traveller3@example.com']);
      const byRole = adminUserListSchema.parse(
        (await admin.get('/api/v1/admin/users?role=admin')).body.data,
      );
      expect(byRole.items.map((u) => u.email)).toEqual(['admin@example.com']);

      const list = await admin.get('/api/v1/admin/users');
      expect(JSON.stringify(list.body)).not.toMatch(SECRETS);
      expect(JSON.stringify(list.body)).not.toContain('9876543210');

      const target1 = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'traveller1@example.com' },
      });
      const detailRes = await admin.get(`/api/v1/admin/users/${target1.id}`);
      const detail = adminUserDetailSchema.parse(detailRes.body.data);
      expect(detail).toMatchObject({
        email: 'traveller1@example.com',
        role: 'user',
        activeSessions: 1,
      });
      expect(Object.keys(detailRes.body.data)).not.toEqual(
        expect.arrayContaining(['passwordHash', 'phoneE164', 'phone']),
      );
      expect(JSON.stringify(detailRes.body)).not.toMatch(SECRETS);
      expect(JSON.stringify(detailRes.body)).not.toContain('9876543210');

      const viewed = await testPrisma().auditLog.findMany({
        where: { action: 'admin.user_viewed' },
      });
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({
        actorType: 'ADMIN',
        entityType: 'user',
        entityId: target1.id,
      });
    });
  });

  describe('bookings and payments', () => {
    it('shows bookings with filters and a detail view that masks contact data and never invents a supplier reference', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'user@example.com');
      const hotel = await book(user, 'hotels');
      const cab = await book(user, 'cabs');

      const all = adminBookingListSchema.parse(
        (await admin.get('/api/v1/admin/bookings')).body.data,
      );
      expect(all.pagination.totalResults).toBe(2);
      expect(all.items.every((b) => b.demo && b.userEmail === 'user@example.com')).toBe(true);
      const cabs = adminBookingListSchema.parse(
        (await admin.get('/api/v1/admin/bookings?serviceType=cabs')).body.data,
      );
      expect(cabs.items.map((b) => b.reference)).toEqual([cab.reference]);
      const byRef = adminBookingListSchema.parse(
        (
          await admin.get(
            `/api/v1/admin/bookings?reference=${hotel.reference.slice(0, 8).toLowerCase()}`,
          )
        ).body.data,
      );
      expect(byRef.items.map((b) => b.reference)).toContain(hotel.reference);
      const today = new Date().toISOString().slice(0, 10);
      const none = adminBookingListSchema.parse(
        (await admin.get('/api/v1/admin/bookings?from=2020-01-01&to=2020-01-31')).body.data,
      );
      expect(none.items).toHaveLength(0);
      const todays = adminBookingListSchema.parse(
        (await admin.get(`/api/v1/admin/bookings?from=${today}&to=${today}`)).body.data,
      );
      expect(todays.items).toHaveLength(2);

      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: cab.reference },
      });
      const res = await admin.get(`/api/v1/admin/bookings/${cab.reference}`);
      const detail = adminBookingDetailSchema.parse(res.body.data);
      expect(detail.supplierReference).toBeNull();
      expect(detail.demo).toBe(true);
      expect(detail.history.length).toBeGreaterThan(0);
      expect(row.contactPhone).toBe('+919876543210'); // cabs need a contact phone
      expect(detail.contactPhoneMasked).toBe('•••• 3210');
      expect(JSON.stringify(res.body)).not.toContain('9876543210');
      expect(JSON.stringify(res.body)).not.toMatch(SECRETS);
      const viewed = await testPrisma().auditLog.findMany({
        where: { action: 'admin.booking_viewed' },
      });
      expect(viewed.map((v) => v.entityId)).toEqual([cab.reference]);
    });

    it('shows payment attempts and their history, with no refund or "mark paid" action', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'user@example.com');
      const booking = await book(user);
      const declined = await pay(user, booking, { demoScenario: 'decline' });
      const paid = await pay(user, booking);
      expect(paid.status).toBe(201);

      const list = adminPaymentListSchema.parse(
        (await admin.get('/api/v1/admin/payments')).body.data,
      );
      expect(list.items.map((p) => p.status).sort()).toEqual(['failed', 'succeeded']);
      expect(list.items.every((p) => p.mode === 'demo')).toBe(true);
      const failed = adminPaymentListSchema.parse(
        (await admin.get('/api/v1/admin/payments?status=failed')).body.data,
      );
      expect(failed.items.map((p) => p.id)).toEqual([declined.body.data.id]);
      const byBooking = adminPaymentListSchema.parse(
        (await admin.get(`/api/v1/admin/payments?q=${booking.reference}`)).body.data,
      );
      expect(byBooking.pagination.totalResults).toBe(2);
      const live = adminPaymentListSchema.parse(
        (await admin.get('/api/v1/admin/payments?mode=live')).body.data,
      );
      expect(live.items).toHaveLength(0);

      const res = await admin.get(`/api/v1/admin/payments/${paid.body.data.id}`);
      const detail = adminPaymentDetailSchema.parse(res.body.data);
      expect(detail.status).toBe('succeeded');
      expect(detail.refund.supported).toBe(false);
      expect(detail.refund.note).toMatch(/no money moved/i);
      expect(detail.history.map((h) => h.status)).toContain('succeeded');
      expect(JSON.stringify(res.body)).not.toMatch(SECRETS);

      // There is no way to change a payment from the dashboard.
      for (const path of ['', '/succeed', '/refund', '/status']) {
        const write = await admin
          .post(`/api/v1/admin/payments/${declined.body.data.id}${path}`)
          .set('Origin', ORIGIN)
          .send({ status: 'succeeded' });
        expect(write.status).toBe(404);
      }
      const still = await testPrisma().payment.findUniqueOrThrow({
        where: { id: declined.body.data.id },
      });
      expect(still.status).toBe('FAILED');
    });
  });

  describe('metrics match the database', () => {
    it('overview counts, demo versus real, no demo revenue, and the time window', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'user@example.com');
      const b1 = await book(user);
      await book(user, 'cabs');
      const b3 = await book(user);
      await pay(user, b1);
      await pay(user, b3, { demoScenario: 'decline' });

      const o = adminOverviewSchema.parse(
        (await admin.get('/api/v1/admin/overview?range=7d')).body.data,
      );
      expect(o.timezone).toBe('UTC');
      expect(Date.parse(o.to) - Date.parse(o.from)).toBe(7 * 24 * 3600 * 1000);
      expect(o.users).toEqual({ total: 2, newInRange: 2 });
      expect(o.bookings.total).toBe(3);
      expect(o.bookings.inRange).toBe(3);
      expect(o.bookings.demo).toBe(3);
      expect(o.bookings.real).toBe(0);
      expect(o.bookings.byStatus).toMatchObject({ confirmed: 2, pending: 1 });
      expect(o.payments.attemptsInRange).toBe(2);
      expect(o.payments.byStatus).toMatchObject({ succeeded: 1, failed: 1 });
      expect(o.payments.byMode).toEqual({ demo: 2, live: 0 });
      // A succeeded demo payment is not revenue.
      expect(o.payments.realRevenue.totals).toEqual([]);
      expect(o.unavailable.map((u) => u.metric)).toContain('Revenue');

      // Eight days later, the same rows fall outside 7 days but inside 30.
      const later = app({ now: () => new Date(Date.now() + 8 * 24 * 3600 * 1000) });
      const admin2 = request.agent(later);
      await admin2
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);
      const week = adminOverviewSchema.parse(
        (await admin2.get('/api/v1/admin/overview?range=7d')).body.data,
      );
      expect(week.bookings).toMatchObject({ total: 3, inRange: 0 });
      expect(week.users.newInRange).toBe(0);
      expect(week.payments.attemptsInRange).toBe(0);
      const month = adminOverviewSchema.parse(
        (await admin2.get('/api/v1/admin/overview?range=30d')).body.data,
      );
      expect(month.bookings.inRange).toBe(3);
      expect(month.payments.attemptsInRange).toBe(2);
    });

    it('records searches without personal data, and computes conversion from real rows', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'user@example.com');

      const before = adminSearchAnalyticsSchema.parse(
        (await admin.get('/api/v1/admin/search-analytics')).body.data,
      );
      expect(before.total).toBe(0);
      expect(before.trackedSince).toBeNull();
      expect(before.series).toEqual([]);

      await book(user); // one search, booked
      const { serviceType: _t, ...flights } = VALID_INPUTS.flights;
      await user.post('/api/v1/search/flights').set('Origin', ORIGIN).send(flights); // not booked
      // Invalid requests aren't searches.
      await user.post('/api/v1/search/flights').set('Origin', ORIGIN).send({ origin: 'nowhere' });

      const rows = await searchEvents(2);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'category',
            'createdAt',
            'durationMs',
            'errorCode',
            'id',
            'outcome',
            'providers',
            'resultCount',
            'searchId',
            // Phase 31 (docs/analytics.md#search-events): catalogue places, travel
            // month, filter/sort field names. Still no user, travellers or dates.
            'originPlace',
            'destinationPlace',
            'travelMonth',
            'filterKeys',
            'sort',
            'reused',
          ].sort(),
        );
        expect(JSON.stringify(row)).not.toMatch(/asha|user@example|\+91|userId|adults/i);
        expect(row.travelMonth?.getUTCDate() ?? 1).toBe(1);
      }

      const a = adminSearchAnalyticsSchema.parse(
        (await admin.get('/api/v1/admin/search-analytics?range=24h')).body.data,
      );
      expect(a.total).toBe(2);
      expect(a.byCategory).toMatchObject({ hotels: 1, flights: 1, trains: 0 });
      expect(a.bucket).toBe('hour');
      expect(a.series.reduce((n, s) => n + s.count, 0)).toBe(2);
      expect(a.providers.length).toBeGreaterThan(0);
      expect(a.trackedSince).not.toBeNull();

      const o = adminOverviewSchema.parse(
        (await admin.get('/api/v1/admin/overview?range=24h')).body.data,
      );
      expect(o.conversion).toMatchObject({ searches: 2, searchesWithBooking: 1, rate: 0.5 });
    });

    it('notification health counts what exists and says email is not configured', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'user@example.com');
      await book(user);
      const n = adminNotificationHealthSchema.parse(
        (await admin.get('/api/v1/admin/notifications')).body.data,
      );
      expect(n.createdInRange).toBe(1);
      expect(n.byType.booking_created).toBe(1);
      expect(n.deliveries.byStatus.pending).toBe(1);
      expect(n.email.configured).toBe(false);
    });
  });

  describe('audit log', () => {
    it('records staff sign-ins, views and role changes, and is append-only', async () => {
      const target = app();
      await register(target, 'admin@example.com');
      await promote('admin@example.com', 'admin', 'First administrator');
      const admin = request.agent(target);
      expect(
        (
          await admin
            .post('/api/v1/auth/login')
            .set('Origin', ORIGIN)
            .send({ email: 'admin@example.com', password: PASSWORD })
        ).status,
      ).toBe(200);
      await register(target, 'user@example.com');
      await admin
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'user@example.com', password: PASSWORD })
        .expect(200);
      // (The second login signed the agent in as the user; sign back in as admin.)
      await admin
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);

      const log = adminAuditListSchema.parse(
        (await admin.get('/api/v1/admin/audit-logs')).body.data,
      );
      const actions = log.items.map((e) => e.action);
      expect(actions.filter((a) => a === 'admin.sign_in')).toHaveLength(2); // the user's sign-in isn't staff
      const roleChange = log.items.find((e) => e.action === 'user.role_changed');
      expect(roleChange).toMatchObject({
        actorType: 'admin',
        actorId: 'test',
        metadata: { from: 'USER', to: 'ADMIN', reason: 'First administrator' },
      });
      expect(JSON.stringify(log)).not.toMatch(SECRETS);

      const filtered = adminAuditListSchema.parse(
        (await admin.get('/api/v1/admin/audit-logs?action=user.role')).body.data,
      );
      expect(filtered.items.every((e) => e.action.startsWith('user.role'))).toBe(true);

      // Pages are disjoint and complete.
      const total = log.pagination.totalResults;
      const seen: string[] = [];
      for (let page = 1; page <= total; page += 1) {
        const one = adminAuditListSchema.parse(
          (await admin.get(`/api/v1/admin/audit-logs?pageSize=1&page=${page}`)).body.data,
        );
        expect(one.items).toHaveLength(1);
        seen.push(one.items[0]!.id);
      }
      expect(new Set(seen).size).toBe(total);

      await expect(testPrisma().$executeRaw`UPDATE audit_logs SET action = 'x'`).rejects.toThrow();
      await expect(testPrisma().$executeRaw`DELETE FROM audit_logs`).rejects.toThrow();
    });
  });

  describe('role provisioning', () => {
    it('refuses to demote the last active administrator, and audits every change', async () => {
      const target = app();
      await register(target, 'a@example.com');
      await register(target, 'b@example.com');
      await promote('a@example.com', 'admin');
      await expect(promote('a@example.com', 'user')).rejects.toBeInstanceOf(RoleChangeError);
      await expect(promote('a@example.com', 'support')).rejects.toThrow(
        /last active administrator/,
      );
      await promote('b@example.com', 'admin');
      await promote('a@example.com', 'support', 'Rotation');
      await expect(promote('b@example.com', 'user')).rejects.toThrow(/last active administrator/);
      expect(await promote('b@example.com', 'admin')).toMatchObject({ changed: false });
      await expect(promote('nobody@example.com', 'admin')).rejects.toThrow(/No account/);
      await expect(promote('a@example.com', 'admin', '')).rejects.toThrow(/reason/);

      const changes = await testPrisma().auditLog.findMany({
        where: { action: 'user.role_changed' },
        orderBy: { createdAt: 'asc' },
      });
      expect(changes.map((c) => c.metadata)).toEqual([
        { from: 'USER', to: 'ADMIN', reason: 'Test setup' },
        { from: 'USER', to: 'ADMIN', reason: 'Test setup' },
        { from: 'ADMIN', to: 'SUPPORT', reason: 'Rotation' },
      ]);
    });

    it('refuses staff roles for inactive accounts; concurrent demotions keep one admin', async () => {
      const target = app();
      await register(target, 'a@example.com');
      await register(target, 'b@example.com');
      await register(target, 'c@example.com');
      await testPrisma().user.update({
        where: { email: 'c@example.com' },
        data: { status: 'SUSPENDED' },
      });
      await expect(promote('c@example.com', 'support')).rejects.toThrow(/active accounts/);

      await promote('a@example.com', 'admin');
      await promote('b@example.com', 'admin');
      const results = await Promise.allSettled([
        promote('a@example.com', 'user'),
        promote('b@example.com', 'user'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await testPrisma().user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } })).toBe(1);
    });
  });

  describe('platform health', () => {
    it('reports the worker from its own heartbeat, not from Redis being reachable', async () => {
      const redis = new HealthFakeRedis();
      const admin = await staff(app({ redis }), 'admin@example.com', 'admin');

      let h = adminHealthSchema.parse((await admin.get('/api/v1/admin/health')).body.data);
      expect(h.redis.status).toBe('up');
      expect(h.worker.status).toBe('down'); // Redis is up, but no heartbeat
      expect(h.database.status).toBe('up');
      expect(h.queue).toMatchObject({ status: 'up', waiting: 0, failed: 0 });

      // A fresh app (the report is cached briefly) with a recent heartbeat and a backlog.
      redis.values.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString() }));
      redis.lists.set('bull:wayora-system:wait', 3);
      const admin2 = request.agent(app({ redis }));
      await admin2
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);
      h = adminHealthSchema.parse((await admin2.get('/api/v1/admin/health')).body.data);
      expect(h.worker.status).toBe('up');
      expect(h.queue.waiting).toBe(3);

      // A stale heartbeat (older than 60s) is a stopped worker.
      redis.values.set(
        WORKER_HEARTBEAT_KEY,
        JSON.stringify({ at: new Date(Date.now() - 5 * 60_000).toISOString() }),
      );
      const admin3 = request.agent(app({ redis }));
      await admin3
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);
      h = adminHealthSchema.parse((await admin3.get('/api/v1/admin/health')).body.data);
      expect(h.worker.status).toBe('down');
    });

    it('distinguishes "unknown" and "not configured" from healthy, and leaks no connection details', async () => {
      const redis = new HealthFakeRedis();
      redis.down = true;
      const admin = await staff(app({ redis }), 'admin@example.com', 'admin');
      const res = await admin.get('/api/v1/admin/health');
      const h = adminHealthSchema.parse(res.body.data);
      expect(h.redis.status).toBe('down');
      expect(h.worker.status).toBe('unknown');
      expect(h.queue.status).toBe('unknown');
      expect(h.queue.waiting).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(SECRETS);
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.9/);

      const noRedis = await request.agent(app());
      await noRedis
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);
      const n = adminHealthSchema.parse((await noRedis.get('/api/v1/admin/health')).body.data);
      expect(n.redis.status).toBe('not-configured');
      expect(n.queue.status).toBe('not-configured');
      expect(n.worker.status).toBe('unknown');
    });
  });
});
