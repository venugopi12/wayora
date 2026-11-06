import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOYALTY_RULES,
  adminPromotionSchema,
  adminPromotionUsageSchema,
  bookingPricingSchema,
  bookingRequirementsFor,
  bookingRewardsSchema,
  bookingSchema,
  type AdminPromotionInput,
  type Booking,
  type BookingPricing,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import { createPromotionsService, createRewardsService } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
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
 * Coupons and promotions against a real PostgreSQL (Phase 26,
 * docs/promotions.md): server-side pricing, stable eligibility codes,
 * reservation and redemption with the booking lifecycle, limits under
 * concurrency, automatic promotions and stacking, loyalty and credit
 * integration, cancellation, admin RBAC and audit, and the database guards.
 */

const PASSWORD = 'blue river morning';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
type Agent = ReturnType<typeof request.agent>;
type Clock = ReturnType<typeof testClock>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the promotion tests would be skipped.');
}

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 900,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 1000,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  COUPON_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
  PAYMENT_WINDOW_MINUTES: 30,
  PAYMENT_DEMO_PENDING_SECONDS: 8,
};

const app = (clock: Clock, env: Partial<Env> = {}) =>
  buildTestApp({ prisma: testPrisma(), env: { ...BASE_ENV, ...env }, now: clock.now });
const env = () => ({ ...parseEnv(validEnvSource), ...BASE_ENV });
const promotions = (clock: Clock) =>
  createPromotionsService(testPrisma(), pino({ level: 'silent' }), { now: clock.now });
const rewards = (clock: Clock) =>
  createRewardsService(testPrisma(), env(), pino({ level: 'silent' }), { now: clock.now });

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

let counter = 0;
async function register(
  target: Parameters<typeof request.agent>[0],
  email = `c${(counter += 1)}-${randomUUID().slice(0, 6)}@example.com`,
) {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: PASSWORD });
  expect(res.status).toBe(201);
  const user = await testPrisma().user.findUniqueOrThrow({ where: { email } });
  return { agent, userId: user.id, email };
}

async function staff(
  target: Parameters<typeof request.agent>[0],
  role: 'admin' | 'support' = 'admin',
) {
  const { agent, email } = await register(target);
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

const total = (b: Booking) =>
  BigInt((b.offer.price as { total: { amountMinor: string } }).total.amountMinor);

const pricing = async (agent: Agent, reference: string): Promise<BookingPricing> => {
  const res = await agent.get(`/api/v1/bookings/${reference}/pricing`);
  expect(res.status).toBe(200);
  return bookingPricingSchema.parse(res.body.data);
};
const coupon = (agent: Agent, reference: string, code: string) =>
  agent.put(`/api/v1/bookings/${reference}/pricing/coupon`).set('Origin', ORIGIN).send({ code });
const removeCoupon = (agent: Agent, reference: string) =>
  agent.delete(`/api/v1/bookings/${reference}/pricing/coupon`).set('Origin', ORIGIN);
const pay = (agent: Agent, reference: string, amount: { amountMinor: string; currency: string }) =>
  agent
    .post(`/api/v1/bookings/${reference}/payments`)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ amount, demoScenario: 'succeed' });
const payDue = async (agent: Agent, reference: string) => {
  const p = await pricing(agent, reference);
  return pay(agent, reference, p.payable!);
};

function promo(clock: Clock, over: Partial<AdminPromotionInput> = {}): AdminPromotionInput {
  return {
    kind: 'coupon',
    code: `SAVE${(counter += 1)}`,
    name: 'Ten percent off',
    description: '10% off, up to ₹1,000',
    terms: 'Valid on demo bookings. One use per customer.',
    discountType: 'percentage',
    percentBps: 1_000,
    maxDiscountMinor: '100000',
    currency: 'INR',
    startsAt: new Date(clock.now().getTime() - 60 * MINUTE).toISOString(),
    endsAt: new Date(clock.now().getTime() + 30 * DAY).toISOString(),
    ...over,
  };
}
const create = async (admin: Agent, body: AdminPromotionInput) => {
  const res = await admin.post('/api/v1/admin/promotions').set('Origin', ORIGIN).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return adminPromotionSchema.parse(res.body.data);
};
const adminView = async (admin: Agent, id: string) =>
  adminPromotionSchema.parse((await admin.get(`/api/v1/admin/promotions/${id}`)).body.data);
