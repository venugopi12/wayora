import type { z } from 'zod';
import {
  normalizeCouponCode,
  COUPON_CODE_PATTERN,
  type adminPromotionInputSchema,
  type adminPromotionListQuerySchema,
  type adminPromotionUpdateSchema,
  type adminPromotionUsageQuerySchema,
  type AdminPromotion,
  type AdminPromotionList,
  type AdminPromotionUsage,
  type AppliedPromotion,
  type BookingPricing,
  type Money,
  type PromotionOffer,
  type PromotionRejection,
  type TravelCategorySlug,
} from '@wayora/contracts';
import type {
  Prisma,
  PrismaClient,
  PromotionModel as PromotionRow,
  PromotionKind,
  UserModel as User,
} from '@wayora/database';
import { CATEGORY, SERVICE_TYPE } from '../../utils/categories.js';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { promotionDiscountMinor } from '../pricing/breakdown.js';
import { errorForLog } from '../search/errors.js';
import type { CallContext } from '../search/search.service.js';
import {
  REJECTION_MESSAGE,
  discountFor,
  rankAutomatic,
  staticRejection,
  type PromotionRule,
} from './engine.js';

/*
 * The promotion engine (docs/promotions.md). One service for every promotion
 * step, so no route calculates a discount on its own:
 *
 *   lookup        → find a coupon by normalized code, or the automatic candidates
 *   eligibility   → engine.staticRejection + first-booking + usage limits (database)
 *   calculation   → engine.discountFor (BigInt, capped, never to zero)
 *   reservation   → a RESERVED promotion_redemption, under the promotion's row
 *                   lock and the customer's advisory lock, so limits hold under
 *                   concurrency; it holds until the booking's payment window ends
 *   confirmation  → REDEEMED only once the booking is paid and confirmed
 *   release       → RELEASED (removed, replaced, no longer valid, abandoned, closed unpaid)
 *   reversal      → REVERSED when a paid booking is cancelled (the use is given back)
 *
 * Promotions never change a booking or payment record: they only add the
 * redemption rows that pricing/breakdown.ts subtracts.
 */

type Tx = Prisma.TransactionClient;

export interface PromotionsServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  now?: () => Date;
  /** Expires the user's overdue unpaid bookings first (payments service). */
  expireOverdue?: (filter: { userId: string }) => Promise<unknown>;
  /** Gives back points and credit applied to the booking when its price changes (rewards service). */
  releaseRewards?: (
    tx: Tx,
    bookingId: string,
    actor: { type: 'USER' | 'SYSTEM'; id: string | null },
  ) => Promise<boolean>;
}

const OPEN = ['RESERVED', 'REDEEMED'] as const;
const CLOSED_BOOKING = ['CANCELLED', 'EXPIRED', 'FAILED'] as const;
const NOT_FOUND = "We couldn't find that booking.";

const money = (amountMinor: bigint, currency: string): Money => ({
  amountMinor: amountMinor.toString(),
  currency,
});

export function toRule(p: PromotionRow): PromotionRule {
  return {
    id: p.id,
    kind: p.kind,
    discountType: p.discountType,
    percentBps: p.percentBps,
    amountMinor: p.amountMinor,
    maxDiscountMinor: p.maxDiscountMinor,
    minAmountMinor: p.minAmountMinor,
    currency: p.currency,
    categories: p.categories.map((c) => SERVICE_TYPE[c]),
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    active: p.active,
    firstBookingOnly: p.firstBookingOnly,
    userId: p.userId,
    stackable: p.stackable,
    createdAt: p.createdAt,
  };
}

const reject = (code: PromotionRejection) => new AppError(code, REJECTION_MESSAGE[code]);

const NOTICE_MESSAGE: Record<string, string> = {
  COUPON_EXPIRED: 'Your coupon expired before you paid, so it was removed. Check the new amount.',
  COUPON_INACTIVE:
    'Your coupon was withdrawn before you paid, so it was removed. Check the new amount.',
  REPRICED:
    'Your promotion changed, so the points and travel credit you applied were given back. Apply them again if you want to.',
};

