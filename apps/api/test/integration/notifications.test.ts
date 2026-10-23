import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMAIL_NOT_CONFIGURED_STATUS,
  bookingRequirementsFor,
  bookingSchema,
  notificationListResponseSchema,
  notificationPreferencesSchema,
  notificationSchema,
  type Booking,
  type Notification,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import { createPaymentsService } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import { transitionBooking } from '../../src/modules/bookings/lifecycle.js';
import { createTravelReminders } from '../../src/modules/notifications/reminders.js';
import type { PaymentProvider } from '../../src/modules/payments/providers/types.js';
import { buildTestApp, validEnvSource } from '../helpers.js';
import { SIGNATURE_HEADER, SignedTestGateway, sign } from '../payment-support.js';
import { VALID_INPUTS } from '../search-support.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Notifications against a real PostgreSQL: created with the booking and
 * payment changes they report (same transaction), once per event, owned,
 * paged, marked read, and the email outbox they queue.
 */

const MINUTE = 60 * 1000;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the notification tests would be skipped.',
  );
}

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
};

function app(
  options: {
    clock?: ReturnType<typeof testClock>;
    providers?: { policy?: PaymentProvider | null };
  } = {},
) {
  return buildTestApp({
    prisma: testPrisma(),
    env: BASE_ENV,
    logger: pino({ level: 'silent' }),
    ...(options.clock ? { now: options.clock.now } : {}),
    ...(options.providers ? { paymentProviders: options.providers } : {}),
  });
}

async function signedIn(target: ReturnType<typeof app>, email = 'asha@example.com') {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: 'blue river morning' });
  expect(res.status).toBe(201);
  return agent;
}