const redemptions = (where: object = {}) =>
  testPrisma().promotionRedemption.findMany({ where, orderBy: { createdAt: 'asc' } });

describe.skipIf(!TEST_DATABASE_URL)('promotions (integration, real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetAccounts();
    await resetRules();
  });
  afterAll(disconnect);

  describe('coupons', () => {
    it('validates and reserves a coupon, prices on the server, and redeems it only once the booking is paid', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const { agent, userId } = await register(target);
      const p = await create(admin, promo(clock, { code: 'SAVE10' }));
      const booking = await book(agent);
      const t = total(booking);
      expect(t).toBeGreaterThan(1_000_000n); // so the ₹1,000 cap applies

      const applied = await coupon(agent, booking.reference, '  save 10 ');
      expect(applied.status).toBe(200);
      const priced = bookingPricingSchema.parse(applied.body.data);
      expect(priced.original!.amountMinor).toBe(t.toString()); // never changed
      expect(priced.promotions).toEqual([
        expect.objectContaining({
          kind: 'coupon',
          code: 'SAVE10',
          status: 'reserved',
          discount: { amountMinor: '100000', currency: 'INR' },
        }),
      ]);
      expect(priced.payable!.amountMinor).toBe((t - 100_000n).toString());
      expect((await adminView(admin, p.id)).usage).toMatchObject({ reserved: 1, redeemed: 0 });
      // The booking shows the same amount due.
      expect(
        (await agent.get(`/api/v1/bookings/${booking.reference}`)).body.data.payment.amount
          .amountMinor,
      ).toBe((t - 100_000n).toString());

      // Paying the original total is refused; the discounted amount is accepted.
      expect(
        (await pay(agent, booking.reference, { amountMinor: t.toString(), currency: 'INR' })).body
          .error.code,
      ).toBe('PAYMENT_AMOUNT_MISMATCH');
      const paid = await pay(agent, booking.reference, priced.payable!);
      expect(paid.status).toBe(201);
      expect(paid.body.data.amount.amountMinor).toBe((t - 100_000n).toString());
      const [r] = await redemptions({ userId });
      expect(r).toMatchObject({
        status: 'REDEEMED',
        discountMinor: 100_000n,
        eligibleAmountMinor: t,
        promotionVersion: 1,
      });
      const view = await adminView(admin, p.id);
      expect(view.usage).toMatchObject({
        reserved: 0,
        redeemed: 1,
        redeemedDiscount: { amountMinor: '100000' },
      });
      expect(view.usage.redeemedBookingValue.amountMinor).toBe(t.toString());
      expect((await coupon(agent, booking.reference, 'SAVE10')).status).toBe(409); // paid: can't change

      // Points are earned on what was paid, after the discount.
      clock.advance(25 * DAY);
      await rewards(clock).sweep();
      const earned = await testPrisma().rewardTransaction.findFirstOrThrow({
        where: { userId, type: 'POINTS_EARNED' },
      });
      expect(earned.points).toBe((t - 100_000n) / 1000n);
    });

    it('answers every rejection with its stable code and a safe message', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const { agent, userId } = await register(target);
      const other = await register(target);
      const booking = await book(agent);
      const t = total(booking);
      const code = async (c: string) => {
        const res = await coupon(agent, booking.reference, c);
        return {
          status: res.status,
          code: res.body.error?.code as string,
          message: res.body.error?.message as string,
        };
      };

      expect(await code('NOPE123')).toMatchObject({ status: 422, code: 'COUPON_NOT_FOUND' });
      await create(admin, promo(clock, { code: 'MINE-ONLY', userId: other.userId, listed: false }));
      expect(await code('MINE-ONLY')).toMatchObject({ code: 'COUPON_NOT_FOUND' }); // someone else's personal offer
      await create(
        admin,
        promo(clock, {
          code: 'LATER',
          startsAt: new Date(clock.now().getTime() + DAY).toISOString(),
        }),
      );
      expect(await code('LATER')).toMatchObject({ code: 'COUPON_NOT_STARTED' });
      const off = await create(admin, promo(clock, { code: 'OFFNOW' }));
      await admin
        .post(`/api/v1/admin/promotions/${off.id}/status`)
        .set('Origin', ORIGIN)
        .send({ active: false, reason: 'Paused for testing' });
      expect(await code('OFFNOW')).toMatchObject({ code: 'COUPON_INACTIVE' });
      await create(admin, promo(clock, { code: 'BIGSPEND', minAmountMinor: (t + 1n).toString() }));
      expect(await code('BIGSPEND')).toMatchObject({ code: 'MINIMUM_AMOUNT_NOT_MET' });
      await create(admin, promo(clock, { code: 'FLYONLY', categories: ['flights'] }));
      expect(await code('FLYONLY')).toMatchObject({ code: 'CATEGORY_NOT_ELIGIBLE' });
      await create(admin, promo(clock, { code: 'DOLLARS', currency: 'USD' }));
      expect(await code('DOLLARS')).toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED' });
      await create(
        admin,
        promo(clock, {
          code: 'SHORT',
          endsAt: new Date(clock.now().getTime() + 10 * MINUTE).toISOString(),
        }),
      );

      // Global limit used up by another customer; per-user limit by this one.
      await create(admin, promo(clock, { code: 'ONCE', usageLimit: 1, perUserLimit: 1 }));
      const otherBooking = await book(other.agent);
      expect((await coupon(other.agent, otherBooking.reference, 'ONCE')).status).toBe(200);
      const once = await code('ONCE');
      expect(once).toMatchObject({ status: 409, code: 'USAGE_LIMIT_REACHED' });
      expect(once.message).not.toMatch(/asha|mallory|@|WYD-/i);
      await create(admin, promo(clock, { code: 'PERUSER', perUserLimit: 1 }));
      expect((await coupon(agent, booking.reference, 'PERUSER')).status).toBe(200);
      const second = await book(agent);
      expect((await coupon(agent, second.reference, 'PERUSER')).body.error.code).toBe(
        'USER_USAGE_LIMIT_REACHED',
      );

      // First booking only: not once the customer has a confirmed booking.
      await create(
        admin,
        promo(clock, { code: 'WELCOME', firstBookingOnly: true, perUserLimit: 1 }),
      );
      await removeCoupon(agent, booking.reference);
      await payDue(agent, booking.reference);
      const third = await book(agent);
      expect((await coupon(agent, third.reference, 'WELCOME')).body.error).toMatchObject({
        code: 'USER_NOT_ELIGIBLE',
        message: 'Your account isn’t eligible for this code.',
      });
      const fresh = await register(target);
      const freshBooking = await book(fresh.agent);
      expect((await coupon(fresh.agent, freshBooking.reference, 'WELCOME')).status).toBe(200);

      // Expiry after it was valid.
      clock.advance(11 * MINUTE);
      const late = await book(agent);
      expect((await coupon(agent, late.reference, 'SHORT')).body.error.code).toBe('COUPON_EXPIRED');
      // Every rejection was recorded for review (code and promotion only).
      const audits = await testPrisma().auditLog.findMany({
        where: { action: 'promotion.coupon_rejected', actorId: userId },
      });
      expect(audits.length).toBeGreaterThanOrEqual(6);
    });

    it('a fixed coupon never takes the total below ₹1, and the same code twice changes nothing', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const { agent } = await register(target);
      await create(
        admin,
        promo(clock, {
          code: 'HUGE',
          discountType: 'fixed',
          percentBps: undefined,
          maxDiscountMinor: undefined,
          amountMinor: '999999999',
        }),
      );
      const booking = await book(agent);
      const t = total(booking);
      await coupon(agent, booking.reference, 'HUGE');
      const twice = bookingPricingSchema.parse(
        (await coupon(agent, booking.reference, 'huge')).body.data,
      );
      expect(twice.promotions[0]!.discount.amountMinor).toBe((t - 100n).toString());
      expect(twice.payable!.amountMinor).toBe('100');
      expect(await redemptions()).toHaveLength(1);
    });

    it('limits hold when many checkouts apply the same coupon at once', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      await create(admin, promo(clock, { code: 'FIRST5', usageLimit: 2, perUserLimit: null }));
      const customers = await Promise.all(Array.from({ length: 5 }, () => register(target)));
      const bookings = await Promise.all(customers.map((c) => book(c.agent)));
      const results = await Promise.all(
        customers.map((c, i) => coupon(c.agent, bookings[i]!.reference, 'FIRST5')),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.body.error?.code === 'USAGE_LIMIT_REACHED')).toHaveLength(3);

      // Per customer, too: one customer, two bookings, at once.
      await create(admin, promo(clock, { code: 'JUSTONE', perUserLimit: 1 }));
      const { agent } = await register(target);
      const [a, b] = [await book(agent), await book(agent)];
      const both = await Promise.all([
        coupon(agent, a.reference, 'JUSTONE'),
        coupon(agent, b.reference, 'JUSTONE'),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('an abandoned checkout’s hold ends with its payment window and frees the use', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const p = await create(
        admin,
        promo(clock, { code: 'LASTONE', usageLimit: 1, perUserLimit: null }),
      );
      const first = await register(target);
      const abandoned = await book(first.agent);
      expect((await coupon(first.agent, abandoned.reference, 'LASTONE')).status).toBe(200);
      const second = await register(target);
      const waiting = await book(second.agent);
      expect((await coupon(second.agent, waiting.reference, 'LASTONE')).body.error.code).toBe(
        'USAGE_LIMIT_REACHED',
      );

      clock.advance(31 * MINUTE); // the first checkout's payment window is over
      const later = await book(second.agent);
      expect((await coupon(second.agent, later.reference, 'LASTONE')).status).toBe(200);
      const rows = await redemptions({ promotionId: p.id });
      expect(rows.map((r) => [r.status, r.closeReason])).toEqual([
        ['RELEASED', 'RESERVATION_EXPIRED'],
        ['RESERVED', null],
      ]);
      // The sweep agrees and changes nothing more.
      await promotions(clock).sweep();
      expect((await adminView(admin, p.id)).usage).toMatchObject({ reserved: 1, released: 1 });
    });
  });

  describe('automatic promotions and stacking', () => {
    it('applies the best automatic offer, lets a bigger coupon replace it, combines stackable coupons, and brings it back', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const auto = (over: Partial<AdminPromotionInput>) =>
        create(
          admin,
          promo(clock, { kind: 'automatic', code: undefined, categories: ['hotels'], ...over }),
        );
      await auto({ name: 'Hotels 5%', percentBps: 500, maxDiscountMinor: undefined });
      const flat = await auto({
        name: 'Hotels ₹300 off',
        discountType: 'fixed',
        percentBps: undefined,
        maxDiscountMinor: undefined,
        amountMinor: '30000',
      });
      await auto({
        name: 'Flights 50%',
        categories: ['flights'],
        percentBps: 5_000,
        maxDiscountMinor: undefined,
      });
      const { agent } = await register(target);
      const booking = await book(agent);
      const t = total(booking);
      const fivePct = (t * 500n) / 10_000n;
      const best = fivePct > 30_000n ? 'Hotels 5%' : 'Hotels ₹300 off';

      // Applied when the booking was made: the larger discount wins.
      let p = await pricing(agent, booking.reference);
      expect(p.promotions).toEqual([
        expect.objectContaining({ kind: 'automatic', name: best, code: null }),
      ]);
      const autoDiscount = BigInt(p.promotions[0]!.discount.amountMinor);

      // A non-stackable coupon that takes less off is refused.
      await create(
        admin,
        promo(clock, {
          code: 'TINY',
          discountType: 'fixed',
          percentBps: undefined,
          maxDiscountMinor: undefined,
          amountMinor: '100',
        }),
      );
      expect((await coupon(agent, booking.reference, 'TINY')).body.error.code).toBe(
        'PROMOTION_NOT_STACKABLE',
      );
      // One that takes more off replaces it.
      await create(
        admin,
        promo(clock, { code: 'BIGGER', percentBps: 2_000, maxDiscountMinor: undefined }),
      );
      p = bookingPricingSchema.parse((await coupon(agent, booking.reference, 'BIGGER')).body.data);
      expect(p.promotions.map((x) => x.kind)).toEqual(['coupon']);
      expect(p.promotions[0]!.discount.amountMinor).toBe(((t * 2_000n) / 10_000n).toString());
      // A stackable coupon applies after the automatic offer, on the reduced amount.
      await removeCoupon(agent, booking.reference);
      p = await pricing(agent, booking.reference);
      expect(p.promotions.map((x) => x.name)).toEqual([best]); // the automatic one is back
      await create(
        admin,
        promo(clock, {
          code: 'PLUS5',
          stackable: true,
          percentBps: 500,
          maxDiscountMinor: undefined,
        }),
      );
      p = bookingPricingSchema.parse((await coupon(agent, booking.reference, 'PLUS5')).body.data);
      const plus = ((t - autoDiscount) * 500n) / 10_000n;
      expect(p.promotions.map((x) => x.kind).sort()).toEqual(['automatic', 'coupon']);
      expect(p.promotionDiscount!.amountMinor).toBe((autoDiscount + plus).toString());
      expect(p.payable!.amountMinor).toBe((t - autoDiscount - plus).toString());
      const rows = await redemptions();
      expect(rows.find((r) => r.code === 'PLUS5')!.eligibleAmountMinor).toBe(t - autoDiscount);
      expect(rows.some((r) => r.closeReason === 'REPLACED')).toBe(true);
      // Ties are broken the same way every time (largest, then ending soonest…): checked in the engine tests.
      expect(flat.kind).toBe('automatic');
    });
  });

  describe('loyalty, credit and the booking lifecycle', () => {
    it('points apply after promotions; changing the coupon gives them back; credit stays separate', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const { agent, userId } = await register(target);
      await create(admin, promo(clock, { code: 'TENOFF', maxDiscountMinor: undefined }));
      await admin
        .post(`/api/v1/admin/rewards/users/${userId}/adjustments`)
        .set('Origin', ORIGIN)
        .send({
          mode: 'demo',
          points: 40_000,
          reason: 'Points for the integration test',
          idempotencyKey: randomUUID(),
        });
      await admin
        .post(`/api/v1/admin/rewards/users/${userId}/credits`)
        .set('Origin', ORIGIN)
        .send({
          mode: 'demo',
          amount: { amountMinor: '20000', currency: 'INR' },
          reason: 'promotion',
          note: 'Welcome credit',
          justification: 'Integration test credit',
          idempotencyKey: randomUUID(),
        });
      const booking = await book(agent);
      const t = total(booking);
      const d = (t * 1_000n) / 10_000n;
      await coupon(agent, booking.reference, 'TENOFF');

      // Rewards are measured against the price after the coupon.
      let q = bookingRewardsSchema.parse(
        (await agent.get(`/api/v1/bookings/${booking.reference}/rewards`)).body.data,
      );
      expect(q.afterPromotions!.amountMinor).toBe((t - d).toString());
      expect(BigInt(q.points.max)).toBe(
        [40_000n, 20_000n, ((t - d) * 5_000n) / 10_000n / 25n].reduce((a, b) => (b < a ? b : a)),
      );
      const put = await agent
        .put(`/api/v1/bookings/${booking.reference}/rewards`)
        .set('Origin', ORIGIN)
        .send({ points: 1_000, creditAmountMinor: '20000', confirm: true });
      expect(put.status).toBe(200);
      let p = await pricing(agent, booking.reference);
      expect(p).toMatchObject({
        points: { points: 1_000, amount: { amountMinor: '25000' } },
        credit: { amountMinor: '20000' },
        payable: { amountMinor: (t - d - 25_000n - 20_000n).toString() },
      });

      // Changing the coupon gives the points and credit back (the price they were measured on changed).
      await removeCoupon(agent, booking.reference);
      p = await pricing(agent, booking.reference);
      expect(p.points).toBeNull();
      expect(p.credit).toBeNull();
      q = bookingRewardsSchema.parse(
        (await agent.get(`/api/v1/bookings/${booking.reference}/rewards`)).body.data,
      );
      expect(q.points.balance).toBe(40_000);
      expect(q.credit.available!.amountMinor).toBe('20000');
      const statuses = await testPrisma().rewardRedemption.findMany({ select: { status: true } });
      expect(statuses).toEqual([{ status: 'RELEASED' }]);

      // Apply again, pay; nothing on the credit or ledger refers to the coupon.
      await coupon(agent, booking.reference, 'TENOFF');
      await agent
        .put(`/api/v1/bookings/${booking.reference}/rewards`)
        .set('Origin', ORIGIN)
        .send({ points: 1_000, creditAmountMinor: '20000', confirm: true });
      expect((await payDue(agent, booking.reference)).status).toBe(201);
      const payment = await testPrisma().payment.findFirstOrThrow({ where: { userId } });
      expect(payment.amountMinor).toBe(t - d - 45_000n);
      expect(
        await testPrisma().travelCredit.count({ where: { reason: 'PROMOTION', userId } }),
      ).toBe(1); // only the admin's
      expect(
        await testPrisma().rewardTransaction.count({
          where: { userId, description: { contains: 'TENOFF' } },
        }),
      ).toBe(0);
    });

    it('cancelling a paid booking reverses the coupon use and frees it; the refund is only what was paid', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const p = await create(
        admin,
        promo(clock, { code: 'ONLYONE', usageLimit: 1, perUserLimit: null }),
      );
      const { agent } = await register(target);
      const booking = await book(agent);
      const t = total(booking);
      await coupon(agent, booking.reference, 'ONLYONE');
      expect((await payDue(agent, booking.reference)).status).toBe(201);
      // Settled twice at once: one redemption, no double counting.
      const id = (
        await testPrisma().booking.findUniqueOrThrow({ where: { reference: booking.reference } })
      ).id;
      await Promise.all([
        promotions(clock).reconcileBooking(id),
        promotions(clock).reconcileBooking(id),
      ]);
      expect((await adminView(admin, p.id)).usage).toMatchObject({ redeemed: 1, reserved: 0 });

      expect(
        (await agent.post(`/api/v1/bookings/${booking.reference}/cancel`).set('Origin', ORIGIN))
          .status,
      ).toBe(200);
      const [r] = await redemptions({ promotionId: p.id });
      expect(r).toMatchObject({ status: 'REVERSED', closeReason: 'BOOKING_CANCELLED' });
      const refund = await testPrisma().refund.findFirstOrThrow({ where: { bookingId: id } });
      expect(refund.amountMinor).toBe(t - 100_000n); // what was paid, not the original price
      // The use is free again for someone else.
      const other = await register(target);
      const next = await book(other.agent);
      expect((await coupon(other.agent, next.reference, 'ONLYONE')).status).toBe(200);
    });

    it('a coupon that stops being valid before payment is removed, and the new amount must be confirmed', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const p = await create(admin, promo(clock, { code: 'PULLED' }));
      const { agent } = await register(target);
      const booking = await book(agent);
      const t = total(booking);
      const before = bookingPricingSchema.parse(
        (await coupon(agent, booking.reference, 'PULLED')).body.data,
      );
      await admin
        .post(`/api/v1/admin/promotions/${p.id}/status`)
        .set('Origin', ORIGIN)
        .send({ active: false, reason: 'Campaign withdrawn early' });

      const refused = await pay(agent, booking.reference, before.payable!);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      const after = await pricing(agent, booking.reference);
      expect(after.promotions).toEqual([]);
      expect(after.payable!.amountMinor).toBe(t.toString());
      expect(after.notice).toMatchObject({ code: 'COUPON_INACTIVE' });
      expect((await pay(agent, booking.reference, after.payable!)).status).toBe(201);
      expect((await redemptions())[0]).toMatchObject({
        status: 'RELEASED',
        closeReason: 'COUPON_INACTIVE',
      });
    });
  });

  describe('discovery, admin and guards', () => {
    it('lists only running, listed offers, plus the signed-in customer’s own personal offers', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const { agent, userId } = await register(target);
      const other = await register(target);
      await create(
        admin,
        promo(clock, { code: 'PUBLIC1', name: 'Public offer', categories: ['hotels'] }),
      );
      await create(
        admin,
        promo(clock, {
          code: 'SOON',
          name: 'Not yet',
          startsAt: new Date(clock.now().getTime() + DAY).toISOString(),
        }),
      );
      const paused = await create(admin, promo(clock, { code: 'PAUSED', name: 'Paused' }));
      await admin
        .post(`/api/v1/admin/promotions/${paused.id}/status`)
        .set('Origin', ORIGIN)
        .send({ active: false, reason: 'Paused for testing' });
      await create(
        admin,
        promo(clock, { code: 'JUSTYOU', name: 'Just for you', userId, listed: false }),
      );
      await create(admin, promo(clock, { code: 'HIDDEN', name: 'Unlisted', listed: false }));

      const anon = await request(target).get('/api/v1/promotions');
      expect(anon.status).toBe(200);
      expect(anon.body.data.items.map((o: { name: string }) => o.name)).toEqual(['Public offer']);
      const mine = await agent.get('/api/v1/promotions');
      expect(
        mine.body.data.items.map((o: { name: string; personal: boolean }) => [o.name, o.personal]),
      ).toEqual([
        ['Public offer', false],
        ['Just for you', true],
      ]);
      expect((await other.agent.get('/api/v1/promotions')).body.data.items).toHaveLength(1);
      expect(
        (await request(target).get('/api/v1/promotions?category=flights')).body.data.items,
      ).toEqual([]);
      clock.advance(31 * DAY);
      expect((await request(target).get('/api/v1/promotions')).body.data.items).toEqual([]);
    });

    it('admin: support reads, only admins change, every change is validated and audited, usage shows no customer details', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const support = await staff(target, 'support');
      const { agent } = await register(target);
      const body = promo(clock, { code: 'AUDITED' });
      expect(
        (await support.post('/api/v1/admin/promotions').set('Origin', ORIGIN).send(body)).status,
      ).toBe(403);
      expect(
        (await agent.post('/api/v1/admin/promotions').set('Origin', ORIGIN).send(body)).status,
      ).toBe(403);
      expect((await agent.get('/api/v1/admin/promotions')).status).toBe(403);
      expect(
        (
          await admin
            .post('/api/v1/admin/promotions')
            .set('Origin', ORIGIN)
            .send({ ...body, percentBps: 9_999 })
        ).status,
      ).toBe(400);
      const p = await create(admin, body);
      expect(
        (await admin.post('/api/v1/admin/promotions').set('Origin', ORIGIN).send(body)).status,
      ).toBe(409); // codes are unique
      expect((await support.get('/api/v1/admin/promotions')).status).toBe(200);

      const { kind: _k, code: _c, ...editable } = adminPromotionSchemaToInput(body);
      const noReason = await admin
        .patch(`/api/v1/admin/promotions/${p.id}`)
        .set('Origin', ORIGIN)
        .send({ ...editable, percentBps: 1_500 });
      expect(noReason.status).toBe(400);
      const edited = await admin
        .patch(`/api/v1/admin/promotions/${p.id}`)
        .set('Origin', ORIGIN)
        .send({ ...editable, percentBps: 1_500, reason: 'Raise to 15% for the weekend' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ percentBps: 1_500, version: 2 });
      expect(
        (
          await support
            .patch(`/api/v1/admin/promotions/${p.id}`)
            .set('Origin', ORIGIN)
            .send({ ...editable, reason: 'Support trying to edit' })
        ).status,
      ).toBe(403);
      const audit = await testPrisma().auditLog.findFirstOrThrow({
        where: { action: 'promotion.updated', entityId: p.id },
      });
      expect(audit.metadata).toMatchObject({
        reason: 'Raise to 15% for the weekend',
        changes: { percentBps: { from: 1_000, to: 1_500 } },
      });

      const booking = await book(agent);
      await coupon(agent, booking.reference, 'AUDITED');
      const usage = adminPromotionUsageSchema.parse(
        (await support.get(`/api/v1/admin/promotions/${p.id}/usage`)).body.data,
      );
      expect(usage.items).toEqual([
        expect.objectContaining({
          bookingReference: booking.reference,
          status: 'reserved',
          promotionVersion: 2,
        }),
      ]);
      expect(JSON.stringify(usage)).not.toMatch(/@example\.com|Asha|userId/);
    });

    it('the database keeps usage history and its facts', async () => {
      const clock = testClock();
      const target = app(clock);
      const admin = await staff(target);
      const p = await create(admin, promo(clock, { code: 'KEEPME' }));
      const { agent } = await register(target);
      const booking = await book(agent);
      await coupon(agent, booking.reference, 'KEEPME');
      const prisma = testPrisma();
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM "promotions" WHERE "id" = '${p.id}'`),
      ).rejects.toThrow(/kept for audit/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "promotion_redemptions" SET "discount_minor" = 1`),
      ).rejects.toThrow(/immutable/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "promotion_redemptions"`)).rejects.toThrow(
        /kept for audit/,
      );
      await removeCoupon(agent, booking.reference);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "promotion_redemptions" SET "status" = 'RESERVED', "closed_at" = NULL, "close_reason" = NULL`,
        ),
      ).rejects.toThrow(/can't reopen|can''t reopen|reopen/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "promotions" SET "percent_bps" = 20000`),
      ).rejects.toThrow(/promotions_discount/);
    });
  });
});

/** The editable part of a create body (kind and code can't change). */
function adminPromotionSchemaToInput(body: AdminPromotionInput) {
  return {
    ...body,
    minAmountMinor: body.minAmountMinor ?? '0',
    categories: body.categories ?? [],
    usageLimit: body.usageLimit ?? null,
    perUserLimit: body.perUserLimit === undefined ? 1 : body.perUserLimit,
    firstBookingOnly: body.firstBookingOnly ?? false,
    userId: body.userId ?? null,
    stackable: body.stackable ?? false,
    listed: body.listed ?? true,
    active: body.active ?? true,
  };
}
