import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOYALTY_RULES,
  adminUserRewardsSchema,
  bookingRewardsSchema,
  bookingRequirementsFor,
  bookingSchema,
  rewardTransactionListSchema,
  rewardsSummarySchema,
  type Booking,
  type BookingRewards,
  type LoyaltyRules,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import { createRewardsService } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import { transitionBooking } from '../../src/modules/bookings/lifecycle.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
import { addMonths } from '../../src/modules/rewards/rules.js';
import { buildTestApp, validEnvSource } from '../helpers.js';
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
 * Loyalty against a real PostgreSQL (Phase 25, docs/rewards.md): earning
 * after travel on what was actually paid, checkout redemption recalculated
 * by the server, giving back and taking back, concurrency, credits, expiry,
 * tiers, admin RBAC and audit, and the database's own guards.
 */

const PASSWORD = 'blue river morning';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
type Agent = ReturnType<typeof request.agent>;
type Clock = ReturnType<typeof testClock>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the rewards tests would be skipped.');
}

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 900,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 1000,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
  PAYMENT_WINDOW_MINUTES: 30,
  PAYMENT_DEMO_PENDING_SECONDS: 8,
};

const app = (clock: Clock, env: Partial<Env> = {}) =>
  buildTestApp({ prisma: testPrisma(), env: { ...BASE_ENV, ...env }, now: clock.now });

const rewardsService = (clock: Clock, env: Partial<Env> = {}) =>
  createRewardsService(
    testPrisma(),
    { ...parseEnv(validEnvSource), ...BASE_ENV, ...env },
    pino({ level: 'silent' }),
    { now: clock.now },
  );

/** Rule versions outlive resetAccounts (no user link): put version 1 back. */
async function resetRules() {
  const prisma = testPrisma();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "loyalty_rule_versions" CASCADE');
  await prisma.loyaltyRuleVersion.create({
    data: {
      version: 1,
      config: DEFAULT_LOYALTY_RULES as never,
      reason: 'Initial rules shipped with Phase 25.',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });
}

async function register(target: Parameters<typeof request.agent>[0], email: string) {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: PASSWORD });
  expect(res.status).toBe(201);
  const user = await testPrisma().user.findUniqueOrThrow({ where: { email } });
  return { agent, userId: user.id };
}

async function admin(
  target: Parameters<typeof request.agent>[0],
  role: 'admin' | 'support' = 'admin',
) {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
  const { agent } = await register(target, email);
  await setUserRole(testPrisma(), { email, role, reason: 'Test setup', actor: 'test' });
  return agent;
}

async function book(agent: Agent, type: SearchServiceType = 'hotels'): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const s = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
  expect(s.status).toBe(200);
  const offer = (s.body.data.results as SearchResult[])[0]!;
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceType: offer.serviceType,
      searchId: s.body.data.searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect(res.status).toBe(201);
  return bookingSchema.parse(res.body.data);
}

const getBooking = async (agent: Agent, reference: string) =>
  bookingSchema.parse((await agent.get(`/api/v1/bookings/${reference}`)).body.data);

