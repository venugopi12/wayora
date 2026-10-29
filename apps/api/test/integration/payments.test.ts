import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  DEMO_PAYMENT_NOTICE,
  bookingRequirementsFor,
  bookingSchema,
  paymentListResponseSchema,
  paymentSchema,
  type Booking,
  type Payment,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import { createPaymentsService } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { transitionBooking } from '../../src/modules/bookings/lifecycle.js';
import { PAYMENT_TRANSITIONS } from '../../src/modules/payments/events.js';
import { DemoPaymentProvider } from '../../src/modules/payments/providers/demo.js';
import type { PaymentProvider } from '../../src/modules/payments/providers/types.js';
import { captureLogs } from '../fake-redis.js';
import { buildTestApp, validEnvSource } from '../helpers.js';
import {
  FailingProvider,
  SIGNATURE_HEADER,
  SignedTestGateway,
  SlowDemoProvider,
  sign,
} from '../payment-support.js';
import { VALID_INPUTS } from '../search-support.js';
import { parseEnv } from '../../src/config/env.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Payments against a real PostgreSQL (TEST_DATABASE_URL): the demo provider,
 * the payment lifecycle and its effect on bookings, idempotency under
 * concurrency, provider events (dedupe, ordering, signatures), ownership and
 * the database's own guards.
 */

const PASSWORD = 'blue river morning';
const MINUTE = 60 * 1000;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the payment tests would be skipped.');
}

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
  PAYMENT_WINDOW_MINUTES: 30,
  PAYMENT_DEMO_PENDING_SECONDS: 8,
};

function app(
  options: {
    clock?: ReturnType<typeof testClock>;
    logs?: ReturnType<typeof captureLogs>;
    env?: Partial<Env>;
    providers?: { policy?: PaymentProvider | null; extra?: readonly PaymentProvider[] };
  } = {},
) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...options.env },
    logger: options.logs ? pino({ level: 'info' }, options.logs.stream) : pino({ level: 'silent' }),
    ...(options.clock ? { now: options.clock.now } : {}),
    ...(options.providers ? { paymentProviders: options.providers } : {}),
  });
}