async function book(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const search = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
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

async function list(
  agent: Agent,
  query = '',
): Promise<{
  items: Notification[];
  unreadCount: number;
  pagination: { totalResults: number; totalPages: number };
}> {
  const res = await agent.get(`/api/v1/notifications${query}`);
  expect(res.status).toBe(200);
  return notificationListResponseSchema.parse(res.body.data);
}
const types = async (agent: Agent) => (await list(agent)).items.map((n) => n.type);

describe.skipIf(!TEST_DATABASE_URL)('notifications (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('created with the change they report', () => {
    it('booking then demo payment: one notification each, demo-labelled, linked, with an email queued', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      let page = await list(agent);
      expect(page.unreadCount).toBe(1);
      expect(page.items[0]).toMatchObject({
        type: 'booking_created',
        category: 'booking',
        demo: true,
        read: false,
        title: 'Demo booking saved: payment needed',
        link: { kind: 'booking', bookingReference: booking.reference },
      });
      expect(page.items[0]!.message).toContain(booking.reference);
      expect(page.items[0]!.message).toMatch(/no supplier was contacted and no ticket was issued/);

      const paid = await pay(agent, booking);
      page = await list(agent);
      // The success confirms the booking: ONE notification for that transition.
      expect(page.items.map((n) => n.type)).toEqual(['payment_succeeded', 'booking_created']);
      expect(page.items[0]).toMatchObject({
        title: 'Demo payment succeeded',
        link: {
          kind: 'payment',
          bookingReference: booking.reference,
          paymentId: paid.body.data.id,
        },
      });
      expect(page.items[0]!.message).toMatch(/No real money was charged/);
      expect(page.items[0]!.message).not.toMatch(/Asha|Rao/);

      const deliveries = await testPrisma().notificationDelivery.findMany();
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.status === 'PENDING' && d.channel === 'EMAIL')).toBe(true);
    });

    it('a booking confirmed without payment gets one “confirmed” notification', async () => {
      const agent = await signedIn(app());
      await book(agent, 'cabs');
      expect(await types(agent)).toEqual(['booking_confirmed']);
    });

    it('declined, pending then settled, and cancelled payments; repeated checks add nothing', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      await pay(agent, booking, { demoScenario: 'decline' });
      const pending = await pay(agent, booking, { demoScenario: 'pending' });
      for (let i = 0; i < 3; i += 1) await agent.get(`/api/v1/payments/${pending.body.data.id}`);
      clock.advance(9_000);
      for (let i = 0; i < 3; i += 1) await agent.get(`/api/v1/payments/${pending.body.data.id}`);
      expect(await types(agent)).toEqual([
        'payment_succeeded',
        'payment_pending',
        'payment_failed',
        'booking_created',
      ]);
      expect((await list(agent)).items[2]!.title).toBe('Demo payment declined');

      // A payment the owner cancels themselves produces no notification.
      const other = await book(agent);
      const p = await pay(agent, other, { demoScenario: 'pending' });
      await agent.post(`/api/v1/payments/${p.body.data.id}/cancel`).set('Origin', ORIGIN);
      const after = await types(agent);
      expect(after.filter((t) => t === 'payment_pending')).toHaveLength(2);
      expect(after).not.toContain('payment_cancelled');
    });

    it('cancelled and expired bookings, once each; refused changes notify nobody', async () => {
      const clock = testClock();
      const target = app({ clock });
      const agent = await signedIn(target);
      const paid = await book(agent);
      await pay(agent, paid);
      await agent.post(`/api/v1/bookings/${paid.reference}/cancel`).set('Origin', ORIGIN);
      const again = await agent
        .post(`/api/v1/bookings/${paid.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(again.status).toBe(409);
      const cancelled = (await list(agent)).items.filter((n) => n.type === 'booking_cancelled');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.message).toMatch(
        /demo provider can’t refund; no real money was charged/,
      );

      const unpaid = await book(agent);
      clock.advance(31 * MINUTE);
      const service = createPaymentsService(
        testPrisma(),
        { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
        pino({ level: 'silent' }),
        { now: clock.now },
      );
      await service.expireOverdueBookings();
      await service.expireOverdueBookings();
      await agent.get(`/api/v1/bookings/${unpaid.reference}`);
      const expired = (await list(agent)).items.filter((n) => n.type === 'booking_expired');
      expect(expired).toHaveLength(1);
      expect(expired[0]!.message).toMatch(/Nothing was charged/);

      // Refused: a payment for the expired booking, and a tampered amount elsewhere.
      const before = (await list(agent)).pagination.totalResults;
      expect((await pay(agent, unpaid)).status).toBe(409);
      const fresh = await book(agent);
      const tampered = await agent
        .post(`/api/v1/bookings/${fresh.reference}/payments`)
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: { ...fresh.payment.amount!, amountMinor: '1' } });
      expect(tampered.status).toBe(409);
      expect((await list(agent)).pagination.totalResults).toBe(before + 1); // only fresh's "created"
    });

    it('a payment that succeeds after its booking was cancelled says the booking stays cancelled', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      const res = await pay(agent, booking, { demoScenario: 'pending' });
      const prisma = testPrisma();
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference: booking.reference },
      });
      await prisma.$transaction((tx) =>
        transitionBooking(tx, clock.now(), row.id, 'PENDING', 'CANCELLED', {
          actorType: 'USER',
          note: 'Race.',
        }),
      );
      clock.advance(9_000);
      await agent.get(`/api/v1/payments/${res.body.data.id}`);
      const [latest] = (await list(agent)).items;
      expect(latest).toMatchObject({
        type: 'payment_succeeded',
        title: 'Demo payment completed after the booking closed',
      });
      expect(latest!.message).toMatch(/stays cancelled.*can’t refund; no real money/);
    });

    it('provider events: duplicates and out-of-order events add nothing; a confirmed refund notifies', async () => {
      const gateway = new SignedTestGateway();
      const target = app({ providers: { policy: gateway } });
      const agent = await signedIn(target);
      const booking = await book(agent);
      const res = await pay(agent, booking);
      const ref = SignedTestGateway.reference(res.body.data.id);
      const post = (events: object[]) => {
        const body = JSON.stringify({ events });
        return request(target)
          .post('/api/v1/payment-events/test-gateway')
          .set('Content-Type', 'application/json')
          .set(SIGNATURE_HEADER, sign(body, Math.floor(Date.now() / 1000)))
          .send(body);
      };
      const event = (type: string, id = `evt_${type}`) => ({
        id,
        type,
        providerReference: ref,
        occurredAt: new Date().toISOString(),
      });
      await post([event('payment.succeeded')]);
      await post([event('payment.succeeded')]);
      await post([event('payment.pending', 'evt_late'), event('payment.failed', 'evt_late2')]);
      expect(await types(agent)).toEqual([
        'payment_succeeded',
        'payment_pending',
        'booking_created',
      ]);
      expect((await list(agent)).items[0]).toMatchObject({
        title: 'Payment received',
        demo: false,
      });

      const service = createPaymentsService(
        testPrisma(),
        { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
        pino({ level: 'silent' }),
        { providers: { policy: new SignedTestGateway() } },
      );
      const payment = await testPrisma().payment.findUniqueOrThrow({
        where: { id: res.body.data.id },
      });
      await service.requestRefund(payment.userId, payment.id);
      expect((await types(agent))[0]).toBe('payment_succeeded'); // refund pending: no notification
      await post([event('refund.succeeded')]);
      await post([event('refund.succeeded')]);
      const refunded = (await list(agent)).items.filter((n) => n.type === 'payment_refunded');
      expect(refunded).toHaveLength(1);
      expect(refunded[0]!.title).toBe('Refund confirmed');
    });

    it('travel reminders: once, the day before a confirmed booking starts; none for others', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const confirmed = await book(agent);
      await pay(agent, confirmed);
      const cancelled = await book(agent);
      await agent.post(`/api/v1/bookings/${cancelled.reference}/cancel`).set('Origin', ORIGIN);
      const unpaid = await book(agent);
      // Not yet: the trip isn't tomorrow.
      expect(await createTravelReminders(testPrisma(), clock.now())).toBe(0);
      // The day before check-in (India calendar).
      const startsOn = Date.parse(`${confirmed.startsOn!}T00:00:00+05:30`);
      const dayBefore = new Date(startsOn - 12 * 60 * MINUTE);
      expect(await createTravelReminders(testPrisma(), dayBefore)).toBe(1);
      expect(await createTravelReminders(testPrisma(), dayBefore)).toBe(0);
      const reminders = (await list(agent)).items.filter((n) => n.type === 'travel_reminder');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        category: 'reminder',
        title: 'Your demo trip is tomorrow',
        link: { kind: 'booking', bookingReference: confirmed.reference },
      });
      expect(reminders[0]!.message).toMatch(/no ticket or supplier reservation exists/);
      expect(unpaid.status).toBe('pending');
    });

    it('a notification that can’t be written rolls back the booking with it', async () => {
      const agent = await signedIn(app());
      const prisma = testPrisma();
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_fail_notifications BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION test_fail_notifications()`);
      try {
        const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
        const search = await agent.post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
        const offer = search.body.data.results[0] as SearchResult;
        const res = await agent
          .post('/api/v1/bookings')
          .set('Origin', ORIGIN)
          .set('Idempotency-Key', randomUUID())
          .send({
            serviceType: 'hotels',
            searchId: search.body.data.searchId,
            offerId: offer.id,
            travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
            acceptedPrice: offer.price,
            acceptDemoTerms: true,
          });
        expect(res.status).toBe(500);
        expect(await prisma.booking.count()).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS test_fail_notifications ON notifications',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_notifications()');
      }
    });
  });

  describe('reading and managing them', () => {
    async function seed(userId: string, count: number, at: Date) {
      // Same timestamp for all: order must still be deterministic (by id).
      await testPrisma().notification.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          userId,
          type: 'BOOKING_CONFIRMED' as const,
          title: `Seeded ${i}`,
          message: 'Seeded notification.',
          isDemo: true,
          dedupeKey: `seed:${userId}:${i}`,
          createdAt: at,
        })),
      });
    }
    const userIdOf = async (email: string) =>
      (await testPrisma().user.findUniqueOrThrow({ where: { email } })).id;

    it('pages newest first with a deterministic order, and counts unread for this user only', async () => {
      const target = app();
      const asha = await signedIn(target);
      const ravi = await signedIn(target, 'ravi@example.com');
      await seed(await userIdOf('asha@example.com'), 25, new Date());
      await seed(await userIdOf('ravi@example.com'), 3, new Date());
      const first = await list(asha, '?pageSize=10');
      const second = await list(asha, '?pageSize=10&page=2');
      const third = await list(asha, '?pageSize=10&page=3');
      const ids = [...first.items, ...second.items, ...third.items].map((n) => n.id);
      expect(new Set(ids).size).toBe(25);
      expect(ids).toEqual([...ids].sort().reverse());
      expect(first).toMatchObject({
        unreadCount: 25,
        pagination: { totalResults: 25, totalPages: 3 },
      });
      expect((await ravi.get('/api/v1/notifications/unread-count')).body.data).toEqual({
        unread: 3,
      });
      expect((await list(asha, '?pageSize=10')).items.map((n) => n.id)).toEqual(
        first.items.map((n) => n.id),
      );
    });

    it('marks one and all as read, only its own; counts follow the stored state', async () => {
      const target = app();
      const asha = await signedIn(target);
      const ravi = await signedIn(target, 'ravi@example.com');
      await seed(await userIdOf('asha@example.com'), 3, new Date(Date.now() - 1000));
      await seed(await userIdOf('ravi@example.com'), 2, new Date(Date.now() - 1000));
      const [one] = (await list(asha)).items;
      const read = await asha.patch(`/api/v1/notifications/${one!.id}/read`).set('Origin', ORIGIN);
      expect(read.status).toBe(200);
      const marked = notificationSchema.parse(read.body.data);
      expect(marked.read).toBe(true);
      // Idempotent: the first read time stays.
      const again = await asha.patch(`/api/v1/notifications/${one!.id}/read`).set('Origin', ORIGIN);
      expect(again.body.data.readAt).toBe(marked.readAt);
      expect((await asha.get('/api/v1/notifications/unread-count')).body.data.unread).toBe(2);
      expect((await list(asha, '?unread=true')).items).toHaveLength(2);

      // Ravi can't touch Asha's: "not found", and nothing changes.
      const [ashas] = (await list(asha, '?unread=true')).items;
      const foreign = await ravi
        .patch(`/api/v1/notifications/${ashas!.id}/read`)
        .set('Origin', ORIGIN);
      expect(foreign.status).toBe(404);
      expect(JSON.stringify(foreign.body)).not.toContain(ashas!.id);
      const all = await ravi.post('/api/v1/notifications/read-all').set('Origin', ORIGIN);
      expect(all.body.data).toEqual({ updated: 2, unread: 0 });
      expect((await asha.get('/api/v1/notifications/unread-count')).body.data.unread).toBe(2);
      expect(
        (await asha.post('/api/v1/notifications/read-all').set('Origin', ORIGIN)).body.data,
      ).toEqual({
        updated: 2,
        unread: 0,
      });
    });

    it('refuses signed-out, cross-site, malformed and unknown requests', async () => {
      const target = app();
      const asha = await signedIn(target);
      expect((await request(target).get('/api/v1/notifications')).status).toBe(401);
      expect((await request(target).get('/api/v1/notifications/unread-count')).status).toBe(401);
      expect(
        (await asha.post('/api/v1/notifications/read-all').set('Origin', 'https://evil.example'))
          .status,
      ).toBe(403);
      expect(
        (await asha.patch('/api/v1/notifications/not-a-uuid/read').set('Origin', ORIGIN)).status,
      ).toBe(400);
      expect(
        (await asha.patch(`/api/v1/notifications/${randomUUID()}/read`).set('Origin', ORIGIN))
          .status,
      ).toBe(404);
      for (const q of ['?page=0', '?pageSize=500', '?userId=x', '?unread=maybe']) {
        expect((await asha.get(`/api/v1/notifications${q}`)).status).toBe(400);
      }
      expect((await asha.get('/api/v1/notifications')).headers['cache-control']).toBe('no-store');
      expect(
        (await asha.delete(`/api/v1/notifications/${randomUUID()}`).set('Origin', ORIGIN)).status,
      ).toBe(404);
    });

    it('survives an API restart (it is in the database)', async () => {
      const first = app();
      const agent = await signedIn(first);
      await book(agent);
      // A new app instance (as after a restart) over the same database.
      const restarted = app();
      const again = request.agent(restarted);
      await again
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'asha@example.com', password: 'blue river morning' });
      expect((await list(again)).items.map((n) => n.type)).toEqual(['booking_created']);
    });

    it('content can’t be rewritten in the database; only the read time changes', async () => {
      const agent = await signedIn(app());
      await book(agent);
      const prisma = testPrisma();
      const row = await prisma.notification.findFirstOrThrow();
      await expect(
        prisma.notification.update({
          where: { id: row.id },
          data: { message: 'Your real ticket is ready' },
        }),
      ).rejects.toThrow(/only read_at can change/);
      await expect(
        prisma.notification.update({ where: { id: row.id }, data: { readAt: new Date() } }),
      ).resolves.toBeTruthy();
    });
  });

  describe('email preferences', () => {
    it('default on, report that email isn’t configured, and only decide whether an email is queued', async () => {
      const agent = await signedIn(app());
      const prefs = notificationPreferencesSchema.parse(
        (await agent.get('/api/v1/notifications/preferences')).body.data,
      );
      expect(prefs).toEqual({
        emailBookings: true,
        emailPayments: true,
        emailReminders: true,
        email: { active: false, status: EMAIL_NOT_CONFIGURED_STATUS },
      });
      const updated = await agent
        .patch('/api/v1/notifications/preferences')
        .set('Origin', ORIGIN)
        .send({ emailPayments: false });
      expect(updated.body.data).toMatchObject({ emailBookings: true, emailPayments: false });
      for (const body of [
        {},
        { emailPayments: 'no' },
        { sms: true },
        { userId: randomUUID(), emailBookings: false },
      ]) {
        expect(
          (await agent.patch('/api/v1/notifications/preferences').set('Origin', ORIGIN).send(body))
            .status,
        ).toBe(400);
      }

      const booking = await book(agent);
      await pay(agent, booking);
      // Both in-app notifications exist; only the booking one queued an email.
      expect(await types(agent)).toEqual(['payment_succeeded', 'booking_created']);
      const deliveries = await testPrisma().notificationDelivery.findMany({
        include: { notification: { select: { type: true } } },
      });
      expect(deliveries.map((d) => d.notification.type)).toEqual(['BOOKING_CREATED']);
      expect(deliveries[0]).toMatchObject({ status: 'PENDING', sentAt: null });
    });
  });
});