const bookingSelect = {
  id: true,
  reference: true,
  userId: true,
  status: true,
  category: true,
  currency: true,
  isDemo: true,
  paymentMode: true,
  paymentDueAt: true,
  totalAmountMinor: true,
  payments: { select: { status: true, refundRequired: true } },
  promotionRedemptions: {
    where: { status: { in: [...OPEN] } },
    include: { promotion: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.BookingSelect;
type BookingRow = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

export class PromotionsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(private readonly options: PromotionsServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  // ─── Locks and counts ───────────────────────────────────────────────────

  private async lockPromotion(tx: Tx, id: string): Promise<PromotionRow> {
    await tx.$queryRaw`SELECT "id" FROM "promotions" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.promotion.findUniqueOrThrow({ where: { id } });
  }

  /** Serializes per-customer checks (first booking, per-user limits) across promotions. */
  private async lockCustomer(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`promotions:user:${userId}`}))`;
  }

  /** Releases this promotion's holds whose checkout was abandoned (call under its lock). */
  private async releaseStale(tx: Tx, promotionId: string, now: Date): Promise<void> {
    const stale = await tx.promotionRedemption.findMany({
      where: {
        promotionId,
        status: 'RESERVED',
        reservedUntil: { lte: now },
        booking: {
          payments: { none: { status: { in: ['CREATED', 'PENDING', 'SUCCEEDED'] } } },
        },
      },
      select: { id: true },
    });
    for (const r of stale) await this.close(tx, r.id, 'RELEASED', 'RESERVATION_EXPIRED', now);
  }

  private async close(
    tx: Tx,
    id: string,
    status: 'RELEASED' | 'REVERSED',
    reason: string,
    now: Date,
  ): Promise<boolean> {
    const changed = await tx.promotionRedemption.updateMany({
      where: { id, status: { in: [...OPEN] } },
      data: { status, closeReason: reason, closedAt: now, updatedAt: now },
    });
    return changed.count === 1;
  }

  /** Database checks, in order: personal/first-booking eligibility, per-user limit, global limit. */
  private async usageRejection(
    tx: Tx,
    p: PromotionRow,
    userId: string,
    bookingId: string,
  ): Promise<PromotionRejection | null> {
    if (p.firstBookingOnly) {
      const [confirmed, otherFirst] = await Promise.all([
        tx.booking.count({ where: { userId, status: 'CONFIRMED', id: { not: bookingId } } }),
        tx.promotionRedemption.count({
          where: {
            userId,
            bookingId: { not: bookingId },
            status: { in: [...OPEN] },
            promotion: { firstBookingOnly: true },
          },
        }),
      ]);
      if (confirmed > 0 || otherFirst > 0) return 'USER_NOT_ELIGIBLE';
    }
    const used = (where: Prisma.PromotionRedemptionWhereInput) =>
      tx.promotionRedemption.count({
        where: {
          promotionId: p.id,
          status: { in: [...OPEN] },
          bookingId: { not: bookingId },
          ...where,
        },
      });
    if (p.perUserLimit !== null && (await used({ userId })) >= p.perUserLimit) {
      return 'USER_USAGE_LIMIT_REACHED';
    }
    if (p.usageLimit !== null && (await used({})) >= p.usageLimit) return 'USAGE_LIMIT_REACHED';
    return null;
  }

  // ─── Checkout ───────────────────────────────────────────────────────────

  /** Why promotions can't change on this booking now, or null. */
  private blocker(b: BookingRow, now: Date): string | null {
    if (b.paymentMode !== 'DEMO' || b.totalAmountMinor === null) {
      return 'This booking isn’t paid on Wayora, so promotions don’t apply to it.';
    }
    if (b.payments.some((p) => ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status))) {
      return 'This booking is already paid.';
    }
    if (b.payments.some((p) => p.status === 'CREATED' || p.status === 'PENDING')) {
      return 'A payment for this booking is in progress, so its promotions can’t change now.';
    }
    if (b.status !== 'PENDING') return 'Promotions can only change before a booking is paid.';
    if (b.paymentDueAt && b.paymentDueAt.getTime() <= now.getTime()) {
      return 'This booking’s payment window has closed.';
    }
    return null;
  }

  private async findOwned(userId: string, reference: string) {
    await this.options.expireOverdue?.({ userId });
    const found = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', NOT_FOUND);
    return found.id;
  }

  private readBooking(tx: Tx, bookingId: string) {
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: bookingSelect });
  }

  /**
   * The best automatic promotion this booking qualifies for, reserved under
   * its lock (call with the booking locked). Only when the booking has no
   * live coupon and no live automatic promotion. Returns whether one was added.
   */
  private async ensureAutomaticTx(tx: Tx, b: BookingRow, now: Date): Promise<boolean> {
    if (this.blocker(b, now) !== null || b.promotionRedemptions.length > 0) return false;
    const total = b.totalAmountMinor!;
    const facts = {
      now,
      userId: b.userId,
      currency: b.currency,
      category: SERVICE_TYPE[b.category],
      eligibleMinor: total,
    };
    const rows = await tx.promotion.findMany({
      where: {
        kind: 'AUTOMATIC',
        active: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
        currency: b.currency,
        OR: [{ userId: null }, { userId: b.userId }],
      },
    });
    const candidates = rankAutomatic(
      rows
        .map((row) => ({ row, rule: toRule(row) }))
        .filter((c) => staticRejection(c.rule, facts) === null)
        .map((c) => ({ ...c, discount: discountFor(c.rule, total) })),
    );
    for (const c of candidates) {
      const p = await this.lockPromotion(tx, c.row.id);
      await this.lockCustomer(tx, b.userId);
      await this.releaseStale(tx, p.id, now);
      // Re-check under the lock: it may have changed since it was read.
      const rule = toRule(p);
      if (staticRejection(rule, facts) !== null) continue;
      if ((await this.usageRejection(tx, p, b.userId, b.id)) !== null) continue;
      const discount = discountFor(rule, total);
      await this.reserve(tx, b, p, 'AUTOMATIC', total, discount, now);
      return true;
    }
    return false;
  }

  private async reserve(
    tx: Tx,
    b: BookingRow,
    p: PromotionRow,
    kind: PromotionKind,
    eligible: bigint,
    discount: bigint,
    now: Date,
  ) {
    await tx.promotionRedemption.create({
      data: {
        promotionId: p.id,
        bookingId: b.id,
        userId: b.userId,
        kind,
        code: p.code,
        eligibleAmountMinor: eligible,
        discountMinor: discount,
        currency: b.currency,
        promotionVersion: p.version,
        // Held for the booking's payment window (longer while a payment is in progress).
        reservedUntil: b.paymentDueAt ?? now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  /** After a booking's promotions changed: points and credit go back (their limits used the old price). */
  private async repriced(
    tx: Tx,
    bookingId: string,
    actor: { type: 'USER' | 'SYSTEM'; id: string | null },
  ) {
    const released = (await this.options.releaseRewards?.(tx, bookingId, actor)) ?? false;
    if (released) {
      await tx.auditLog.create({
        data: {
          actorType: actor.type,
          actorId: actor.id,
          action: 'promotion.repriced',
          entityType: 'booking',
          entityId: bookingId,
          metadata: { rewardsReleased: true },
        },
      });
    }
  }

  /**
   * Applies a coupon (PUT /bookings/:reference/pricing/coupon). Validates it
   * against the booking, then reserves one use. Replaces an earlier coupon;
   * a non-stackable coupon replaces the automatic promotion only if it takes
   * more off. The same code again changes nothing.
   */
  async applyCoupon(
    userId: string,
    reference: string,
    rawCode: string,
    context: CallContext = {},
  ): Promise<BookingPricing> {
    const code = normalizeCouponCode(rawCode);
    if (!COUPON_CODE_PATTERN.test(code)) throw reject('COUPON_NOT_FOUND');
    const bookingId = await this.findOwned(userId, reference);
    await this.reconcileBooking(bookingId);
    let rejected: { code: PromotionRejection; promotionId: string; bookingId: string } | null =
      null;
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockBooking(tx, bookingId);
      const b = await this.readBooking(tx, bookingId);
      const blocker = this.blocker(b, now);
      if (blocker) throw new AppError('CONFLICT', blocker);
      const currentCoupon = b.promotionRedemptions.find((r) => r.kind === 'COUPON');
      if (currentCoupon?.code === code) return; // already applied
      const found = await tx.promotion.findUnique({ where: { code } });
      if (!found || found.kind !== 'COUPON' || (found.userId && found.userId !== userId)) {
        throw reject('COUPON_NOT_FOUND');
      }
      const p = await this.lockPromotion(tx, found.id);
      await this.lockCustomer(tx, userId);
      await this.releaseStale(tx, p.id, now);
      const rule = toRule(p);
      const total = b.totalAmountMinor!;
      const auto = b.promotionRedemptions.find((r) => r.kind === 'AUTOMATIC');
      const eligible = p.stackable && auto ? total - auto.discountMinor : total;
      const facts = {
        now,
        userId,
        currency: b.currency,
        category: SERVICE_TYPE[b.category],
        eligibleMinor: eligible,
      };
      const rejection =
        staticRejection(rule, facts) ?? (await this.usageRejection(tx, p, userId, b.id));
      if (rejection) {
        // Recorded after this transaction (so the record survives the refusal).
        rejected = { code: rejection, promotionId: p.id, bookingId: b.id };
        return;
      }
      const discount = discountFor(rule, eligible);
      if (auto && !p.stackable && discount <= auto.discountMinor) {
        rejected = { code: 'PROMOTION_NOT_STACKABLE', promotionId: p.id, bookingId: b.id };
        return;
      }
      if (auto && !p.stackable) {
        // One promotion only: the coupon replaces the automatic one, as it takes more off.
        await this.close(tx, auto.id, 'RELEASED', 'REPLACED', now);
      }
      if (currentCoupon) await this.close(tx, currentCoupon.id, 'RELEASED', 'REPLACED', now);
      await this.reserve(tx, b, p, 'COUPON', eligible, discount, now);
      await this.repriced(tx, b.id, { type: 'USER', id: userId });
      await tx.auditLog.create({
        data: {
          actorType: 'USER',
          actorId: userId,
          action: 'promotion.coupon_applied',
          entityType: 'booking',
          entityId: b.id,
          requestId: context.requestId ?? null,
          metadata: {
            promotionId: p.id,
            code,
            discountMinor: discount.toString(),
            eligibleMinor: eligible.toString(),
            currency: b.currency,
            version: p.version,
          },
        },
      });
    });
    const refusal = rejected as {
      code: PromotionRejection;
      promotionId: string;
      bookingId: string;
    } | null;
    if (refusal) {
      // Kept for review: which promotion and why (nothing about other customers).
      await this.prisma.auditLog.create({
        data: {
          actorType: 'USER',
          actorId: userId,
          action: 'promotion.coupon_rejected',
          entityType: 'booking',
          entityId: refusal.bookingId,
          requestId: context.requestId ?? null,
          metadata: { promotionId: refusal.promotionId, reason: refusal.code },
        },
      });
      throw reject(refusal.code);
    }
    return this.pricing(userId, reference);
  }

  /** Removes the coupon (DELETE /bookings/:reference/pricing/coupon); an automatic promotion may apply again. */
  async removeCoupon(
    userId: string,
    reference: string,
    context: CallContext = {},
  ): Promise<BookingPricing> {
    const bookingId = await this.findOwned(userId, reference);
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockBooking(tx, bookingId);
      const b = await this.readBooking(tx, bookingId);
      const blocker = this.blocker(b, now);
      if (blocker) throw new AppError('CONFLICT', blocker);
      const coupon = b.promotionRedemptions.find((r) => r.kind === 'COUPON');
      if (!coupon) return;
      await this.close(tx, coupon.id, 'RELEASED', 'REMOVED', now);
      await this.repriced(tx, b.id, { type: 'USER', id: userId });
      await tx.auditLog.create({
        data: {
          actorType: 'USER',
          actorId: userId,
          action: 'promotion.coupon_removed',
          entityType: 'booking',
          entityId: b.id,
          requestId: context.requestId ?? null,
          metadata: { promotionId: coupon.promotionId, code: coupon.code },
        },
      });
    });
    return this.pricing(userId, reference);
  }

  /**
   * Before a payment is recorded (payments hook): promotions that stopped
   * being valid (deactivated or past their end) are released, and points and
   * credit applied on top of them go back. The payment then no longer matches
   * the amount the customer saw, so they review the new amount first.
   */
  async revalidateBeforePayment(bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockBooking(tx, bookingId);
      const b = await this.readBooking(tx, bookingId);
      if (this.blocker(b, now) !== null) return;
      let changed = false;
      for (const r of b.promotionRedemptions) {
        if (r.status !== 'RESERVED') continue;
        const reason = !r.promotion.active
          ? 'COUPON_INACTIVE'
          : now.getTime() >= r.promotion.endsAt.getTime()
            ? 'COUPON_EXPIRED'
            : null;
        if (reason && (await this.close(tx, r.id, 'RELEASED', reason, now))) changed = true;
      }
      if (changed) await this.repriced(tx, b.id, { type: 'SYSTEM', id: null });
    });
  }

  /** The authoritative price breakdown (GET /bookings/:reference/pricing). */
  async pricing(userId: string, reference: string): Promise<BookingPricing> {
    const bookingId = await this.findOwned(userId, reference);
    await this.reconcileBooking(bookingId);
    return this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockBooking(tx, bookingId);
      let b = await this.readBooking(tx, bookingId);
      if (await this.ensureAutomaticTx(tx, b, now)) {
        await this.repriced(tx, b.id, { type: 'SYSTEM', id: null });
        b = await this.readBooking(tx, bookingId);
      }
      return this.breakdown(tx, b, now);
    });
  }

  /** Applies the best automatic promotion to a new booking (after it commits; never fails the booking). */
  async applyAutomatic(bookingId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, bookingId);
        await this.ensureAutomaticTx(tx, await this.readBooking(tx, bookingId), this.now());
      });
    } catch (error) {
      this.options.logger.warn(
        { err: errorForLog(error), bookingId },
        'Automatic promotion not applied; checkout will try again',
      );
    }
  }

  private presentApplied(r: BookingRow['promotionRedemptions'][number]): AppliedPromotion {
    return {
      promotionId: r.promotionId,
      kind: r.kind === 'COUPON' ? 'coupon' : 'automatic',
      code: r.code,
      name: r.promotion.name,
      description: r.promotion.description,
      discount: money(r.discountMinor, r.currency),
      status: r.status === 'REDEEMED' ? 'redeemed' : 'reserved',
      reservedUntil: r.status === 'RESERVED' ? r.reservedUntil.toISOString() : null,
    };
  }

  private async breakdown(tx: Tx, b: BookingRow, now: Date): Promise<BookingPricing> {
    const total = b.totalAmountMinor;
    const c = b.currency;
    const promo = await promotionDiscountMinor(tx, b.id);
    const rewards = await tx.rewardRedemption.findFirst({
      where: { bookingId: b.id, status: { in: ['APPLIED', 'CONSUMED'] } },
      select: {
        points: true,
        pointsAmountMinor: true,
        creditAmountMinor: true,
        totalAmountMinor: true,
      },
    });
    const blocker = this.blocker(b, now);
    // The last automatic change the customer should hear about, if nothing replaced it since.
    const lastChange = await tx.promotionRedemption.findFirst({
      where: { bookingId: b.id, closeReason: { in: ['COUPON_EXPIRED', 'COUPON_INACTIVE'] } },
      orderBy: { closedAt: 'desc' },
      select: { closeReason: true, closedAt: true },
    });
    const newer = b.promotionRedemptions.some(
      (r) => r.kind === 'COUPON' && lastChange?.closedAt && r.createdAt > lastChange.closedAt,
    );
    const notice =
      lastChange?.closedAt && !newer && blocker === null
        ? {
            code: lastChange.closeReason!,
            message: NOTICE_MESSAGE[lastChange.closeReason!] ?? 'Your promotion changed.',
            at: lastChange.closedAt.toISOString(),
          }
        : null;
    return {
      demo: b.isDemo,
      original: total === null ? null : money(total, c),
      promotions: b.promotionRedemptions.map((r) => this.presentApplied(r)),
      promotionDiscount: total === null ? null : money(promo, c),
      afterPromotions: total === null ? null : money(total - promo, c),
      points:
        rewards && rewards.points > 0n
          ? { points: Number(rewards.points), amount: money(rewards.pointsAmountMinor, c) }
          : null,
      credit:
        rewards && rewards.creditAmountMinor > 0n ? money(rewards.creditAmountMinor, c) : null,
      payable: total === null ? null : money(total - promo - (rewards?.totalAmountMinor ?? 0n), c),
      canChangePromotions: blocker === null,
      reason: blocker,
      notice,
    };
  }

  // ─── Settling ───────────────────────────────────────────────────────────

  /**
   * Brings a booking's promotion uses in line with its booking and payment
   * (idempotent; after commits, on reads, and from the sweep):
   *   RESERVED + paid and confirmed          → REDEEMED
   *   RESERVED + booking closed              → RELEASED (BOOKING_CLOSED)
   *   RESERVED + hold over, nothing paying   → RELEASED (RESERVATION_EXPIRED)
   *   REDEEMED + booking cancelled or failed → REVERSED (BOOKING_CANCELLED)
   */
  async reconcileBooking(bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      if (!(await lockBooking(tx, bookingId))) return;
      const b = await this.readBooking(tx, bookingId);
      const paid = b.payments.some((p) => p.status === 'SUCCEEDED' && !p.refundRequired);
      const paying = b.payments.some((p) => ['CREATED', 'PENDING', 'SUCCEEDED'].includes(p.status));
      const closed = (CLOSED_BOOKING as readonly string[]).includes(b.status);
      for (const r of b.promotionRedemptions) {
        if (r.status === 'RESERVED') {
          if (b.status === 'CONFIRMED' && paid) {
            await tx.promotionRedemption.updateMany({
              where: { id: r.id, status: 'RESERVED' },
              data: { status: 'REDEEMED', redeemedAt: now, updatedAt: now },
            });
          } else if (closed) {
            await this.close(tx, r.id, 'RELEASED', 'BOOKING_CLOSED', now);
          } else if (r.reservedUntil.getTime() <= now.getTime() && !paying) {
            await this.close(tx, r.id, 'RELEASED', 'RESERVATION_EXPIRED', now);
          }
        } else if (b.status === 'CANCELLED' || b.status === 'FAILED') {
          await this.close(tx, r.id, 'REVERSED', 'BOOKING_CANCELLED', now);
        }
      }
    });
  }

  /** Maintenance (every minute, every instance): settles holds and uses that need it. */
  async sweep(limit = 200): Promise<number> {
    const now = this.now();
    const rows = await this.prisma.promotionRedemption.findMany({
      where: {
        OR: [
          { status: 'RESERVED', reservedUntil: { lte: now } },
          { status: 'RESERVED', booking: { status: { not: 'PENDING' } } },
          { status: 'REDEEMED', booking: { status: { in: ['CANCELLED', 'FAILED'] } } },
        ],
      },
      select: { bookingId: true },
      distinct: ['bookingId'],
      take: limit,
    });
    for (const r of rows) {
      try {
        await this.reconcileBooking(r.bookingId);
      } catch (error) {
        this.options.logger.warn(
          { err: errorForLog(error), bookingId: r.bookingId },
          'Promotion settlement failed; will retry',
        );
      }
    }
    return rows.length;
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  private presentOffer(p: PromotionRow, forUser: string | null): PromotionOffer {
    const c = p.currency;
    return {
      id: p.id,
      kind: p.kind === 'COUPON' ? 'coupon' : 'automatic',
      code: p.code,
      name: p.name,
      description: p.description,
      terms: p.terms,
      discountType: p.discountType === 'PERCENTAGE' ? 'percentage' : 'fixed',
      percentBps: p.percentBps,
      amount: p.amountMinor === null ? null : money(p.amountMinor, c),
      maxDiscount: p.maxDiscountMinor === null ? null : money(p.maxDiscountMinor, c),
      minAmount: p.minAmountMinor > 0n ? money(p.minAmountMinor, c) : null,
      categories: p.categories.map((x) => SERVICE_TYPE[x]),
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      firstBookingOnly: p.firstBookingOnly,
      stackable: p.stackable,
      personal: forUser !== null && p.userId === forUser,
    };
  }

  /**
   * GET /promotions: active offers running now, listed ones for everyone and
   * the signed-in customer's own personal offers. Nothing about eligibility
   * is claimed; that is checked at checkout.
   */
  async offers(userId: string | null, category?: TravelCategorySlug): Promise<PromotionOffer[]> {
    const now = this.now();
    const visible: Prisma.PromotionWhereInput = {
      OR: [{ listed: true, userId: null }, ...(userId ? [{ userId }] : [])],
    };
    const inCategory: Prisma.PromotionWhereInput = category
      ? { OR: [{ categories: { isEmpty: true } }, { categories: { has: CATEGORY[category] } }] }
      : {};
    const rows = await this.prisma.promotion.findMany({
      where: {
        active: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
        AND: [visible, inCategory],
      },
      orderBy: [{ endsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    return rows.map((p) => this.presentOffer(p, userId));
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  private state(p: PromotionRow, now: Date): AdminPromotion['state'] {
    if (!p.active) return 'inactive';
    if (now.getTime() < p.startsAt.getTime()) return 'scheduled';
    if (now.getTime() >= p.endsAt.getTime()) return 'ended';
    return 'running';
  }

  private async presentAdmin(p: PromotionRow, now: Date): Promise<AdminPromotion> {
    const groups = await this.prisma.promotionRedemption.groupBy({
      by: ['status'],
      where: { promotionId: p.id },
      _count: { _all: true },
    });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const redeemed = await this.prisma.promotionRedemption.aggregate({
      where: { promotionId: p.id, status: 'REDEEMED' },
      _sum: { discountMinor: true },
    });
    const value = await this.prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(b."total_amount_minor")::bigint AS "total"
        FROM "promotion_redemptions" r JOIN "bookings" b ON b."id" = r."booking_id"
       WHERE r."promotion_id" = ${p.id}::uuid AND r."status" = 'REDEEMED'`;
    return {
      ...this.presentOffer(p, null),
      code: p.code,
      currency: p.currency,
      usageLimit: p.usageLimit,
      perUserLimit: p.perUserLimit,
      userId: p.userId,
      listed: p.listed,
      active: p.active,
      version: p.version,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      usage: {
        reserved: count('RESERVED'),
        redeemed: count('REDEEMED'),
        released: count('RELEASED'),
        reversed: count('REVERSED'),
        redeemedDiscount: money(redeemed._sum.discountMinor ?? 0n, p.currency),
        redeemedBookingValue: money(BigInt(value[0]?.total ?? 0n), p.currency),
      },
      state: this.state(p, now),
    };
  }

  async adminList(
    query: z.output<typeof adminPromotionListQuerySchema>,
  ): Promise<AdminPromotionList> {
    const now = this.now();
    const where: Prisma.PromotionWhereInput = {
      ...(query.kind ? { kind: query.kind === 'coupon' ? 'COUPON' : 'AUTOMATIC' } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: normalizeCouponCode(query.q) } },
            ],
          }
        : {}),
      ...(query.state === 'inactive'
        ? { active: false }
        : query.state === 'scheduled'
          ? { active: true, startsAt: { gt: now } }
          : query.state === 'ended'
            ? { active: true, endsAt: { lte: now } }
            : query.state === 'running'
              ? { active: true, startsAt: { lte: now }, endsAt: { gt: now } }
              : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.promotion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.promotion.count({ where }),
    ]);
    return {
      items: await Promise.all(rows.map((p) => this.presentAdmin(p, now))),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async adminGet(id: string): Promise<AdminPromotion> {
    const p = await this.prisma.promotion.findUnique({ where: { id } });
    if (!p) throw new AppError('NOT_FOUND', 'There is no promotion with that id.');
    return this.presentAdmin(p, this.now());
  }

  async adminUsage(
    id: string,
    query: z.output<typeof adminPromotionUsageQuerySchema>,
  ): Promise<AdminPromotionUsage> {
    await this.adminGet(id);
    const where: Prisma.PromotionRedemptionWhereInput = {
      promotionId: id,
      ...(query.status ? { status: query.status.toUpperCase() as 'RESERVED' } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.promotionRedemption.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { booking: { select: { reference: true } } },
      }),
      this.prisma.promotionRedemption.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status.toLowerCase() as 'reserved',
        bookingReference: r.booking.reference,
        discount: money(r.discountMinor, r.currency),
        eligibleAmount: money(r.eligibleAmountMinor, r.currency),
        promotionVersion: r.promotionVersion,
        createdAt: r.createdAt.toISOString(),
        redeemedAt: r.redeemedAt?.toISOString() ?? null,
        closedAt: r.closedAt?.toISOString() ?? null,
        closeReason: r.closeReason,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  private fields(input: Omit<z.output<typeof adminPromotionUpdateSchema>, 'reason'>) {
    return {
      name: input.name,
      description: input.description,
      terms: input.terms,
      discountType:
        input.discountType === 'percentage' ? ('PERCENTAGE' as const) : ('FIXED' as const),
      percentBps: input.percentBps ?? null,
      amountMinor: input.amountMinor ? BigInt(input.amountMinor) : null,
      maxDiscountMinor: input.maxDiscountMinor ? BigInt(input.maxDiscountMinor) : null,
      minAmountMinor: BigInt(input.minAmountMinor),
      currency: input.currency,
      categories: input.categories.map((c) => CATEGORY[c]),
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      usageLimit: input.usageLimit,
      perUserLimit: input.perUserLimit,
      firstBookingOnly: input.firstBookingOnly,
      userId: input.userId,
      stackable: input.stackable,
      listed: input.listed,
      active: input.active,
    };
  }

  private async checkUser(userId: string | null) {
    if (!userId) return;
    const exists = await this.prisma.user.count({ where: { id: userId } });
    if (!exists) throw new AppError('BAD_REQUEST', 'There is no customer with that id.');
  }

  private snapshot(p: PromotionRow) {
    return {
      ...p,
      amountMinor: p.amountMinor?.toString() ?? null,
      maxDiscountMinor: p.maxDiscountMinor?.toString() ?? null,
      minAmountMinor: p.minAmountMinor.toString(),
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      createdAt: undefined,
      updatedAt: undefined,
    };
  }

  async adminCreate(
    admin: User,
    input: z.output<typeof adminPromotionInputSchema>,
    context: CallContext = {},
  ): Promise<AdminPromotion> {
    await this.checkUser(input.userId);
    if (input.code && (await this.prisma.promotion.count({ where: { code: input.code } }))) {
      throw new AppError(
        'CONFLICT',
        'A promotion with this code already exists (codes are never reused).',
      );
    }
    const created = await this.prisma
      .$transaction(async (tx) => {
        const now = this.now();
        const p = await tx.promotion.create({
          data: {
            kind: input.kind === 'coupon' ? 'COUPON' : 'AUTOMATIC',
            code: input.kind === 'coupon' ? (input.code ?? null) : null,
            ...this.fields(input),
            createdById: admin.id,
            updatedById: admin.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'ADMIN',
            actorId: admin.id,
            action: 'promotion.created',
            entityType: 'promotion',
            entityId: p.id,
            requestId: context.requestId ?? null,
            metadata: this.snapshot(p) as unknown as Prisma.InputJsonValue,
          },
        });
        return p;
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          throw new AppError(
            'CONFLICT',
            'A promotion with this code already exists (codes are never reused).',
          );
        }
        throw error;
      });
    return this.presentAdmin(created, this.now());
  }

  /**
   * Edits a promotion (admins; reason required; audited with what changed).
   * Uses already reserved or redeemed keep the discount they were given;
   * new checkouts use the new version.
   */
  async adminUpdate(
    admin: User,
    id: string,
    input: z.output<typeof adminPromotionUpdateSchema>,
    context: CallContext = {},
  ): Promise<AdminPromotion> {
    const { reason, ...rest } = input;
    await this.checkUser(rest.userId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.promotion.findUnique({ where: { id } });
      if (!existing) throw new AppError('NOT_FOUND', 'There is no promotion with that id.');
      const before = await this.lockPromotion(tx, id);
      if (before.kind === 'AUTOMATIC' && rest.stackable) {
        throw new AppError('BAD_REQUEST', 'Only coupons can be stackable.');
      }
      const now = this.now();
      const after = await tx.promotion.update({
        where: { id },
        data: {
          ...this.fields(rest),
          version: { increment: 1 },
          updatedById: admin.id,
          updatedAt: now,
        },
      });
      const a = this.snapshot(before) as Record<string, unknown>;
      const b = this.snapshot(after) as Record<string, unknown>;
      const changed = Object.keys(b).filter(
        (k) =>
          !['version', 'updatedById'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
      );
      await tx.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: admin.id,
          action: 'promotion.updated',
          entityType: 'promotion',
          entityId: id,
          requestId: context.requestId ?? null,
          metadata: {
            reason,
            version: after.version,
            changes: Object.fromEntries(changed.map((k) => [k, { from: a[k], to: b[k] }])),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return after;
    });
    return this.presentAdmin(updated, this.now());
  }

  async adminSetActive(
    admin: User,
    id: string,
    active: boolean,
    reason: string,
    context: CallContext = {},
  ): Promise<AdminPromotion> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.promotion.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new AppError('NOT_FOUND', 'There is no promotion with that id.');
      const before = await this.lockPromotion(tx, id);
      if (before.active === active) return before;
      const p = await tx.promotion.update({
        where: { id },
        data: { active, version: { increment: 1 }, updatedById: admin.id, updatedAt: this.now() },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: admin.id,
          action: active ? 'promotion.activated' : 'promotion.deactivated',
          entityType: 'promotion',
          entityId: id,
          requestId: context.requestId ?? null,
          metadata: { reason, version: p.version },
        },
      });
      return p;
    });
    return this.presentAdmin(updated, this.now());
  }
}
