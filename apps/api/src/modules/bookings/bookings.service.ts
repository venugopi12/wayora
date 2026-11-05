import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import {
  BOOKING_REFERENCE_ALPHABET,
  bookingRequirementsFor,
  offerTravelDates,
  type Booking,
  type BookingCancellation,
  type BookingDocuments,
  type BookingRefund,
  type BookingReservation,
  type ReservationState,
  type BookingListQuery,
  type BookingPayment,
  type BookingListResponse,
  type BookingStatus,
  type BookingSummary,
  type BookingView,
  type createBookingRequestSchema,
  DEMO_PAYMENT_SCENARIOS,
  type OfferResponse,
} from '@wayora/contracts';
import {
  Prisma,
  type BookingStatus as DbBookingStatus,
  type PrismaClient,
  type ReservationStatus as DbReservationStatus,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { messages, notify } from '../notifications/notify.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { pricesEqual, type CallContext, type SearchService } from '../search/search.service.js';
import { IdempotencyService, requestHash } from './idempotency.js';
import type { ReservationService } from './reservations.service.js';
import { bookingSnapshotSchema, type BookingSnapshot } from './snapshot.js';
import {
  AWAITING_PAYMENT_NOTE,
  DEMO_CANCELLATION_NOTE,
  DEMO_CONFIRMATION_NOTE,
  DEMO_PAID_CANCELLATION_NOTE,
  TRANSITIONS,
  lockBooking,
  transitionBooking,
} from './lifecycle.js';
import { CATEGORY } from '../../utils/categories.js';
import { errorForLog } from '../search/errors.js';

export { DEMO_CANCELLATION_NOTE, DEMO_CONFIRMATION_NOTE, TRANSITIONS } from './lifecycle.js';

/*
 * Bookings (docs/bookings.md).
 *
 * - Demo bookings: Wayora records the booking and simulates its
 *   confirmation; no supplier is contacted and nothing is ticketed. Since
 *   Phase 13 a booking may first need a demo payment (docs/payments.md).
 * - Supplier bookings (Phase 23): only when SUPPLIER_RESERVATIONS_ENABLED is
 *   on and the offer's provider implements reservations (none real yet).
 *   The booking is recorded with its reservation, committed, and only then
 *   sent to the supplier (reservations.service.ts); it is confirmed only when
 *   the supplier confirms.
 *
 * This service stays the owner of the booking lifecycle (bookings/lifecycle.ts).
 */

export type CreateBookingInput = z.output<typeof createBookingRequestSchema>;

const API_STATUS: Record<DbBookingStatus, BookingStatus> = {
  PENDING: 'pending',
  HELD: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

const ACTIVE: DbBookingStatus[] = ['PENDING', 'CONFIRMED'];

/** Travel dates are local dates; every demo place is in India, so "today" is today in India. */
export const BOOKING_CALENDAR_TIME_ZONE = 'Asia/Kolkata';

/**
 * WYD-XXXX-XXXX (demo) or WY-XXXX-XXXX (supplier booking) from the
 * unambiguous alphabet, with a CSPRNG. Wayora's own reference, never a
 * supplier's.
 */
export function newBookingReference(kind: 'demo' | 'supplier' = 'demo'): string {
  const pick = () => BOOKING_REFERENCE_ALPHABET[randomInt(BOOKING_REFERENCE_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${kind === 'demo' ? 'WYD' : 'WY'}-${group()}-${group()}`;
}

export { bookingSnapshotSchema } from './snapshot.js';
type Snapshot = BookingSnapshot;

const toDate = (isoDate: string | null) => (isoDate ? new Date(`${isoDate}T00:00:00Z`) : null);
const fromDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export const NOT_FOUND_MESSAGE = "We couldn't find that booking.";

const paymentsSelect = {
  payments: {
    select: { id: true, status: true, refundRequired: true },
    orderBy: { attempt: 'desc' },
  },
  // Rewards set against it at checkout (Phase 25): the amount due is the total minus these.
  rewardRedemptions: {
    where: { status: { in: ['APPLIED', 'CONSUMED'] } },
    select: { status: true, points: true, totalAmountMinor: true, currency: true },
  },
  reservation: {
    select: {
      id: true,
      provider: true,
      status: true,
      supplierReference: true,
      confirmedAt: true,
      errorCategory: true,
      ambiguous: true,
      needsAttention: true,
      nextCheckAt: true,
    },
  },
} satisfies Prisma.BookingInclude;
const bookingInclude = {
  travellers: { orderBy: { position: 'asc' } },
  events: { orderBy: [{ createdAt: 'asc' }, { fromStatus: { sort: 'asc', nulls: 'first' } }] },
  documents: { orderBy: [{ issuedAt: 'asc' }, { type: 'asc' }, { reference: 'asc' }] },
  refunds: {
    select: { status: true, mode: true, amountMinor: true, currency: true },
    orderBy: { createdAt: 'desc' },
  },
  ...paymentsSelect,
} satisfies Prisma.BookingInclude;
type BookingRow = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;
type BookingSummaryRow = Prisma.BookingGetPayload<{ include: typeof paymentsSelect }>;

export interface BookingsServiceOptions {
  prisma: PrismaClient;
  search: SearchService;
  registry: ProviderRegistry;
  logger: Logger;
  now?: () => Date;
  /** Reference generator (tests inject collisions). */
  newReference?: () => string;
  /** Payments (Phase 13). Without it, every booking is payment mode NONE (Phase 12 behaviour). */
  payments?: PaymentsService;
  /** Supplier reservations (Phase 23). Without it, supplier offers can't be booked. */
  reservations?: ReservationService;
  /** SUPPLIER_RESERVATIONS_ENABLED. */
  supplierReservationsEnabled?: boolean;
}

const RESERVATION_STATE: Record<DbReservationStatus, ReservationState> = {
  PENDING: 'requested',
  IN_PROGRESS: 'in-progress',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  CANCELLATION_PENDING: 'cancellation-pending',
  CANCELLED: 'cancelled',
};

/** Why a supplier didn't reserve it, in Wayora's words. */
const FAILURE_REASON: Partial<Record<string, string>> = {
  OFFER_UNAVAILABLE: 'the offer was no longer available',
  PRICE_CHANGED: 'its price had changed',
  INVALID_DETAILS: 'it didn’t accept the booking details',
  NOT_FOUND: 'it has no record of the request',
  UNAVAILABLE: 'the supplier connection was switched off, so nothing was sent',
};

export class BookingsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  private readonly newReference: () => string;
  readonly idempotency: IdempotencyService;

  constructor(private readonly options: BookingsServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
    this.newReference = options.newReference ?? newBookingReference;
    this.idempotency = new IdempotencyService(options.prisma, this.now);
  }

  private log(context: CallContext): Logger {
    return context.requestId
      ? this.options.logger.child({ requestId: context.requestId })
      : this.options.logger;
  }

  /** Today's date where the travel happens (see BOOKING_CALENDAR_TIME_ZONE). */
  today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_CALENDAR_TIME_ZONE }).format(
      this.now(),
    );
  }

  // ─── Create ─────────────────────────────────────────────────────────────

  /**
   * Creates a demo booking, at most once per idempotency key. `rawBody` is
   * the request as sent (its hash identifies the request); `input` is the
   * validated version.
   */
  async create(
    userId: string,
    input: CreateBookingInput,
    rawBody: unknown,
    key: string,
    context: CallContext = {},
  ): Promise<{ status: number; booking: Booking; replayed: boolean }> {
    const claim = await this.idempotency.claim<{ reference: string }>({
      operation: 'POST /bookings',
      userId,
      key,
      hash: requestHash(rawBody),
    });
    if (claim.kind === 'replay') {
      return {
        status: claim.status,
        booking: await this.get(userId, claim.body.reference),
        replayed: true,
      };
    }
    try {
      const reference = await this.createBooking(userId, input, claim, context);
      return { status: 201, booking: await this.get(userId, reference), replayed: false };
    } catch (error) {
      await this.idempotency.release(claim);
      throw error;
    }
  }

  /**
   * Whether a supplier offer from this provider can be booked now: the
   * switch is on, its adapter implements reservations, and its breaker isn't
   * open. Throws the reason otherwise; nothing is recorded.
   */
  private assertSupplierBookable(providerId: string): void {
    const reservations = this.options.reservations;
    if (!this.options.supplierReservationsEnabled || !reservations?.operationsFor(providerId)) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Booking this offer isn’t available yet.');
    }
    if (this.options.search.breakerStates().get(providerId) === 'open') {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'This supplier isn’t answering right now, so nothing was booked. Try again in a few minutes.',
      );
    }
  }

  /** How an offer can be booked now (for the offer page). */
  bookingAvailability(result: { source: string; providerId: string }): {
    available: boolean;
    kind: 'demo' | 'supplier';
    reason: string | null;
  } {
    if (result.source === 'demo') return { available: true, kind: 'demo', reason: null };
    try {
      this.assertSupplierBookable(result.providerId);
      return { available: true, kind: 'supplier', reason: null };
    } catch (error) {
      return {
        available: false,
        kind: 'supplier',
        reason:
          error instanceof AppError && error.code === 'PROVIDER_UNAVAILABLE'
            ? error.message
            : 'Booking supplier offers on Wayora isn’t available for this supplier.',
      };
    }
  }

  private async createBooking(
    userId: string,
    input: CreateBookingInput,
    claim: { scope: string; key: string },
    context: CallContext,
  ): Promise<string> {
    const log = this.log(context);
    if (input.acceptDemoTerms !== true && input.acceptSupplierTerms !== true) {
      throw new AppError('VALIDATION_FAILED', 'The request is invalid.', {
        details: [
          {
            path: 'body.acceptDemoTerms',
            message: 'Confirm the booking terms.',
            code: 'required',
          },
        ],
      });
    }
    // 1. The offer, from the server's search session only (Phase 11 checks:
    //    expiry, category, membership, integrity, and revalidation if supported).
    const offer: OfferResponse = await this.options.search.offer(
      input.serviceType,
      input.searchId,
      input.offerId,
      context,
    );
    const result = offer.result;
    const supplier = result.source !== 'demo';
    // Supplier offers need a provider that implements reservations (none real yet).
    if (supplier) this.assertSupplierBookable(result.providerId);
    if (result.price === null) {
      throw new AppError('BAD_REQUEST', "This offer has no price, so it can't be booked.");
    }
    if (supplier && result.price.kind !== 'total') {
      throw new AppError(
        'BAD_REQUEST',
        'This offer’s price is an estimate, so it can’t be reserved.',
      );
    }
    // 2. The price is the server's. The visitor's accepted price is only compared.
    if (!pricesEqual(input.acceptedPrice, result.price)) {
      throw new AppError(
        'PRICE_CHANGED',
        offer.validation.status === 'price-changed'
          ? 'The price has changed since you searched. Review the new price and confirm again.'
          : "The price you confirmed doesn't match this offer. Review the offer and confirm again.",
      );
    }
    // 3. The details this category needs, from the offer contract.
    const requirements = bookingRequirementsFor(result);
    const issues: { path: string; message: string; code: string }[] = [];
    const named = requirements.namedTravellers.length;
    if (input.travellers.length !== named) {
      issues.push({
        path: 'body.travellers',
        message:
          named === 0
            ? 'This booking needs no traveller names.'
            : `Enter ${named === 1 ? 'one name' : `${named} names`} for this booking.`,
        code: 'invalid_length',
      });
    }
    const phone = input.contactPhone ?? null;
    if (requirements.contactPhone === 'required' && !phone) {
      issues.push({
        path: 'body.contactPhone',
        message: 'Enter a mobile number.',
        code: 'required',
      });
    }
    if (requirements.contactPhone === 'not-needed' && phone) {
      // Not stored when not needed: leave it out.
      issues.push({
        path: 'body.contactPhone',
        message: 'This booking doesn’t need a phone number.',
        code: 'unexpected',
      });
    }
    // The terms that apply to this kind of booking.
    if (supplier && input.acceptSupplierTerms !== true) {
      issues.push({
        path: 'body.acceptSupplierTerms',
        message: 'Confirm that you understand how this supplier booking works.',
        code: 'required',
      });
    }
    if (!supplier && input.acceptDemoTerms !== true) {
      issues.push({
        path: 'body.acceptDemoTerms',
        message: 'Confirm that you understand this is a demo booking.',
        code: 'required',
      });
    }
    if (issues.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'The request is invalid.', { details: issues });
    }

    // 4. The booking, its people and history, the audit entry and the
    //    idempotency outcome: all in one transaction.
    const { startsOn, endsOn } = offerTravelDates(result);
    const price = result.price;
    // How it is paid: a demo payment when payments are on and the price is an
    // exact total; estimate ranges (cabs) can't be charged, so they are NONE.
    const policy = this.options.payments?.policy;
    // Supplier bookings take no payment on Wayora: the traveller pays the
    // supplier under its terms (providers/reservations.ts, `settlement`).
    const paymentMode = !supplier && policy?.provider && price.kind === 'total' ? 'DEMO' : 'NONE';
    const snapshot: Snapshot = {
      v: 1,
      offer: result,
      providerName:
        this.options.registry.find(result.providerId)?.provider.name ?? result.providerId,
      priceCheck: offer.validation.status,
      searchGeneratedAt: offer.generatedAt,
      searchExpiresAt: offer.expiresAt,
    };
    for (let attempt = 1; ; attempt += 1) {
      const reference = supplier ? newBookingReference('supplier') : this.newReference();
      let reservationId: string | null = null;
      try {
        await this.prisma.$transaction(async (tx) => {
          const now = this.now();
          const booking = await tx.booking.create({
            data: {
              reference,
              userId,
              category: CATEGORY[result.serviceType],
              status: 'PENDING',
              isDemo: !supplier,
              provider: result.providerId,
              searchId: offer.searchId,
              offerSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              partySize: requirements.partySize,
              startsOn: toDate(startsOn),
              endsOn: toDate(endsOn),
              contactPhone: requirements.contactPhone === 'required' ? phone : null,
              currency: price.kind === 'total' ? price.total.currency : price.min.currency,
              totalAmountMinor: price.kind === 'total' ? BigInt(price.total.amountMinor) : null,
              paymentMode,
              paymentDueAt:
                paymentMode === 'DEMO' ? new Date(now.getTime() + policy!.windowMs) : null,
              createdAt: now,
              travellers: {
                create: input.travellers.map((t, position) => ({
                  position,
                  type: requirements.namedTravellers[position]?.type?.toUpperCase() as
                    'ADULT' | 'CHILD' | 'INFANT' | undefined,
                  firstName: t.firstName,
                  lastName: t.lastName,
                })),
              },
              events: {
                create: {
                  fromStatus: null,
                  toStatus: 'PENDING',
                  actorType: 'USER',
                  note: supplier
                    ? `Reservation requested from ${snapshot.providerName}; not confirmed until it confirms.`.slice(
                        0,
                        255,
                      )
                    : paymentMode === 'DEMO'
                      ? AWAITING_PAYMENT_NOTE
                      : 'Demo booking requested.',
                  createdAt: now,
                },
              },
            },
          });
          if (supplier) {
            // Recorded with the booking; sent only after this commits.
            reservationId = await this.options.reservations!.record(
              tx,
              now,
              { id: booking.id, provider: result.providerId },
              context,
            );
            await notify(tx, now, {
              ...messages.supplierBookingRequested(reference, snapshot.providerName),
              userId,
              isDemo: false,
              bookingId: booking.id,
              dedupeKey: `booking:${booking.id}:CREATED`,
            });
          }
          // Without a payment step, the demo confirmation follows at once;
          // with one, it waits for the demo payment (payments/events.ts).
          if (!supplier && paymentMode === 'NONE') {
            await transitionBooking(tx, now, booking.id, 'PENDING', 'CONFIRMED', {
              actorType: 'SYSTEM',
              note: DEMO_CONFIRMATION_NOTE,
            });
          }
          // One notification for what happened (created-and-confirmed is one event).
          const dueAt = paymentMode === 'DEMO' ? new Date(now.getTime() + policy!.windowMs) : null;
          if (!supplier) {
            await notify(tx, now, {
              ...(dueAt
                ? messages.bookingAwaitingPayment(reference, dueAt)
                : messages.bookingConfirmed(reference)),
              userId,
              isDemo: true,
              bookingId: booking.id,
              dedupeKey: `booking:${booking.id}:${dueAt ? 'CREATED' : 'CONFIRMED'}`,
            });
          }
          await tx.auditLog.create({
            data: {
              actorType: 'USER',
              actorId: userId,
              action: 'booking.created',
              entityType: 'booking',
              entityId: booking.id,
              requestId: context.requestId ?? null,
              metadata: {
                reference,
                category: CATEGORY[result.serviceType],
                provider: result.providerId,
                paymentMode,
                demo: !supplier,
              },
            },
          });
          // A repeat of this request now returns this booking: the supplier
          // is never asked twice for one request.
          await this.idempotency.complete(tx, claim, { status: 201, body: { reference } });
        });
        log.info(
          {
            booking: {
              reference,
              serviceType: result.serviceType,
              providerId: result.providerId,
              partySize: requirements.partySize,
              paymentMode,
              demo: !supplier,
            },
          },
          supplier ? 'Supplier booking recorded' : 'Demo booking created',
        );
        if (reservationId) {
          // Never fails the request: the booking exists and shows its state.
          await this.options
            .reservations!.submit(reservationId, context)
            .catch((error: unknown) => {
              log.error(
                { err: errorForLog(error) },
                'Sending the reservation failed; recovery will retry',
              );
            });
        }
        return reference;
      } catch (error) {
        // The only unique key a new booking can hit is its reference: draw another.
        if (isUniqueViolation(error) && attempt < 3) {
          log.warn({ attempt }, 'Booking reference collision; retrying');
          continue;
        }
        throw error;
      }
    }
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /** One booking of this user. Another user's booking is "not found", never "forbidden". */
  async get(userId: string, reference: string): Promise<Booking> {
    await this.expireOverdue({ userId });
    const find = () =>
      this.prisma.booking.findFirst({ where: { reference, userId }, include: bookingInclude });
    let row = await find();
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    // A supplier reservation whose scheduled check is due is checked now
    // (the schedule bounds how often a read can reach the supplier).
    const r = row.reservation;
    if (
      r &&
      this.options.reservations &&
      !r.needsAttention &&
      ['PENDING', 'IN_PROGRESS', 'UNKNOWN', 'CANCELLATION_PENDING'].includes(r.status) &&
      r.nextCheckAt !== null &&
      r.nextCheckAt.getTime() <= this.now().getTime()
    ) {
      await this.options.reservations.reconcileOne(r.id).catch((error: unknown) => {
        this.options.logger.warn({ err: errorForLog(error) }, 'Reservation check on read failed');
      });
      row = (await find())!;
    }
    return this.present(row);
  }

  /** Bookings past their payment window become EXPIRED before they are shown. */
  private async expireOverdue(filter: { userId: string }): Promise<void> {
    await this.options.payments?.expireOverdueBookings(filter);
  }

  private viewWhere(view: BookingView, today: Date): Prisma.BookingWhereInput {
    if (view === 'cancelled') return { status: { in: ['CANCELLED', 'FAILED', 'EXPIRED'] } };
    // Spelled out both ways (never NOT(...)): with SQL's three-valued logic a
    // booking without dates (metro) would otherwise fall out of both views.
    if (view === 'past') {
      return {
        status: { in: ACTIVE },
        OR: [{ endsOn: { lt: today } }, { endsOn: null, startsOn: { lt: today } }],
      };
    }
    return {
      status: { in: ACTIVE },
      OR: [
        { endsOn: { gte: today } },
        { endsOn: null, startsOn: { gte: today } },
        { endsOn: null, startsOn: null },
      ],
    };
  }

  async list(userId: string, query: Required<BookingListQuery>): Promise<BookingListResponse> {
    const today = toDate(this.today())!;
    const views: BookingView[] = ['upcoming', 'past', 'cancelled'];
    const order: Record<BookingView, Prisma.BookingOrderByWithRelationInput[]> = {
      upcoming: [{ startsOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      past: [{ startsOn: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      cancelled: [{ cancelledAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    };
    const view = query.view as BookingView;
    const page = Number(query.page);
    const pageSize = Number(query.pageSize);
    await this.expireOverdue({ userId });
    const [rows, ...counts] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where: { userId, ...this.viewWhere(view, today) },
        orderBy: order[view],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: paymentsSelect,
      }),
      ...views.map((v) =>
        this.prisma.booking.count({ where: { userId, ...this.viewWhere(v, today) } }),
      ),
    ]);
    const countByView = Object.fromEntries(views.map((v, i) => [v, counts[i]!])) as Record<
      BookingView,
      number
    >;
    const total = countByView[view];
    return {
      view,
      items: rows.map((row) => this.presentSummary(row)),
      pagination: { page, pageSize, totalResults: total, totalPages: Math.ceil(total / pageSize) },
      counts: countByView,
    };
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────

  /** Why a booking can't be cancelled now, or null if it can. */
  private cancellationBlocker(row: {
    status: DbBookingStatus;
    startsOn: Date | null;
    isDemo: boolean;
    provider: string | null;
    reservation: { status: DbReservationStatus } | null;
  }): string | null {
    if (row.status === 'CANCELLED') return 'This booking is already cancelled.';
    if (row.status === 'EXPIRED') return 'This booking expired before it was paid.';
    if (!row.isDemo) {
      // Supplier bookings: only a confirmed reservation, through a supplier that can cancel.
      if (row.reservation?.status === 'CANCELLATION_PENDING') {
        return 'Cancellation is already requested; waiting for the supplier to confirm it.';
      }
      if (row.status !== 'CONFIRMED' || row.reservation?.status !== 'CONFIRMED') {
        return row.status === 'FAILED'
          ? 'Nothing was reserved, so there is nothing to cancel.'
          : 'The supplier hasn’t confirmed this booking yet, so it can’t be cancelled. If it doesn’t confirm it, nothing is reserved.';
      }
      if (!row.provider || !this.options.reservations?.canCancel(row.provider)) {
        return 'Cancelling this booking isn’t available through Wayora. Contact the supplier with its reference, under its own terms.';
      }
    }
    if (!TRANSITIONS[row.status].includes('CANCELLED')) {
      return "This booking can't be cancelled in its current state.";
    }
    if (row.startsOn && fromDate(row.startsOn)! < this.today()) {
      return 'This trip has already started, so it can’t be cancelled.';
    }
    return null;
  }

  async cancel(userId: string, reference: string, context: CallContext = {}): Promise<Booking> {
    await this.expireOverdue({ userId });
    const found = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: {
        id: true,
        status: true,
        startsOn: true,
        isDemo: true,
        provider: true,
        reservation: { select: { status: true } },
      },
    });
    if (!found) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    const firstBlocker = this.cancellationBlocker(found);
    if (firstBlocker) throw new AppError('BOOKING_NOT_CANCELLABLE', firstBlocker);
    if (!found.isDemo) {
      // The supplier decides; the booking stays confirmed until it confirms.
      await this.options.reservations!.requestCancellation(
        found.id,
        { type: 'USER', id: userId },
        context,
      );
      return this.get(userId, reference);
    }
    // A payment still in progress is cancelled first (best effort); if it
    // settles anyway, the payment rules handle it (docs/payments.md#late-success).
    await this.options.payments?.cancelActiveForBooking(found.id, context);

    const refundsToSend = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, found.id);
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: {
          id: true,
          status: true,
          startsOn: true,
          isDemo: true,
          provider: true,
          reservation: { select: { status: true } },
        },
      });
      const blocker = this.cancellationBlocker(row);
      if (blocker) throw new AppError('BOOKING_NOT_CANCELLABLE', blocker);
      // A paid demo booking: the payment would be owed back. The demo provider
      // can't refund (nothing was taken), so it is flagged, never "refunded".
      const paid = await tx.payment.updateMany({
        where: { bookingId: row.id, status: 'SUCCEEDED' },
        data: { refundRequired: true },
      });
      // The refunds themselves (Phase 23): requested from providers that can
      // refund, otherwise recorded as owed (the demo provider took nothing).
      const refundIds = (await this.options.payments?.openRefunds(tx, this.now(), row.id)) ?? [];
      const changed = await transitionBooking(tx, this.now(), row.id, row.status, 'CANCELLED', {
        actorType: 'USER',
        note: paid.count > 0 ? DEMO_PAID_CANCELLATION_NOTE : DEMO_CANCELLATION_NOTE,
      });
      // Lost a race with another cancellation: report the state it ended in.
      if (!changed)
        throw new AppError('BOOKING_NOT_CANCELLABLE', 'This booking is already cancelled.');
      await notify(tx, this.now(), {
        ...messages.bookingCancelled(reference, paid.count > 0),
        userId,
        isDemo: true,
        bookingId: row.id,
        dedupeKey: `booking:${row.id}:CANCELLED`,
      });
      await tx.auditLog.create({
        data: {
          actorType: 'USER',
          actorId: userId,
          action: 'booking.cancelled',
          entityType: 'booking',
          entityId: row.id,
          requestId: context.requestId ?? null,
          metadata: { reference, from: row.status, refundRequired: paid.count > 0, demo: true },
        },
      });
      return refundIds;
    });
    this.log(context).info({ booking: { reference } }, 'Demo booking cancelled');
    for (const id of refundsToSend) await this.options.payments?.sendRefund(id, context);
    // Rewards used on it go back; earned points are taken back (Phase 25).
    await this.options.payments?.settled(found.id);
    return this.get(userId, reference);
  }

  // ─── Presentation ───────────────────────────────────────────────────────

  private snapshot(row: BookingSummaryRow): Snapshot {
    const parsed = bookingSnapshotSchema.safeParse(row.offerSnapshot);
    if (!parsed.success) {
      // The column is write-once and validated on write: this means corruption.
      this.options.logger.error({ bookingId: row.id }, 'Stored booking snapshot is invalid');
      throw new AppError('INTERNAL_ERROR', 'This booking could not be read.');
    }
    return parsed.data;
  }

  private presentSummary(row: BookingSummaryRow): BookingSummary {
    const snapshot = this.snapshot(row);
    return {
      reference: row.reference,
      status: API_STATUS[row.status],
      demo: row.isDemo,
      serviceType: snapshot.offer.serviceType,
      offer: snapshot.offer,
      providerName: snapshot.providerName,
      price: snapshot.offer.price,
      partySize: row.partySize,
      startsOn: fromDate(row.startsOn),
      endsOn: fromDate(row.endsOn),
      createdAt: row.createdAt.toISOString(),
      cancellable: this.cancellationBlocker(row) === null,
      payment: this.presentPayment(row),
      reservation: this.presentReservation(row, snapshot.providerName),
    };
  }

  /** The supplier side, in Wayora's words (docs/bookings.md#supplier-reservations). */
  private presentReservation(row: BookingSummaryRow, supplier: string): BookingReservation {
    const r = row.reservation;
    if (row.isDemo || !r) {
      return {
        kind: 'demo',
        state: null,
        supplierReference: null,
        confirmedAt: null,
        priceMismatch: false,
        needsAttention: false,
        explanation: 'Demo booking: no supplier reservation was made.',
      };
    }
    const state = RESERVATION_STATE[r.status];
    const priceMismatch = r.errorCategory === 'PRICE_MISMATCH';
    const team = r.needsAttention
      ? ` Our team is confirming it with ${supplier} directly; nothing else is sent until then.`
      : '';
    const explanation = {
      requested: `Recorded by Wayora and being sent to ${supplier}.${team}`,
      'in-progress': `Sent to ${supplier}, waiting for its confirmation. Nothing is confirmed until ${supplier} confirms it.${team}`,
      unknown: `${supplier} didn’t give a clear answer, so Wayora is checking whether it reserved it. Wayora won’t send another request until it knows.${team}`,
      confirmed: priceMismatch
        ? `${supplier} confirmed this reservation, at a price different from the one you booked. Our team will contact you about it.`
        : `${supplier} confirmed this reservation.`,
      failed: `${supplier} didn’t reserve it${
        r.errorCategory && FAILURE_REASON[r.errorCategory]
          ? ` (${FAILURE_REASON[r.errorCategory]})`
          : ''
      }, so nothing is booked. Wayora took no payment.`,
      'cancellation-pending': `You asked ${supplier} to cancel it. It stays confirmed until ${supplier} confirms the cancellation.${team}`,
      cancelled: `${supplier} confirmed the cancellation.`,
    }[state];
    return {
      kind: 'supplier',
      state,
      // Only a reference the supplier gave, and only once it confirmed.
      supplierReference: ['confirmed', 'cancellation-pending', 'cancelled'].includes(state)
        ? r.supplierReference
        : null,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      priceMismatch,
      needsAttention: r.needsAttention,
      explanation,
    };
  }

  private presentDocuments(row: BookingRow, supplier: string): BookingDocuments {
    if (row.isDemo) {
      return {
        state: 'not-applicable',
        items: [],
        explanation: 'Demo booking: no ticket, voucher or PNR exists.',
      };
    }
    const confirmed = ['CONFIRMED', 'CANCELLATION_PENDING', 'CANCELLED'].includes(
      row.reservation?.status ?? '',
    );
    if (row.documents.length === 0) {
      return {
        state: 'none-issued',
        items: [],
        explanation: confirmed
          ? `${supplier} hasn’t issued a ticket or voucher through Wayora. Use the supplier reference with ${supplier}.`
          : `A ticket or voucher can exist only after ${supplier} confirms the reservation.`,
      };
    }
    return {
      state: 'issued',
      items: row.documents.map((d) => {
        const t = d.travellerPosition === null ? undefined : row.travellers[d.travellerPosition];
        return {
          type: d.type.toLowerCase() as 'ticket' | 'voucher' | 'itinerary',
          reference: d.reference,
          travellerName: t ? `${t.firstName} ${t.lastName}` : null,
          issuedAt: d.issuedAt.toISOString(),
        };
      }),
      explanation: `Issued by ${supplier}.`,
    };
  }

  private presentCancellation(
    row: BookingRow,
    supplier: string,
    cancellable: boolean,
    snapshot: Snapshot,
  ): BookingCancellation {
    const offer = snapshot.offer;
    // Terms only from the supplier's own offer data (demo offers never carry any).
    const policy =
      offer.serviceType === 'hotels' && offer.source !== 'demo'
        ? (offer.cancellationPolicy ?? null)
        : null;
    const pending = row.reservation?.status === 'CANCELLATION_PENDING';
    if (row.status === 'CANCELLED') {
      return {
        available: false,
        state: 'cancelled',
        explanation: row.isDemo
          ? 'Cancelled. Only the booking’s status changed; no supplier was contacted.'
          : `Cancelled: ${supplier} confirmed it.`,
        policy,
      };
    }
    if (pending) {
      return {
        available: false,
        state: 'pending',
        explanation: `Waiting for ${supplier} to confirm the cancellation. The booking stays confirmed until it does.`,
        policy,
      };
    }
    let explanation: string;
    if (cancellable) {
      explanation = row.isDemo
        ? 'You can cancel this demo booking until the travel date. Only its status changes.'
        : `Cancelling asks ${supplier} to cancel it; it is cancelled only when ${supplier} confirms. Any refund of what you paid ${supplier} follows its terms.`;
    } else {
      explanation = this.cancellationBlocker(row) ?? 'This booking can’t be cancelled now.';
    }
    return { available: cancellable, state: 'not-requested', explanation, policy };
  }

  private presentRefund(row: BookingRow, supplier: string): BookingRefund {
    if (!row.isDemo) {
      return {
        state: 'not-applicable',
        amount: null,
        demo: false,
        explanation: `Wayora took no payment for this booking. Any refund of what you paid ${supplier} follows its terms.`,
      };
    }
    const refund = row.refunds[0];
    if (!refund) {
      const owed = row.payments.find((p) => p.refundRequired);
      return owed
        ? {
            state: 'required',
            amount: null,
            demo: true,
            explanation:
              'A refund would be owed, but this was a demo payment: no real money was charged, and the demo provider can’t refund.',
          }
        : {
            state: 'not-applicable',
            amount: null,
            demo: row.isDemo,
            explanation: 'Nothing was paid, so there is nothing to refund.',
          };
    }
    const demo = refund.mode === 'DEMO';
    const amount = { amountMinor: refund.amountMinor.toString(), currency: refund.currency };
    const explanation = {
      REQUIRED: demo
        ? 'A refund would be owed, but this was a demo payment: no real money was charged, and the demo provider can’t refund.'
        : 'A refund is owed. This payment provider can’t refund through Wayora, so our team handles it.',
      REQUESTED: 'A refund was requested from the payment provider.',
      PENDING: 'The payment provider is processing the refund.',
      SUCCEEDED: 'The payment provider confirmed the refund.',
      FAILED: 'The payment provider refused the refund. Our team will follow up.',
      UNKNOWN: 'The payment provider hasn’t answered clearly yet; Wayora is checking with it.',
    }[refund.status];
    return {
      state: refund.status.toLowerCase() as BookingRefund['state'],
      amount,
      demo,
      explanation,
    };
  }

  /** The money side of a booking (docs/payments.md#booking-and-payment). */
  private presentPayment(row: BookingSummaryRow): BookingPayment {
    const none: BookingPayment = {
      mode: 'none',
      state: 'not-required',
      amount: null,
      dueAt: null,
      canPay: false,
      activePaymentId: null,
      demoScenarios: null,
    };
    if (row.paymentMode !== 'DEMO' || row.totalAmountMinor === null) return none;
    const policy = this.options.payments?.policy;
    const active = row.payments.find((p) => p.status === 'CREATED' || p.status === 'PENDING');
    const paid = row.payments.find((p) =>
      ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status),
    );
    const due = row.paymentDueAt;
    const payable =
      row.status === 'PENDING' &&
      !active &&
      !paid &&
      due !== null &&
      due.getTime() > this.now().getTime() &&
      Boolean(policy?.provider);
    const rewards = row.rewardRedemptions[0] ?? null;
    const state: BookingPayment['state'] = row.payments.some((p) => p.refundRequired)
      ? 'refund-required'
      : paid
        ? 'paid'
        : active
          ? 'processing'
          : payable
            ? 'unpaid'
            : 'closed';
    return {
      mode: 'demo',
      state,
      amount: {
        amountMinor: (row.totalAmountMinor - (rewards?.totalAmountMinor ?? 0n)).toString(),
        currency: row.currency,
      },
      rewards: rewards
        ? {
            points: Number(rewards.points),
            amount: {
              amountMinor: rewards.totalAmountMinor.toString(),
              currency: rewards.currency,
            },
          }
        : null,
      dueAt: due?.toISOString() ?? null,
      canPay: payable,
      activePaymentId: active?.id ?? null,
      demoScenarios:
        payable && policy?.provider?.mode === 'DEMO' && policy.demoScenarios
          ? [...DEMO_PAYMENT_SCENARIOS]
          : null,
    };
  }

  private present(row: BookingRow): Booking {
    const summary = this.presentSummary(row);
    const snapshot = this.snapshot(row);
    return {
      ...summary,
      documents: this.presentDocuments(row, snapshot.providerName),
      cancellation: this.presentCancellation(
        row,
        snapshot.providerName,
        summary.cancellable,
        snapshot,
      ),
      refund: this.presentRefund(row, snapshot.providerName),
      travellers: row.travellers.map((t) => ({
        firstName: t.firstName,
        lastName: t.lastName,
        type: t.type ? (t.type.toLowerCase() as 'adult' | 'child' | 'infant') : null,
      })),
      contactPhone: row.contactPhone,
      priceCheck: this.snapshot(row).priceCheck,
      history: row.events.map((e) => ({
        status: API_STATUS[e.toStatus],
        at: e.createdAt.toISOString(),
        by: e.actorType === 'USER' ? 'you' : e.actorType === 'PROVIDER' ? 'supplier' : 'wayora',
        note: e.note,
      })),
    };
  }
}
