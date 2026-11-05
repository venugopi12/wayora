import { randomInt } from 'node:crypto';
import type {
  AuditActorType,
  PaymentMode,
  Prisma,
  RewardOrigin,
  RewardTransactionType,
  TravelCreditReason,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';

/*
 * The rewards ledger (docs/rewards.md#ledger). Everything that changes a
 * points balance or a travel credit goes through these functions, inside a
 * database transaction that holds the account's row lock:
 *
 * - `lockAccount` creates the (user, mode) account if needed and locks it
 *   (SELECT … FOR UPDATE). Every balance change for that user and mode,
 *   points or credit, runs under this lock, so concurrent requests queue
 *   instead of overspending. Lock order is always booking → account.
 * - Every change writes one ledger row (append-only, a trigger forbids edits)
 *   and updates the cached balance in the same transaction; a CHECK keeps the
 *   balance from going negative even if code were wrong.
 * - Automated steps carry an idempotency key (unique), checked under the
 *   lock before writing, so retries and concurrent workers apply them once.
 * - Points are held in lots (one per earning or positive adjustment) that
 *   expire; spending takes from the soonest-expiring lot first, and expired
 *   lots are expired before anything is spent.
 */

type Tx = Prisma.TransactionClient;

export interface LockedAccount {
  id: string;
  userId: string;
  mode: PaymentMode;
  pointsBalance: bigint;
  tier: string;
  tierQualifiedAt: Date | null;
}

export async function lockAccount(
  tx: Tx,
  userId: string,
  mode: PaymentMode,
): Promise<LockedAccount> {
  await tx.loyaltyAccount.createMany({ data: [{ userId, mode }], skipDuplicates: true });
  const rows = await tx.$queryRaw<
    {
      id: string;
      user_id: string;
      mode: PaymentMode;
      points_balance: bigint;
      tier: string;
      tier_qualified_at: Date | null;
    }[]
  >`SELECT "id", "user_id", "mode", "points_balance", "tier", "tier_qualified_at"
      FROM "loyalty_accounts"
     WHERE "user_id" = ${userId}::uuid AND "mode" = ${mode}::"payment_mode"
       FOR UPDATE`;
  const row = rows[0]!;
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    pointsBalance: BigInt(row.points_balance),
    tier: row.tier,
    tierQualifiedAt: row.tier_qualified_at,
  };
}

export interface EntryContext {
  now: Date;
  origin: RewardOrigin;
  actorType: AuditActorType;
  actorId?: string | null;
  reason?: string | null;
  ruleVersion?: number | null;
  bookingId?: string | null;
  redemptionId?: string | null;
}

/** Whether an automated step with this key already happened. */
export async function alreadyDone(tx: Tx, idempotencyKey: string): Promise<boolean> {
  return (await tx.rewardTransaction.count({ where: { idempotencyKey } })) > 0;
}

/** One points row and the balance with it. Throws if the balance would go negative. */
export async function postPoints(
  tx: Tx,
  account: LockedAccount,
  entry: {
    type: RewardTransactionType;
    points: bigint;
    qualifyingPoints?: bigint;
    description: string;
    idempotencyKey: string;
    metadata?: Prisma.InputJsonValue;
    /** Creates a lot (positive changes that add new points). */
    lotExpiresAt?: Date;
  },
  ctx: EntryContext,
): Promise<string> {
  const balance = account.pointsBalance + entry.points;
  if (balance < 0n) throw new AppError('CONFLICT', 'Not enough points.');
  const row = await tx.rewardTransaction.create({
    data: {
      accountId: account.id,
      userId: account.userId,
      mode: account.mode,
      type: entry.type,
      origin: ctx.origin,
      points: entry.points,
      qualifyingPoints: entry.qualifyingPoints ?? 0n,
      balanceAfter: balance,
      description: entry.description.slice(0, 255),
      reason: ctx.reason ?? null,
      actorType: ctx.actorType,
      actorId: ctx.actorId ?? null,
      ruleVersion: ctx.ruleVersion ?? null,
      bookingId: ctx.bookingId ?? null,
      redemptionId: ctx.redemptionId ?? null,
      idempotencyKey: entry.idempotencyKey,
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      createdAt: ctx.now,
    },
    select: { id: true },
  });
  if (entry.points !== 0n) {
    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { pointsBalance: balance, updatedAt: ctx.now },
    });
    account.pointsBalance = balance;
  }
  if (entry.lotExpiresAt && entry.points > 0n) {
    await tx.loyaltyPointLot.create({
      data: {
        accountId: account.id,
        transactionId: row.id,
        points: entry.points,
        remaining: entry.points,
        expiresAt: entry.lotExpiresAt,
        createdAt: ctx.now,
      },
    });
  }
  return row.id;
}