const pay = (
  agent: Agent,
  reference: string,
  amount: { amountMinor: string; currency: string },
  scenario = 'succeed',
) =>
  agent
    .post(`/api/v1/bookings/${reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount, demoScenario: scenario });

const quote = async (agent: Agent, reference: string): Promise<BookingRewards> => {
  const res = await agent.get(`/api/v1/bookings/${reference}/rewards`);
  expect(res.status).toBe(200);
  return bookingRewardsSchema.parse(res.body.data);
};

const apply = (agent: Agent, reference: string, points: number, creditAmountMinor = '0') =>
  agent
    .put(`/api/v1/bookings/${reference}/rewards`)
    .set('Origin', ORIGIN)
    .send({ points, creditAmountMinor, confirm: true });

const summary = async (agent: Agent) => {
  const res = await agent.get('/api/v1/rewards');
  expect(res.status).toBe(200);
  return rewardsSummarySchema.parse(res.body.data);
};

const grant = (adminAgent: Agent, userId: string, points: number, key = randomUUID()) =>
  adminAgent
    .post(`/api/v1/admin/rewards/users/${userId}/adjustments`)
    .set('Origin', ORIGIN)
    .send({ mode: 'demo', points, reason: 'Goodwill for a test scenario', idempotencyKey: key });

const issue = (adminAgent: Agent, userId: string, body: Record<string, unknown>) =>
  adminAgent
    .post(`/api/v1/admin/rewards/users/${userId}/credits`)
    .set('Origin', ORIGIN)
    .send({
      mode: 'demo',
      amount: { amountMinor: '50000', currency: 'INR' },
      reason: 'support_compensation',
      note: 'Sorry about the delayed refund',
      justification: 'Support case: late refund confirmation',
      idempotencyKey: randomUUID(),
      ...body,
    });

/** Cached balance = ledger sum = points left in unexpired lots (the ledger invariant). */
async function consistent(userId: string, clock: Clock) {
  const check = await rewardsService(clock).verifyAccount(userId, 'DEMO');
  if (!check) return 0n;
  expect(check.balance).toBe(check.ledgerSum);
  expect(check.lotsRemaining).toBe(check.balance);
  return check.balance;
}

const total = (b: Booking) => BigInt(b.payment.amount!.amountMinor);

describe.skipIf(!TEST_DATABASE_URL)('rewards (integration, real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetAccounts();
    await resetRules();
  });
  afterAll(disconnect);

  describe('earning', () => {
    it('earns once, after the trip ends, on what was actually paid', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const booking = await book(agent);
      expect((await pay(agent, booking.reference, booking.payment.amount!)).status).toBe(201);
      expect((await getBooking(agent, booking.reference)).status).toBe('confirmed');
      const expected = total(booking) / 1000n; // ₹10 = 1 point

      // Before the trip: an estimate, nothing earned.
      await rewardsService(clock).sweep();
      let s = await summary(agent);
      expect(s.accounts.map((a) => a.mode)).toEqual(['demo']);
      expect(s.liveEnabled).toBe(false);
      expect(s.accounts[0]!.pointsBalance).toBe(0);
      expect(s.accounts[0]!.pending).toEqual([
        expect.objectContaining({ bookingReference: booking.reference, points: Number(expected) }),
      ]);

      // After check-out + 1 day: earned, once, however often it is settled.
      clock.advance(25 * DAY);
      const service = rewardsService(clock);
      const bookingId = (
        await testPrisma().booking.findUniqueOrThrow({ where: { reference: booking.reference } })
      ).id;
      await Promise.all([
        service.sweep(),
        service.reconcileBooking(bookingId),
        service.reconcileBooking(bookingId),
      ]);
      await service.sweep();
      const earned = await testPrisma().rewardTransaction.findMany({
        where: { userId, type: 'POINTS_EARNED' },
      });
      expect(earned).toHaveLength(1);
      expect(earned[0]).toMatchObject({
        points: expected,
        qualifyingPoints: expected,
        ruleVersion: 1,
        mode: 'DEMO',
        origin: 'AUTOMATED',
      });
      expect(earned[0]!.metadata).toMatchObject({
        paidMinor: total(booking).toString(),
        spendMinorPerPoint: '1000',
      });
      s = await summary(agent);
      expect(s.accounts[0]!.pointsBalance).toBe(Number(expected));
      expect(s.accounts[0]!.pending).toEqual([]);
      expect(await consistent(userId, clock)).toBe(expected);

      // One in-app notification, labelled demo; no email queued for rewards.
      const notes = await testPrisma().notification.findMany({
        where: { userId, type: 'REWARDS' },
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ isDemo: true, title: 'Demo points earned' });
      expect(
        await testPrisma().notificationDelivery.count({ where: { notificationId: notes[0]!.id } }),
      ).toBe(0);

      const history = rewardTransactionListSchema.parse(
        (await agent.get('/api/v1/rewards/transactions')).body.data,
      );
      expect(history.items[0]).toMatchObject({
        type: 'points_earned',
        points: Number(expected),
        bookingReference: booking.reference,
        mode: 'demo',
      });
    });

    it('unpaid, expired and cancelled bookings earn nothing', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const unpaid = await book(agent);
      const cancelled = await book(agent);
      expect(
        (await agent.post(`/api/v1/bookings/${cancelled.reference}/cancel`).set('Origin', ORIGIN))
          .status,
      ).toBe(200);
      clock.advance(40 * DAY);
      expect((await getBooking(agent, unpaid.reference)).status).toBe('expired');
      await rewardsService(clock).sweep();
      expect(await testPrisma().rewardTransaction.count({ where: { userId } })).toBe(0);
    });
  });

  describe('checkout', () => {
    it('applies points within the rules, recalculated by the server; the payment is for the rest', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      expect((await grant(staff, userId, 50_000)).status).toBe(201);
      const booking = await book(agent);
      const t = total(booking);

      const q = await quote(agent, booking.reference);
      expect(q).toMatchObject({
        available: true,
        mode: 'demo',
        points: { balance: 50_000, min: 200, value: { amountMinor: '25', currency: 'INR' } },
      });
      const expectedMax = [50_000n, 20_000n, (t * 5_000n) / 10_000n / 25n, (t - 100n) / 25n].reduce(
        (a, b) => (b < a ? b : a),
      );
      expect(BigInt(q.points.max)).toBe(expectedMax);
      expect(q.payable).toEqual({ amountMinor: t.toString(), currency: 'INR' });

      expect((await apply(agent, booking.reference, 150)).status).toBe(400); // below the minimum
      expect((await apply(agent, booking.reference, q.points.max + 1)).status).toBe(400); // above the maximum
      // Only points and credit are accepted; amounts and discounts come from the server.
      const forged = await agent
        .put(`/api/v1/bookings/${booking.reference}/rewards`)
        .set('Origin', ORIGIN)
        .send({ points: 1000, creditAmountMinor: '0', confirm: true, discountMinor: '999999' });
      expect(forged.status).toBe(400);
      expect(
        (
          await agent
            .put(`/api/v1/bookings/${booking.reference}/rewards`)
            .set('Origin', ORIGIN)
            .send({ points: 1000, creditAmountMinor: '0' })
        ).status,
      ).toBe(400); // no confirmation
      expect((await apply(agent, booking.reference, 1000.5)).status).toBe(400);
      expect(await testPrisma().rewardRedemption.count()).toBe(0);

      const applied = await apply(agent, booking.reference, 1000);
      expect(applied.status).toBe(200);
      const a = bookingRewardsSchema.parse(applied.body.data);
      expect(a.applied).toMatchObject({
        status: 'applied',
        points: 1000,
        pointsAmount: { amountMinor: '25000' },
      });
      expect(a.payable!.amountMinor).toBe((t - 25_000n).toString());
      expect(a.total!.amountMinor).toBe(t.toString()); // the offer price never changes
      // The same request again changes nothing.
      expect((await apply(agent, booking.reference, 1000)).status).toBe(200);
      expect(
        await testPrisma().rewardTransaction.count({ where: { userId, type: 'POINTS_REDEEMED' } }),
      ).toBe(1);

      const fresh = await getBooking(agent, booking.reference);
      expect(fresh.payment.amount!.amountMinor).toBe((t - 25_000n).toString());
      expect(fresh.payment.rewards).toEqual({
        points: 1000,
        amount: { amountMinor: '25000', currency: 'INR' },
      });
      // Paying the old total is refused; the remainder is accepted.
      expect((await pay(agent, booking.reference, booking.payment.amount!)).body.error.code).toBe(
        'PAYMENT_AMOUNT_MISMATCH',
      );
      const paid = await pay(agent, booking.reference, fresh.payment.amount!);
      expect(paid.status).toBe(201);
      expect(paid.body.data.amount.amountMinor).toBe((t - 25_000n).toString());
      expect((await quote(agent, booking.reference)).applied!.status).toBe('consumed');
      expect((await apply(agent, booking.reference, 2000)).status).toBe(409); // paid: can't change

      // Earned later on the money paid only (not the points' value).
      clock.advance(25 * DAY);
      await rewardsService(clock).sweep();
      const earned = await testPrisma().rewardTransaction.findFirstOrThrow({
        where: { userId, type: 'POINTS_EARNED' },
      });
      expect(earned.points).toBe((t - 25_000n) / 1000n);
      await consistent(userId, clock);
    });

    it('gives rewards back when removed, when the booking expires unpaid, and when a paid booking is cancelled', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      await grant(staff, userId, 5_000);

      const removed = await book(agent);
      await apply(agent, removed.reference, 1_000);
      expect((await summary(agent)).accounts[0]!.pointsBalance).toBe(4_000);
      const del = await agent
        .delete(`/api/v1/bookings/${removed.reference}/rewards`)
        .set('Origin', ORIGIN);
      expect(del.status).toBe(200);
      expect(del.body.data.applied).toBeNull();
      expect((await summary(agent)).accounts[0]!.pointsBalance).toBe(5_000);

      const expiring = await book(agent);
      await apply(agent, expiring.reference, 2_000);
      clock.advance(31 * MINUTE);
      expect((await quote(agent, expiring.reference)).applied).toBeNull();
      expect((await getBooking(agent, expiring.reference)).status).toBe('expired');

      const cancelled = await book(agent);
      await apply(agent, cancelled.reference, 3_000);
      const due = (await getBooking(agent, cancelled.reference)).payment.amount!;
      expect((await pay(agent, cancelled.reference, due)).status).toBe(201);
      expect((await summary(agent)).accounts[0]!.pointsBalance).toBe(2_000);
      expect(
        (await agent.post(`/api/v1/bookings/${cancelled.reference}/cancel`).set('Origin', ORIGIN))
          .status,
      ).toBe(200);
      expect((await summary(agent)).accounts[0]!.pointsBalance).toBe(5_000);

      const statuses = await testPrisma().rewardRedemption.findMany({
        orderBy: { createdAt: 'asc' },
        select: { status: true },
      });
      expect(statuses.map((r) => r.status)).toEqual(['RELEASED', 'RELEASED', 'RESTORED']);
      const notes = await testPrisma().notification.findMany({
        where: { userId, type: 'REWARDS' },
        select: { title: true },
      });
      expect(notes.filter((n) => n.title === 'Demo rewards given back')).toHaveLength(2); // expiry and cancellation
      await consistent(userId, clock);
    });

    it('two checkouts at once cannot spend the same points', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      await grant(staff, userId, 1_000);
      const [a, b] = [await book(agent), await book(agent)];
      const results = await Promise.all([
        apply(agent, a.reference, 1_000),
        apply(agent, b.reference, 1_000),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect((await summary(agent)).accounts[0]!.pointsBalance).toBe(0);
      expect(await testPrisma().rewardRedemption.count({ where: { status: 'APPLIED' } })).toBe(1);
      await consistent(userId, clock);
    });

    it('rewards cannot change while a payment is in progress', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      await grant(staff, userId, 5_000);
      const booking = await book(agent);
      expect((await pay(agent, booking.reference, booking.payment.amount!, 'pending')).status).toBe(
        201,
      );
      const res = await apply(agent, booking.reference, 1_000);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/in progress/);
    });
  });

  describe('travel credit', () => {
    it('is issued once per key, used partly, kept to its currency, given back, and expires', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      const key = randomUUID();
      const first = await issue(staff, userId, {
        idempotencyKey: key,
        expiresOn: new Date(clock.now().getTime() + 60 * DAY).toISOString().slice(0, 10),
      });
      expect(first.status).toBe(201);
      expect((await issue(staff, userId, { idempotencyKey: key })).status).toBe(201); // same key: nothing new
      expect(await testPrisma().travelCredit.count()).toBe(1);
      await issue(staff, userId, { amount: { amountMinor: '9900', currency: 'USD' } });

      const booking = await book(agent);
      const q = await quote(agent, booking.reference);
      expect(q.credit.available).toEqual({ amountMinor: '50000', currency: 'INR' }); // USD credit doesn't count
      expect((await apply(agent, booking.reference, 0, '60000')).status).toBe(400); // more than there is
      const used = bookingRewardsSchema.parse(
        (await apply(agent, booking.reference, 0, '20000')).body.data,
      );
      expect(used.applied).toMatchObject({ creditAmount: { amountMinor: '20000' }, points: 0 });
      expect(used.payable!.amountMinor).toBe((total(booking) - 20_000n).toString());
      let credit = await testPrisma().travelCredit.findFirstOrThrow({ where: { currency: 'INR' } });
      expect(credit).toMatchObject({
        status: 'ACTIVE',
        remainingAmountMinor: 30_000n,
        originalAmountMinor: 50_000n,
      });

      await agent.delete(`/api/v1/bookings/${booking.reference}/rewards`).set('Origin', ORIGIN);
      credit = await testPrisma().travelCredit.findFirstOrThrow({ where: { currency: 'INR' } });
      expect(credit.remainingAmountMinor).toBe(50_000n);

      // Past its expiry: expired by the sweep, and no longer usable.
      clock.advance(61 * DAY);
      await rewardsService(clock).sweep();
      credit = await testPrisma().travelCredit.findFirstOrThrow({ where: { currency: 'INR' } });
      expect(credit).toMatchObject({ status: 'EXPIRED', remainingAmountMinor: 0n });
      const later = await book(agent);
      expect((await quote(agent, later.reference)).credit.available!.amountMinor).toBe('0');
      expect((await apply(agent, later.reference, 0, '100')).status).toBe(400);

      const types = (
        await testPrisma().rewardTransaction.findMany({
          where: { creditId: credit.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((t) => t.type);
      expect(types).toEqual([
        'CREDIT_ISSUED',
        'CREDIT_REDEEMED',
        'CREDIT_RESTORED',
        'CREDIT_EXPIRED',
      ]);
      // Credit is never a cash refund: no refund rows were created for it.
      expect(await testPrisma().refund.count()).toBe(0);
    });

    it('a revoked credit is withdrawn with a reason and audited', async () => {
      const clock = testClock();
      const target = app(clock);
      const { userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      const view = adminUserRewardsSchema.parse((await issue(staff, userId, {})).body.data);
      const reference = view.credits[0]!.reference;
      expect(
        (
          await staff
            .post(`/api/v1/admin/rewards/credits/${reference}/revoke`)
            .set('Origin', ORIGIN)
            .send({ reason: 'short' })
        ).status,
      ).toBe(400);
      const revoked = await staff
        .post(`/api/v1/admin/rewards/credits/${reference}/revoke`)
        .set('Origin', ORIGIN)
        .send({ reason: 'Issued to the wrong customer by mistake' });
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.credits[0].status).toBe('revoked');
      const audit = await testPrisma().auditLog.findFirstOrThrow({
        where: { action: 'rewards.credit_revoked' },
      });
      expect(audit.metadata).toMatchObject({
        reason: 'Issued to the wrong customer by mistake',
        amountMinor: '50000',
      });
    });
  });

  describe('reversal, expiry and tiers', () => {
    it('takes earned points back once when a booking stops qualifying, never below zero', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      const booking = await book(agent);
      await pay(agent, booking.reference, booking.payment.amount!);
      clock.advance(25 * DAY);
      const service = rewardsService(clock);
      await service.sweep();
      const earned = (
        await testPrisma().rewardTransaction.findFirstOrThrow({
          where: { userId, type: 'POINTS_EARNED' },
        })
      ).points;
      // Spend most of them first.
      expect((await grant(staff, userId, -Number(earned - 10n))).status).toBe(201);

      // The booking stops qualifying (e.g. its payment had to be refunded).
      const prisma = testPrisma();
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference: booking.reference },
      });
      await prisma.$transaction(async (tx) => {
        await transitionBooking(tx, clock.now(), row.id, 'CONFIRMED', 'CANCELLED', {
          actorType: 'ADMIN',
          note: 'Test: refunded',
        });
        await tx.payment.updateMany({
          where: { bookingId: row.id },
          data: { refundRequired: true },
        });
      });
      await Promise.all([service.reconcileBooking(row.id), service.reconcileBooking(row.id)]);
      await service.sweep();
      const reversals = await prisma.rewardTransaction.findMany({
        where: { userId, type: 'POINTS_REVERSED' },
      });
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({ points: -10n, qualifyingPoints: -earned });
      expect(reversals[0]!.metadata).toMatchObject({
        earnedPoints: earned.toString(),
        takenBack: '10',
        unrecovered: (earned - 10n).toString(),
      });
      expect(await consistent(userId, clock)).toBe(0n);
    });

    it('points expire after the rule period, are announced first, and expired points cannot be spent', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      await grant(staff, userId, 3_000);
      // 20 days before the lot expires (24 calendar months): inside the 30-day notice window.
      const expiresAt = addMonths(clock.now(), 24);
      clock.advance(expiresAt.getTime() - clock.now().getTime() - 20 * DAY);
      await rewardsService(clock).sweep();
      await rewardsService(clock).sweep();
      expect(
        await testPrisma().notification.count({ where: { userId, title: 'Points expiring soon' } }),
      ).toBe(1);
      expect((await summary(agent)).accounts[0]!.expiring).toEqual([
        expect.objectContaining({ points: 3_000 }),
      ]);

      clock.advance(21 * DAY); // past expiry; not swept yet
      const booking = await book(agent);
      expect((await quote(agent, booking.reference)).points.balance).toBe(0);
      expect((await apply(agent, booking.reference, 1_000)).status).toBe(400);
      await rewardsService(clock).sweep();
      const expired = await testPrisma().rewardTransaction.findMany({
        where: { userId, type: 'POINTS_EXPIRED' },
      });
      expect(expired).toHaveLength(1);
      expect(expired[0]!.points).toBe(-3_000n);
      expect(await consistent(userId, clock)).toBe(0n);
    });

    it('upgrades on qualifying points under the rule version in force, keeps the tier, then downgrades', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent, userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      const config: LoyaltyRules = structuredClone(DEFAULT_LOYALTY_RULES);
      config.tiers[1]!.minQualifyingPoints = 10;
      const created = await staff
        .post('/api/v1/admin/rewards/rules')
        .set('Origin', ORIGIN)
        .send({ config, reason: 'Lower Silver threshold for the test' });
      expect(created.status).toBe(201);
      expect(created.body.data.active.version).toBe(2);

      clock.advance(MINUTE);
      const booking = await book(agent);
      await pay(agent, booking.reference, booking.payment.amount!);
      clock.advance(25 * DAY);
      await rewardsService(clock).sweep();
      const earned = await testPrisma().rewardTransaction.findFirstOrThrow({
        where: { userId, type: 'POINTS_EARNED' },
      });
      expect(earned.ruleVersion).toBe(2);
      let s = await summary(agent);
      expect(s.accounts[0]!.tier).toMatchObject({ id: 'silver', next: { id: 'gold' } });
      expect(
        await testPrisma().notification.count({ where: { userId, title: 'You reached Silver' } }),
      ).toBe(1);

      // Qualifying points leave the 12-month window; the tier is kept for 12 months, then dropped.
      clock.advance(366 * DAY);
      await rewardsService(clock).sweep();
      s = await summary(agent);
      expect(s.accounts[0]!.tier.id).toBe('explorer');
      expect(
        await testPrisma().auditLog.count({ where: { action: 'rewards.tier_downgrade' } }),
      ).toBe(1);
    });
  });

  describe('security and admin', () => {
    it('rewards are private, and customers cannot change balances', async () => {
      const clock = testClock();
      const target = app(clock);
      const { agent: asha, userId } = await register(target, 'asha@example.com');
      const { agent: mallory } = await register(target, 'mallory@example.com');
      const booking = await book(asha);

      expect((await request(target).get('/api/v1/rewards')).status).toBe(401);
      expect((await mallory.get(`/api/v1/bookings/${booking.reference}/rewards`)).status).toBe(404);
      expect((await apply(mallory, booking.reference, 0)).status).toBe(404);
      expect((await grant(asha, userId, 1_000)).status).toBe(403);
      expect((await mallory.get(`/api/v1/admin/rewards/users/${userId}`)).status).toBe(403);
      // Write routes don't exist for customers.
      expect(
        (await asha.post('/api/v1/rewards').set('Origin', ORIGIN).send({ points: 1000 })).status,
      ).toBe(404);
      expect(await testPrisma().loyaltyAccount.count({ where: { pointsBalance: { gt: 0 } } })).toBe(
        0,
      );
    });

    it('support can read; only admins adjust, with a reason, once per key, audited; live rewards stay off', async () => {
      const clock = testClock();
      const target = app(clock);
      const { userId } = await register(target, 'asha@example.com');
      const support = await admin(target, 'support');
      const staff = await admin(target);
      expect((await support.get(`/api/v1/admin/rewards/users/${userId}`)).status).toBe(200);
      expect((await support.get('/api/v1/admin/rewards/rules')).status).toBe(200);
      expect((await grant(support, userId, 100)).status).toBe(403);

      const noReason = await staff
        .post(`/api/v1/admin/rewards/users/${userId}/adjustments`)
        .set('Origin', ORIGIN)
        .send({ mode: 'demo', points: 100, reason: '', idempotencyKey: randomUUID() });
      expect(noReason.status).toBe(400);
      const key = randomUUID();
      expect((await grant(staff, userId, 700, key)).status).toBe(201);
      expect((await grant(staff, userId, 700, key)).status).toBe(201); // repeat: once
      expect((await grant(staff, userId, -800)).status).toBe(409); // can't go negative
      const live = await staff
        .post(`/api/v1/admin/rewards/users/${userId}/adjustments`)
        .set('Origin', ORIGIN)
        .send({
          mode: 'live',
          points: 100,
          reason: 'Trying to add real value',
          idempotencyKey: randomUUID(),
        });
      expect(live.status).toBe(409);

      const view = adminUserRewardsSchema.parse(
        (await staff.get(`/api/v1/admin/rewards/users/${userId}`)).body.data,
      );
      expect(view.accounts).toEqual([
        expect.objectContaining({ mode: 'demo', pointsBalance: 700, ledgerSum: 700 }),
      ]);
      expect(view.recent[0]).toMatchObject({
        type: 'points_adjusted',
        origin: 'manual',
        actorType: 'admin',
        reason: 'Goodwill for a test scenario',
      });
      expect(JSON.stringify(view)).not.toMatch(/asha@example\.com/);
      const audits = await testPrisma().auditLog.findMany({
        where: { action: 'rewards.points_adjusted' },
      });
      expect(audits).toHaveLength(1);
      const list = await staff.get('/api/v1/admin/rewards/transactions?origin=manual');
      expect(list.body.data.items).toHaveLength(1);
      // Invalid rule sets are refused by the server.
      const badRules = structuredClone(DEFAULT_LOYALTY_RULES) as unknown as {
        redeem: { maxPointsCoverageBps: number };
      };
      badRules.redeem.maxPointsCoverageBps = 20_000;
      expect(
        (
          await staff
            .post('/api/v1/admin/rewards/rules')
            .set('Origin', ORIGIN)
            .send({ config: badRules, reason: 'Allow paying 200%' })
        ).status,
      ).toBe(400);
    });

    it('the database keeps the ledger append-only and balances non-negative', async () => {
      const clock = testClock();
      const target = app(clock);
      const { userId } = await register(target, 'asha@example.com');
      const staff = await admin(target);
      await grant(staff, userId, 100);
      const prisma = testPrisma();
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "reward_transactions" SET "points" = 999999`),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "reward_transactions"`)).rejects.toThrow(
        /append-only/,
      );
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "loyalty_accounts" SET "points_balance" = -1`),
      ).rejects.toThrow(/balance_not_negative/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "loyalty_rule_versions" SET "reason" = 'x'`),
      ).rejects.toThrow(/append-only/);
      await consistent(userId, clock);
    });
  });
});
