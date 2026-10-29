import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AdminReservationResolve } from '@wayora/contracts';
import {
  Prisma,
  type PrismaClient,
  type ReservationErrorCategory,
  type ReservationStatus,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { messages, notify } from '../notifications/notify.js';
import { ProviderError } from '../providers/provider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  cancellationOutcomeSchema,
  reservationOutcomeSchema,
  type CancellationOutcome,
  type ReservationOutcome,
  type ReservationRequest,
  type SupplierReservations,
} from '../providers/reservations.js';
import { TimeoutError, withTimeout } from '../search/concurrency.js';
import { errorForLog } from '../search/errors.js';
import { lockBooking, transitionBooking } from './lifecycle.js';
import { bookingSnapshotSchema } from './snapshot.js';

/*
 * Supplier reservations (Phase 23, docs/bookings.md#supplier-reservations).
 *
 * The supplier side of a non-demo booking, kept apart from the booking's
 * own status and from payments. No real supplier implements reservations
 * yet (docs/providers.md); the lifecycle is exercised through the test-only
 * fixture supplier.
 *
 *   PENDING ──send──▶ IN_PROGRESS ──confirmed──▶ CONFIRMED ──cancel──▶ CANCELLATION_PENDING
 *      │                 │  ├──rejected──▶ FAILED                         │  ├─confirmed─▶ CANCELLED
 *      │                 │  └──no answer──▶ UNKNOWN ──lookup / resend──┘    │  └─refused──▶ CONFIRMED
 *      └─(supplier off)─▶ FAILED
 *
 * Rules:
 * - Never confirmed because a request was sent: only a supplier's
 *   `confirmed` answer (with its reference), or staff recording one after
 *   checking with the supplier, confirms. The booking follows (a database
 *   trigger refuses anything else).
 * - Exactly one process sends a request: every send is a conditional status
 *   change first (PENDING → IN_PROGRESS), committed before the call.
 * - An answer Wayora didn't get (timeout, error, unreadable) is UNKNOWN,
 *   never FAILED. Recovery uses the supplier's read-only lookup, or, only
 *   for suppliers documented to de-duplicate by Wayora's idempotency key, a
 *   resend with the same key; otherwise staff reconcile it (needs attention).
 * - Bounded: checks back off exponentially (with jitter) and stop after
 *   `maxChecks`; resends stop after `maxResends`.
 * - Every status change is in reservation_events; booking changes, the
 *   owner's notification and the audit entry commit in the same transaction.
 */

type Tx = Prisma.TransactionClient;
type Actor = 'SYSTEM' | 'PROVIDER' | 'USER' | 'ADMIN';

export interface CallContext {
  requestId?: string;
}

export interface RecoveryPolicy {
  /** First wait before a status check; doubles per check (with jitter). */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Lookups before recovery stops and staff take over. */
  maxChecks: number;
  /** Requests (first one included) to a de-duplicating supplier, and cancellation requests. */
  maxResends: number;
  /** "Not found" means "not reserved" only this long after the last request. */
  notFoundGraceMs: number;
  /** A reservation still PENDING this long after it was recorded was never sent (a crash): send it. */
  unsentGraceMs: number;
}

export const DEFAULT_RECOVERY: RecoveryPolicy = {
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  maxChecks: 8,
  maxResends: 3,
  notFoundGraceMs: 15 * 60_000,
  unsentGraceMs: 60_000,
};

export interface ReservationServiceOptions {
  prisma: PrismaClient;
  registry: ProviderRegistry;
  logger: Logger;
  /** Time limit of one reserve, lookup or cancel call. */
  timeoutMs: number;
  recovery?: Partial<RecoveryPolicy>;
  now?: () => Date;
  random?: () => number;
}

const reservationInclude = {
  booking: {
    select: {
      id: true,
      reference: true,
      userId: true,
      status: true,
      offerSnapshot: true,
      partySize: true,
      contactPhone: true,
      travellers: { orderBy: { position: 'asc' } },
    },
  },
} satisfies Prisma.SupplierReservationInclude;
type ReservationRow = Prisma.SupplierReservationGetPayload<{ include: typeof reservationInclude }>;

const REJECTION: Record<
  Extract<ReservationOutcome, { status: 'rejected' }>['reason'],
  ReservationErrorCategory
> = {
  'offer-unavailable': 'OFFER_UNAVAILABLE',
  'price-changed': 'PRICE_CHANGED',
  'invalid-details': 'INVALID_DETAILS',
  other: 'REJECTED',
};

/** A normalized category for a call that got no usable answer (never supplier text). */
export function errorCategoryOf(error: unknown): ReservationErrorCategory {
  if (error instanceof TimeoutError) return 'TIMEOUT';
  if (error instanceof ProviderError)
    return error.kind === 'unavailable' ? 'UNAVAILABLE' : 'INVALID_RESPONSE';
  if (error instanceof ZodError || error instanceof UnexpectedAnswer) return 'INVALID_RESPONSE';
  return 'UNKNOWN';
}