export interface LotAllocation {
  id: string;
  points: string;
}

/**
 * Takes `points` from unexpired lots, soonest expiry first. `first` names a
 * lot to take from before the others (a reversal takes back its own points
 * first). Returns what came from where; takes less only if `partial`.
 */
export async function takeFromLots(
  tx: Tx,
  account: LockedAccount,
  points: bigint,
  now: Date,
  { first, partial = false }: { first?: string; partial?: boolean } = {},
): Promise<LotAllocation[]> {
  const lots = await tx.loyaltyPointLot.findMany({
    where: { accountId: account.id, remaining: { gt: 0 }, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    select: { id: true, remaining: true },
  });
  if (first) lots.sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
  const taken: LotAllocation[] = [];
  let left = points;
  for (const lot of lots) {
    if (left === 0n) break;
    const take = lot.remaining < left ? lot.remaining : left;
    await tx.loyaltyPointLot.update({
      where: { id: lot.id },
      data: { remaining: lot.remaining - take },
    });
    taken.push({ id: lot.id, points: take.toString() });
    left -= take;
  }
  if (left > 0n && !partial) {
    // The cached balance said there were enough points; the lots disagree.
    throw new AppError('CONFLICT', 'Not enough points.');
  }
  return taken;
}

/** Gives points back to the lots they came from (their original expiry stays). */
export async function returnToLots(tx: Tx, allocations: readonly LotAllocation[]): Promise<void> {
  for (const a of allocations) {
    await tx.loyaltyPointLot.update({
      where: { id: a.id },
      data: { remaining: { increment: BigInt(a.points) } },
    });
  }
}

/** Expires the account's lots whose time has come (one ledger row per lot). Returns points expired. */
export async function expireDueLots(tx: Tx, account: LockedAccount, now: Date): Promise<bigint> {
  const due = await tx.loyaltyPointLot.findMany({
    where: { accountId: account.id, remaining: { gt: 0 }, expiresAt: { lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    select: { id: true, remaining: true, expiresAt: true },
  });
  let total = 0n;
  for (const lot of due) {
    await tx.loyaltyPointLot.update({ where: { id: lot.id }, data: { remaining: 0n } });
    // A lot can expire more than once only if points were given back to it after it expired.
    const n = await tx.rewardTransaction.count({
      where: { type: 'POINTS_EXPIRED', idempotencyKey: { startsWith: `expire-lot:${lot.id}:` } },
    });
    await postPoints(
      tx,
      account,
      {
        type: 'POINTS_EXPIRED',
        points: -lot.remaining,
        description: `${lot.remaining.toString()} points expired`,
        idempotencyKey: `expire-lot:${lot.id}:${n + 1}`,
        metadata: { lotId: lot.id, expiresAt: lot.expiresAt.toISOString() },
      },
      { now, origin: 'AUTOMATED', actorType: 'SYSTEM' },
    );
    total += lot.remaining;
  }
  return total;
}

// ─── Travel credits ──────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const block = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
/** WYC-7KQ2-M9XD (WYC: Wayora credit). */
export const creditReference = () => `WYC-${block()}-${block()}`;

export interface CreditAllocation {
  id: string;
  amountMinor: string;
}

/** A credit row and its CREDIT_* ledger entry. */
async function postCredit(
  tx: Tx,
  account: LockedAccount,
  credit: { id: string; currency: string; reference: string },
  entry: {
    type: RewardTransactionType;
    amountMinor: bigint;
    description: string;
    idempotencyKey: string;
    metadata?: Prisma.InputJsonValue;
  },
  ctx: EntryContext,
): Promise<void> {
  await tx.rewardTransaction.create({
    data: {
      accountId: account.id,
      userId: account.userId,
      mode: account.mode,
      type: entry.type,
      origin: ctx.origin,
      amountMinor: entry.amountMinor,
      currency: credit.currency,
      creditId: credit.id,
      description: entry.description.slice(0, 255),
      reason: ctx.reason ?? null,
      actorType: ctx.actorType,
      actorId: ctx.actorId ?? null,
      ruleVersion: ctx.ruleVersion ?? null,
      bookingId: ctx.bookingId ?? null,
      redemptionId: ctx.redemptionId ?? null,
      idempotencyKey: entry.idempotencyKey,
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      createdAt: ctx.now,
    },
  });
}

export async function issueCredit(
  tx: Tx,
  account: LockedAccount,
  input: {
    currency: string;
    amountMinor: bigint;
    reason: TravelCreditReason;
    note: string;
    expiresAt: Date | null;
    bookingId: string | null;
    campaign: string | null;
    idempotencyKey: string;
  },
  ctx: EntryContext,
): Promise<{ id: string; reference: string; created: boolean }> {
  const existing = await tx.travelCredit.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, reference: true },
  });
  if (existing) return { ...existing, created: false };
  let credit: { id: string; reference: string } | null = null;
  for (let attempt = 0; attempt < 5 && !credit; attempt += 1) {
    const reference = creditReference();
    if (await tx.travelCredit.count({ where: { reference } })) continue;
    credit = await tx.travelCredit.create({
      data: {
        reference,
        userId: account.userId,
        mode: account.mode,
        currency: input.currency,
        originalAmountMinor: input.amountMinor,
        remainingAmountMinor: input.amountMinor,
        reason: input.reason,
        note: input.note,
        issuedAt: ctx.now,
        expiresAt: input.expiresAt,
        bookingId: input.bookingId,
        campaign: input.campaign,
        issuedById: ctx.actorId ?? null,
        idempotencyKey: input.idempotencyKey,
        updatedAt: ctx.now,
      },
      select: { id: true, reference: true },
    });
  }
  if (!credit) throw new AppError('INTERNAL_ERROR', 'Could not create a credit reference.');
  await postCredit(
    tx,
    account,
    { ...credit, currency: input.currency },
    {
      type: 'CREDIT_ISSUED',
      amountMinor: input.amountMinor,
      description: `Travel credit ${credit.reference} issued: ${input.note}`,
      idempotencyKey: `credit-issued:${credit.id}`,
    },
    ctx,
  );
  return { ...credit, created: true };
}

