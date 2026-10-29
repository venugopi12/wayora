import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingRequirementsFor,
  bookingSchema,
  type Booking,
  type SearchResult,
} from '@wayora/contracts';
import { createPaymentsService } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import {
  ProviderPaymentError,
  type ProviderAttempt,
  type ProviderCallResult,
  type ProviderRefund,
} from '../../src/modules/payments/providers/types.js';
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
 * Refunds against a real PostgreSQL (Phase 23, docs/payments.md#refunds):
 * tracked apart from the booking and the payment, always the payment's own
 * amount, requested once per payment, and complete only on the provider's
 * word. The refundable provider is the test-only signed gateway; the demo
 * provider can't refund (it took no money).
 */

const PASSWORD = 'blue river morning';
const MINUTE = 60_000;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the refund tests would be skipped.');
}

const BASE_ENV: Partial<Env> = {
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
};

/** The signed test gateway, counting refund calls and able to fail them. */
class RefundGateway extends SignedTestGateway {
  refundIds: string[] = [];
  next: 'ok' | 'unknown-once' | 'reject' = 'ok';
  override refund(attempt: ProviderAttempt, refund?: ProviderRefund): Promise<ProviderCallResult> {
    this.refundIds.push(refund!.refundId);
    if (this.next === 'reject') {
      return Promise.reject(new ProviderPaymentError('rejected', 'declined', 'refund_declined'));
    }
    if (this.next === 'unknown-once') {
      this.next = 'ok';
      return Promise.reject(new ProviderPaymentError('unknown', 'timed out'));
    }
    return super.refund(attempt, refund);
  }
}

function setup(gateway: SignedTestGateway | null) {
  const clock = testClock();
  const app = buildTestApp({
    prisma: testPrisma(),
    env: BASE_ENV,
    logger: pino({ level: 'silent' }),
    now: clock.now,
    ...(gateway ? { paymentProviders: { policy: gateway } } : {}),
  });
  const payments = createPaymentsService(
    testPrisma(),
    { ...parseEnv(validEnvSource), ...BASE_ENV } as Env,
    pino({ level: 'silent' }),
    { now: clock.now, ...(gateway ? { providers: { policy: gateway } } : {}) },
  );
  return { app, clock, payments };
}

async function signedIn(target: ReturnType<typeof setup>['app']) {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email: 'asha@example.com', password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function bookHotel(agent: Agent): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
  const search = await agent.post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
  const offer = search.body.data.results[0] as SearchResult;
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceType: 'hotels',
      searchId: search.body.data.searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect(res.status).toBe(201);
  return bookingSchema.parse(res.body.data);
}

