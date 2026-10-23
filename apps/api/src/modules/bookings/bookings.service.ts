import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  BOOKING_REFERENCE_ALPHABET,
  bookingRequirementsFor,
  offerTravelDates,
  offerValidationSchema,
  searchResultSchema,
  type Booking,
  type BookingListQuery,
  type BookingPayment,
  type BookingListResponse,
  type BookingStatus,
  type BookingSummary,
  type BookingView,
  type createBookingRequestSchema,
  DEMO_PAYMENT_SCENARIOS,
  type OfferResponse,
  type SearchServiceType,
} from '@wayora/contracts';
import {
  Prisma,
  type BookingStatus as DbBookingStatus,
  type PrismaClient,
  type TravelCategory,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { messages, notify } from '../notifications/notify.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { pricesEqual, type CallContext, type SearchService } from '../search/search.service.js';
import { IdempotencyService, requestHash } from './idempotency.js';
import {
  AWAITING_PAYMENT_NOTE,
  DEMO_CANCELLATION_NOTE,
  DEMO_CONFIRMATION_NOTE,
  DEMO_PAID_CANCELLATION_NOTE,
  TRANSITIONS,
  lockBooking,
  transitionBooking,
} from './lifecycle.js';

export { DEMO_CANCELLATION_NOTE, DEMO_CONFIRMATION_NOTE, TRANSITIONS } from './lifecycle.js';

/*
 * Demo bookings (docs/bookings.md). Wayora records the booking and simulates
 * its confirmation; no supplier is contacted and nothing is ticketed. Since
 * Phase 13 a booking may first need a demo payment (docs/payments.md); this
 * service stays the owner of the booking lifecycle (bookings/lifecycle.ts).
 */

export type CreateBookingInput = z.output<typeof createBookingRequestSchema>;

const CATEGORY: Record<SearchServiceType, TravelCategory> = {
  flights: 'FLIGHT',
  hotels: 'HOTEL',
  trains: 'TRAIN',
  buses: 'BUS',
  metro: 'METRO',
  cabs: 'CAB',
  holidays: 'HOLIDAY_PACKAGE',
};

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

/** WYD-XXXX-XXXX from the unambiguous alphabet, with a CSPRNG. */
export function newBookingReference(): string {
  const pick = () => BOOKING_REFERENCE_ALPHABET[randomInt(BOOKING_REFERENCE_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `WYD-${group()}-${group()}`;
}

/** What is kept of the offer: validated, versioned, never changed (a DB trigger enforces it). */
const snapshotSchema = z.object({
  v: z.literal(1),
  offer: searchResultSchema,
  providerName: z.string(),
  priceCheck: offerValidationSchema.shape.status,
  searchGeneratedAt: z.string(),
  searchExpiresAt: z.string(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const toDate = (isoDate: string | null) => (isoDate ? new Date(`${isoDate}T00:00:00Z`) : null);
const fromDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const NOT_FOUND_MESSAGE = "We couldn't find that booking.";

const paymentsSelect = {
  payments: {
    select: { id: true, status: true, refundRequired: true },
    orderBy: { attempt: 'desc' },
  },
} satisfies Prisma.BookingInclude;
const bookingInclude = {
  travellers: { orderBy: { position: 'asc' } },
  events: { orderBy: [{ createdAt: 'asc' }, { fromStatus: { sort: 'asc', nulls: 'first' } }] },
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
}

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

  private async createBooking(
    userId: string,
    input: CreateBookingInput,
    claim: { scope: string; key: string },
    context: CallContext,
  ): Promise<string> {
    const log = this.log(context);
    // 1. The offer, from the server's search session only (Phase 11 checks:
    //    expiry, category, membership, integrity, and revalidation if supported).
    const offer: OfferResponse = await this.options.search.offer(
      input.serviceType,
      input.searchId,
      input.offerId,
      context,
    );
    const result = offer.result;
    if (result.source !== 'demo') {
      // Real offers need a real supplier booking, which doesn't exist yet.
      throw new AppError('SERVICE_UNAVAILABLE', 'Booking this offer isn’t available yet.');
    }
    if (result.price === null) {
      throw new AppError('BAD_REQUEST', "This offer has no price, so it can't be booked.");
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
    const paymentMode = policy?.provider && price.kind === 'total' ? 'DEMO' : 'NONE';
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
      const reference = this.newReference();
      try {
        await this.prisma.$transaction(async (tx) => {
          const now = this.now();
          const booking = await tx.booking.create({
            data: {
              reference,
              userId,
              category: CATEGORY[result.serviceType],
              status: 'PENDING',
              isDemo: true,
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
                  note: paymentMode === 'DEMO' ? AWAITING_PAYMENT_NOTE : 'Demo booking requested.',
                  createdAt: now,
                },
              },
            },
          });
          // Without a payment step, the demo confirmation follows at once;
          // with one, it waits for the demo payment (payments/events.ts).
          if (paymentMode === 'NONE') {
            await transitionBooking(tx, now, booking.id, 'PENDING', 'CONFIRMED', {
              actorType: 'SYSTEM',
              note: DEMO_CONFIRMATION_NOTE,
            });
          }
          // One notification for what happened (created-and-confirmed is one event).
          const dueAt = paymentMode === 'DEMO' ? new Date(now.getTime() + policy!.windowMs) : null;
          await notify(tx, now, {
            ...(dueAt
              ? messages.bookingAwaitingPayment(reference, dueAt)
              : messages.bookingConfirmed(reference)),
            userId,
            isDemo: true,
            bookingId: booking.id,
            dedupeKey: `booking:${booking.id}:${dueAt ? 'CREATED' : 'CONFIRMED'}`,
          });
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
                demo: true,
              },
            },
          });
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
            },
          },
          'Demo booking created',
        );
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
    const row = await this.prisma.booking.findFirst({
      where: { reference, userId },
      include: bookingInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
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
  }): string | null {
    if (row.status === 'CANCELLED') return 'This booking is already cancelled.';
    if (row.status === 'EXPIRED') return 'This booking expired before it was paid.';
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
      select: { id: true, status: true, startsOn: true },
    });
    if (!found) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    const firstBlocker = this.cancellationBlocker(found);
    if (firstBlocker) throw new AppError('BOOKING_NOT_CANCELLABLE', firstBlocker);
    // A payment still in progress is cancelled first (best effort); if it
    // settles anyway, the payment rules handle it (docs/payments.md#late-success).
    await this.options.payments?.cancelActiveForBooking(found.id, context);

    await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, found.id);
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: { id: true, status: true, startsOn: true },
      });
      const blocker = this.cancellationBlocker(row);
      if (blocker) throw new AppError('BOOKING_NOT_CANCELLABLE', blocker);
      // A paid demo booking: the payment would be owed back. The demo provider
      // can't refund (nothing was taken), so it is flagged, never "refunded".
      const paid = await tx.payment.updateMany({
        where: { bookingId: row.id, status: 'SUCCEEDED' },
        data: { refundRequired: true },
      });
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
    });
    this.log(context).info({ booking: { reference } }, 'Demo booking cancelled');
    return this.get(userId, reference);
  }

  // ─── Presentation ───────────────────────────────────────────────────────

  private snapshot(row: BookingSummaryRow): Snapshot {
    const parsed = snapshotSchema.safeParse(row.offerSnapshot);
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
      amount: { amountMinor: row.totalAmountMinor.toString(), currency: row.currency },
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
    return {
      ...this.presentSummary(row),
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
        by: e.actorType === 'USER' ? 'you' : 'wayora',
        note: e.note,
      })),
    };
  }
}