class UnexpectedAnswer extends Error {
  constructor(what: string) {
    super(`Unexpected supplier answer: ${what}`);
    this.name = 'UnexpectedAnswer';
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Statuses recovery works on. */
const OPEN: ReservationStatus[] = ['PENDING', 'IN_PROGRESS', 'UNKNOWN', 'CANCELLATION_PENDING'];

/** Extra time on top of the call timeout before an IN_PROGRESS row is considered abandoned. */
const ABANDONED_MARGIN_MS = 60_000;

export class ReservationService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  private readonly random: () => number;
  readonly policy: RecoveryPolicy;

  constructor(private readonly options: ReservationServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.policy = { ...DEFAULT_RECOVERY, ...options.recovery };
  }

  private log(context: CallContext = {}): Logger {
    const child = this.options.logger.child({ component: 'reservations' });
    return context.requestId ? child.child({ requestId: context.requestId }) : child;
  }

  /** The supplier's reservation operations, if its provider is registered, enabled and has them. */
  operationsFor(providerId: string): SupplierReservations | null {
    const found = this.options.registry.find(providerId);
    return found?.enabled ? (found.provider.reservations ?? null) : null;
  }

  private supplierName(providerId: string): string {
    return this.options.registry.find(providerId)?.provider.name ?? providerId;
  }

  /** Delay before check number `n` (0-based): exponential, capped, half of it jittered. */
  private delayFor(n: number): number {
    const ceiling = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** n);
    return Math.round(ceiling / 2 + this.random() * (ceiling / 2));
  }

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + this.options.timeoutMs + ABANDONED_MARGIN_MS);
  }

  private async load(id: string): Promise<ReservationRow | null> {
    return this.prisma.supplierReservation.findUnique({
      where: { id },
      include: reservationInclude,
    });
  }

  // ─── Creating (inside the booking's own transaction) ──────────────────

  /** Records the reservation for a new supplier booking. Nothing is sent yet. */
  async record(
    tx: Tx,
    now: Date,
    booking: { id: string; provider: string },
    context: CallContext,
  ): Promise<string> {
    const reservation = await tx.supplierReservation.create({
      data: {
        bookingId: booking.id,
        provider: booking.provider,
        idempotencyKey: randomUUID(),
        status: 'PENDING',
        // If this process stops before sending, recovery sends it after this.
        nextCheckAt: new Date(now.getTime() + this.policy.unsentGraceMs),
        requestId: context.requestId ?? null,
        createdAt: now,
        events: {
          create: {
            fromStatus: null,
            toStatus: 'PENDING',
            actorType: 'USER',
            note: 'Reservation recorded by Wayora; not sent to the supplier yet.',
            requestId: context.requestId ?? null,
            createdAt: now,
          },
        },
      },
      select: { id: true },
    });
    return reservation.id;
  }

  // ─── Status changes ───────────────────────────────────────────────────

  /** Changes the status only if it is still `from` (no lost updates); logs the change. */
  private async move(
    tx: Tx,
    reservation: { id: string; status: ReservationStatus },
    to: ReservationStatus,
    data: Prisma.SupplierReservationUpdateManyMutationInput,
    event: {
      actorType: Actor;
      note: string;
      errorCategory?: ReservationErrorCategory | null;
      requestId?: string | null;
    },
  ): Promise<boolean> {
    const now = this.now();
    const changed = await tx.supplierReservation.updateMany({
      where: { id: reservation.id, status: reservation.status },
      data: { ...data, status: to, updatedAt: now },
    });
    if (changed.count !== 1) return false;
    if (reservation.status !== to) {
      await tx.reservationEvent.create({
        data: {
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: to,
          actorType: event.actorType,
          errorCategory: event.errorCategory ?? null,
          note: event.note.slice(0, 255),
          requestId: event.requestId ?? null,
          createdAt: now,
        },
      });
    }
    return true;
  }

  private async audit(
    tx: Tx,
    r: ReservationRow,
    action: string,
    actor: { type: Actor; id: string | null },
    context: CallContext,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorType: actor.type,
        actorId: actor.id,
        action,
        entityType: 'booking',
        entityId: r.bookingId,
        requestId: context.requestId ?? null,
        metadata: {
          reference: r.booking.reference,
          provider: r.provider,
          ...metadata,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ─── Sending a reservation ────────────────────────────────────────────

  private requestFor(r: ReservationRow): ReservationRequest {
    const snapshot = bookingSnapshotSchema.parse(r.booking.offerSnapshot);
    const price = snapshot.offer.price;
    if (!price) throw new Error('A supplier booking always has a price.');
    return {
      idempotencyKey: r.idempotencyKey,
      bookingReference: r.booking.reference,
      offer: snapshot.offer,
      expectedPrice: price,
      travellers: r.booking.travellers.map((t) => ({
        firstName: t.firstName,
        lastName: t.lastName,
        type: t.type ? (t.type.toLowerCase() as 'adult' | 'child' | 'infant') : null,
      })),
      contactPhone: r.booking.contactPhone,
      partySize: r.booking.partySize,
    };
  }

  /**
   * Sends the reservation request: the first time (from PENDING), or again
   * after an unknown outcome to a supplier that de-duplicates by Wayora's
   * key. Never throws: every outcome is recorded.
   */
  async submit(reservationId: string, context: CallContext = {}): Promise<void> {
    const r = await this.load(reservationId);
    if (!r) return;
    const ops = this.operationsFor(r.provider);
    const log = this.log(context).child({ bookingReference: r.booking.reference });
    if (!ops) {
      if (r.status === 'PENDING') {
        // Nothing was sent, so nothing can have been reserved.
        await this.failUnsent(r, context);
      }
      return;
    }
    const resend = r.status === 'UNKNOWN';
    if (!(r.status === 'PENDING' || (resend && this.canResend(r, ops)))) return;

    const now = this.now();
    const claimed = await this.prisma.$transaction((tx) =>
      this.move(
        tx,
        r,
        'IN_PROGRESS',
        {
          attempts: { increment: 1 },
          lastAttemptAt: now,
          nextCheckAt: this.leaseUntil(now),
          ambiguous: false,
          requestId: context.requestId ?? null,
        },
        {
          actorType: 'SYSTEM',
          note: resend
            ? 'Reservation request sent again with the same key (the supplier de-duplicates by it).'
            : 'Reservation request sent to the supplier.',
          requestId: context.requestId ?? null,
        },
      ),
    );
    if (!claimed) return; // another process is sending it
    const current = { ...r, status: 'IN_PROGRESS' as const, attempts: r.attempts + 1 };

    const started = performance.now();
    let outcome: ReservationOutcome;
    try {
      const raw = await withTimeout(this.options.timeoutMs, undefined, (signal) =>
        ops.reserve(this.requestFor(r), { signal, now: this.now() }),
      );
      outcome = reservationOutcomeSchema.parse(raw);
      if (outcome.status === 'not-found' || outcome.status === 'cancelled') {
        throw new UnexpectedAnswer(outcome.status);
      }
    } catch (error) {
      const category = errorCategoryOf(error);
      log.warn(
        {
          reservation: { provider: r.provider, operation: 'reserve', category },
          durationMs: Math.round(performance.now() - started),
          err: errorForLog(error),
        },
        'Reservation outcome unknown; it will not be sent blindly again',
      );
      await this.markUnknown(current, category, ops, context);
      return;
    }
    log.info(
      {
        reservation: {
          provider: r.provider,
          operation: 'reserve',
          outcome: outcome.status,
          attempt: current.attempts,
        },
        durationMs: Math.round(performance.now() - started),
      },
      'Reservation call finished',
    );
    await this.applyOutcome(current, outcome, ops, { type: 'PROVIDER', id: r.provider }, context);
  }

  private canResend(r: { attempts: number }, ops: SupplierReservations): boolean {
    return ops.idempotentReserve && r.attempts < this.policy.maxResends;
  }

  private canRecover(r: { attempts: number }, ops: SupplierReservations): boolean {
    return Boolean(ops.lookup) || this.canResend(r, ops);
  }

  /** The supplier connection is off or gone and nothing was sent: definitively not reserved. */
  private async failUnsent(r: ReservationRow, context: CallContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, r.bookingId);
      const moved = await this.move(
        tx,
        r,
        'FAILED',
        { nextCheckAt: null, errorCategory: 'UNAVAILABLE' },
        {
          actorType: 'SYSTEM',
          note: 'Not sent: the supplier connection is switched off. Nothing was reserved.',
          errorCategory: 'UNAVAILABLE',
          requestId: context.requestId ?? null,
        },
      );
      if (moved) await this.failBooking(tx, r, 'SYSTEM', context);
    });
  }

  /** No definitive answer: keep it open, and check (or hand over to staff). */
  private async markUnknown(
    r: ReservationRow,
    category: ReservationErrorCategory,
    ops: SupplierReservations,
    context: CallContext,
  ): Promise<void> {
    const recoverable = this.canRecover(r, ops);
    await this.prisma.$transaction((tx) =>
      this.move(
        tx,
        r,
        'UNKNOWN',
        {
          ambiguous: true,
          errorCategory: category,
          needsAttention: !recoverable,
          nextCheckAt: recoverable
            ? new Date(this.now().getTime() + this.delayFor(r.checks))
            : null,
        },
        {
          actorType: 'SYSTEM',
          note: recoverable
            ? 'No definitive answer from the supplier. Wayora will check before doing anything else.'
            : 'No definitive answer, and this supplier has no status lookup: staff must check with the supplier.',
          errorCategory: category,
          requestId: context.requestId ?? null,
        },
      ),
    );
  }

  /** Applies a supplier's answer to an open reservation (from a request, a lookup, or staff). */
  private async applyOutcome(
    r: ReservationRow,
    outcome: ReservationOutcome,
    ops: SupplierReservations | null,
    actor: { type: Actor; id: string | null },
    context: CallContext,
  ): Promise<void> {
    const now = this.now();
    const requestId = context.requestId ?? null;
    switch (outcome.status) {
      case 'confirmed':
        await this.confirm(r, outcome, actor, context);
        return;
      case 'pending': {
        const lookup = Boolean(ops?.lookup);
        await this.prisma.$transaction((tx) =>
          this.move(
            tx,
            r,
            'IN_PROGRESS',
            {
              ambiguous: false,
              errorCategory: null,
              ...(r.supplierReference === null && outcome.supplierReference
                ? { supplierReference: outcome.supplierReference }
                : {}),
              needsAttention: !lookup,
              nextCheckAt: lookup ? new Date(now.getTime() + this.delayFor(r.checks)) : null,
            },
            {
              actorType: actor.type,
              note: 'The supplier accepted the request but hasn’t confirmed it yet.',
              requestId,
            },
          ),
        );
        return;
      }
      case 'rejected':
      case 'cancelled': {
        const category =
          outcome.status === 'rejected' ? REJECTION[outcome.reason] : ('REJECTED' as const);
        await this.prisma.$transaction(async (tx) => {
          await lockBooking(tx, r.bookingId);
          const moved = await this.move(
            tx,
            r,
            'FAILED',
            { ambiguous: false, nextCheckAt: null, errorCategory: category },
            {
              actorType: actor.type,
              note:
                outcome.status === 'cancelled'
                  ? 'The supplier reports it cancelled before it was confirmed. Nothing is reserved.'
                  : 'The supplier did not reserve it.',
              errorCategory: category,
              requestId,
            },
          );
          if (moved) await this.failBooking(tx, r, actor.type, context);
        });
        return;
      }
      case 'not-found':
        throw new Error('not-found is handled by the caller');
    }
  }

  private async confirm(
    r: ReservationRow,
    outcome: Extract<ReservationOutcome, { status: 'confirmed' }>,
    actor: { type: Actor; id: string | null },
    context: CallContext,
  ): Promise<void> {
    const now = this.now();
    const snapshot = bookingSnapshotSchema.parse(r.booking.offerSnapshot);
    const booked = snapshot.offer.price;
    const bookedTotal = booked?.kind === 'total' ? booked.total : null;
    // A supplier confirming another price is still a confirmation (it holds
    // the reservation), but staff must follow up with the traveller.
    const mismatch =
      outcome.price !== null &&
      (!bookedTotal ||
        bookedTotal.amountMinor !== outcome.price.amountMinor ||
        bookedTotal.currency !== outcome.price.currency);
    const travellerCount = r.booking.travellers.length;
    const documents = outcome.documents.filter(
      (d) => d.travellerIndex === null || d.travellerIndex < travellerCount,
    );
    if (documents.length !== outcome.documents.length) {
      this.log(context).warn(
        {
          bookingReference: r.booking.reference,
          dropped: outcome.documents.length - documents.length,
        },
        'Supplier documents for unknown travellers were not recorded',
      );
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, r.bookingId);
        const moved = await this.move(
          tx,
          r,
          'CONFIRMED',
          {
            supplierReference: outcome.supplierReference,
            confirmedAt: now,
            confirmedDetails: {
              price: outcome.price,
              documentsIssued: documents.length,
              via: actor.type === 'ADMIN' ? 'staff' : 'supplier',
            },
            ambiguous: false,
            nextCheckAt: null,
            errorCategory: mismatch ? 'PRICE_MISMATCH' : null,
            needsAttention: mismatch,
          },
          {
            actorType: actor.type,
            note:
              actor.type === 'ADMIN'
                ? 'Confirmed: recorded by Wayora staff after checking with the supplier.'
                : mismatch
                  ? 'Confirmed by the supplier, at a different price than booked: staff will follow up.'
                  : 'Confirmed by the supplier.',
            errorCategory: mismatch ? 'PRICE_MISMATCH' : null,
            requestId: context.requestId ?? null,
          },
        );
        if (!moved) return;
        if (documents.length > 0) {
          await tx.travelDocument.createMany({
            data: documents.map((d) => ({
              reservationId: r.id,
              bookingId: r.bookingId,
              type: d.type.toUpperCase() as 'TICKET' | 'VOUCHER' | 'ITINERARY',
              reference: d.reference,
              travellerPosition: d.travellerIndex,
              issuedAt: now,
              createdAt: now,
            })),
            skipDuplicates: true,
          });
        }
        const supplier = this.supplierName(r.provider);
        await tx.booking.update({
          where: { id: r.bookingId },
          data: { providerReference: outcome.supplierReference },
        });
        const confirmed = await transitionBooking(tx, now, r.bookingId, 'PENDING', 'CONFIRMED', {
          actorType: actor.type,
          note: `Confirmed by ${supplier}.`.slice(0, 255),
        });
        if (!confirmed) {
          // The booking left PENDING another way: never leave the two disagreeing silently.
          throw new Error('Booking was not pending when its reservation was confirmed.');
        }
        await notify(tx, now, {
          ...messages.supplierBookingConfirmed(
            r.booking.reference,
            supplier,
            outcome.supplierReference,
          ),
          userId: r.booking.userId,
          isDemo: false,
          bookingId: r.bookingId,
          dedupeKey: `booking:${r.bookingId}:CONFIRMED`,
        });
        await this.audit(tx, r, 'reservation.confirmed', actor, context, {
          priceMismatch: mismatch,
          documents: documents.length,
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The supplier's reference already belongs to another booking: never
      // attach it twice. Keep this one open for staff.
      this.log(context).error(
        { bookingReference: r.booking.reference },
        'Supplier confirmation reuses a reference already on record; staff must reconcile',
      );
      await this.prisma.supplierReservation.updateMany({
        where: { id: r.id, status: r.status },
        data: {
          needsAttention: true,
          nextCheckAt: null,
          errorCategory: 'INVALID_RESPONSE',
          ...(r.status === 'UNKNOWN' ? { ambiguous: true } : {}),
        },
      });
    }
  }

  private async failBooking(
    tx: Tx,
    r: ReservationRow,
    actorType: Actor,
    context: CallContext,
  ): Promise<void> {
    const now = this.now();
    const supplier = this.supplierName(r.provider);
    const failed = await transitionBooking(tx, now, r.bookingId, 'PENDING', 'FAILED', {
      actorType,
      note: `Not confirmed by ${supplier}: nothing was reserved, and Wayora took no payment.`.slice(
        0,
        255,
      ),
    });
    if (!failed) return;
    await notify(tx, now, {
      ...messages.supplierBookingFailed(r.booking.reference, supplier),
      userId: r.booking.userId,
      isDemo: false,
      bookingId: r.bookingId,
      dedupeKey: `booking:${r.bookingId}:FAILED`,
    });
    await this.audit(tx, r, 'reservation.failed', { type: actorType, id: null }, context);
  }

  // ─── Recovery ─────────────────────────────────────────────────────────

  /**
   * Works through open reservations whose next check is due (run
   * periodically). Each row is leased with a conditional update first, so
   * several API instances never handle the same one at once.
   */
  async reconcileDue(limit = 20): Promise<number> {
    const now = this.now();
    const due = await this.prisma.supplierReservation.findMany({
      where: { status: { in: OPEN }, needsAttention: false, nextCheckAt: { lte: now } },
      orderBy: { nextCheckAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let handled = 0;
    for (const { id } of due) {
      try {
        if (await this.reconcileOne(id)) handled += 1;
      } catch (error) {
        this.log().error({ err: errorForLog(error) }, 'Reservation recovery failed; will retry');
      }
    }
    return handled;
  }

  /** One recovery step for one reservation, if it is due and this process wins its lease. */
  async reconcileOne(id: string, options: { force?: boolean; context?: CallContext } = {}) {
    const context = options.context ?? {};
    const r = await this.load(id);
    if (!r || !OPEN.includes(r.status)) return false;
    if (r.status === 'PENDING') {
      await this.submit(r.id, context);
      return true;
    }
    const now = this.now();
    const leased = await this.prisma.supplierReservation.updateMany({
      where: {
        id: r.id,
        status: r.status,
        ...(options.force ? {} : { needsAttention: false, nextCheckAt: { lte: now } }),
      },
      data: { nextCheckAt: this.leaseUntil(now) },
    });
    if (leased.count !== 1) return false;
    if (r.status === 'CANCELLATION_PENDING') await this.checkCancellation(r, context);
    else await this.checkReservation(r, context);
    return true;
  }

  private async attention(
    r: ReservationRow,
    category: ReservationErrorCategory | null,
    why: string,
    context: CallContext,
  ): Promise<void> {
    this.log(context).warn(
      { bookingReference: r.booking.reference, provider: r.provider, why },
      'Reservation needs staff attention',
    );
    await this.prisma.supplierReservation.updateMany({
      where: { id: r.id, status: r.status },
      data: {
        needsAttention: true,
        nextCheckAt: null,
        ...(category ? { errorCategory: category } : {}),
      },
    });
  }

  private async reschedule(
    r: ReservationRow,
    category: ReservationErrorCategory | null,
    context: CallContext,
  ): Promise<void> {
    const checks = r.checks + 1;
    if (checks >= this.policy.maxChecks) {
      await this.attention(r, category, 'status checks exhausted', context);
      return;
    }
    await this.prisma.supplierReservation.updateMany({
      where: { id: r.id, status: r.status },
      data: {
        nextCheckAt: new Date(this.now().getTime() + this.delayFor(checks)),
        ...(category ? { errorCategory: category } : {}),
      },
    });
  }

  private async lookup(
    r: ReservationRow,
    ops: SupplierReservations,
    context: CallContext,
  ): Promise<ReservationOutcome | { error: ReservationErrorCategory }> {
    await this.prisma.supplierReservation.update({
      where: { id: r.id },
      data: { checks: { increment: 1 } },
    });
    try {
      const raw = await withTimeout(this.options.timeoutMs, undefined, (signal) =>
        ops.lookup!(
          {
            idempotencyKey: r.idempotencyKey,
            bookingReference: r.booking.reference,
            supplierReference: r.supplierReference,
            offer: bookingSnapshotSchema.parse(r.booking.offerSnapshot).offer,
          },
          { signal, now: this.now() },
        ),
      );
      const outcome = reservationOutcomeSchema.parse(raw);
      this.log(context).info(
        { reservation: { provider: r.provider, operation: 'lookup', outcome: outcome.status } },
        'Reservation lookup finished',
      );
      return outcome;
    } catch (error) {
      const category = errorCategoryOf(error);
      this.log(context).warn(
        {
          reservation: { provider: r.provider, operation: 'lookup', category },
          err: errorForLog(error),
        },
        'Reservation lookup failed',
      );
      return { error: category };
    }
  }

  private async checkReservation(r: ReservationRow, context: CallContext): Promise<void> {
    const ops = this.operationsFor(r.provider);
    if (!ops) {
      await this.attention(r, 'UNAVAILABLE', 'supplier connection is switched off', context);
      return;
    }
    if (ops.lookup) {
      const outcome = await this.lookup(r, ops, context);
      if ('error' in outcome) {
        await this.reschedule(r, outcome.error, context);
        return;
      }
      if (outcome.status === 'not-found') {
        const since = (r.lastAttemptAt ?? r.createdAt).getTime();
        if (this.now().getTime() - since < this.policy.notFoundGraceMs) {
          await this.reschedule(r, null, context);
          return;
        }
        // Long enough after the last request: the supplier never took it.
        await this.prisma.$transaction(async (tx) => {
          await lockBooking(tx, r.bookingId);
          const moved = await this.move(
            tx,
            r,
            'FAILED',
            { ambiguous: false, nextCheckAt: null, errorCategory: 'NOT_FOUND' },
            {
              actorType: 'PROVIDER',
              note: 'The supplier has no record of this reservation, so nothing was reserved.',
              errorCategory: 'NOT_FOUND',
              requestId: context.requestId ?? null,
            },
          );
          if (moved) await this.failBooking(tx, r, 'PROVIDER', context);
        });
        return;
      }
      await this.applyOutcome(
        { ...r, checks: r.checks + 1 },
        outcome,
        ops,
        { type: 'PROVIDER', id: r.provider },
        context,
      );
      return;
    }
    // No lookup. An IN_PROGRESS row here was abandoned mid-request (the
    // process stopped): its outcome is unknown.
    let current = r;
    if (r.status === 'IN_PROGRESS') {
      await this.markUnknown(r, 'UNKNOWN', ops, context);
      const reloaded = await this.load(r.id);
      if (!reloaded || reloaded.status !== 'UNKNOWN') return;
      current = reloaded;
    }
    if (this.canResend(current, ops)) {
      await this.submit(current.id, context);
      return;
    }
    await this.attention(current, null, 'no lookup and no safe resend', context);
  }

  // ─── Cancellation ─────────────────────────────────────────────────────

  /** Whether the booking's supplier can cancel through Wayora. */
  canCancel(providerId: string): boolean {
    return Boolean(this.operationsFor(providerId)?.cancel);
  }

  /**
   * Asks the supplier to cancel a confirmed reservation. The booking stays
   * confirmed until the supplier confirms the cancellation. A second request
   * while one is pending changes nothing (no duplicate cancellation calls).
   */
  async requestCancellation(
    bookingId: string,
    actor: { type: 'USER'; id: string },
    context: CallContext = {},
  ): Promise<'cancelled' | 'pending'> {
    const r = await this.prisma.supplierReservation.findUnique({
      where: { bookingId },
      include: reservationInclude,
    });
    if (!r) throw new AppError('BOOKING_NOT_CANCELLABLE', 'This booking can’t be cancelled.');
    const ops = this.operationsFor(r.provider);
    const supplier = this.supplierName(r.provider);
    if (r.status === 'CANCELLATION_PENDING') return 'pending';
    if (!ops?.cancel) {
      throw new AppError(
        'BOOKING_NOT_CANCELLABLE',
        `Cancelling this booking isn’t available through Wayora. Contact ${supplier}${
          r.supplierReference ? ` with reference ${r.supplierReference}` : ''
        } under its own terms.`,
      );
    }
    if (r.status !== 'CONFIRMED') {
      throw new AppError(
        'BOOKING_NOT_CANCELLABLE',
        'Only a reservation the supplier has confirmed can be cancelled.',
      );
    }
    const now = this.now();
    const key = r.cancellationKey ?? randomUUID();
    const claimed = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, r.bookingId);
      const moved = await this.move(
        tx,
        r,
        'CANCELLATION_PENDING',
        {
          cancellationKey: key,
          cancellationRequestedAt: now,
          cancelAttempts: { increment: 1 },
          lastAttemptAt: now,
          nextCheckAt: this.leaseUntil(now),
          errorCategory: null,
          needsAttention: false,
          requestId: context.requestId ?? null,
        },
        {
          actorType: 'USER',
          note: 'Cancellation requested from the supplier.',
          requestId: context.requestId ?? null,
        },
      );
      if (moved) {
        await this.audit(tx, r, 'reservation.cancellation_requested', actor, context);
      }
      return moved;
    });
    if (!claimed) return 'pending';
    const current: ReservationRow = {
      ...r,
      status: 'CANCELLATION_PENDING',
      cancellationKey: key,
      cancelAttempts: r.cancelAttempts + 1,
    };
    return this.sendCancellation(current, ops, context);
  }

  private async sendCancellation(
    r: ReservationRow,
    ops: SupplierReservations,
    context: CallContext,
  ): Promise<'cancelled' | 'pending'> {
    let outcome: CancellationOutcome;
    const started = performance.now();
    try {
      const raw = await withTimeout(this.options.timeoutMs, undefined, (signal) =>
        ops.cancel!(
          {
            cancellationKey: r.cancellationKey!,
            supplierReference: r.supplierReference!,
            bookingReference: r.booking.reference,
          },
          { signal, now: this.now() },
        ),
      );
      outcome = cancellationOutcomeSchema.parse(raw);
    } catch (error) {
      const category = errorCategoryOf(error);
      this.log(context).warn(
        {
          reservation: { provider: r.provider, operation: 'cancel', category },
          durationMs: Math.round(performance.now() - started),
          err: errorForLog(error),
        },
        'Cancellation outcome unknown',
      );
      const recoverable = Boolean(ops.lookup);
      await this.prisma.supplierReservation.updateMany({
        where: { id: r.id, status: 'CANCELLATION_PENDING' },
        data: {
          ambiguous: true,
          errorCategory: category,
          needsAttention: !recoverable,
          nextCheckAt: recoverable
            ? new Date(this.now().getTime() + this.delayFor(r.checks))
            : null,
        },
      });
      return 'pending';
    }
    this.log(context).info(
      {
        reservation: { provider: r.provider, operation: 'cancel', outcome: outcome.status },
        durationMs: Math.round(performance.now() - started),
      },
      'Cancellation call finished',
    );
    return this.applyCancellation(r, outcome, ops, { type: 'PROVIDER', id: r.provider }, context);
  }

  private async applyCancellation(
    r: ReservationRow,
    outcome: CancellationOutcome,
    ops: SupplierReservations | null,
    actor: { type: Actor; id: string | null },
    context: CallContext,
  ): Promise<'cancelled' | 'pending'> {
    const now = this.now();
    const supplier = this.supplierName(r.provider);
    if (outcome.status === 'pending') {
      const lookup = Boolean(ops?.lookup);
      await this.prisma.supplierReservation.updateMany({
        where: { id: r.id, status: 'CANCELLATION_PENDING' },
        data: {
          ambiguous: false,
          needsAttention: !lookup,
          nextCheckAt: lookup ? new Date(now.getTime() + this.delayFor(r.checks)) : null,
        },
      });
      return 'pending';
    }
    if (outcome.status === 'rejected') {
      const category: ReservationErrorCategory =
        outcome.reason === 'not-cancellable' ? 'NOT_CANCELLABLE' : 'REJECTED';
      await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, r.bookingId);
        const moved = await this.move(
          tx,
          r,
          'CONFIRMED',
          { ambiguous: false, nextCheckAt: null, errorCategory: category },
          {
            actorType: actor.type,
            note: 'The supplier refused the cancellation; the booking stays confirmed.',
            errorCategory: category,
            requestId: context.requestId ?? null,
          },
        );
        if (moved) await this.audit(tx, r, 'reservation.cancellation_refused', actor, context);
      });
      throw new AppError(
        'BOOKING_NOT_CANCELLABLE',
        `${supplier} refused to cancel this booking, so it stays confirmed. Contact ${supplier} about its own terms.`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, r.bookingId);
      const moved = await this.move(
        tx,
        r,
        'CANCELLED',
        {
          cancelledAt: now,
          cancellationReference: outcome.cancellationReference,
          ambiguous: false,
          nextCheckAt: null,
          errorCategory: null,
          needsAttention: false,
        },
        {
          actorType: actor.type,
          note:
            actor.type === 'ADMIN'
              ? 'Cancelled: recorded by Wayora staff after checking with the supplier.'
              : 'The supplier confirmed the cancellation.',
          requestId: context.requestId ?? null,
        },
      );
      if (!moved) return;
      const cancelled = await transitionBooking(tx, now, r.bookingId, 'CONFIRMED', 'CANCELLED', {
        actorType: actor.type,
        note: `Cancellation confirmed by ${supplier}.`.slice(0, 255),
      });
      if (!cancelled) throw new Error('Booking was not confirmed when its cancellation was.');
      await notify(tx, now, {
        ...messages.supplierBookingCancelled(r.booking.reference, supplier),
        userId: r.booking.userId,
        isDemo: false,
        bookingId: r.bookingId,
        dedupeKey: `booking:${r.bookingId}:CANCELLED`,
      });
      await this.audit(tx, r, 'reservation.cancelled', actor, context);
    });
    return 'cancelled';
  }

  private async checkCancellation(r: ReservationRow, context: CallContext): Promise<void> {
    const ops = this.operationsFor(r.provider);
    if (!ops) {
      await this.attention(r, 'UNAVAILABLE', 'supplier connection is switched off', context);
      return;
    }
    if (!ops.lookup) {
      await this.attention(r, null, 'cancellation outcome unknown and no lookup', context);
      return;
    }
    const outcome = await this.lookup(r, ops, context);
    if ('error' in outcome) {
      await this.reschedule(r, outcome.error, context);
      return;
    }
    const current = { ...r, checks: r.checks + 1 };
    switch (outcome.status) {
      case 'cancelled':
        await this.applyCancellation(
          current,
          { status: 'cancelled', cancellationReference: outcome.cancellationReference },
          ops,
          { type: 'PROVIDER', id: r.provider },
          context,
        );
        return;
      case 'confirmed':
        // The cancellation didn't take. Cancelling can't create anything, so
        // it is asked again (same key), a bounded number of times.
        if (ops.cancel && r.cancelAttempts < this.policy.maxResends) {
          await this.prisma.supplierReservation.update({
            where: { id: r.id },
            data: { cancelAttempts: { increment: 1 }, lastAttemptAt: this.now() },
          });
          await this.sendCancellation(
            { ...current, cancelAttempts: r.cancelAttempts + 1 },
            ops,
            context,
          ).catch((error: unknown) => {
            if (!(error instanceof AppError)) throw error;
          });
          return;
        }
        await this.attention(r, null, 'supplier still shows it confirmed', context);
        return;
      case 'pending':
        await this.reschedule(r, null, context);
        return;
      default:
        await this.attention(
          r,
          'INVALID_RESPONSE',
          `unexpected lookup answer ${outcome.status}`,
          context,
        );
    }
  }

  // ─── Staff (admin) ────────────────────────────────────────────────────

  /** What staff may do with this reservation now (admin.reservations.manage). */
  adminActions(r: {
    provider: string;
    status: ReservationStatus;
    needsAttention: boolean;
    ambiguous: boolean;
  }): { recheck: boolean; resolve: boolean } {
    const open = ['IN_PROGRESS', 'UNKNOWN', 'CANCELLATION_PENDING'].includes(r.status);
    return {
      // A read-only lookup only: staff can never make Wayora send another reservation.
      recheck: open && Boolean(this.operationsFor(r.provider)?.lookup),
      resolve: open && (r.needsAttention || r.ambiguous),
    };
  }

  /** Staff: one status lookup now, whatever the schedule. Never sends a reservation. */
  async adminRecheck(
    bookingId: string,
    admin: { id: string },
    context: CallContext = {},
  ): Promise<void> {
    const r = await this.prisma.supplierReservation.findUnique({
      where: { bookingId },
      include: reservationInclude,
    });
    if (!r || !this.adminActions(r).recheck) {
      throw new AppError('CONFLICT', 'This reservation can’t be rechecked now.');
    }
    await this.prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'reservation.recheck_requested',
        entityType: 'booking',
        entityId: r.bookingId,
        requestId: context.requestId ?? null,
        metadata: { reference: r.booking.reference, provider: r.provider, status: r.status },
      },
    });
    const ops = this.operationsFor(r.provider)!;
    const now = this.now();
    const leased = await this.prisma.supplierReservation.updateMany({
      where: { id: r.id, status: r.status },
      data: { nextCheckAt: this.leaseUntil(now), needsAttention: false },
    });
    if (leased.count !== 1) return;
    const current = { ...r, needsAttention: false };
    if (r.status === 'CANCELLATION_PENDING') {
      await this.checkCancellation(current, context);
      return;
    }
    // Lookup only (never a resend), whatever the supplier's idempotency.
    const outcome = await this.lookup(current, ops, context);
    if ('error' in outcome) {
      await this.reschedule(current, outcome.error, context);
      return;
    }
    if (outcome.status === 'not-found') {
      await this.reschedule(current, 'NOT_FOUND', context);
      return;
    }
    await this.applyOutcome(
      { ...current, checks: r.checks + 1 },
      outcome,
      ops,
      { type: 'PROVIDER', id: r.provider },
      context,
    );
  }

  /**
   * Staff: records the outcome they confirmed with the supplier, for a
   * reservation automatic recovery couldn't settle. Sends nothing.
   */
  async adminResolve(
    bookingId: string,
    input: AdminReservationResolve,
    admin: { id: string },
    context: CallContext = {},
  ): Promise<void> {
    const r = await this.prisma.supplierReservation.findUnique({
      where: { bookingId },
      include: reservationInclude,
    });
    if (!r || !this.adminActions(r).resolve) {
      throw new AppError('CONFLICT', 'This reservation has no open question to resolve.');
    }
    const cancelling = r.status === 'CANCELLATION_PENDING';
    const allowed = cancelling ? ['cancelled', 'confirmed'] : ['confirmed', 'failed'];
    if (!allowed.includes(input.outcome)) {
      throw new AppError(
        'CONFLICT',
        cancelling
          ? 'A pending cancellation resolves as cancelled, or confirmed (the supplier kept it).'
          : 'A pending reservation resolves as confirmed or failed.',
      );
    }
    const actor = { type: 'ADMIN' as const, id: admin.id };
    // The reason stays in the audit log (staff-only), never in the traveller's history.
    await this.prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'reservation.resolved_manually',
        entityType: 'booking',
        entityId: r.bookingId,
        requestId: context.requestId ?? null,
        metadata: {
          reference: r.booking.reference,
          provider: r.provider,
          from: r.status,
          outcome: input.outcome,
          reason: input.reason,
        },
      },
    });
    if (cancelling) {
      if (input.outcome === 'cancelled') {
        await this.applyCancellation(
          r,
          { status: 'cancelled', cancellationReference: null },
          null,
          actor,
          context,
        );
        return;
      }
      if (input.outcome === 'confirmed' && input.supplierReference.trim() !== r.supplierReference) {
        throw new AppError('CONFLICT', 'That isn’t the supplier reference on record for it.');
      }
      await this.applyCancellation(
        r,
        { status: 'rejected', reason: 'other' },
        null,
        actor,
        context,
      ).catch((error: unknown) => {
        if (!(error instanceof AppError)) throw error;
      });
      return;
    }
    if (input.outcome === 'confirmed') {
      await this.confirm(
        r,
        {
          status: 'confirmed',
          supplierReference: input.supplierReference.trim(),
          price: null,
          documents: [],
        },
        actor,
        context,
      );
      const after = await this.prisma.supplierReservation.findUnique({
        where: { id: r.id },
        select: { status: true },
      });
      if (after?.status !== 'CONFIRMED') {
        throw new AppError(
          'CONFLICT',
          'That supplier reference already belongs to another booking.',
        );
      }
      return;
    }
    await this.applyOutcome(r, { status: 'rejected', reason: 'other' }, null, actor, context);
  }
}
