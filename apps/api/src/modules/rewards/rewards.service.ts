import type { z } from 'zod';
import {
  adminCreateRulesSchema,
  loyaltyRulesSchema,
  type adminRewardTransactionsQuerySchema,
  type rewardTransactionsQuerySchema,
  type AdminIssueCredit,
  type AdminPointsAdjustment,
  type AdminRewardTransaction,
  type AdminRewardTransactionList,
  type AdminRules,
  type AdminRuleVersion,
  type AdminUserRewards,
  type ApplyBookingRewards,
  type BookingRewards,
  type LoyaltyRules,
  type Money,
  type RewardMode,
  type RewardsAccount,
  type RewardsSummary,
  type RewardTransaction,
  type RewardTransactionList,
  type TierProgress,
  type TravelCredit,
} from '@wayora/contracts';
import {
  type Prisma,
  type PaymentMode,
  type PrismaClient,
  type RewardTransactionType as RewardTransactionTypeDb,
  type UserModel as User,
} from '@wayora/database';
import { SERVICE_TYPE } from '../../utils/categories.js';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { formatAmount, notify } from '../notifications/notify.js';
import { errorForLog } from '../search/errors.js';
import type { CallContext } from '../search/search.service.js';
import {
  alreadyDone,
  creditAvailable,
  expireDueCredits,
  expireDueLots,
  issueCredit,
  lockAccount,
  postPoints,
  restoreCredits,
  returnToLots,
  revokeCredit,
  spendCredits,
  takeFromLots,
  type CreditAllocation,
  type LockedAccount,
  type LotAllocation,
} from './ledger.js';
import {
  addDays,
  addMonths,
  calculateEarn,
  evaluateTier,
  parseRules,
  publicRules,
  redemptionLimits,
  tierById,
  type RuleVersion,
} from './rules.js';

/*
 * Loyalty points, tiers and travel credits (docs/rewards.md).
 *
 * States kept apart: the booking, its payments and its supplier reservation
 * are never changed here; rewards only read them and keep their own records
 * (ledger, lots, credits, redemptions). A failure here never touches a
 * booking or payment: rewards are settled by `reconcileBooking`, which is
 * idempotent and runs after booking and payment changes commit, on reads,
 * and from the maintenance sweep (so a missed or failed run is retried).
 *
 * Demo and live are separate accounts (mode DEMO / LIVE): demo bookings and
 * demo payments only ever earn and spend DEMO points, which have no cash
 * value. LIVE rewards need LOYALTY_LIVE_REWARDS_ENABLED and a live payment.
 */

type Tx = Prisma.TransactionClient;

export interface RewardsServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  liveEnabled: boolean;
  now?: () => Date;
  /** Expires the user's overdue unpaid bookings before rewards are read (payments service). */
  expireOverdue?: (filter: { userId: string }) => Promise<unknown>;
}

const NOT_FOUND = "We couldn't find that booking.";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_NOTICE_DAYS = 30;
const EXPIRING_WINDOW_DAYS = 90;
const CLOSED = ['CANCELLED', 'EXPIRED', 'FAILED'] as const;

const toMode = (mode: PaymentMode): RewardMode => (mode === 'DEMO' ? 'demo' : 'live');
const fromMode = (mode: RewardMode): PaymentMode => (mode === 'demo' ? 'DEMO' : 'LIVE');
const money = (amountMinor: bigint, currency: string): Money => ({
  amountMinor: amountMinor.toString(),
  currency,
});
const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: bigint) => Number(v);

interface Allocations {
  lots: LotAllocation[];
  credits: CreditAllocation[];
}

/** Rewards mode of a booking: anything demo (booking or payment) is DEMO. */
function bookingMode(row: { isDemo: boolean; paymentMode: string }, paidMode?: PaymentMode | null) {
  return row.isDemo || row.paymentMode === 'DEMO' || paidMode === 'DEMO'
    ? ('DEMO' as const)
    : ('LIVE' as const);
}

