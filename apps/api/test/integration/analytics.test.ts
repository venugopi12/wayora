import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingRequirementsFor,
  bookingSchema,
  customersReportSchema,
  funnelReportSchema,
  marketingReportSchema,
  overviewReportSchema,
  providersReportSchema,
  revenueReportSchema,
  searchReportSchema,
  supportReportSchema,
  type Booking,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
import { MemoryAnalyticsCache, type AnalyticsCache } from '../../src/modules/analytics/cache.js';
import { buildTestApp } from '../helpers.js';
import { VALID_INPUTS } from '../search-support.js';
import { ORIGIN, TEST_DATABASE_URL, disconnect, resetAccounts, testPrisma } from './db.js';

/*
 * Analytics (Phase 31, docs/analytics.md) against a real PostgreSQL: events
 * recorded by triggers and by the API (idempotent, consent respected, no
 * personal data), reports that match the source records exactly (demo never
 * mixed with real, currencies never summed, refunds pending not deducted),
 * date boundaries in the reporting timezone, role-based access, audited
 * exports, and a cache that never crosses roles.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the analytics tests would be skipped.');
}

type Agent = ReturnType<typeof request.agent>;
const PASSWORD = 'blue river morning';
const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  SEARCH_RATE_LIMIT_MAX: 1000,
  ANALYTICS_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
};

function app(options: { cache?: AnalyticsCache; now?: () => Date; env?: Partial<Env> } = {}) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...options.env },
    logger: pino({ level: 'silent' }),
    ...(options.cache ? { analyticsCache: options.cache } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
type App = ReturnType<typeof app>;

async function register(target: App, email: string, name = 'Asha Rao'): Promise<Agent> {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function staff(target: App, email: string, role: 'support' | 'admin'): Promise<Agent> {
  const agent = await register(target, email, 'Staff Member');
  await setUserRole(testPrisma(), { email, role, reason: 'Test setup', actor: 'test' });
  return agent;
}

async function search(agent: Agent, type: SearchServiceType = 'hotels', extra: object = {}) {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const res = await agent
    .post(`/api/v1/search/${type}`)
    .set('Origin', ORIGIN)
    .send({ ...body, ...extra });
  expect(res.status).toBe(200);
  return {
    searchId: res.body.data.searchId as string,
    offer: res.body.data.results[0] as SearchResult,
  };
}

async function book(agent: Agent, key = randomUUID()): Promise<Booking> {
  const { searchId, offer } = await search(agent);
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', key)
    .send({
      serviceType: offer.serviceType,
      searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect([200, 201]).toContain(res.status);
  return bookingSchema.parse(res.body.data);
}

const pay = (agent: Agent, booking: Booking, extra: object = {}) =>
  agent
    .post(`/api/v1/bookings/${booking.reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount: booking.payment.amount, ...extra });

/** API events are written off the request path; wait for them. */
async function events(type: string, expected = 1) {
  for (let i = 0; i < 100; i += 1) {
    const rows = await testPrisma().analyticsEvent.findMany({ where: { type } });
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return testPrisma().analyticsEvent.findMany({ where: { type } });
}
/** Waits a little, then returns what's there (for "nothing was recorded"). */
async function settled(type: string) {
  await new Promise((r) => setTimeout(r, 150));
  return testPrisma().analyticsEvent.findMany({ where: { type } });
}
async function searchRows(expected: number) {
  for (let i = 0; i < 100; i += 1) {
    const rows = await testPrisma().searchEvent.findMany({ orderBy: { createdAt: 'asc' } });
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return testPrisma().searchEvent.findMany({ orderBy: { createdAt: 'asc' } });
}

/** Tracking began long ago (so whole periods count as covered). */
const trackingSince = (at: Date) =>
  testPrisma().analyticsEvent.update({
    where: { dedupeKey: 'analytics.tracking_started' },
    data: { occurredAt: at },
  });

const PII = /@example\.com|Asha|Rao|\+91|password|argon2|token/i;

describe.skipIf(!TEST_DATABASE_URL)('analytics (integration, real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetAccounts();
    await trackingSince(new Date('2020-01-01T00:00:00Z'));
  });
  afterAll(async () => {
    await trackingSince(new Date());
    await disconnect();
  });

  describe('event tracking', () => {
    it('records account events: registration, sign-in and out, profile completion — once each', async () => {
      const target = app();
      const agent = await register(target, 'a@example.com');
      const user = await testPrisma().user.findUniqueOrThrow({ where: { email: 'a@example.com' } });
      expect(await events('user.registered')).toMatchObject([
        { userId: user.id, source: 'SERVER', entityType: 'user' },
      ]);

      // Profile completion: a name and a saved traveller, the first time only.
      for (const firstName of ['Meera', 'Kiran']) {
        const res = await agent
          .post('/api/v1/users/me/travellers')
          .set('Origin', ORIGIN)
          .send({ firstName, lastName: 'Rao' });
        expect(res.status).toBe(201);
      }
      expect(await events('user.profile_completed')).toHaveLength(1);

      await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN).expect(200);
      expect(await events('user.logout')).toHaveLength(1);
      const login = await agent
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'a@example.com', password: PASSWORD });
      expect(login.status).toBe(200);
      const logins = await events('user.login');
      expect(logins).toHaveLength(1);
      expect(logins[0]!.dedupeKey).toMatch(/^user\.login:[0-9a-f-]{36}$/);

      // No personal data anywhere in the events.
      const all = await testPrisma().analyticsEvent.findMany();
      expect(
        JSON.stringify(all, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
      ).not.toMatch(PII);
    });

    it('counts a customer active once per reporting day; polling and staff don’t count', async () => {
      let t = Date.parse('2026-03-10T03:00:00Z'); // 08:30 in India
      const target = app({ now: () => new Date(t) });
      const agent = await register(target, 'b@example.com');
      await agent.get('/api/v1/auth/me').expect(200);
      await agent.get('/api/v1/auth/me').expect(200);
      expect(await events('user.active')).toHaveLength(1);

      // The next local day (00:30 in India on 11 March is 19:00 UTC on 10 March).
      t = Date.parse('2026-03-10T19:00:00Z');
      await agent.get('/api/v1/notifications/unread-count').expect(200);
      expect(await settled('user.active')).toHaveLength(1);
      await agent.get('/api/v1/auth/me').expect(200);
      const active = await events('user.active', 2);
      expect(active.map((e) => e.dedupeKey.slice(-10)).sort()).toEqual([
        '2026-03-10',
        '2026-03-11',
      ]);

      const admin = await staff(target, 'boss@example.com', 'admin');
      await admin.get('/api/v1/auth/me').expect(200);
      const boss = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'boss@example.com' },
      });
      const staffActive = (await settled('user.active')).filter((e) => e.userId === boss.id);
      expect(staffActive).toHaveLength(0);
    });

    it('records the search-to-payment path, idempotently, with demo flags from the records', async () => {
      const target = app();
      const agent = await register(target, 'c@example.com');
      const key = randomUUID();
      const booking = await book(agent, key);
      // The same submission again (a retry) is the same attempt and the same booking.
      const again = await book(agent, key);
      expect(again.reference).toBe(booking.reference);
      expect(await events('booking.initiated')).toHaveLength(1);
      const created = await events('booking.created');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ isDemo: true, category: 'HOTEL', currency: 'INR' });
      expect(created[0]!.searchId).not.toBeNull();

      expect((await pay(agent, booking, { demoScenario: 'decline' })).status).toBeLessThan(500);
      expect((await pay(agent, booking)).status).toBe(201);
      expect(await events('payment.initiated', 2)).toHaveLength(2);
      expect(await events('payment.failed')).toHaveLength(1);
      const paid = await events('payment.succeeded');
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({
        isDemo: true,
        amountMinor: BigInt(booking.payment.amount!.amountMinor),
      });

      await agent
        .post(`/api/v1/bookings/${booking.reference}/cancel`)
        .set('Origin', ORIGIN)
        .expect(200);
      expect(await events('booking.cancelled')).toHaveLength(1);
      // A demo refund is recorded as owed: initiated, not completed.
      expect(await events('refund.initiated')).toHaveLength(1);
      expect(await settled('refund.completed')).toHaveLength(0);
    });

    it('records search details coarsely: places, travel month, filter and sort names — never values', async () => {
      const target = app();
      const agent = request.agent(target);
      await search(agent, 'flights', {
        filters: { maxStops: 0 },
        sortBy: 'price-asc',
      });
      const [row] = await searchRows(1);
      expect(row).toMatchObject({
        originPlace: 'airport:BLR',
        destinationPlace: 'airport:DEL',
        filterKeys: ['maxStops'],
        sort: 'price-asc',
        reused: false,
      });
      expect(row!.travelMonth!.toISOString()).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
      expect(JSON.stringify(row)).not.toMatch(/adults|"0"|maxStops":/);
    });

    it('offer views: once per search and offer; nothing with Do Not Track or GPC', async () => {
      const target = app();
      const agent = request.agent(target);
      const { searchId, offer } = await search(agent);
      const url = `/api/v1/search/hotels/sessions/${searchId}/offer?id=${encodeURIComponent(offer.id)}`;
      await agent.get(url).set('DNT', '1').expect(200);
      await agent.get(url).set('Sec-GPC', '1').expect(200);
      expect(await settled('offer.viewed')).toHaveLength(0);
      await agent.get(url).expect(200);
      await agent.get(url).expect(200);
      const viewed = await events('offer.viewed');
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({ searchId, userId: null, category: 'HOTEL' });
    });

    it('client "offer chosen" events: only for real recent searches, deduplicated, consent respected', async () => {
      const target = app();
      const agent = request.agent(target);
      const { searchId, offer } = await search(agent);
      const event = { type: 'offer.selected', serviceType: 'hotels', searchId, offerId: offer.id };
      const send = (body: object, headers: Record<string, string> = {}) =>
        request(target).post('/api/v1/analytics/interactions').set(headers).send(body);

      expect((await send({ events: [event] }, { 'Sec-GPC': '1' })).body.data.recorded).toBe(0);
      expect(
        (await send({ events: [{ ...event, searchId: randomUUID() }] })).body.data.recorded,
      ).toBe(0);
      expect((await send({ events: [event, event] })).body.data.recorded).toBe(1);
      expect((await send({ events: [event] })).body.data.recorded).toBe(0);
      // Only the allow-listed shape: no extra fields, no other types.
      expect((await send({ events: [{ ...event, email: 'x@example.com' }] })).status).toBe(400);
      expect((await send({ events: [{ ...event, type: 'booking.created' }] })).status).toBe(400);
      const rows = await events('offer.selected');
      expect(rows).toMatchObject([{ source: 'CLIENT', userId: null, searchId }]);
    });
  });

  describe('reports', () => {
    it('overview and revenue: demo never counted as money, figures match the records', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'd@example.com');
      const b1 = await book(user);
      const b2 = await book(user);
      expect((await pay(user, b1)).status).toBe(201);
      await book(user); // unpaid

      const res = await admin.get('/api/v1/admin/analytics/overview?preset=today');
      expect(res.status).toBe(200);
      const o = overviewReportSchema.parse(res.body.data);
      expect(o.timezone).toBe('Asia/Kolkata');
      expect(o.bookings.created.demo.value).toBe(3);
      expect(o.bookings.created.real.value).toBe(0);
      expect(o.users.new.value).toBe(1); // customers only: the admin is staff now
      // Three identical searches share one search session: one search, three requests.
      expect(o.searches.total.value).toBe(1);
      expect(o.searches.requests).toBe(3);
      expect(o.conversion).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
      expect(o.payments.successRate.demo).toMatchObject({ numerator: 1, denominator: 1 });
      expect(o.payments.successRate.real).toMatchObject({
        numerator: 0,
        denominator: 0,
        value: null,
      });
      const real = o.money!.find((m) => m.mode === 'real')!;
      const demo = o.money!.find((m) => m.mode === 'demo')!;
      expect(real.collected).toEqual([]);
      expect(demo.collected).toEqual([
        { currency: 'INR', amountMinor: b1.payment.amount!.amountMinor, previousMinor: '0' },
      ]);
      expect(o.notes.map((n) => n.metric)).toContain('Real revenue');

      const rev = revenueReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/revenue?preset=today').expect(200)).body.data,
      );
      const demoLine = rev.modes.find((m) => m.mode === 'demo')!.lines[0]!;
      const total = BigInt(b1.payment.amount!.amountMinor);
      expect(demoLine.paymentsSucceeded.amountMinor).toBe(total.toString());
      expect(demoLine.confirmedBookings.value).toBe(1);
      expect(demoLine.grossBookingValue.amountMinor).toBe(total.toString());
      expect(demoLine.netCollected.amountMinor).toBe(total.toString());
      expect(rev.modes.find((m) => m.mode === 'real')!.lines).toEqual([]);
      expect(b2.reference).toBeTruthy();
    });

    it('refunds: pending refunds are not deducted; completed ones are; currencies stay apart', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'e@example.com');
      const b = await book(user);
      await pay(user, b).expect(201);
      await user.post(`/api/v1/bookings/${b.reference}/cancel`).set('Origin', ORIGIN).expect(200);
      const amount = BigInt(b.payment.amount!.amountMinor);

      let rev = revenueReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/revenue?preset=today').expect(200)).body.data,
      );
      let line = rev.modes.find((m) => m.mode === 'demo')!.lines[0]!;
      expect(line.refundsPending).toEqual({ amountMinor: amount.toString(), count: 1 });
      expect(line.refundsCompleted.amountMinor).toBe('0');
      expect(line.netCollected.amountMinor).toBe(amount.toString());

      // Completed (as a provider would report it), and a second booking in another currency.
      const refund = await testPrisma().refund.findFirstOrThrow();
      await testPrisma().refund.update({
        where: { id: refund.id },
        data: { status: 'SUCCEEDED', completedAt: new Date() },
      });
      const b2 = await book(user);
      await pay(user, b2).expect(201);
      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: b2.reference },
      });
      // Booked facts are immutable; lift that guard for this one test-only rewrite (DDL is transactional).
      const db = testPrisma();
      await db.$transaction([
        db.$executeRaw`ALTER TABLE bookings DISABLE TRIGGER bookings_booked_facts_immutable`,
        db.$executeRaw`ALTER TABLE payments DISABLE TRIGGER payments_facts_immutable`,
        db.$executeRaw`UPDATE bookings SET currency = 'USD' WHERE id = ${row.id}::uuid`,
        db.$executeRaw`UPDATE payments SET currency = 'USD' WHERE booking_id = ${row.id}::uuid`,
        db.$executeRaw`ALTER TABLE payments ENABLE TRIGGER payments_facts_immutable`,
        db.$executeRaw`ALTER TABLE bookings ENABLE TRIGGER bookings_booked_facts_immutable`,
      ]);

      // A different cache key (granularity) so this is computed afresh.
      rev = revenueReportSchema.parse(
        (
          await admin
            .get('/api/v1/admin/analytics/revenue?preset=today&granularity=week')
            .expect(200)
        ).body.data,
      );
      const lines = rev.modes.find((m) => m.mode === 'demo')!.lines;
      expect(lines.map((l) => l.currency)).toEqual(['INR', 'USD']);
      line = lines[0]!;
      expect(line.refundsCompleted.amountMinor).toBe(amount.toString());
      expect(line.netCollected.amountMinor).toBe('0');
      expect(lines[1]!.paymentsSucceeded.amountMinor).toBe(b2.payment.amount!.amountMinor);
      expect(lines[1]!.refundsCompleted.amountMinor).toBe('0');
    });

    it('funnel: each search followed to its furthest stage; later stages imply earlier ones', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'f@example.com');
      const b = await book(user); // search → booking (no offer view recorded)
      await pay(user, b).expect(201);
      const { searchId, offer } = await search(user, 'flights'); // viewed only
      await user
        .get(`/api/v1/search/flights/sessions/${searchId}/offer?id=${encodeURIComponent(offer.id)}`)
        .expect(200);
      await events('offer.viewed');
      await search(user, 'buses'); // results only

      const f = funnelReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/funnel?preset=today').expect(200)).body.data,
      );
      const stage = (k: string) => f.stages.find((s) => s.key === k)!;
      expect(stage('search_initiated').count).toBe(3);
      expect(stage('results_returned').count).toBe(3);
      expect(stage('offer_viewed')).toMatchObject({ count: 2, observed: 1 });
      expect(stage('offer_selected')).toMatchObject({ count: 1, observed: 0 });
      expect(stage('booking_created')).toMatchObject({ count: 1, split: { real: 0, demo: 1 } });
      expect(stage('payment_completed')).toMatchObject({ count: 1, split: { real: 0, demo: 1 } });
      expect(stage('supplier_confirmed').count).toBe(0);
      // Counts never grow down the first six stages.
      const counts = f.stages.slice(0, 6).map((s) => s.count);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      expect(f.byCategory.map((c) => c.category).sort()).toEqual(['buses', 'flights', 'hotels']);
    });

    it('search report: route pairs only above the minimum group size; no individual searches', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const visitor = request.agent(target);
      const base = Date.parse(`${VALID_INPUTS.hotels.checkIn}T00:00:00Z`);
      for (let i = 0; i < 5; i += 1) {
        const day = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
        const out = new Date(base + (i + 3) * 86_400_000).toISOString().slice(0, 10);
        await search(visitor, 'hotels', { checkIn: day, checkOut: out });
      }
      await search(visitor, 'flights');
      await searchRows(6);
      const s = searchReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/search?preset=today').expect(200)).body.data,
      );
      expect(s.routes).toEqual([
        expect.objectContaining({ category: 'hotels', destination: 'city:goa', searches: 5 }),
      ]);
      expect(s.byCategory.find((c) => c.category === 'flights')?.searches).toBe(1);
      expect(JSON.stringify(s)).not.toMatch(/airport:DEL/);
    });

    it('customers, providers, marketing and support reports answer with their shapes', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'g@example.com');
      const b = await book(user);
      await pay(user, b).expect(201);
      for (const [report, schema] of [
        ['customers', customersReportSchema],
        ['providers', providersReportSchema],
        ['marketing', marketingReportSchema],
        ['support', supportReportSchema],
      ] as const) {
        const res = await admin.get(`/api/v1/admin/analytics/${report}?preset=last_7_days`);
        expect(res.status, report).toBe(200);
        expect(() => schema.parse(res.body.data), report).not.toThrow();
        expect(JSON.stringify(res.body), report).not.toMatch(/@example\.com|\+91/);
      }
      const c = customersReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/customers?preset=today').expect(200)).body.data,
      );
      expect(c.booking.find((x) => x.mode === 'demo')!.customers.value).toBe(1);
      expect(c.booking.find((x) => x.mode === 'real')!.customers.value).toBe(0);
      const p = providersReportSchema.parse(
        (await admin.get('/api/v1/admin/analytics/providers?preset=today').expect(200)).body.data,
      );
      expect(p.search.length).toBeGreaterThan(0);
      expect(p.search.every((x) => x.kind === 'demo')).toBe(true);
    });
  });

  describe('dates and timezone', () => {
    it('counts by calendar day in the reporting timezone, with exact midnight boundaries', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const ids: string[] = [];
      for (const email of ['h1@example.com', 'h2@example.com', 'h3@example.com']) {
        await register(target, email);
        ids.push((await testPrisma().user.findUniqueOrThrow({ where: { email } })).id);
      }
      // 23:59:59.999 on 1 Feb, 00:00 on 2 Feb and 23:59 on 2 Feb, in India (UTC+05:30).
      const at = [
        '2026-02-01T18:29:59.999Z',
        '2026-02-01T18:30:00.000Z',
        '2026-02-02T18:29:00.000Z',
      ];
      for (let i = 0; i < 3; i += 1)
        await testPrisma().user.update({
          where: { id: ids[i]! },
          data: { createdAt: new Date(at[i]!) },
        });
      const get = async (from: string, to: string) =>
        overviewReportSchema.parse(
          (
            await admin
              .get(`/api/v1/admin/analytics/overview?preset=custom&from=${from}&to=${to}`)
              .expect(200)
          ).body.data,
        );
      const feb2 = await get('2026-02-02', '2026-02-02');
      expect(feb2.users.new.value).toBe(2);
      expect(feb2.users.new.previous).toBe(1); // 1 Feb, the comparison day
      expect(feb2.period).toMatchObject({
        start: '2026-02-01T18:30:00.000Z',
        end: '2026-02-02T18:30:00.000Z',
        days: 1,
        partial: false,
      });
      expect(feb2.previous).toMatchObject({ from: '2026-02-01', to: '2026-02-01' });
    });

    it('rejects invalid ranges', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      for (const q of [
        'preset=custom',
        'preset=custom&from=2026-02-10&to=2026-02-01',
        'preset=custom&from=2025-01-01&to=2026-02-01',
        'preset=custom&from=2026-02-30&to=2026-03-01',
        'preset=custom&from=2026-01-01&to=2099-01-01',
        'preset=today&from=2026-01-01',
        'preset=forever',
        'preset=today&granularity=hour',
      ]) {
        const res = await admin.get(`/api/v1/admin/analytics/overview?${q}`);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code, q).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('access', () => {
    it('401 signed out, 403 for customers; support sees no money; revenue and export are admin-only', async () => {
      const target = app();
      await request(target).get('/api/v1/admin/analytics/overview').expect(401);
      const user = await register(target, 'i@example.com');
      for (const path of ['overview', 'revenue', 'funnel', 'overview/export']) {
        const res = await user.get(`/api/v1/admin/analytics/${path}`);
        expect(res.status, path).toBe(403);
      }
      const support = await staff(target, 'help@example.com', 'support');
      const o = overviewReportSchema.parse(
        (await support.get('/api/v1/admin/analytics/overview').expect(200)).body.data,
      );
      expect(o.money).toBeNull();
      await support.get('/api/v1/admin/analytics/revenue').expect(403);
      await support.get('/api/v1/admin/analytics/funnel/export').expect(403);
      await support.get('/api/v1/admin/analytics/support').expect(200);
      const denied = await testPrisma().auditLog.findMany({
        where: { action: 'admin.access_denied' },
      });
      expect(denied.map((d) => d.entityId)).toEqual(
        expect.arrayContaining([
          'admin.analytics.read',
          'admin.analytics.financial',
          'admin.analytics.export',
        ]),
      );
    });

    it('exports CSV matching the report, bounded, formula-safe, and audited', async () => {
      const target = app();
      const admin = await staff(target, 'admin@example.com', 'admin');
      const user = await register(target, 'j@example.com');
      const b = await book(user);
      await pay(user, b).expect(201);
      const res = await admin.get('/api/v1/admin/analytics/revenue/export?preset=today');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="wayora-revenue-/);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      const text = res.text;
      expect(text).toContain('section,metric,dimension,mode,currency,value,previous');
      expect(text).toContain(
        `revenue,payments_succeeded,,demo,INR,${b.payment.amount!.amountMinor},0`,
      );
      expect(text).not.toMatch(PII);
      const audit = await testPrisma().auditLog.findMany({
        where: { action: 'admin.analytics_exported' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entityType: 'analytics_report', entityId: 'revenue' });
      expect(audit[0]!.metadata).toMatchObject({ preset: 'today', timezone: 'Asia/Kolkata' });
    });

    it('the cache never serves one role’s report to another, and expires', async () => {
      const cache = new MemoryAnalyticsCache();
      const target = app({ cache });
      const admin = await staff(target, 'admin@example.com', 'admin');
      const support = await staff(target, 'help@example.com', 'support');
      const first = (await admin.get('/api/v1/admin/analytics/overview?preset=today').expect(200))
        .body.data;
      expect(first.money).not.toBeNull();
      const s = (await support.get('/api/v1/admin/analytics/overview?preset=today').expect(200))
        .body.data;
      expect(s.money).toBeNull();
      // Served from the cache: a booking made now doesn't show until it expires.
      const user = await register(target, 'k@example.com');
      await book(user);
      const again = (await admin.get('/api/v1/admin/analytics/overview?preset=today').expect(200))
        .body.data;
      expect(again.generatedAt).toBe(first.generatedAt);
      expect(again.bookings.created.demo.value).toBe(0);
      // A different query is a different entry.
      const weekly = (
        await admin
          .get('/api/v1/admin/analytics/overview?preset=today&granularity=week')
          .expect(200)
      ).body.data;
      expect(weekly.bookings.created.demo.value).toBe(1);
    });
  });
});
