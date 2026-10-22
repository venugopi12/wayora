import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@wayora/database';
import { AppError } from '../../utils/errors.js';

/*
 * Idempotent POSTs (docs/bookings.md#idempotency), on the Phase 1
 * `idempotency_keys` table: unique (scope, key), a hash of the request,
 * a lock, and the outcome to replay.
 *
 * - Keys are scoped to the operation AND the signed-in user, so one person's
 *   key can never collide with or replay another's.
 * - The first request inserts the row (IN_PROGRESS, locked). A concurrent
 *   duplicate hits the unique constraint and gets IDEMPOTENCY_IN_PROGRESS;
 *   a later duplicate gets the stored outcome replayed.
 * - The operation marks the key COMPLETED inside its own transaction, so
 *   "booking created" and "key completed" commit together: a crash between
 *   them is impossible.
 * - Failed attempts release the key (nothing was created), so the same key
 *   can be retried, e.g. after fixing a field.
 * - Only what is needed to replay is stored (the booking reference), never
 *   request bodies or personal details: the request is kept as a SHA-256.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** How long a key is remembered (a day covers any realistic client retry). */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a request may hold a key before another may take it over (crashed process). */
const LOCK_MS = 60 * 1000;

/** Prisma's transaction client type. */
type Tx = Prisma.TransactionClient;

export type IdempotencyClaim<T> =
  { kind: 'proceed'; scope: string; key: string } | { kind: 'replay'; status: number; body: T };

export function validateIdempotencyKey(value: string | undefined): string {
  if (!value) {
    throw new AppError(
      'BAD_REQUEST',
      `Send an ${IDEMPOTENCY_KEY_HEADER} header (a new random value per booking attempt).`,
    );
  }
  if (!KEY_PATTERN.test(value)) {
    throw new AppError(
      'BAD_REQUEST',
      `The ${IDEMPOTENCY_KEY_HEADER} header must be 16–128 letters, digits, "-" or "_".`,
    );
  }
  return value;
}

/** Stable SHA-256 of a JSON value: object keys sorted, so key order doesn't matter. */
export function requestHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

const inProgress = () =>
  new AppError(
    'IDEMPOTENCY_IN_PROGRESS',
    'This booking is already being created. Wait a moment, then check My trips.',
  );

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Claims `key` for this user's `operation`, or explains why not:
   * a replay of the stored outcome, IDEMPOTENCY_IN_PROGRESS (a duplicate is
   * running), or IDEMPOTENCY_KEY_REUSED (same key, different request).
   */
  async claim<T>(input: {
    operation: string;
    userId: string;
    key: string;
    hash: string;
  }): Promise<IdempotencyClaim<T>> {
    const scope = `${input.operation}:${input.userId}`;
    if (await this.insert(scope, input)) return { kind: 'proceed', scope, key: input.key };

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key: input.key } },
    });
    if (!existing) {
      // Released between our insert and read (the other attempt failed): one more try.
      if (await this.insert(scope, input)) return { kind: 'proceed', scope, key: input.key };
      throw inProgress();
    }
    if (existing.requestHash !== input.hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This request key was already used for a different booking request. Start the booking again.',
      );
    }
    if (existing.status === 'COMPLETED' && existing.responseStatus !== null) {
      return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody as T };
    }
    // In progress. If its lock has run out, the process that held it is gone:
    // take it over atomically, so only one waiting duplicate can.
    const now = this.now();
    if (existing.lockedUntil && existing.lockedUntil.getTime() <= now.getTime()) {
      const taken = await this.prisma.idempotencyKey.updateMany({
        where: { id: existing.id, lockedUntil: existing.lockedUntil, status: 'IN_PROGRESS' },
        data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
      });
      if (taken.count === 1) return { kind: 'proceed', scope, key: input.key };
    }
    throw inProgress();
  }

  /** Inserts a fresh, locked key; false if (scope, key) already exists. */
  private async insert(
    scope: string,
    input: { userId: string; key: string; hash: string },
  ): Promise<boolean> {
    const now = this.now();
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          scope,
          key: input.key,
          userId: input.userId,
          requestHash: input.hash,
          lockedUntil: new Date(now.getTime() + LOCK_MS),
          expiresAt: new Date(now.getTime() + KEY_TTL_MS),
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Records the outcome, inside the operation's own transaction. */
  async complete(
    tx: Tx,
    claim: { scope: string; key: string },
    outcome: { status: number; body: unknown },
  ): Promise<void> {
    await tx.idempotencyKey.update({
      where: { scope_key: { scope: claim.scope, key: claim.key } },
      data: {
        status: 'COMPLETED',
        responseStatus: outcome.status,
        responseBody: outcome.body as Prisma.InputJsonValue,
        lockedUntil: null,
      },
    });
  }

  /** Frees a key whose operation failed (nothing was created), so it can be retried. */
  async release(claim: { scope: string; key: string }): Promise<void> {
    await this.prisma.idempotencyKey
      .deleteMany({ where: { scope: claim.scope, key: claim.key, status: 'IN_PROGRESS' } })
      .catch(() => undefined); // it expires anyway
  }

  /** Deletes keys past their expiry (run periodically). */
  async purgeExpired(): Promise<number> {
    const now = this.now();
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: {
        expiresAt: { lt: now },
        OR: [{ status: { not: 'IN_PROGRESS' } }, { lockedUntil: { lt: now } }],
      },
    });
    return count;
  }
}