/** A booking paid through the signed gateway (succeeded by verified webhook). */
async function paidThroughGateway(target: ReturnType<typeof setup>['app'], agent: Agent) {
  const booking = await bookHotel(agent);
  const res = await agent
    .post(`/api/v1/bookings/${booking.reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount: booking.payment.amount });
  expect(res.status).toBe(201);
  const paymentId = res.body.data.id as string;
  const ref = SignedTestGateway.reference(paymentId);
  const post = (type: string, id = `evt_${type}_${ref}`) => {
    const body = JSON.stringify({
      events: [{ id, type, providerReference: ref, occurredAt: new Date().toISOString() }],
    });
    return request(target)
      .post('/api/v1/payment-events/test-gateway')
      .set('Content-Type', 'application/json')
      .set(SIGNATURE_HEADER, sign(body, Math.floor(Date.now() / 1000)))
      .send(body);
  };
  expect((await post('payment.succeeded')).body.data.outcomes).toEqual(['applied']);
  return { booking, paymentId, post };
}

const getBooking = async (agent: Agent, reference: string) =>
  bookingSchema.parse((await agent.get(`/api/v1/bookings/${reference}`)).body.data);
const cancel = (agent: Agent, reference: string) =>
  agent.post(`/api/v1/bookings/${reference}/cancel`).set('Origin', ORIGIN);

describe.skipIf(!TEST_DATABASE_URL)('refunds (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  it('a cancelled paid booking: refund requested once, pending, then confirmed by the provider', async () => {
    const gateway = new RefundGateway();
    const { app } = setup(gateway);
    const agent = await signedIn(app);
    const { booking, paymentId, post } = await paidThroughGateway(app, agent);
    expect((await getBooking(agent, booking.reference)).refund.state).toBe('not-applicable');

    const cancelled = await cancel(agent, booking.reference);
    expect(cancelled.status).toBe(200);
    const after = bookingSchema.parse(cancelled.body.data);
    expect(after.status).toBe('cancelled');
    // The refund's own state, the payment's own amount.
    expect(after.refund).toMatchObject({
      state: 'pending',
      amount: booking.payment.amount,
      demo: false,
    });
    const refund = await testPrisma().refund.findFirstOrThrow({ where: { paymentId } });
    const payment = await testPrisma().payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(refund).toMatchObject({
      status: 'PENDING',
      reason: 'BOOKING_CANCELLED',
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      attempts: 1,
    });
    expect(payment.status).toBe('REFUND_PENDING');
    expect(gateway.refundIds).toEqual([refund.id]);

    // Not refunded until the provider says so; then once.
    expect((await post('refund.succeeded')).body.data.outcomes).toEqual(['applied']);
    expect((await post('refund.succeeded')).body.data.outcomes).toEqual(['duplicate']);
    const done = await getBooking(agent, booking.reference);
    expect(done.refund).toMatchObject({ state: 'succeeded' });
    expect(done.refund.explanation).toBe('The payment provider confirmed the refund.');
    expect(await testPrisma().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject(
      {
        status: 'SUCCEEDED',
      },
    );
    expect(
      (await testPrisma().payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe('REFUNDED');
    expect(await testPrisma().notification.count({ where: { type: 'PAYMENT_REFUNDED' } })).toBe(1);
    expect(await testPrisma().refund.count()).toBe(1);
    expect(gateway.refundIds).toHaveLength(1);
  });

  it('an unknown outcome is checked first, then asked again with the same refund id', async () => {
    const gateway = new RefundGateway();
    gateway.next = 'unknown-once';
    const { app, clock, payments } = setup(gateway);
    const agent = await signedIn(app);
    const { booking, paymentId } = await paidThroughGateway(app, agent);
    await cancel(agent, booking.reference);
    expect((await getBooking(agent, booking.reference)).refund.state).toBe('unknown');
    expect(await testPrisma().refund.findFirstOrThrow({ where: { paymentId } })).toMatchObject({
      status: 'UNKNOWN',
      attempts: 1,
    });
    // Not due yet.
    await payments.processRefunds();
    expect(gateway.refundIds).toHaveLength(1);
    clock.advance(MINUTE);
    await payments.processRefunds();
    expect(gateway.refundIds).toHaveLength(2);
    expect(new Set(gateway.refundIds).size).toBe(1); // the same refund, never a second one
    expect((await getBooking(agent, booking.reference)).refund.state).toBe('pending');
    expect(await testPrisma().refund.count()).toBe(1);
  });

  it('a refused refund is failed, not refunded; the payment stays owed back', async () => {
    const gateway = new RefundGateway();
    gateway.next = 'reject';
    const { app } = setup(gateway);
    const agent = await signedIn(app);
    const { booking, paymentId } = await paidThroughGateway(app, agent);
    await cancel(agent, booking.reference);
    const after = await getBooking(agent, booking.reference);
    expect(after.refund).toMatchObject({ state: 'failed' });
    expect(after.refund.explanation).toMatch(/refused the refund/);
    const refund = await testPrisma().refund.findFirstOrThrow({ where: { paymentId } });
    expect(refund).toMatchObject({ status: 'FAILED', failureCode: 'refund_declined' });
    expect(
      await testPrisma().payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).toMatchObject({ status: 'SUCCEEDED', refundRequired: true });
  });

  it('a provider’s refund failure after pending: failed, payment back to succeeded', async () => {
    const gateway = new RefundGateway();
    const { app } = setup(gateway);
    const agent = await signedIn(app);
    const { booking, paymentId, post } = await paidThroughGateway(app, agent);
    await cancel(agent, booking.reference);
    expect((await post('refund.failed')).body.data.outcomes).toEqual(['applied']);
    expect((await getBooking(agent, booking.reference)).refund.state).toBe('failed');
    expect(
      (await testPrisma().payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe('SUCCEEDED');
  });

  it('the demo provider can’t refund: recorded as owed, labelled demo, nothing sent', async () => {
    const { app, clock, payments } = setup(null);
    const agent = await signedIn(app);
    const booking = await bookHotel(agent);
    const paid = await agent
      .post(`/api/v1/bookings/${booking.reference}/payments`)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: booking.payment.amount, demoScenario: 'succeed' });
    expect(paid.status).toBe(201);
    await cancel(agent, booking.reference);
    const after = await getBooking(agent, booking.reference);
    expect(after.refund).toMatchObject({
      state: 'required',
      demo: true,
      amount: booking.payment.amount,
    });
    expect(after.refund.explanation).toMatch(/no real money was charged/);
    clock.advance(60 * MINUTE);
    expect(await payments.processRefunds()).toBe(0);
    expect(
      await testPrisma().refund.findFirstOrThrow({ where: { paymentId: paid.body.data.id } }),
    ).toMatchObject({ status: 'REQUIRED', mode: 'DEMO', attempts: 0 });
  });

  it('the database keeps a refund to its payment’s amount, once per payment', async () => {
    const gateway = new RefundGateway();
    const { app } = setup(gateway);
    const agent = await signedIn(app);
    const { booking, paymentId } = await paidThroughGateway(app, agent);
    await cancel(agent, booking.reference);
    const prisma = testPrisma();
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    const base = {
      paymentId,
      bookingId: payment.bookingId,
      userId: payment.userId,
      provider: payment.provider,
      mode: payment.mode,
      status: 'REQUESTED' as const,
      reason: 'MANUAL' as const,
      currency: payment.currency,
    };
    await expect(
      prisma.refund.create({ data: { ...base, amountMinor: payment.amountMinor + 1n } }),
    ).rejects.toThrow(/must match a successful payment/);
    await expect(
      prisma.refund.create({ data: { ...base, amountMinor: payment.amountMinor } }),
    ).rejects.toThrow(/refunds_one_open_per_payment|Unique constraint/);
    await expect(
      prisma.refund.update({ where: { id: refund.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.refund.delete({ where: { id: refund.id } })).rejects.toThrow(
      /can't be deleted/,
    );
  });
});