export class RewardsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(private readonly options: RewardsServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  get liveEnabled(): boolean {
    return this.options.liveEnabled;
  }

  // ─── Rules ──────────────────────────────────────────────────────────────

  /** The rule version in force at `at` (the newest whose effectiveFrom has passed). */
  async rulesAt(at: Date, client: Tx | PrismaClient = this.prisma): Promise<RuleVersion> {
    const row = await client.loyaltyRuleVersion.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
    if (!row) throw new AppError('INTERNAL_ERROR', 'No loyalty rules are configured.');
    return parseRules(row.version, row.config, row.effectiveFrom);
  }

  private async rulesVersion(version: number, client: Tx | PrismaClient): Promise<RuleVersion> {
    const row = await client.loyaltyRuleVersion.findUniqueOrThrow({ where: { version } });
    return parseRules(row.version, row.config, row.effectiveFrom);
  }

  // ─── Tiers ──────────────────────────────────────────────────────────────

  private async qualifyingPoints(
    client: Tx | PrismaClient,
    accountId: string,
    rules: LoyaltyRules,
    now: Date,
  ): Promise<bigint> {
    const sum = await client.rewardTransaction.aggregate({
      where: {
        accountId,
        createdAt: { gt: addMonths(now, -rules.qualificationMonths) },
      },
      _sum: { qualifyingPoints: true },
    });
    const q = sum._sum.qualifyingPoints ?? 0n;
    return q < 0n ? 0n : q;
  }

  /** Re-evaluates the tier under the account lock; notifies an upgrade. */
  private async refreshTier(tx: Tx, account: LockedAccount, rv: RuleVersion, now: Date) {
    const q = await this.qualifyingPoints(tx, account.id, rv.rules, now);
    const next = evaluateTier(
      rv.rules,
      { tierId: account.tier, qualifiedAt: account.tierQualifiedAt },
      q,
      now,
    );
    const same =
      next.tierId === account.tier &&
      (next.qualifiedAt?.getTime() ?? null) === (account.tierQualifiedAt?.getTime() ?? null);
    if (same) return;
    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { tier: next.tierId, tierQualifiedAt: next.qualifiedAt, updatedAt: now },
    });
    if (next.change) {
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: `rewards.tier_${next.change}`,
          entityType: 'loyalty_account',
          entityId: account.id,
          metadata: {
            from: account.tier,
            to: next.tierId,
            qualifyingPoints: q.toString(),
            ruleVersion: rv.version,
          },
        },
      });
    }
    if (next.change === 'upgrade') {
      const tier = tierById(rv.rules, next.tierId);
      await notify(tx, now, {
        userId: account.userId,
        type: 'REWARDS',
        title: `You reached ${tier.name}`,
        message: `${account.mode === 'DEMO' ? 'Demo rewards: ' : ''}you now earn points at ×${tier.earnMultiplierBps / 10_000} on eligible bookings.`,
        isDemo: account.mode === 'DEMO',
        dedupeKey: `rewards:tier:${account.id}:${next.tierId}:${day(now)}`,
      });
    }
    account.tier = next.tierId;
    account.tierQualifiedAt = next.qualifiedAt;
  }

  private tierProgress(
    rules: LoyaltyRules,
    account: { tier: string; tierQualifiedAt: Date | null } | null,
    qualifying: bigint,
  ): TierProgress {
    const tier = tierById(rules, account?.tier ?? rules.tiers[0]!.id);
    const index = rules.tiers.findIndex((t) => t.id === tier.id);
    const next = rules.tiers[index + 1];
    return {
      id: tier.id,
      name: tier.name,
      earnMultiplierBps: tier.earnMultiplierBps,
      qualifyingPoints: num(qualifying),
      keptUntil:
        index > 0 && account?.tierQualifiedAt
          ? addMonths(account.tierQualifiedAt, rules.qualificationMonths).toISOString()
          : null,
      next: next
        ? {
            id: next.id,
            name: next.name,
            minQualifyingPoints: next.minQualifyingPoints,
            pointsNeeded: Math.max(0, next.minQualifyingPoints - num(qualifying)),
          }
        : null,
    };
  }

  // ─── Customer views ─────────────────────────────────────────────────────

  async summary(userId: string): Promise<RewardsSummary> {
    await this.options.expireOverdue?.({ userId });
    await this.reconcileUser(userId);
    const now = this.now();
    const rv = await this.rulesAt(now);
    const modes: PaymentMode[] = this.liveEnabled ? ['DEMO', 'LIVE'] : ['DEMO'];
    const accounts = await Promise.all(modes.map((m) => this.accountView(userId, m, rv, now)));
    return { accounts, rules: publicRules(rv, now), liveEnabled: this.liveEnabled };
  }

  private async accountView(
    userId: string,
    mode: PaymentMode,
    rv: RuleVersion,
    now: Date,
  ): Promise<RewardsAccount> {
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { userId_mode: { userId, mode } },
    });
    const qualifying = account
      ? await this.qualifyingPoints(this.prisma, account.id, rv.rules, now)
      : 0n;
    const balance = account?.pointsBalance ?? 0n;
    const lots = account
      ? await this.prisma.loyaltyPointLot.findMany({
          where: {
            accountId: account.id,
            remaining: { gt: 0 },
            expiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * DAY_MS) },
          },
          orderBy: { expiresAt: 'asc' },
          select: { remaining: true, expiresAt: true },
        })
      : [];
    const credits = await this.prisma.travelCredit.findMany({
      where: { userId, mode },
      orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
      take: 50,
      include: { booking: { select: { reference: true } } },
    });
    const creditBalance = new Map<string, bigint>();
    for (const c of credits) {
      if (c.status === 'ACTIVE' && (!c.expiresAt || c.expiresAt > now)) {
        creditBalance.set(
          c.currency,
          (creditBalance.get(c.currency) ?? 0n) + c.remainingAmountMinor,
        );
      }
    }
    return {
      mode: toMode(mode),
      pointsBalance: num(balance),
      balanceValue: Object.entries(rv.rules.redeem.pointValueMinor).map(([currency, v]) =>
        money(balance * BigInt(v), currency),
      ),
      tier: this.tierProgress(rv.rules, account, qualifying),
      pending: await this.pendingPoints(userId, mode, account, rv, now),
      expiring: lots.map((l) => ({
        points: num(l.remaining),
        expiresAt: l.expiresAt.toISOString(),
      })),
      credits: credits.map((c) => this.presentCredit(c)),
      creditBalance: [...creditBalance].map(([currency, amount]) => money(amount, currency)),
      monthly: account ? await this.monthly(account.id, now) : this.emptyMonths(now),
    };
  }

  private emptyMonths(now: Date) {
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
      return { month: d.toISOString().slice(0, 7), earned: 0, redeemed: 0 };
    });
  }

  /** Points earned and (net) redeemed per UTC month, last 12 months. */
  private async monthly(accountId: string, now: Date) {
    const months = this.emptyMonths(now);
    const since = new Date(`${months[0]!.month}-01T00:00:00Z`);
    const rows = await this.prisma.$queryRaw<{ month: string; type: string; points: bigint }[]>`
      SELECT to_char(date_trunc('month', "created_at" AT TIME ZONE 'UTC'), 'YYYY-MM') AS "month",
             "type"::text AS "type", SUM("points")::bigint AS "points"
        FROM "reward_transactions"
       WHERE "account_id" = ${accountId}::uuid AND "created_at" >= ${since}
         AND "type" IN ('POINTS_EARNED', 'POINTS_REDEEMED', 'POINTS_RESTORED')
       GROUP BY 1, 2`;
    for (const m of months) {
      const of = (type: string) =>
        BigInt(rows.find((r) => r.month === m.month && r.type === type)?.points ?? 0n);
      m.earned = num(of('POINTS_EARNED'));
      const net = -of('POINTS_REDEEMED') - of('POINTS_RESTORED');
      m.redeemed = net > 0n ? num(net) : 0;
    }
    return months;
  }

  /** Estimates for confirmed, paid bookings whose points aren't available yet. */
  private async pendingPoints(
    userId: string,
    mode: PaymentMode,
    account: { tier: string } | null,
    rv: RuleVersion,
    now: Date,
  ) {
    const rows = await this.prisma.booking.findMany({
      where: {
        userId,
        status: 'CONFIRMED',
        payments: { some: { status: 'SUCCEEDED', refundRequired: false } },
        rewardTransactions: { none: { type: 'POINTS_EARNED' } },
      },
      select: {
        reference: true,
        category: true,
        currency: true,
        isDemo: true,
        paymentMode: true,
        startsOn: true,
        endsOn: true,
        confirmedAt: true,
        payments: {
          where: { status: 'SUCCEEDED', refundRequired: false },
          select: { amountMinor: true, mode: true },
        },
      },
      orderBy: { startsOn: 'asc' },
      take: 20,
    });
    return rows
      .filter((b) => bookingMode(b, b.payments[0]?.mode) === mode)
      .map((b) => {
        const earn = calculateEarn(rv.rules, {
          currency: b.currency,
          paidMinor: b.payments.reduce((s, p) => s + p.amountMinor, 0n),
          category: SERVICE_TYPE[b.category],
          tierId: account?.tier ?? rv.rules.tiers[0]!.id,
          confirmedAt: b.confirmedAt ?? now,
        });
        return {
          bookingReference: b.reference,
          points: num(earn.points),
          availableOn: addDays(this.completionDay(b), rv.rules.earn.availableAfterDays),
        };
      })
      .filter((p) => p.points > 0);
  }

  /** The day a trip ends: its end date, else its start date, else the confirmation day. */
  private completionDay(b: {
    endsOn: Date | null;
    startsOn: Date | null;
    confirmedAt: Date | null;
  }) {
    return day(b.endsOn ?? b.startsOn ?? b.confirmedAt ?? this.now());
  }

  private presentCredit(c: {
    reference: string;
    mode: PaymentMode;
    currency: string;
    originalAmountMinor: bigint;
    remainingAmountMinor: bigint;
    reason: string;
    note: string;
    status: string;
    issuedAt: Date;
    expiresAt: Date | null;
    booking: { reference: string } | null;
  }): TravelCredit {
    return {
      reference: c.reference,
      mode: toMode(c.mode),
      original: money(c.originalAmountMinor, c.currency),
      remaining: money(c.remainingAmountMinor, c.currency),
      reason: c.reason.toLowerCase() as TravelCredit['reason'],
      note: c.note,
      status: c.status.toLowerCase() as TravelCredit['status'],
      issuedAt: c.issuedAt.toISOString(),
      expiresAt: c.expiresAt?.toISOString() ?? null,
      bookingReference: c.booking?.reference ?? null,
    };
  }

  private static readonly txInclude = {
    booking: { select: { reference: true } },
    credit: { select: { reference: true } },
  } satisfies Prisma.RewardTransactionInclude;

  private presentTransaction(
    t: Prisma.RewardTransactionGetPayload<{ include: typeof RewardsService.txInclude }>,
  ): RewardTransaction {
    const isCredit = t.type.startsWith('CREDIT_');
    return {
      id: t.id,
      mode: toMode(t.mode),
      type: t.type.toLowerCase() as RewardTransaction['type'],
      origin: t.origin === 'MANUAL' ? 'manual' : 'automated',
      points: num(t.points),
      balanceAfter: t.balanceAfter === null ? null : num(t.balanceAfter),
      amount: isCredit && t.currency ? money(t.amountMinor, t.currency) : null,
      description: t.description,
      bookingReference: t.booking?.reference ?? null,
      creditReference: t.credit?.reference ?? null,
      ruleVersion: t.ruleVersion,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async transactions(
    userId: string,
    query: z.output<typeof rewardTransactionsQuerySchema>,
  ): Promise<RewardTransactionList> {
    if (query.mode === 'live' && !this.liveEnabled) {
      return {
        items: [],
        pagination: { page: query.page, pageSize: query.pageSize, totalResults: 0, totalPages: 0 },
      };
    }
    const where: Prisma.RewardTransactionWhereInput = {
      userId,
      mode: fromMode(query.mode),
      ...(query.kind === 'points'
        ? { type: { in: POINT_TYPES } }
        : query.kind === 'credits'
          ? { type: { in: CREDIT_TYPES } }
          : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.rewardTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: RewardsService.txInclude,
      }),
      this.prisma.rewardTransaction.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.presentTransaction(r)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  // ─── Checkout ───────────────────────────────────────────────────────────

  private static readonly bookingSelect = {
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
    payments: { select: { status: true, mode: true } },
    rewardRedemptions: {
      where: { status: { in: ['APPLIED', 'CONSUMED'] } },
      select: {
        id: true,
        status: true,
        points: true,
        pointsAmountMinor: true,
        creditAmountMinor: true,
        totalAmountMinor: true,
        allocations: true,
        currency: true,
      },
    },
  } satisfies Prisma.BookingSelect;

  /** Why this booking can't take rewards now, or null. */
  private checkoutBlocker(
    b: Prisma.BookingGetPayload<{ select: typeof RewardsService.bookingSelect }>,
    now: Date,
  ): string | null {
    if (b.paymentMode !== 'DEMO' || b.totalAmountMinor === null) {
      return 'This booking isn’t paid on Wayora, so rewards can’t be used on it.';
    }
    if (b.payments.some((p) => ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status))) {
      return 'This booking is already paid.';
    }
    if (b.payments.some((p) => p.status === 'CREATED' || p.status === 'PENDING')) {
      return 'A payment for this booking is in progress, so its rewards can’t change now.';
    }
    if (b.status !== 'PENDING') return 'Rewards can only be used before a booking is paid.';
    if (b.paymentDueAt && b.paymentDueAt.getTime() <= now.getTime()) {
      return 'This booking’s payment window has closed.';
    }
    if (bookingMode(b) === 'LIVE' && !this.liveEnabled) {
      return 'Rewards aren’t available for this booking.';
    }
    return null;
  }

  /** What a booking can take, and what it has (GET /bookings/:reference/rewards). */
  async bookingRewards(userId: string, reference: string): Promise<BookingRewards> {
    await this.options.expireOverdue?.({ userId });
    const found = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', NOT_FOUND);
    await this.reconcileBooking(found.id);
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: RewardsService.bookingSelect,
      });
      return this.quote(tx, b, this.now());
    });
  }

  private async quote(
    tx: Tx,
    b: Prisma.BookingGetPayload<{ select: typeof RewardsService.bookingSelect }>,
    now: Date,
  ): Promise<BookingRewards> {
    const rv = await this.rulesAt(now, tx);
    const mode = bookingMode(b);
    const open = b.rewardRedemptions[0] ?? null;
    const total = b.totalAmountMinor;
    const account = await tx.loyaltyAccount.findUnique({
      where: { userId_mode: { userId: b.userId, mode } },
    });
    // Unexpired points only: lots past their expiry don't count even before the sweep expires them.
    const usable = account
      ? ((
          await tx.loyaltyPointLot.aggregate({
            where: { accountId: account.id, remaining: { gt: 0 }, expiresAt: { gt: now } },
            _sum: { remaining: true },
          })
        )._sum.remaining ?? 0n)
      : 0n;
    const balance = account
      ? usable < account.pointsBalance
        ? usable
        : account.pointsBalance
      : 0n;
    const credit =
      (
        await tx.travelCredit.aggregate({
          where: {
            userId: b.userId,
            mode,
            currency: b.currency,
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _sum: { remainingAmountMinor: true },
        })
      )._sum.remainingAmountMinor ?? 0n;
    // An APPLIED redemption's points and credit count as available to re-apply.
    const heldPoints = open?.status === 'APPLIED' ? open.points : 0n;
    const heldCredit = open?.status === 'APPLIED' ? open.creditAmountMinor : 0n;
    const blocker = this.checkoutBlocker(b, now);
    const limits = redemptionLimits(rv.rules, {
      category: SERVICE_TYPE[b.category],
      currency: b.currency,
      totalMinor: total ?? 0n,
      pointsBalance: balance + heldPoints,
      creditAvailableMinor: credit + heldCredit,
    });
    const reason = blocker ?? limits.reason;
    const available = reason === null;
    const applied = open
      ? {
          status: open.status === 'CONSUMED' ? ('consumed' as const) : ('applied' as const),
          points: num(open.points),
          pointsAmount: money(open.pointsAmountMinor, open.currency),
          creditAmount: money(open.creditAmountMinor, open.currency),
          total: money(open.totalAmountMinor, open.currency),
        }
      : null;
    return {
      available,
      reason,
      mode: toMode(mode),
      total: total === null ? null : money(total, b.currency),
      points: {
        balance: num(balance + heldPoints),
        min: num(limits.minPoints),
        max: available ? num(limits.maxPoints) : 0,
        value: limits.pointValueMinor === null ? null : money(limits.pointValueMinor, b.currency),
      },
      credit: {
        available: money(credit + heldCredit, b.currency),
        max: available ? money(limits.maxCreditFor(0n), b.currency) : money(0n, b.currency),
      },
      applied,
      payable: total === null ? null : money(total - (open?.totalAmountMinor ?? 0n), b.currency),
      ruleVersion: rv.version,
    };
  }

  /**
   * Sets the rewards used on an unpaid booking (PUT /bookings/:reference/rewards).
   * The server recomputes every limit and amount; the request only says how
   * many points and how much credit the customer chose. Replaces what was
   * applied before (giving it back first), all in one transaction under the
   * booking's and the account's locks, so two checkouts can't spend the
   * same balance.
   */
  async applyToBooking(
    userId: string,
    reference: string,
    input: ApplyBookingRewards,
    context: CallContext = {},
  ): Promise<BookingRewards> {
    await this.options.expireOverdue?.({ userId });
    const found = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', NOT_FOUND);
    const points = BigInt(input.points);
    const credit = BigInt(input.creditAmountMinor);
    return this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockBooking(tx, found.id);
      const b = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: RewardsService.bookingSelect,
      });
      const blocker = this.checkoutBlocker(b, now);
      if (blocker) throw new AppError('CONFLICT', blocker);
      const mode = bookingMode(b);
      const account = await lockAccount(tx, userId, mode);
      const open = b.rewardRedemptions[0] ?? null;
      if (open && open.points === points && open.creditAmountMinor === credit) {
        return this.quote(tx, b, now); // unchanged: nothing to do
      }
      if (open) await this.giveBack(tx, account, b, open, 'RELEASED', now, 'USER', userId);
      if (points === 0n && credit === 0n) {
        await this.audit(tx, userId, 'rewards.redemption.removed', b.id, context, {
          reference: b.reference,
        });
        return this.quote(tx, await this.reread(tx, b.id), now);
      }

      // Expired points and credit can't be spent.
      await expireDueLots(tx, account, now);
      await expireDueCredits(tx, account, now);
      const rv = await this.rulesAt(now, tx);
      const total = b.totalAmountMinor!;
      const limits = redemptionLimits(rv.rules, {
        category: SERVICE_TYPE[b.category],
        currency: b.currency,
        totalMinor: total,
        pointsBalance: account.pointsBalance,
        creditAvailableMinor: await creditAvailable(tx, account, b.currency, now),
      });
      if (limits.reason) throw new AppError('CONFLICT', limits.reason);
      if (points > 0n && points < limits.minPoints) {
        throw new AppError(
          'BAD_REQUEST',
          `Use at least ${limits.minPoints.toString()} points, or none.`,
        );
      }
      if (points > limits.maxPoints) {
        throw new AppError(
          'BAD_REQUEST',
          limits.maxPoints === 0n
            ? 'You don’t have enough points to use on this booking.'
            : `You can use at most ${limits.maxPoints.toString()} points on this booking.`,
        );
      }
      const maxCredit = limits.maxCreditFor(points);
      if (credit > maxCredit) {
        throw new AppError(
          'BAD_REQUEST',
          maxCredit === 0n
            ? 'No travel credit can be used on this booking.'
            : `You can use at most ${formatAmount(maxCredit, b.currency)} of travel credit on this booking.`,
        );
      }
      const pointsAmount = points * limits.pointValueMinor!;
      const redemption = await tx.rewardRedemption.create({
        data: {
          bookingId: b.id,
          userId,
          mode,
          currency: b.currency,
          points,
          pointsAmountMinor: pointsAmount,
          creditAmountMinor: credit,
          totalAmountMinor: pointsAmount + credit,
          allocations: { lots: [], credits: [] },
          ruleVersion: rv.version,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      const ctx = {
        now,
        origin: 'AUTOMATED' as const,
        actorType: 'USER' as const,
        actorId: userId,
        ruleVersion: rv.version,
        bookingId: b.id,
        redemptionId: redemption.id,
      };
      const lots =
        points > 0n ? await takeFromLots(tx, account, points, now) : ([] as LotAllocation[]);
      if (points > 0n) {
        await postPoints(
          tx,
          account,
          {
            type: 'POINTS_REDEEMED',
            points: -points,
            description: `${points.toString()} points used on booking ${b.reference} (${formatAmount(pointsAmount, b.currency)} off)`,
            idempotencyKey: `redeem:${redemption.id}`,
            metadata: {
              pointValueMinor: limits.pointValueMinor!.toString(),
              amountMinor: pointsAmount.toString(),
              currency: b.currency,
            },
          },
          ctx,
        );
      }
      const credits =
        credit > 0n
          ? await spendCredits(tx, account, b.currency, credit, {
              ...ctx,
              bookingReference: b.reference,
            })
          : [];
      await tx.rewardRedemption.update({
        where: { id: redemption.id },
        data: { allocations: { lots, credits } as unknown as Prisma.InputJsonValue },
      });
      await this.audit(tx, userId, 'rewards.redemption.applied', b.id, context, {
        reference: b.reference,
        points: points.toString(),
        pointsAmountMinor: pointsAmount.toString(),
        creditAmountMinor: credit.toString(),
        currency: b.currency,
        mode,
        ruleVersion: rv.version,
      });
      return this.quote(tx, await this.reread(tx, b.id), now);
    });
  }

  async removeFromBooking(userId: string, reference: string, context: CallContext = {}) {
    return this.applyToBooking(
      userId,
      reference,
      { points: 0, creditAmountMinor: '0', confirm: true },
      context,
    );
  }

  private reread(tx: Tx, bookingId: string) {
    return tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: RewardsService.bookingSelect,
    });
  }

  private async audit(
    tx: Tx,
    userId: string,
    action: string,
    bookingId: string,
    context: CallContext,
    metadata: Prisma.InputJsonValue,
  ) {
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorId: userId,
        action,
        entityType: 'booking',
        entityId: bookingId,
        requestId: context.requestId ?? null,
        metadata,
      },
    });
  }

  /**
   * The amount a payment must be for (payments.service): the booking's total
   * minus rewards applied to it. Call inside the payment's transaction, after
   * the booking is locked.
   */
  static async payableMinor(tx: Tx, bookingId: string, totalMinor: bigint): Promise<bigint> {
    const open = await tx.rewardRedemption.findFirst({
      where: { bookingId, status: 'APPLIED' },
      select: { totalAmountMinor: true },
    });
    return totalMinor - (open?.totalAmountMinor ?? 0n);
  }

  /** Gives a redemption's points and credit back (to the lots and credits they came from). */
  private async giveBack(
    tx: Tx,
    account: LockedAccount,
    b: { id: string; reference: string },
    open: { id: string; points: bigint; creditAmountMinor: bigint; allocations: Prisma.JsonValue },
    status: 'RELEASED' | 'RESTORED',
    now: Date,
    actorType: 'USER' | 'SYSTEM',
    actorId: string | null,
  ) {
    const alloc = open.allocations as unknown as Allocations;
    const ctx = {
      now,
      origin: 'AUTOMATED' as const,
      actorType,
      actorId,
      bookingId: b.id,
      redemptionId: open.id,
    };
    const changed = await tx.rewardRedemption.updateMany({
      where: { id: open.id, status: { in: ['APPLIED', 'CONSUMED'] } },
      data: { status, closedAt: now, updatedAt: now },
    });
    if (changed.count !== 1) return;
    if (open.points > 0n) {
      await returnToLots(tx, alloc.lots);
      await postPoints(
        tx,
        account,
        {
          type: 'POINTS_RESTORED',
          points: open.points,
          description:
            status === 'RELEASED'
              ? `${open.points.toString()} points given back from booking ${b.reference}`
              : `${open.points.toString()} points restored: booking ${b.reference} was cancelled`,
          idempotencyKey: `restore:${open.id}`,
        },
        ctx,
      );
      await expireDueLots(tx, account, now);
    }
    if (open.creditAmountMinor > 0n) {
      await restoreCredits(tx, account, alloc.credits, {
        ...ctx,
        bookingReference: b.reference,
        key: open.id,
      });
    }
  }

  // ─── Settling bookings ──────────────────────────────────────────────────

  /**
   * Brings a booking's rewards in line with its booking and payment state
   * (docs/rewards.md#booking-and-payment). Idempotent; safe to call any
   * number of times from anywhere. Never changes the booking or payment.
   *
   * 1. Rewards applied to an unpaid booking: kept while it can still be paid;
   *    marked used (CONSUMED) once it is paid and confirmed; given back
   *    (RELEASED) if it expires, fails or is cancelled unpaid.
   * 2. Rewards used on a paid booking that is then cancelled: given back (RESTORED).
   * 3. Points are earned once, when a confirmed booking with a successful,
   *    un-refunded payment has ended (plus `availableAfterDays`).
   * 4. Earned points are taken back once if the booking stops qualifying.
   */
  async reconcileBooking(bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      if (!(await lockBooking(tx, bookingId))) return;
      const b = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: {
          id: true,
          reference: true,
          userId: true,
          status: true,
          category: true,
          currency: true,
          isDemo: true,
          paymentMode: true,
          startsOn: true,
          endsOn: true,
          confirmedAt: true,
          payments: {
            select: { id: true, status: true, mode: true, amountMinor: true, refundRequired: true },
          },
          rewardRedemptions: {
            where: { status: { in: ['APPLIED', 'CONSUMED'] } },
            select: {
              id: true,
              status: true,
              points: true,
              creditAmountMinor: true,
              totalAmountMinor: true,
              allocations: true,
              currency: true,
            },
          },
          rewardTransactions: {
            where: { type: { in: ['POINTS_EARNED', 'POINTS_REVERSED'] } },
            select: {
              id: true,
              type: true,
              points: true,
              qualifyingPoints: true,
              ruleVersion: true,
              lot: { select: { id: true } },
            },
          },
        },
      });
      const paid = b.payments.filter((p) => p.status === 'SUCCEEDED' && !p.refundRequired);
      const everPaid = b.payments.some((p) =>
        ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status),
      );
      const mode = bookingMode(
        b,
        paid[0]?.mode ?? b.payments.find((p) => p.status !== 'FAILED')?.mode,
      );
      const closed = (CLOSED as readonly string[]).includes(b.status);
      const isDemo = mode === 'DEMO';
      let account: LockedAccount | null = null;
      const accountFor = async () => (account ??= await lockAccount(tx, b.userId, mode));

      // 1–2. Redemptions.
      const open = b.rewardRedemptions[0];
      if (open) {
        if (open.status === 'APPLIED' && b.status === 'CONFIRMED' && paid.length > 0) {
          await tx.rewardRedemption.update({
            where: { id: open.id },
            data: { status: 'CONSUMED', updatedAt: now },
          });
          await notify(tx, now, {
            userId: b.userId,
            type: 'REWARDS',
            title: isDemo ? 'Demo rewards used' : 'Rewards used',
            message: `${this.usedText(open)} went towards booking ${b.reference}.${isDemo ? ' Demo rewards have no cash value.' : ''}`,
            isDemo,
            bookingId: b.id,
            dedupeKey: `rewards:redeemed:${open.id}`,
          });
        } else if (closed) {
          const status = everPaid || open.status === 'CONSUMED' ? 'RESTORED' : 'RELEASED';
          await this.giveBack(tx, await accountFor(), b, open, status, now, 'SYSTEM', null);
          await notify(tx, now, {
            userId: b.userId,
            type: 'REWARDS',
            title: isDemo ? 'Demo rewards given back' : 'Rewards given back',
            message: `Booking ${b.reference} ${b.status === 'CANCELLED' ? 'was cancelled' : b.status === 'EXPIRED' ? 'expired' : 'didn’t go ahead'}, so ${this.usedText(open)} went back to your account. Original expiry dates still apply.`,
            isDemo,
            bookingId: b.id,
            dedupeKey: `rewards:restored:${open.id}`,
          });
        }
      }

      // LIVE rewards stay off unless enabled.
      if (mode === 'LIVE' && !this.liveEnabled) return;

      // 3. Earning.
      const earned = b.rewardTransactions.find((t) => t.type === 'POINTS_EARNED');
      const reversed = b.rewardTransactions.some((t) => t.type === 'POINTS_REVERSED');
      if (!earned && b.status === 'CONFIRMED' && paid.length > 0 && b.confirmedAt) {
        const rv = await this.rulesAt(b.confirmedAt, tx);
        const availableOn = addDays(this.completionDay(b), rv.rules.earn.availableAfterDays);
        if (availableOn <= day(now)) {
          const acc = await accountFor();
          const key = `earn:${b.id}`;
          if (!(await alreadyDone(tx, key))) {
            const paidMinor = paid.reduce((s, p) => s + p.amountMinor, 0n);
            const earn = calculateEarn(rv.rules, {
              currency: b.currency,
              paidMinor,
              category: SERVICE_TYPE[b.category],
              tierId: acc.tier,
              confirmedAt: b.confirmedAt,
            });
            await postPoints(
              tx,
              acc,
              {
                type: 'POINTS_EARNED',
                points: earn.points,
                qualifyingPoints: earn.qualifyingPoints,
                description:
                  earn.points > 0n
                    ? `Earned ${earn.points.toString()} points on booking ${b.reference}`
                    : `No points on booking ${b.reference}: ${earn.breakdown.note ?? ''}`,
                idempotencyKey: key,
                metadata: earn.breakdown,
                lotExpiresAt: addMonths(now, rv.rules.earn.expiryMonths),
              },
              {
                now,
                origin: 'AUTOMATED',
                actorType: 'SYSTEM',
                ruleVersion: rv.version,
                bookingId: b.id,
              },
            );
            if (earn.points > 0n) {
              await notify(tx, now, {
                userId: b.userId,
                type: 'REWARDS',
                title: isDemo ? 'Demo points earned' : 'Points earned',
                message: `You earned ${earn.points.toString()} points on booking ${b.reference}.${isDemo ? ' Demo points come from demo bookings and have no cash value.' : ''}`,
                isDemo,
                bookingId: b.id,
                dedupeKey: `rewards:earned:${b.id}`,
              });
            }
            await this.refreshTier(tx, acc, await this.rulesAt(now, tx), now);
          }
        }
      }

      // 4. Reversal.
      const stillQualifies = b.status === 'CONFIRMED' && paid.length > 0;
      if (earned && !reversed && !stillQualifies) {
        const acc = await accountFor();
        const want = earned.points;
        const lots =
          want > 0n
            ? await takeFromLots(
                tx,
                acc,
                want < acc.pointsBalance ? want : acc.pointsBalance,
                now,
                {
                  ...(earned.lot ? { first: earned.lot.id } : {}),
                  partial: true,
                },
              )
            : [];
        const taken = lots.reduce((s, l) => s + BigInt(l.points), 0n);
        await postPoints(
          tx,
          acc,
          {
            type: 'POINTS_REVERSED',
            points: -taken,
            qualifyingPoints: -earned.qualifyingPoints,
            description:
              taken === want
                ? `${want.toString()} points taken back: booking ${b.reference} no longer qualifies`
                : `${taken.toString()} of ${want.toString()} points taken back: booking ${b.reference} no longer qualifies (the rest were already used)`,
            idempotencyKey: `reverse:${b.id}`,
            metadata: {
              earnedPoints: want.toString(),
              takenBack: taken.toString(),
              unrecovered: (want - taken).toString(),
              bookingStatus: b.status,
            },
          },
          {
            now,
            origin: 'AUTOMATED',
            actorType: 'SYSTEM',
            ruleVersion: earned.ruleVersion,
            bookingId: b.id,
          },
        );
        if (want > 0n) {
          await notify(tx, now, {
            userId: b.userId,
            type: 'REWARDS',
            title: 'Points taken back',
            message: `${taken.toString()} points earned on booking ${b.reference} were taken back because it no longer qualifies.`,
            isDemo,
            bookingId: b.id,
            dedupeKey: `rewards:reversed:${b.id}`,
          });
        }
        await this.refreshTier(tx, acc, await this.rulesAt(now, tx), now);
      }
    });
  }

  private usedText(r: { points: bigint; creditAmountMinor: bigint; currency: string }): string {
    const parts = [
      r.points > 0n ? `${r.points.toString()} points` : null,
      r.creditAmountMinor > 0n
        ? `${formatAmount(r.creditAmountMinor, r.currency)} of travel credit`
        : null,
    ].filter(Boolean);
    return parts.join(' and ');
  }

  /** Settles every booking of a user that may need it (on reads). */
  async reconcileUser(userId: string): Promise<void> {
    const ids = await this.candidates({ userId }, 50);
    for (const id of ids) await this.safely(() => this.reconcileBooking(id), id);
    const accounts = await this.prisma.loyaltyAccount.findMany({
      where: { userId },
      select: { userId: true, mode: true },
    });
    for (const a of accounts) await this.safely(() => this.maintainAccount(a.userId, a.mode));
  }

  private async safely(run: () => Promise<unknown>, bookingId?: string) {
    try {
      await run();
    } catch (error) {
      // Never surfaces to the booking or payment: the next sweep retries.
      this.options.logger.warn(
        { err: errorForLog(error), ...(bookingId ? { bookingId } : {}) },
        'Rewards settlement failed; will retry',
      );
    }
  }

  /** Bookings whose rewards may need settling. */
  private async candidates(filter: { userId?: string }, limit: number): Promise<string[]> {
    const now = this.now();
    const user = filter.userId ? { userId: filter.userId } : {};
    const [redemptions, toEarn, toReverse] = await Promise.all([
      this.prisma.rewardRedemption.findMany({
        where: {
          ...user,
          OR: [
            { status: 'APPLIED', booking: { status: { in: ['CONFIRMED', ...CLOSED] } } },
            { status: 'CONSUMED', booking: { status: { in: [...CLOSED] } } },
          ],
        },
        select: { bookingId: true },
        take: limit,
      }),
      this.prisma.booking.findMany({
        where: {
          ...user,
          status: 'CONFIRMED',
          payments: {
            some: {
              status: 'SUCCEEDED',
              refundRequired: false,
              ...(this.liveEnabled ? {} : { mode: 'DEMO' }),
            },
          },
          rewardTransactions: { none: { type: 'POINTS_EARNED' } },
          // Trips that have ended (the exact day check happens in reconcileBooking).
          OR: [
            { endsOn: { lt: now } },
            { endsOn: null, startsOn: { lt: now } },
            { endsOn: null, startsOn: null, confirmedAt: { lt: now } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      this.prisma.booking.findMany({
        where: {
          ...user,
          rewardTransactions: {
            some: { type: 'POINTS_EARNED' },
            none: { type: 'POINTS_REVERSED' },
          },
          OR: [
            { status: { not: 'CONFIRMED' } },
            { payments: { none: { status: 'SUCCEEDED', refundRequired: false } } },
          ],
        },
        select: { id: true },
        take: limit,
      }),
    ]);
    return [
      ...new Set([
        ...redemptions.map((r) => r.bookingId),
        ...toEarn.map((b) => b.id),
        ...toReverse.map((b) => b.id),
      ]),
    ];
  }

  /** Expiry, expiry notices and tier review for one account. */
  private async maintainAccount(userId: string, mode: PaymentMode): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const account = await lockAccount(tx, userId, mode);
      await expireDueLots(tx, account, now);
      await expireDueCredits(tx, account, now);
      const isDemo = mode === 'DEMO';
      const soon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY_MS);
      const lots = await tx.loyaltyPointLot.findMany({
        where: {
          accountId: account.id,
          remaining: { gt: 0 },
          expiresAt: { gt: now, lte: soon },
          expiryNoticeAt: null,
        },
        select: { id: true, remaining: true, expiresAt: true },
      });
      for (const lot of lots) {
        await tx.loyaltyPointLot.update({ where: { id: lot.id }, data: { expiryNoticeAt: now } });
        await notify(tx, now, {
          userId,
          type: 'REWARDS',
          title: 'Points expiring soon',
          message: `${lot.remaining.toString()} ${isDemo ? 'demo ' : ''}points expire on ${day(lot.expiresAt)}. Use them on a booking before then.`,
          isDemo,
          dedupeKey: `rewards:expiring:lot:${lot.id}`,
        });
      }
      const credits = await tx.travelCredit.findMany({
        where: {
          userId,
          mode,
          status: 'ACTIVE',
          expiresAt: { gt: now, lte: soon },
          expiryNoticeAt: null,
        },
        select: {
          id: true,
          reference: true,
          remainingAmountMinor: true,
          currency: true,
          expiresAt: true,
        },
      });
      for (const c of credits) {
        await tx.travelCredit.update({ where: { id: c.id }, data: { expiryNoticeAt: now } });
        await notify(tx, now, {
          userId,
          type: 'REWARDS',
          title: 'Travel credit expiring soon',
          message: `${formatAmount(c.remainingAmountMinor, c.currency)} of ${isDemo ? 'demo ' : ''}travel credit (${c.reference}) expires on ${day(c.expiresAt!)}.`,
          isDemo,
          dedupeKey: `rewards:expiring:credit:${c.id}`,
        });
      }
      await this.refreshTier(tx, account, await this.rulesAt(now, tx), now);
    });
  }

  /**
   * Maintenance (server.ts, every minute; idempotent and lock-safe, so every
   * API instance may run it): settles bookings, expires points and credit,
   * sends expiry notices, and reviews tiers whose hold has run out.
   */
  async sweep(limit = 100): Promise<{ bookings: number; accounts: number }> {
    const ids = await this.candidates({}, limit);
    for (const id of ids) await this.safely(() => this.reconcileBooking(id), id);
    const now = this.now();
    const soon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY_MS);
    const [lotAccounts, creditUsers, tierAccounts] = await Promise.all([
      this.prisma.loyaltyPointLot.findMany({
        where: {
          remaining: { gt: 0 },
          OR: [{ expiresAt: { lte: now } }, { expiresAt: { lte: soon }, expiryNoticeAt: null }],
        },
        select: { account: { select: { userId: true, mode: true } } },
        distinct: ['accountId'],
        take: limit,
      }),
      this.prisma.travelCredit.findMany({
        where: {
          status: 'ACTIVE',
          OR: [{ expiresAt: { lte: now } }, { expiresAt: { lte: soon }, expiryNoticeAt: null }],
        },
        select: { userId: true, mode: true },
        distinct: ['userId', 'mode'],
        take: limit,
      }),
      this.prisma.loyaltyAccount.findMany({
        where: { tier: { not: 'explorer' }, tierQualifiedAt: { not: null } },
        select: { userId: true, mode: true, tierQualifiedAt: true },
        take: 500,
      }),
    ]);
    const rv = await this.rulesAt(now);
    const due = tierAccounts.filter(
      (a) => addMonths(a.tierQualifiedAt!, rv.rules.qualificationMonths).getTime() <= now.getTime(),
    );
    const accounts = new Map<string, { userId: string; mode: PaymentMode }>();
    for (const a of [...lotAccounts.map((l) => l.account), ...creditUsers, ...due]) {
      accounts.set(`${a.userId}:${a.mode}`, { userId: a.userId, mode: a.mode });
    }
    for (const a of accounts.values())
      await this.safely(() => this.maintainAccount(a.userId, a.mode));
    return { bookings: ids.length, accounts: accounts.size };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  private presentAdminTransaction(
    t: Prisma.RewardTransactionGetPayload<{ include: typeof RewardsService.txInclude }>,
  ): AdminRewardTransaction {
    return {
      ...this.presentTransaction(t),
      userId: t.userId,
      reason: t.reason,
      actorType: t.actorType.toLowerCase() as AdminRewardTransaction['actorType'],
    };
  }

  async adminTransactions(
    query: z.output<typeof adminRewardTransactionsQuerySchema>,
  ): Promise<AdminRewardTransactionList> {
    const where: Prisma.RewardTransactionWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.type ? { type: query.type.toUpperCase() as RewardTransactionTypeDb } : {}),
      ...(query.origin ? { origin: query.origin === 'manual' ? 'MANUAL' : 'AUTOMATED' } : {}),
      ...(query.mode ? { mode: fromMode(query.mode) } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.rewardTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: RewardsService.txInclude,
      }),
      this.prisma.rewardTransaction.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.presentAdminTransaction(r)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async adminUser(userId: string): Promise<AdminUserRewards> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true },
    });
    if (!user) throw new AppError('NOT_FOUND', 'There is no user with that id.');
    const now = this.now();
    const rv = await this.rulesAt(now);
    const accounts = await this.prisma.loyaltyAccount.findMany({ where: { userId } });
    const credits = await this.prisma.travelCredit.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      take: 50,
      include: { booking: { select: { reference: true } } },
    });
    const recent = await this.prisma.rewardTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      include: RewardsService.txInclude,
    });
    return {
      userId: user.id,
      name: user.displayName,
      accounts: await Promise.all(
        accounts.map(async (a) => {
          const sum = await this.prisma.rewardTransaction.aggregate({
            where: { accountId: a.id },
            _sum: { points: true },
          });
          return {
            mode: toMode(a.mode),
            pointsBalance: num(a.pointsBalance),
            ledgerSum: num(sum._sum.points ?? 0n),
            tier: this.tierProgress(
              rv.rules,
              a,
              await this.qualifyingPoints(this.prisma, a.id, rv.rules, now),
            ),
          };
        }),
      ),
      credits: credits.map((c) => this.presentCredit(c)),
      recent: recent.map((t) => this.presentAdminTransaction(t)),
    };
  }

  private requireMode(mode: RewardMode): PaymentMode {
    if (mode === 'live' && !this.liveEnabled) {
      throw new AppError('CONFLICT', 'Live rewards are switched off on this server.');
    }
    return fromMode(mode);
  }

  private async requireCustomer(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new AppError('NOT_FOUND', 'There is no user with that id.');
  }

  /** A manual points adjustment (admins only, with a reason; audited; at most once per key). */
  async adjustPoints(
    admin: User,
    userId: string,
    input: AdminPointsAdjustment,
    context: CallContext = {},
  ) {
    await this.requireCustomer(userId);
    const mode = this.requireMode(input.mode);
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const account = await lockAccount(tx, userId, mode);
      const key = `adjust:${input.idempotencyKey}`;
      if (await alreadyDone(tx, key)) return;
      await expireDueLots(tx, account, now);
      const points = BigInt(input.points);
      const rv = await this.rulesAt(now, tx);
      const ctx = {
        now,
        origin: 'MANUAL' as const,
        actorType: 'ADMIN' as const,
        actorId: admin.id,
        reason: input.reason,
        ruleVersion: rv.version,
      };
      if (points < 0n) {
        if (-points > account.pointsBalance) {
          throw new AppError(
            'CONFLICT',
            `The account has ${account.pointsBalance.toString()} points; an adjustment can't make it negative.`,
          );
        }
        await takeFromLots(tx, account, -points, now);
      }
      await postPoints(
        tx,
        account,
        {
          type: 'POINTS_ADJUSTED',
          points,
          description:
            points > 0n
              ? `${points.toString()} points added by Wayora support`
              : `${(-points).toString()} points removed by Wayora support`,
          idempotencyKey: key,
          ...(points > 0n ? { lotExpiresAt: addMonths(now, rv.rules.earn.expiryMonths) } : {}),
        },
        ctx,
      );
      await this.adminAudit(
        tx,
        admin,
        'rewards.points_adjusted',
        'loyalty_account',
        account.id,
        context,
        {
          userId,
          mode,
          points: points.toString(),
          reason: input.reason,
        },
      );
      if (points > 0n) {
        await notify(tx, now, {
          userId,
          type: 'REWARDS',
          title: mode === 'DEMO' ? 'Demo points added' : 'Points added',
          message: `Wayora added ${points.toString()} points to your account.`,
          isDemo: mode === 'DEMO',
          dedupeKey: `rewards:adjusted:${input.idempotencyKey}`,
        });
      }
    });
    return this.adminUser(userId);
  }

  /** Issues a travel credit (admins only, with a reason; at most once per key). */
  async issueCredit(
    admin: User,
    userId: string,
    input: AdminIssueCredit,
    context: CallContext = {},
  ) {
    await this.requireCustomer(userId);
    const mode = this.requireMode(input.mode);
    const now = this.now();
    const expiresAt = input.expiresOn ? new Date(`${input.expiresOn}T23:59:59.999Z`) : null;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      throw new AppError('BAD_REQUEST', 'Choose an expiry date in the future.');
    }
    let bookingId: string | null = null;
    if (input.bookingReference) {
      const booking = await this.prisma.booking.findFirst({
        where: { reference: input.bookingReference.toUpperCase(), userId },
        select: { id: true, currency: true },
      });
      if (!booking) throw new AppError('NOT_FOUND', 'That booking doesn’t belong to this user.');
      if (booking.currency !== input.amount.currency) {
        throw new AppError(
          'BAD_REQUEST',
          'A credit for a booking must be in the booking’s currency.',
        );
      }
      bookingId = booking.id;
    }
    await this.prisma.$transaction(async (tx) => {
      const account = await lockAccount(tx, userId, mode);
      const issued = await issueCredit(
        tx,
        account,
        {
          currency: input.amount.currency,
          amountMinor: BigInt(input.amount.amountMinor),
          reason: input.reason.toUpperCase() as 'PROMOTION',
          note: input.note,
          expiresAt,
          bookingId,
          campaign: input.campaign ?? null,
          idempotencyKey: `admin-credit:${input.idempotencyKey}`,
        },
        {
          now,
          origin: 'MANUAL',
          actorType: 'ADMIN',
          actorId: admin.id,
          reason: input.justification,
          bookingId,
        },
      );
      if (!issued.created) return;
      await this.adminAudit(
        tx,
        admin,
        'rewards.credit_issued',
        'travel_credit',
        issued.id,
        context,
        {
          userId,
          mode,
          reference: issued.reference,
          amountMinor: input.amount.amountMinor,
          currency: input.amount.currency,
          reason: input.reason,
          justification: input.justification,
        },
      );
      await notify(tx, now, {
        userId,
        type: 'REWARDS',
        title: mode === 'DEMO' ? 'Demo travel credit added' : 'Travel credit added',
        message: `${formatAmount(BigInt(input.amount.amountMinor), input.amount.currency)} of travel credit (${issued.reference}): ${input.note}${mode === 'DEMO' ? ' Demo credit has no cash value.' : ' Travel credit isn’t a cash refund.'}`,
        isDemo: mode === 'DEMO',
        dedupeKey: `rewards:credit-issued:${issued.id}`,
      });
    });
    return this.adminUser(userId);
  }

  async revokeCredit(admin: User, reference: string, reason: string, context: CallContext = {}) {
    const credit = await this.prisma.travelCredit.findUnique({
      where: { reference: reference.toUpperCase() },
      select: { id: true, userId: true, mode: true },
    });
    if (!credit) throw new AppError('NOT_FOUND', 'There is no credit with that reference.');
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const account = await lockAccount(tx, credit.userId, credit.mode);
      const revoked = await revokeCredit(tx, account, credit.id, {
        now,
        origin: 'MANUAL',
        actorType: 'ADMIN',
        actorId: admin.id,
        reason,
      });
      await this.adminAudit(
        tx,
        admin,
        'rewards.credit_revoked',
        'travel_credit',
        credit.id,
        context,
        {
          userId: credit.userId,
          reference: revoked.reference,
          amountMinor: revoked.amountMinor.toString(),
          currency: revoked.currency,
          reason,
        },
      );
    });
    return this.adminUser(credit.userId);
  }

  private presentRuleVersion(row: {
    version: number;
    config: Prisma.JsonValue;
    reason: string;
    effectiveFrom: Date;
    createdAt: Date;
    createdById: string | null;
  }): AdminRuleVersion {
    return {
      version: row.version,
      config: loyaltyRulesSchema.parse(row.config),
      reason: row.reason,
      effectiveFrom: row.effectiveFrom.toISOString(),
      createdAt: row.createdAt.toISOString(),
      manual: row.createdById !== null,
    };
  }

  async adminRules(): Promise<AdminRules> {
    const now = this.now();
    const active = await this.rulesAt(now);
    const rows = await this.prisma.loyaltyRuleVersion.findMany({
      orderBy: { version: 'desc' },
      take: 50,
    });
    const activeRow =
      rows.find((r) => r.version === active.version) ??
      (await this.prisma.loyaltyRuleVersion.findUniqueOrThrow({
        where: { version: active.version },
      }));
    return {
      active: this.presentRuleVersion(activeRow),
      versions: rows.map((r) => this.presentRuleVersion(r)),
    };
  }

  /** A new rule version, in force from now (admins only; audited). Older versions stay for history. */
  async createRules(
    admin: User,
    input: z.output<typeof adminCreateRulesSchema>,
    context: CallContext = {},
  ): Promise<AdminRules> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      // Serialize version numbers.
      await tx.$executeRaw`LOCK TABLE "loyalty_rule_versions" IN SHARE ROW EXCLUSIVE MODE`;
      const last = await tx.loyaltyRuleVersion.findFirst({ orderBy: { version: 'desc' } });
      const version = (last?.version ?? 0) + 1;
      await tx.loyaltyRuleVersion.create({
        data: {
          version,
          config: input.config as unknown as Prisma.InputJsonValue,
          reason: input.reason,
          createdById: admin.id,
          effectiveFrom: now,
          createdAt: now,
        },
      });
      await this.adminAudit(
        tx,
        admin,
        'rewards.rules_created',
        'loyalty_rules',
        String(version),
        context,
        {
          version,
          previous: last?.version ?? null,
          reason: input.reason,
        },
      );
    });
    return this.adminRules();
  }

  private async adminAudit(
    tx: Tx,
    admin: User,
    action: string,
    entityType: string,
    entityId: string,
    context: CallContext,
    metadata: Prisma.InputJsonValue,
  ) {
    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: admin.id,
        action,
        entityType,
        entityId,
        requestId: context.requestId ?? null,
        metadata,
      },
    });
  }

  /** Ledger consistency (tests and admin): cached balance vs the ledger sum and the lots. */
  async verifyAccount(userId: string, mode: PaymentMode) {
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { userId_mode: { userId, mode } },
    });
    if (!account) return null;
    const [ledger, lots] = await Promise.all([
      this.prisma.rewardTransaction.aggregate({
        where: { accountId: account.id },
        _sum: { points: true },
      }),
      this.prisma.loyaltyPointLot.aggregate({
        where: { accountId: account.id },
        _sum: { remaining: true },
      }),
    ]);
    return {
      balance: account.pointsBalance,
      ledgerSum: ledger._sum.points ?? 0n,
      lotsRemaining: lots._sum.remaining ?? 0n,
    };
  }

  /** Re-checks one version's rules (to explain old transactions). */
  async ruleVersion(version: number) {
    return this.rulesVersion(version, this.prisma);
  }
}

const POINT_TYPES: RewardTransactionTypeDb[] = [
  'POINTS_EARNED',
  'POINTS_REDEEMED',
  'POINTS_RESTORED',
  'POINTS_REVERSED',
  'POINTS_EXPIRED',
  'POINTS_ADJUSTED',
];
const CREDIT_TYPES: RewardTransactionTypeDb[] = [
  'CREDIT_ISSUED',
  'CREDIT_REDEEMED',
  'CREDIT_RESTORED',
  'CREDIT_EXPIRED',
  'CREDIT_REVOKED',
];

export { adminCreateRulesSchema };