/** Active, unexpired credit in one currency (call after expireDueCredits). */
export async function creditAvailable(
  tx: Tx,
  account: LockedAccount,
  currency: string,
  now: Date,
): Promise<bigint> {
  const sum = await tx.travelCredit.aggregate({
    where: {
      userId: account.userId,
      mode: account.mode,
      currency,
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    _sum: { remainingAmountMinor: true },
  });
  return sum._sum.remainingAmountMinor ?? 0n;
}

/** Spends `amount` of credit in `currency`, soonest expiry first (partial use allowed). */
export async function spendCredits(
  tx: Tx,
  account: LockedAccount,
  currency: string,
  amount: bigint,
  ctx: EntryContext & { bookingReference: string },
): Promise<CreditAllocation[]> {
  const credits = await tx.travelCredit.findMany({
    where: {
      userId: account.userId,
      mode: account.mode,
      currency,
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }],
    },
    orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { issuedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, reference: true, currency: true, remainingAmountMinor: true },
  });
  const used: CreditAllocation[] = [];
  let left = amount;
  for (const c of credits) {
    if (left === 0n) break;
    const take = c.remainingAmountMinor < left ? c.remainingAmountMinor : left;
    const remaining = c.remainingAmountMinor - take;
    await tx.travelCredit.update({
      where: { id: c.id },
      data: {
        remainingAmountMinor: remaining,
        status: remaining === 0n ? 'USED' : 'ACTIVE',
        updatedAt: ctx.now,
      },
    });
    await postCredit(
      tx,
      account,
      c,
      {
        type: 'CREDIT_REDEEMED',
        amountMinor: -take,
        description: `Travel credit ${c.reference} used on booking ${ctx.bookingReference}`,
        idempotencyKey: `credit-redeemed:${ctx.redemptionId}:${c.id}`,
      },
      ctx,
    );
    used.push({ id: c.id, amountMinor: take.toString() });
    left -= take;
  }
  if (left > 0n) throw new AppError('CONFLICT', 'Not enough travel credit.');
  return used;
}