async function signedIn(target: Parameters<typeof request.agent>[0], email = 'asha@example.com') {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function search(agent: Agent, type: SearchServiceType) {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const res = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
  expect(res.status).toBe(200);
  return {
    searchId: res.body.data.searchId as string,
    offers: res.body.data.results as SearchResult[],
  };
}

function bookingBody(searchId: string, offer: SearchResult) {
  const requirements = bookingRequirementsFor(offer);
  return {
    serviceType: offer.serviceType,
    searchId,
    offerId: offer.id,
    travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
    ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
    acceptedPrice: offer.price,
    acceptDemoTerms: true,
  };
}

async function book(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const { searchId, offers } = await search(agent, type);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(bookingBody(searchId, offers[0]!));
  expect(res.status).toBe(201);
  return bookingSchema.parse(res.body.data);
}

const pay = (agent: Agent, reference: string, body: object, key: string = randomUUID()) =>
  agent
    .post(`/api/v1/bookings/${reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', key)
    .send(body);

const amountOf = (booking: Booking) => booking.payment.amount!;

const getBooking = async (agent: Agent, reference: string) =>
  bookingSchema.parse((await agent.get(`/api/v1/bookings/${reference}`)).body.data);

const getPayment = async (agent: Agent, id: string): Promise<Payment> => {
  const res = await agent.get(`/api/v1/payments/${id}`);
  expect(res.status).toBe(200);
  return paymentSchema.parse(res.body.data);
};

const rows = async () => {
  const prisma = testPrisma();
  return {
    payments: await prisma.payment.count(),
    succeeded: await prisma.payment.count({ where: { status: 'SUCCEEDED' } }),
    events: await prisma.paymentStatusEvent.count(),
    providerEvents: await prisma.webhookEvent.count(),
  };
};

describe.skipIf(!TEST_DATABASE_URL)('payments (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('bookings that need a payment', () => {
    it('a priced booking waits for its demo payment; an estimate-priced one needs none', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const hotel = await book(agent, 'hotels');
      expect(hotel.status).toBe('pending');
      expect(hotel.payment).toEqual({
        mode: 'demo',
        state: 'unpaid',
        amount: (hotel.price as { total: { amountMinor: string; currency: string } }).total,
        dueAt: new Date(clock.now().getTime() + 30 * MINUTE).toISOString(),
        canPay: true,
        activePaymentId: null,
        demoScenarios: ['succeed', 'decline', 'pending', 'pending-decline'],
      });
      expect(hotel.history.map((h) => h.status)).toEqual(['pending']);
      expect(hotel.history[0]!.note).toMatch(/confirmed once its demo payment succeeds/);
      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: hotel.reference },
      });
      expect(row).toMatchObject({ paymentMode: 'DEMO', status: 'PENDING', confirmedAt: null });

      // Cab fares are ranges: there is no exact amount to take.
      const cab = await book(agent, 'cabs');
      expect(cab.status).toBe('confirmed');
      expect(cab.payment).toMatchObject({
        mode: 'none',
        state: 'not-required',
        canPay: false,
        amount: null,
      });
      const res = await pay(agent, cab.reference, {
        amount: { amountMinor: '100', currency: 'INR' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_ALLOWED');
    });

    it('with payments off, bookings are confirmed without a payment and can’t be paid', async () => {
      const agent = await signedIn(
        app({ env: { PAYMENT_PROVIDER: 'none', PAYMENT_DEMO_SCENARIOS: 'false' } }),
      );
      const hotel = await book(agent, 'hotels');
      expect(hotel.status).toBe('confirmed');
      expect(hotel.payment.mode).toBe('none');
      const res = await pay(agent, hotel.reference, {
        amount: { amountMinor: '100', currency: 'INR' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_ALLOWED');
      expect(await rows()).toMatchObject({ payments: 0 });
    });
  });

  describe('the demo payment lifecycle', () => {
    it('succeeds: server amount, demo notice, history, provider event, and the booking’s demo confirmation', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(res.status).toBe(201);
      const payment = paymentSchema.parse(res.body.data);
      expect(payment).toMatchObject({
        bookingReference: booking.reference,
        attempt: 1,
        status: 'succeeded',
        mode: 'demo',
        demo: true,
        amount: amountOf(booking),
        demoScenario: 'succeed',
        failure: null,
        cancellable: false,
        refund: { required: false, supported: false },
        notice: DEMO_PAYMENT_NOTICE,
      });
      expect(payment.notice).toBe('Demo payment — no real money was charged.');
      expect(payment.completedAt).not.toBeNull();
      expect(payment.history.map((h) => [h.status, h.by])).toEqual([
        ['created', 'you'],
        ['succeeded', 'provider'],
      ]);
      // No provider internals in the response.
      expect(JSON.stringify(res.body)).not.toMatch(/demo_pay_|providerReference|idempotency/i);

      const after = await getBooking(agent, booking.reference);
      expect(after.status).toBe('confirmed');
      expect(after.payment).toMatchObject({ state: 'paid', canPay: false, demoScenarios: null });
      expect(after.history.at(-1)).toMatchObject({ status: 'confirmed', by: 'wayora' });
      expect(after.history.at(-1)!.note).toMatch(/after a demo payment.*no real money was charged/);

      const prisma = testPrisma();
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(row.providerReference).toMatch(/^demo_pay_[0-9a-f]{32}$/);
      expect(row.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.amountMinor.toString()).toBe(amountOf(booking).amountMinor);
      const events = await prisma.webhookEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'demo',
        eventType: 'payment.succeeded',
        status: 'PROCESSED',
        signatureVerified: true,
      });
      expect(events[0]!.payload).toMatchObject({ source: 'call', failureCode: null });
      expect(
        (await prisma.auditLog.findMany({ where: { entityType: 'payment' } }))
          .map((a) => a.action)
          .sort(),
      ).toEqual(['payment.created', 'payment.succeeded']);

      // Paid once: no second payment.
      const again = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/already paid/);
    });

    it('a declined payment leaves the booking payable; the next attempt can succeed', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const declined = paymentSchema.parse(
        (
          await pay(agent, booking.reference, {
            amount: amountOf(booking),
            demoScenario: 'decline',
          })
        ).body.data,
      );
      expect(declined).toMatchObject({
        status: 'failed',
        failure: {
          code: 'demo_declined',
          message: expect.stringMatching(/declined \(simulated\)/),
        },
      });
      const between = await getBooking(agent, booking.reference);
      expect(between).toMatchObject({
        status: 'pending',
        payment: { state: 'unpaid', canPay: true },
      });

      const second = paymentSchema.parse(
        (await pay(agent, booking.reference, { amount: amountOf(booking) })).body.data,
      );
      expect(second).toMatchObject({ attempt: 2, status: 'succeeded' });
      const list = paymentListResponseSchema.parse(
        (await agent.get(`/api/v1/bookings/${booking.reference}/payments`)).body.data,
      );
      expect(list.items.map((p) => [p.attempt, p.status])).toEqual([
        [2, 'succeeded'],
        [1, 'failed'],
      ]);
      expect((await getBooking(agent, booking.reference)).status).toBe('confirmed');
    });

    it('a pending payment settles later; the provider is asked again, and its events apply once', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      const pending = paymentSchema.parse(
        (
          await pay(agent, booking.reference, {
            amount: amountOf(booking),
            demoScenario: 'pending',
          })
        ).body.data,
      );
      expect(pending).toMatchObject({ status: 'pending', cancellable: true, completedAt: null });
      const during = await getBooking(agent, booking.reference);
      expect(during).toMatchObject({
        status: 'pending',
        payment: { state: 'processing', canPay: false, activePaymentId: pending.id },
      });
      // Only one attempt at a time.
      const second = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/already in progress/);
      // Still pending before the provider settles; polling repeats the same event.
      expect((await getPayment(agent, pending.id)).status).toBe('pending');
      expect(await rows()).toMatchObject({ providerEvents: 1 });

      clock.advance(9_000);
      const settled = await getPayment(agent, pending.id);
      expect(settled.status).toBe('succeeded');
      expect(settled.history.map((h) => h.status)).toEqual(['created', 'pending', 'succeeded']);
      expect((await getBooking(agent, booking.reference)).status).toBe('confirmed');
      // Asking again changes nothing: each provider event is stored and applied once.
      await getPayment(agent, pending.id);
      await agent.get(`/api/v1/bookings/${booking.reference}/payments`);
      expect(await rows()).toMatchObject({
        payments: 1,
        succeeded: 1,
        events: 3,
        providerEvents: 2,
      });
    });

    it('a pending payment can be declined later', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'pending-decline',
      });
      clock.advance(9_000);
      const payment = await getPayment(agent, res.body.data.id);
      expect(payment).toMatchObject({ status: 'failed', failure: { code: 'demo_declined' } });
      expect((await getBooking(agent, booking.reference)).payment).toMatchObject({ canPay: true });
    });

    it('cancels a pending payment once; it never settles afterwards and isn’t shown as refunded', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'pending',
      });
      const id = res.body.data.id as string;
      const cancelled = await agent.post(`/api/v1/payments/${id}/cancel`).set('Origin', ORIGIN);
      expect(cancelled.status).toBe(200);
      expect(paymentSchema.parse(cancelled.body.data)).toMatchObject({
        status: 'cancelled',
        cancellable: false,
        failure: { code: 'cancelled' },
        refund: { required: false },
      });
      const again = await agent.post(`/api/v1/payments/${id}/cancel`).set('Origin', ORIGIN);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PAYMENT_NOT_CANCELLABLE');
      // The settlement time passes: a cancelled attempt stays cancelled.
      clock.advance(60_000);
      expect((await getPayment(agent, id)).status).toBe('cancelled');
      expect(await getBooking(agent, booking.reference)).toMatchObject({
        status: 'pending',
        payment: { state: 'unpaid', canPay: true },
      });
      // A completed payment can't be cancelled.
      const paid = await pay(agent, booking.reference, { amount: amountOf(booking) });
      const late = await agent
        .post(`/api/v1/payments/${paid.body.data.id}/cancel`)
        .set('Origin', ORIGIN);
      expect(late.status).toBe(409);
    });

    it('allows only the documented payment transitions', () => {
      expect(PAYMENT_TRANSITIONS).toEqual({
        CREATED: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
        PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
        // Phase 23: some providers report a refund as done without a pending step.
        SUCCEEDED: ['REFUND_PENDING', 'REFUNDED'],
        REFUND_PENDING: ['REFUNDED', 'SUCCEEDED'],
        FAILED: [],
        CANCELLED: [],
        REFUNDED: [],
      });
    });
  });

  describe('trust: amounts, statuses and scenarios', () => {
    it('refuses a tampered amount or currency, and any client-sent status', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const amount = amountOf(booking);
      const cheaper = await pay(agent, booking.reference, {
        amount: { ...amount, amountMinor: String(BigInt(amount.amountMinor) - 1n) },
      });
      expect(cheaper.status).toBe(409);
      expect(cheaper.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      const dollars = await pay(agent, booking.reference, {
        amount: { ...amount, currency: 'USD' },
      });
      expect(dollars.status).toBe(409);
      expect(dollars.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      for (const body of [
        { amount, status: 'succeeded' },
        { amount, outcome: 'succeeded' },
        { amount: { amountMinor: '12.50', currency: amount.currency } },
        { amount, demoScenario: 'refund' },
        {},
      ]) {
        const res = await pay(agent, booking.reference, body);
        expect(res.status).toBe(400);
      }
      expect(await rows()).toMatchObject({ payments: 0 });
      // A failed request frees its key: the corrected request may reuse it.
      const key = randomUUID();
      expect(
        (await pay(agent, booking.reference, { amount: { ...amount, currency: 'USD' } }, key))
          .status,
      ).toBe(409);
      expect((await pay(agent, booking.reference, { amount }, key)).status).toBe(201);
    });

    it('refuses demo scenarios unless the server enables them', async () => {
      const agent = await signedIn(app({ env: { PAYMENT_DEMO_SCENARIOS: 'false' } }));
      const booking = await book(agent);
      expect(booking.payment.demoScenarios).toBeNull();
      const res = await pay(agent, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'decline',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/scenarios aren’t available/);
      const ok = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(ok.body.data).toMatchObject({ status: 'succeeded', demoScenario: 'succeed' });
    });

    it('there is no public callback that can mark a payment successful', async () => {
      const target = app();
      const agent = await signedIn(target);
      const booking = await book(agent);
      const pending = await pay(agent, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'pending',
      });
      const ref = DemoPaymentProvider.reference(pending.body.data.id);
      const forged = {
        events: [
          {
            id: `${ref}:payment.succeeded`,
            type: 'payment.succeeded',
            providerReference: ref,
            occurredAt: new Date().toISOString(),
          },
        ],
      };
      for (const path of [
        '/api/v1/payment-events/demo',
        `/api/v1/payments/${pending.body.data.id}/succeed`,
        `/api/v1/payments/${pending.body.data.id}/confirm`,
        `/api/v1/payments/${pending.body.data.id}`,
      ]) {
        const res = await request(target).post(path).send(forged);
        expect([401, 404]).toContain(res.status);
        const signedInRes = await agent.post(path).set('Origin', ORIGIN).send(forged);
        expect([400, 404]).toContain(signedInRes.status);
      }
      expect((await getPayment(agent, pending.body.data.id)).status).toBe('pending');
      expect(await rows()).toMatchObject({ succeeded: 0 });
    });
  });

  describe('bookings that can no longer be paid', () => {
    it('cancelled and expired bookings refuse new payments', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const cancelledBooking = await book(agent);
      await agent
        .post(`/api/v1/bookings/${cancelledBooking.reference}/cancel`)
        .set('Origin', ORIGIN);
      const refused = await pay(agent, cancelledBooking.reference, {
        amount: amountOf(cancelledBooking),
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/cancelled/);

      const unpaid = await book(agent);
      clock.advance(31 * MINUTE);
      const expired = await getBooking(agent, unpaid.reference);
      expect(expired).toMatchObject({
        status: 'expired',
        cancellable: false,
        payment: { state: 'closed', canPay: false },
      });
      expect(expired.history.at(-1)).toMatchObject({ status: 'expired', by: 'wayora' });
      const late = await pay(agent, unpaid.reference, { amount: amountOf(unpaid) });
      expect(late.status).toBe(409);
      expect(late.body.error.message).toMatch(/expired before it was paid/);
      const cancel = await agent
        .post(`/api/v1/bookings/${unpaid.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(cancel.status).toBe(409);
      // Expired bookings are listed with cancelled ones.
      const list = (await agent.get('/api/v1/bookings?view=cancelled')).body.data;
      expect(list.items.map((b: { reference: string }) => b.reference).sort()).toEqual(
        [cancelledBooking.reference, unpaid.reference].sort(),
      );
      expect(await rows()).toMatchObject({ payments: 0 });
    });

    it('the background job expires overdue bookings, but not while a payment is in progress', async () => {
      const clock = testClock();
      const target = app({ clock });
      const agent = await signedIn(target);
      const idle = await book(agent);
      const paying = await book(agent);
      await pay(agent, paying.reference, { amount: amountOf(paying), demoScenario: 'pending' });
      const service = createPaymentsService(
        testPrisma(),
        { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
        pino({ level: 'silent' }),
        { now: clock.now },
      );
      clock.advance(31 * MINUTE);
      // The pending attempt settles (succeeds) when reconciled; the idle booking expires.
      expect(await service.reconcileInProgress()).toBe(1);
      expect(await service.expireOverdueBookings()).toBe(1);
      expect((await getBooking(agent, idle.reference)).status).toBe('expired');
      expect((await getBooking(agent, paying.reference)).status).toBe('confirmed');
    });

    it('a payment that succeeds after its booking was cancelled leaves the booking cancelled and flags a refund', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'pending',
      });
      // The race: the booking is cancelled before the provider's success arrives.
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
      const payment = await getPayment(agent, res.body.data.id);
      expect(payment).toMatchObject({
        status: 'succeeded',
        refund: { required: true, supported: false },
      });
      expect(payment.history.at(-1)!.note).toMatch(
        /booking stays closed.*can’t refund.*no real money/,
      );
      const after = await getBooking(agent, booking.reference);
      expect(after).toMatchObject({
        status: 'cancelled',
        payment: { state: 'refund-required', canPay: false },
      });
      expect(after.history.map((h) => h.status)).not.toContain('confirmed');
      expect(
        await prisma.auditLog.count({
          where: { action: 'payment.succeeded_after_booking_closed' },
        }),
      ).toBe(1);
    });

    it('cancelling a booking cancels its pending payment; cancelling a paid one flags the refund, never “refunded”', async () => {
      const agent = await signedIn(app());
      const pendingBooking = await book(agent);
      const pending = await pay(agent, pendingBooking.reference, {
        amount: amountOf(pendingBooking),
        demoScenario: 'pending',
      });
      const cancel = await agent
        .post(`/api/v1/bookings/${pendingBooking.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(cancel.status).toBe(200);
      expect((await getPayment(agent, pending.body.data.id)).status).toBe('cancelled');

      const paidBooking = await book(agent);
      const paid = await pay(agent, paidBooking.reference, { amount: amountOf(paidBooking) });
      const cancelPaid = bookingSchema.parse(
        (await agent.post(`/api/v1/bookings/${paidBooking.reference}/cancel`).set('Origin', ORIGIN))
          .body.data,
      );
      expect(cancelPaid).toMatchObject({
        status: 'cancelled',
        payment: { state: 'refund-required' },
      });
      expect(cancelPaid.history.at(-1)!.note).toMatch(/demo provider can’t refund/);
      const payment = await getPayment(agent, paid.body.data.id);
      expect(payment).toMatchObject({
        status: 'succeeded',
        refund: { required: true, supported: false },
      });
    });
  });

  describe('idempotency and concurrency', () => {
    it('replays a repeated request and refuses the same key with a different request', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const key = randomUUID();
      const first = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
      const second = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data.id).toBe(first.body.data.id);
      const changed = await pay(
        agent,
        booking.reference,
        { amount: amountOf(booking), demoScenario: 'decline' },
        key,
      );
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(changed.body.error.message).toMatch(/payment request/);
      expect(await rows()).toMatchObject({ payments: 1, succeeded: 1 });
    });

    it('simultaneous duplicates (same key, or new keys) create one payment and one success', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const key = randomUUID();
      const sameKey = await Promise.all(
        Array.from({ length: 6 }, () =>
          pay(agent, booking.reference, { amount: amountOf(booking) }, key),
        ),
      );
      expect(sameKey.filter((r) => r.status === 201)).not.toHaveLength(0);
      for (const r of sameKey) expect([201, 409]).toContain(r.status);
      expect(new Set(sameKey.filter((r) => r.status === 201).map((r) => r.body.data.id)).size).toBe(
        1,
      );
      expect(await rows()).toMatchObject({ payments: 1, succeeded: 1 });

      const other = await book(agent);
      const newKeys = await Promise.all(
        Array.from({ length: 6 }, () =>
          pay(agent, other.reference, { amount: amountOf(other), demoScenario: 'pending' }),
        ),
      );
      expect(newKeys.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of newKeys.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('PAYMENT_NOT_ALLOWED');
      }
      expect(
        await testPrisma().payment.count({ where: { booking: { reference: other.reference } } }),
      ).toBe(1);
    });

    it('a retry after a client timeout returns the original payment, not a second one', async () => {
      const slow = new SlowDemoProvider({ pendingMs: 8_000 }, 400);
      // A real listening server, so the client can hang up while it works.
      const server = app({ providers: { policy: slow } }).listen(0);
      onTestFinished(() => void server.close());
      const agent = await signedIn(server);
      const booking = await book(agent);
      const key = randomUUID();
      // The client gives up before the server answers…
      await expect(
        pay(agent, booking.reference, { amount: amountOf(booking) }, key).timeout(100),
      ).rejects.toThrow(/Timeout/);
      // …and retries with the same key: while the first is running, "in progress"; after, a replay.
      const during = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
      expect([201, 409]).toContain(during.status);
      await new Promise((r) => setTimeout(r, 600));
      const after = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
      expect(after.status).toBe(201);
      expect(after.headers['idempotent-replayed']).toBe('true');
      expect(after.body.data.status).toBe('succeeded');
      expect(await rows()).toMatchObject({ payments: 1, succeeded: 1 });
    });

    it('a provider outage leaves the attempt to be reconciled; a refusal fails it; secrets never reach logs', async () => {
      const logs = captureLogs();
      const outage = new FailingProvider({ pendingMs: 8_000 }, 'unknown');
      const agent = await signedIn(app({ logs, providers: { policy: outage } }));
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(res.status).toBe(201);
      // Unknown outcome: neither failed nor succeeded.
      expect(res.body.data.status).toBe('created');
      expect(logs.text).toMatch(/Payment outcome unknown/);
      expect(logs.text).not.toContain('sk_live_123');

      const refusing = new FailingProvider({ pendingMs: 8_000 }, 'rejected');
      const agent2 = await signedIn(app({ providers: { policy: refusing } }), 'ravi@example.com');
      const booking2 = await book(agent2);
      const refused = await pay(agent2, booking2.reference, { amount: amountOf(booking2) });
      expect(refused.body.data).toMatchObject({
        status: 'failed',
        failure: { code: 'provider_rejected' },
      });
      expect((await getBooking(agent2, booking2.reference)).payment.canPay).toBe(true);
    });

    it('a database failure leaves no payment and frees the key; a failed event is retried later', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const prisma = testPrisma();
      const key = randomUUID();
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_payment_events() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_fail_payment_events BEFORE INSERT ON payment_status_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_payment_events()`);
      try {
        const res = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toMatch(/injected|trigger|payment_status_events/);
        expect(await rows()).toMatchObject({ payments: 0, events: 0 });
        expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS test_fail_payment_events ON payment_status_events',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_payment_events()');
      }
      expect((await pay(agent, booking.reference, { amount: amountOf(booking) }, key)).status).toBe(
        201,
      );

      // Now a failure while applying a provider event: the booking's confirmation can't be written.
      const second = await book(agent);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_booking_events() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.to_status = 'CONFIRMED' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_fail_booking_events BEFORE INSERT ON booking_status_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_booking_events()`);
      let paymentId: string;
      try {
        // The attempt is recorded and the client told it is still in progress.
        const res = await pay(agent, second.reference, { amount: amountOf(second) });
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('created');
        const row = await prisma.payment.findFirstOrThrow({
          where: { booking: { reference: second.reference } },
        });
        paymentId = row.id;
        // The attempt exists (CREATED) but nothing of the success was half-written.
        expect(row.status).toBe('CREATED');
        expect((await getBooking(agent, second.reference)).status).toBe('pending');
        const event = await prisma.webhookEvent.findFirstOrThrow({
          where: { externalId: `${DemoPaymentProvider.reference(row.id)}:payment.succeeded` },
        });
        expect(event.status).toBe('FAILED');
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS test_fail_booking_events ON booking_status_events',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_booking_events()');
      }
      // Reading it reconciles: the failed event is retried and now applies.
      expect((await getPayment(agent, paymentId)).status).toBe('succeeded');
      expect((await getBooking(agent, second.reference)).status).toBe('confirmed');
      const event = await prisma.webhookEvent.findFirstOrThrow({
        where: { externalId: `${DemoPaymentProvider.reference(paymentId)}:payment.succeeded` },
      });
      expect(event).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    });
  });

  describe('signed provider events (a stand-in for a real gateway)', () => {
    async function gatewaySetup() {
      const gateway = new SignedTestGateway();
      const target = app({ providers: { policy: gateway } });
      const agent = await signedIn(target);
      const booking = await book(agent);
      const res = await pay(agent, booking.reference, { amount: amountOf(booking) });
      expect(res.body.data).toMatchObject({
        status: 'pending',
        mode: 'live',
        demo: false,
        notice: null,
      });
      const ref = SignedTestGateway.reference(res.body.data.id);
      const post = (events: object[], signature?: string) => {
        const body = JSON.stringify({ events });
        return request(target)
          .post('/api/v1/payment-events/test-gateway')
          .set('Content-Type', 'application/json')
          .set(SIGNATURE_HEADER, signature ?? sign(body, Math.floor(Date.now() / 1000)))
          .send(body);
      };
      const event = (type: string, id = `evt_${type}_${ref}`) => ({
        id,
        type,
        providerReference: ref,
        occurredAt: new Date().toISOString(),
      });
      return { gateway, agent, booking, paymentId: res.body.data.id as string, post, event, ref };
    }

    it('applies a verified event once; duplicates and out-of-order events change nothing', async () => {
      const { agent, booking, paymentId, post, event } = await gatewaySetup();
      const ok = await post([event('payment.succeeded')]);
      expect(ok.status).toBe(200);
      expect(ok.body.data.outcomes).toEqual(['applied']);
      expect((await getPayment(agent, paymentId)).status).toBe('succeeded');
      expect((await getBooking(agent, booking.reference)).status).toBe('confirmed');

      expect((await post([event('payment.succeeded')])).body.data.outcomes).toEqual(['duplicate']);
      // "pending" or "failed" after "succeeded": never a step backwards.
      const late = await post([
        event('payment.pending', 'evt_late_1'),
        event('payment.failed', 'evt_late_2'),
      ]);
      expect(late.body.data.outcomes).toEqual(['ignored', 'ignored']);
      const payment = await getPayment(agent, paymentId);
      expect(payment.status).toBe('succeeded');
      expect(payment.history.map((h) => h.status)).toEqual(['created', 'pending', 'succeeded']);
      const ignored = await testPrisma().webhookEvent.findMany({ where: { status: 'IGNORED' } });
      expect(ignored).toHaveLength(2);
      expect(ignored[0]!.lastError).toMatch(/Out of order/);
    });

    it('refuses bad signatures, stale timestamps and malformed events before storing anything', async () => {
      const { agent, paymentId, post, event } = await gatewaySetup();
      const before = await rows();
      const body = JSON.stringify({ events: [event('payment.succeeded')] });
      for (const signature of [
        'nonsense',
        sign(body, Math.floor(Date.now() / 1000), 'whsec_wrong'),
        sign(body, Math.floor(Date.now() / 1000) - 3600),
      ]) {
        const res = await post([event('payment.succeeded')], signature);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('The event could not be verified.');
      }
      const malformed = await post([
        { id: 'x', type: 'payment.teleported', providerReference: 'r' },
      ]);
      expect(malformed.status).toBe(400);
      expect(await rows()).toEqual(before);
      expect((await getPayment(agent, paymentId)).status).toBe('pending');
    });

    it('records an event for an unknown payment as failed (to be resent), and refunds only on the provider’s word', async () => {
      const { agent, paymentId, post, event, ref } = await gatewaySetup();
      const unknown = await post([
        { ...event('payment.succeeded', 'evt_unknown'), providerReference: 'tg_nope' },
      ]);
      expect(unknown.body.data.outcomes).toEqual(['unknown-payment']);
      expect(
        (await testPrisma().webhookEvent.findFirstOrThrow({ where: { externalId: 'evt_unknown' } }))
          .status,
      ).toBe('FAILED');

      await post([event('payment.succeeded')]);
      const service = createPaymentsService(
        testPrisma(),
        { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
        pino({ level: 'silent' }),
        { providers: { policy: new SignedTestGateway() } },
      );
      const user = await testPrisma().payment.findUniqueOrThrow({ where: { id: paymentId } });
      const refunding = await service.requestRefund(user.userId, paymentId);
      expect(refunding.status).toBe('refund_pending');
      expect(
        (await post([{ ...event('refund.succeeded'), providerReference: ref }])).body.data.outcomes,
      ).toEqual(['applied']);
      expect((await getPayment(agent, paymentId)).status).toBe('refunded');
    });

    it('the demo provider can’t refund: requesting one is refused, nothing is marked refunded', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const paid = await pay(agent, booking.reference, { amount: amountOf(booking) });
      const service = createPaymentsService(
        testPrisma(),
        { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
        pino({ level: 'silent' }),
      );
      const row = await testPrisma().payment.findUniqueOrThrow({
        where: { id: paid.body.data.id },
      });
      await expect(service.requestRefund(row.userId, row.id)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_ALLOWED',
      });
      expect((await getPayment(agent, row.id)).status).toBe('succeeded');
    });
  });

  describe('ownership and access', () => {
    it('another user’s payments are “not found”; signed-out, cross-site and malformed requests are refused', async () => {
      const target = app();
      const asha = await signedIn(target);
      const booking = await book(asha);
      const paid = await pay(asha, booking.reference, {
        amount: amountOf(booking),
        demoScenario: 'pending',
      });
      const id = paid.body.data.id as string;
      const ravi = await signedIn(target, 'ravi@example.com');
      for (const res of [
        await ravi.get(`/api/v1/payments/${id}`),
        await ravi.post(`/api/v1/payments/${id}/cancel`).set('Origin', ORIGIN),
        await ravi.get(`/api/v1/bookings/${booking.reference}/payments`),
        await pay(ravi, booking.reference, { amount: amountOf(booking) }),
      ]) {
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(id);
      }
      expect((await request(target).get(`/api/v1/payments/${id}`)).status).toBe(401);
      expect(
        (await asha.post(`/api/v1/payments/${id}/cancel`).set('Origin', 'https://evil.example'))
          .status,
      ).toBe(403);
      expect((await asha.get('/api/v1/payments/not-a-uuid')).status).toBe(400);
      const noKey = await asha
        .post(`/api/v1/bookings/${booking.reference}/payments`)
        .set('Origin', ORIGIN)
        .send({ amount: amountOf(booking) });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.message).toMatch(/Idempotency-Key.*payment attempt/);
      expect((await asha.get(`/api/v1/payments/${id}`)).headers['cache-control']).toBe('no-store');
      // Still Asha's and untouched.
      expect((await getPayment(asha, id)).status).toBe('pending');
    });

    it('limits payment writes per signed-in user', async () => {
      const agent = await signedIn(app({ env: { PAYMENT_RATE_LIMIT_MAX: 2 } }));
      const booking = await book(agent);
      const body = { amount: amountOf(booking), demoScenario: 'decline' };
      expect((await pay(agent, booking.reference, body)).status).toBe(201);
      expect((await pay(agent, booking.reference, body)).status).toBe(201);
      const limited = await pay(agent, booking.reference, body);
      expect(limited.status).toBe(429);
      expect(limited.body.error.message).toMatch(/payment requests/);
    });

    it('logs no idempotency keys or traveller names', async () => {
      const logs = captureLogs();
      const agent = await signedIn(app({ logs }));
      const booking = await book(agent);
      const key = randomUUID();
      const res = await pay(agent, booking.reference, { amount: amountOf(booking) }, key);
      expect(res.status).toBe(201);
      expect(logs.text).toMatch(/Payment attempt submitted/);
      expect(logs.text).not.toContain(key);
      expect(logs.text).not.toMatch(/Asha|Rao/);
    });
  });

  describe('the database’s own guards', () => {
    it('one success per booking, immutable amounts, kept records, append-only history', async () => {
      const agent = await signedIn(app());
      const booking = await book(agent);
      const paid = await pay(agent, booking.reference, { amount: amountOf(booking) });
      const prisma = testPrisma();
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paid.body.data.id } });
      // A second successful payment for the same booking is impossible.
      await expect(
        prisma.payment.create({
          data: {
            bookingId: row.bookingId,
            userId: row.userId,
            attempt: 2,
            mode: 'DEMO',
            provider: 'demo',
            currency: row.currency,
            amountMinor: row.amountMinor,
            status: 'SUCCEEDED',
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.payment.update({ where: { id: row.id }, data: { amountMinor: 1n } }),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.payment.update({ where: { id: row.id }, data: { providerReference: 'other' } }),
      ).rejects.toThrow(/immutable/);
      await expect(prisma.payment.delete({ where: { id: row.id } })).rejects.toThrow(
        /kept for audit/,
      );
      await expect(
        prisma.paymentStatusEvent.deleteMany({ where: { paymentId: row.id } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.payment.update({ where: { id: row.id }, data: { completedAt: null } }),
      ).rejects.toThrow();
      await expect(
        prisma.booking.update({ where: { id: row.bookingId }, data: { paymentMode: 'NONE' } }),
      ).rejects.toThrow(/immutable/);
    });
  });
});