/** Gives spent credit back; credits past their expiry expire again at once. */
export async function restoreCredits(
  tx: Tx,
  account: LockedAccount,
  allocations: readonly CreditAllocation[],
  ctx: EntryContext & { bookingReference: string; key: string },
): Promise<void> {
  for (const a of allocations) {
    const c = await tx.travelCredit.findUniqueOrThrow({
      where: { id: a.id },
      select: {
        id: true,
        reference: true,
        currency: true,
        status: true,
        remainingAmountMinor: true,
      },
    });
    // A revoked credit stays revoked: its value isn't handed back.
    if (c.status === 'REVOKED') continue;
    const amount = BigInt(a.amountMinor);
    await tx.travelCredit.update({
      where: { id: c.id },
      data: {
        remainingAmountMinor: c.remainingAmountMinor + amount,
        status: 'ACTIVE',
        updatedAt: ctx.now,
      },
    });
    await postCredit(
      tx,
      account,
      c,
      {
        type: 'CREDIT_RESTORED',
        amountMinor: amount,
        description: `Travel credit ${c.reference} given back from booking ${ctx.bookingReference}`,
        idempotencyKey: `credit-restored:${ctx.key}:${c.id}`,
      },
      ctx,
    );
  }
  await expireDueCredits(tx, account, ctx.now);
}

/** Expires the account's credits whose time has come. */
export async function expireDueCredits(tx: Tx, account: LockedAccount, now: Date): Promise<number> {
  const due = await tx.travelCredit.findMany({
    where: {
      userId: account.userId,
      mode: account.mode,
      status: 'ACTIVE',
      expiresAt: { lte: now },
    },
    select: { id: true, reference: true, currency: true, remainingAmountMinor: true },
  });
  for (const c of due) {
    await tx.travelCredit.update({
      where: { id: c.id },
      data: { remainingAmountMinor: 0n, status: 'EXPIRED', updatedAt: now },
    });
    const n = await tx.rewardTransaction.count({
      where: { type: 'CREDIT_EXPIRED', creditId: c.id },
    });
    await postCredit(
      tx,
      account,
      c,
      {
        type: 'CREDIT_EXPIRED',
        amountMinor: -c.remainingAmountMinor,
        description: `Travel credit ${c.reference} expired`,
        idempotencyKey: `credit-expired:${c.id}:${n + 1}`,
      },
      { now, origin: 'AUTOMATED', actorType: 'SYSTEM' },
    );
  }
  return due.length;
}

export async function revokeCredit(
  tx: Tx,
  account: LockedAccount,
  creditId: string,
  ctx: EntryContext,
): Promise<{ reference: string; amountMinor: bigint; currency: string }> {
  const c = await tx.travelCredit.findUniqueOrThrow({
    where: { id: creditId },
    select: { id: true, reference: true, currency: true, remainingAmountMinor: true, status: true },
  });
  if (c.status !== 'ACTIVE') {
    throw new AppError('CONFLICT', 'Only an active credit can be revoked.');
  }
  await tx.travelCredit.update({
    where: { id: c.id },
    data: { remainingAmountMinor: 0n, status: 'REVOKED', updatedAt: ctx.now },
  });
  await postCredit(
    tx,
    account,
    c,
    {
      type: 'CREDIT_REVOKED',
      amountMinor: -c.remainingAmountMinor,
      description: `Travel credit ${c.reference} withdrawn`,
      idempotencyKey: `credit-revoked:${c.id}`,
    },
    ctx,
  );
  return { reference: c.reference, amountMinor: c.remainingAmountMinor, currency: c.currency };
}
