import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  DEMO_PAYMENT_NOTICE,
  type createPaymentRequestSchema,
  type DemoPaymentScenario,
  type Payment,
  type PaymentListResponse,
  type PaymentStatus,
} from '@wayora/contracts';
import { Prisma, type PrismaClient } from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { IdempotencyService, requestHash } from '../bookings/idempotency.js';
import { expireIfOverdue, lockBooking } from '../bookings/lifecycle.js';
import { errorForLog } from '../search/errors.js';
import type { CallContext } from '../search/search.service.js';
import { IN_PROGRESS, PaymentEventProcessor } from './events.js';
import {
  ProviderPaymentError,
  type PaymentProvider,
  type ProviderAttempt,
  type ProviderCallResult,
} from './providers/types.js';

/*
 * Payments (docs/payments.md). A payment is an attempt to pay for one
 * booking, with its own lifecycle. This service creates attempts, asks the
 * provider, and reads, cancels and reconciles them; every status change a
 * provider reports goes through PaymentEventProcessor.
 *
 * Trust: the amount and currency come from the booking's record (the client's
 * `amount` is only compared); the outcome comes from the provider (the client
 * never sends a status); ownership is checked on every read and write.
 */

export type CreatePaymentInput = z.output<typeof createPaymentRequestSchema>;

/** What the server is configured to do (config/env.ts). */
export interface PaymentPolicy {
  /** The provider new payments use; null when payments are off (bookings are then mode NONE). */
  provider: PaymentProvider | null;
  /** Whether the demo simulator accepts test scenarios from requests. */
  demoScenarios: boolean;
  /** How long a booking waits for its payment before it expires. */
  windowMs: number;
}

export interface PaymentsServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  policy: PaymentPolicy;
  /** Every provider existing payments may name (includes policy.provider). */
  providers?: readonly PaymentProvider[];
  now?: () => Date;
}

const NOT_FOUND_MESSAGE = "We couldn't find that payment.";
const BOOKING_NOT_FOUND_MESSAGE = "We couldn't find that booking.";

const paymentInclude = {
  events: { orderBy: [{ createdAt: 'asc' }, { fromStatus: { sort: 'asc', nulls: 'first' } }] },
  booking: { select: { reference: true } },
} satisfies Prisma.PaymentInclude;
type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class PaymentsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  private readonly providers: Map<string, PaymentProvider>;
  readonly events: PaymentEventProcessor;
  readonly idempotency: IdempotencyService;

  constructor(private readonly options: PaymentsServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
    this.providers = new Map(
      [
        ...(options.providers ?? []),
        ...(options.policy.provider ? [options.policy.provider] : []),
      ].map((p) => [p.id, p]),
    );
    this.events = new PaymentEventProcessor(options.prisma, options.logger, this.now);
    this.idempotency = new IdempotencyService(options.prisma, this.now);
  }

  get policy(): PaymentPolicy {
    return this.options.policy;
  }

  providerFor(id: string): PaymentProvider | null {
    return this.providers.get(id) ?? null;
  }

  private log(context: CallContext): Logger {
    return context.requestId
      ? this.options.logger.child({ requestId: context.requestId })
      : this.options.logger;
  }

  // ─── Create ─────────────────────────────────────────────────────────────

  /**
   * Starts a payment attempt for one of the user's bookings, at most once
   * per idempotency key (scoped to the user and the booking).
   */
  async create(
    userId: string,
    reference: string,
    input: CreatePaymentInput,
    rawBody: unknown,
    key: string,
    context: CallContext = {},
  ): Promise<{ status: number; payment: Payment; replayed: boolean }> {
    const provider = this.options.policy.provider;
    if (!provider) {
      throw new AppError('PAYMENT_NOT_ALLOWED', 'Payments are switched off on this server.');
    }
    if (
      input.demoScenario !== undefined &&
      !(provider.mode === 'DEMO' && this.options.policy.demoScenarios)
    ) {
      throw new AppError('BAD_REQUEST', 'Demo payment scenarios aren’t available on this server.');
    }

    const claim = await this.idempotency.claim<{ paymentId: string }>({
      operation: `POST /bookings/${reference}/payments`,
      userId,
      key,
      hash: requestHash(rawBody),
      messages: {
        inProgress: 'This payment is already being started. Wait a moment, then check the booking.',
        reused:
          'This request key was already used for a different payment request. Start the payment again.',
      },
    });
    if (claim.kind === 'replay') {
      return {
        status: claim.status,
        payment: await this.get(userId, claim.body.paymentId, context),
        replayed: true,
      };
    }

    let paymentId: string;
    try {
      paymentId = await this.start(userId, reference, input, key, claim, provider, context);
    } catch (error) {
      await this.idempotency.release(claim);
      throw error;
    }
    await this.submit(provider, paymentId, context);
    return { status: 201, payment: await this.read(userId, paymentId), replayed: false };
  }

  /** Validates the booking and records the attempt (CREATED), in one transaction. */
  private async start(
    userId: string,
    reference: string,
    input: CreatePaymentInput,
    key: string,
    claim: { scope: string; key: string },
    provider: PaymentProvider,
    context: CallContext,
  ): Promise<string> {
    const found = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', BOOKING_NOT_FOUND_MESSAGE);
    // A booking past its due time expires first, so it is refused below.
    await this.prisma.$transaction((tx) => expireIfOverdue(tx, this.now(), found.id));

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBooking(tx, found.id);
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: found.id },
          select: {
            status: true,
            paymentMode: true,
            paymentDueAt: true,
            currency: true,
            totalAmountMinor: true,
            payments: { select: { status: true } },
          },
        });
        if (booking.paymentMode !== 'DEMO' || booking.totalAmountMinor === null) {
          throw new AppError(
            'PAYMENT_NOT_ALLOWED',
            'This booking doesn’t take a payment on Wayora.',
          );
        }
        if (
          booking.payments.some((p) =>
            ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status),
          )
        ) {
          throw new AppError('PAYMENT_NOT_ALLOWED', 'This booking is already paid.');
        }
        if (booking.payments.some((p) => IN_PROGRESS.includes(p.status))) {
          throw new AppError(
            'PAYMENT_NOT_ALLOWED',
            'A payment for this booking is already in progress.',
          );
        }
        if (booking.status === 'CANCELLED') {
          throw new AppError(
            'PAYMENT_NOT_ALLOWED',
            'This booking is cancelled, so it can’t be paid.',
          );
        }
        if (booking.status === 'EXPIRED') {
          throw new AppError(
            'PAYMENT_NOT_ALLOWED',
            'This booking expired before it was paid. Make a new booking to try again.',
          );
        }
        if (booking.status !== 'PENDING') {
          throw new AppError(
            'PAYMENT_NOT_ALLOWED',
            'This booking can’t be paid in its current state.',
          );
        }
        // The amount is the booking's; the visitor's figure is only compared.
        if (
          input.amount.currency !== booking.currency ||
          BigInt(input.amount.amountMinor) !== booking.totalAmountMinor
        ) {
          throw new AppError(
            'PAYMENT_AMOUNT_MISMATCH',
            'The amount doesn’t match this booking. Review the booking and pay again.',
          );
        }

        const now = this.now();
        const payment = await tx.payment.create({
          data: {
            bookingId: found.id,
            userId,
            attempt: booking.payments.length + 1,
            mode: provider.mode,
            provider: provider.id,
            currency: booking.currency,
            amountMinor: booking.totalAmountMinor,
            demoScenario: provider.mode === 'DEMO' ? (input.demoScenario ?? 'succeed') : null,
            idempotencyKeyHash: sha256(key),
            createdAt: now,
            events: {
              create: {
                fromStatus: null,
                toStatus: 'CREATED',
                actorType: 'USER',
                note:
                  provider.mode === 'DEMO'
                    ? 'Demo payment started (simulated: no real money moves).'
                    : 'Payment started.',
                createdAt: now,
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'USER',
            actorId: userId,
            action: 'payment.created',
            entityType: 'payment',
            entityId: payment.id,
            requestId: context.requestId ?? null,
            metadata: {
              bookingReference: reference,
              attempt: payment.attempt,
              provider: provider.id,
              mode: provider.mode,
              amountMinor: payment.amountMinor.toString(),
              currency: payment.currency,
            },
          },
        });
        await this.idempotency.complete(tx, claim, {
          status: 201,
          body: { paymentId: payment.id },
        });
        return payment.id;
      });
    } catch (error) {
      // The partial unique indexes: another attempt became active or paid meanwhile.
      if (isUniqueViolation(error)) {
        throw new AppError(
          'PAYMENT_NOT_ALLOWED',
          'A payment for this booking is already in progress.',
        );
      }
      throw error;
    }
  }

  /** Asks the provider to start the attempt and applies what it reports. */
  private async submit(provider: PaymentProvider, paymentId: string, context: CallContext) {
    const log = this.log(context).child({ paymentId, providerId: provider.id });
    const row = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: paymentInclude,
    });
    let result: ProviderCallResult;
    try {
      result = await provider.createAttempt(this.attemptOf(row));
    } catch (error) {
      if (error instanceof ProviderPaymentError && error.kind === 'rejected') {
        await this.failWithoutProvider(paymentId, 'provider_rejected');
        log.warn({ err: errorForLog(error) }, 'Provider rejected the payment attempt');
        return;
      }
      // Unknown outcome (timeout, outage): never assume; reconcile later.
      log.warn({ err: errorForLog(error) }, 'Payment outcome unknown; it will be reconciled');
      return;
    }
    try {
      await this.applyResult(provider, paymentId, result, 'call');
    } catch (error) {
      // Recorded as a failed provider event; reconciliation retries it.
      log.error(
        { err: errorForLog(error) },
        'Applying the provider’s answer failed; it will be retried',
      );
      return;
    }
    log.info(
      { payment: { status: (await this.status(paymentId)) ?? 'unknown' } },
      'Payment attempt submitted',
    );
  }

  private async status(paymentId: string) {
    const row = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  private async applyResult(
    provider: PaymentProvider,
    paymentId: string,
    result: ProviderCallResult,
    source: 'call' | 'poll',
  ) {
    // Set once (a trigger refuses changing it later).
    await this.prisma.payment.updateMany({
      where: { id: paymentId, providerReference: null },
      data: { providerReference: result.providerReference },
    });
    for (const event of result.events) await this.events.handle(provider, event, source);
  }

  /** The provider definitely didn't take the attempt: CREATED → FAILED, by Wayora. */
  private async failWithoutProvider(paymentId: string, code: 'provider_rejected') {
    await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, status: 'CREATED' },
        data: {
          status: 'FAILED',
          completedAt: now,
          failureCode: code,
          failureMessage: 'The payment provider couldn’t start this payment.',
        },
      });
      if (changed.count !== 1) return;
      await tx.paymentStatusEvent.create({
        data: {
          paymentId,
          fromStatus: 'CREATED',
          toStatus: 'FAILED',
          actorType: 'SYSTEM',
          note: 'The provider refused to start the payment; nothing was taken.',
          createdAt: now,
        },
      });
    });
  }

  private attemptOf(
    row:
      | PaymentRow
      | Prisma.PaymentGetPayload<{ include: { booking: { select: { reference: true } } } }>,
  ): ProviderAttempt {
    return {
      paymentId: row.id,
      bookingReference: row.booking.reference,
      amountMinor: row.amountMinor,
      currency: row.currency,
      providerReference: row.providerReference,
      demoScenario: (row.demoScenario as DemoPaymentScenario | null) ?? null,
      createdAt: row.createdAt,
      status: row.status,
    };
  }

  // ─── Read and reconcile ─────────────────────────────────────────────────

  /** Asks the provider about an attempt still in progress and applies the answer. */
  async reconcile(paymentId: string, context: CallContext = {}): Promise<void> {
    const row = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { booking: { select: { reference: true } } },
    });
    if (!row || !IN_PROGRESS.includes(row.status)) return;
    const provider = this.providerFor(row.provider);
    if (!provider) return;
    try {
      const result = await provider.retrieve(this.attemptOf(row));
      await this.applyResult(provider, row.id, result, 'poll');
    } catch (error) {
      this.log(context).warn(
        { paymentId, err: errorForLog(error) },
        'Payment reconciliation failed; will retry',
      );
    }
  }

  private async read(userId: string, paymentId: string): Promise<Payment> {
    const row = await this.prisma.payment.findFirst({
      where: { id: paymentId, userId },
      include: paymentInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return this.present(row);
  }

  /** One payment of this user (another user's is "not found"), reconciled if in progress. */
  async get(userId: string, paymentId: string, context: CallContext = {}): Promise<Payment> {
    const owned = await this.prisma.payment.findFirst({
      where: { id: paymentId, userId },
      select: { id: true, status: true },
    });
    if (!owned) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    if (IN_PROGRESS.includes(owned.status)) await this.reconcile(owned.id, context);
    return this.read(userId, paymentId);
  }

  async listForBooking(userId: string, reference: string): Promise<PaymentListResponse> {
    const booking = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: { id: true },
    });
    if (!booking) throw new AppError('NOT_FOUND', BOOKING_NOT_FOUND_MESSAGE);
    const inProgress = await this.prisma.payment.findMany({
      where: { bookingId: booking.id, status: { in: IN_PROGRESS } },
      select: { id: true },
    });
    for (const p of inProgress) await this.reconcile(p.id);
    const rows = await this.prisma.payment.findMany({
      where: { bookingId: booking.id, userId },
      include: paymentInclude,
      orderBy: { attempt: 'desc' },
    });
    return { items: rows.map((row) => this.present(row)) };
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────

  async cancel(userId: string, paymentId: string, context: CallContext = {}): Promise<Payment> {
    const owned = await this.prisma.payment.findFirst({
      where: { id: paymentId, userId },
      select: { id: true },
    });
    if (!owned) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    // It may have settled since it was last read.
    await this.reconcile(paymentId, context);
    const row = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { booking: { select: { reference: true } } },
    });
    const provider = this.providerFor(row.provider);
    if (!IN_PROGRESS.includes(row.status) || !provider?.capabilities.cancel) {
      throw new AppError(
        'PAYMENT_NOT_CANCELLABLE',
        IN_PROGRESS.includes(row.status)
          ? 'This payment can’t be cancelled.'
          : 'This payment has already completed, so it can’t be cancelled.',
      );
    }
    await this.prisma.auditLog.create({
      data: {
        actorType: 'USER',
        actorId: userId,
        action: 'payment.cancel_requested',
        entityType: 'payment',
        entityId: paymentId,
        requestId: context.requestId ?? null,
        metadata: { status: row.status },
      },
    });
    let result: ProviderCallResult;
    try {
      result = await provider.cancel(this.attemptOf(row));
    } catch (error) {
      if (error instanceof ProviderPaymentError && error.kind === 'not_cancellable') {
        await this.reconcile(paymentId, context);
        throw new AppError(
          'PAYMENT_NOT_CANCELLABLE',
          'This payment has already completed, so it can’t be cancelled.',
        );
      }
      this.log(context).warn({ paymentId, err: errorForLog(error) }, 'Payment cancel failed');
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'We couldn’t reach the payment provider. Try again in a moment.',
      );
    }
    await this.applyResult(provider, paymentId, result, 'call');
    return this.read(userId, paymentId);
  }

  /**
   * Before a booking is cancelled: cancel its attempts still in progress (best
   * effort). One that settles anyway is handled by the late-success rule.
   */
  async cancelActiveForBooking(bookingId: string, context: CallContext = {}): Promise<void> {
    const active = await this.prisma.payment.findMany({
      where: { bookingId, status: { in: IN_PROGRESS } },
      select: { id: true, userId: true },
    });
    for (const p of active) {
      await this.cancel(p.userId, p.id, context).catch((error: unknown) => {
        this.log(context).info(
          { paymentId: p.id, err: errorForLog(error) },
          'Payment not cancelled with its booking',
        );
      });
    }
  }

  // ─── Refunds (extension point) ──────────────────────────────────────────

  /**
   * Requests a refund through the payment's provider. Only providers that can
   * refund AND confirm it implement this; the status becomes `refunded` only
   * when the provider's event says so. The demo provider can't refund (no
   * money was taken), so this is refused for demo payments. Not exposed over
   * HTTP yet: there is no refund flow to put it in.
   */
  async requestRefund(userId: string, paymentId: string): Promise<Payment> {
    const row = await this.prisma.payment.findFirst({
      where: { id: paymentId, userId },
      include: { booking: { select: { reference: true } } },
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    const provider = this.providerFor(row.provider);
    if (!provider?.capabilities.refund || !provider.refund) {
      throw new AppError('PAYMENT_NOT_ALLOWED', 'Refunds aren’t supported for this payment.');
    }
    if (row.status !== 'SUCCEEDED') {
      throw new AppError('PAYMENT_NOT_ALLOWED', 'Only a successful payment can be refunded.');
    }
    const result = await provider.refund(this.attemptOf(row));
    await this.applyResult(provider, paymentId, result, 'call');
    return this.read(userId, paymentId);
  }

  // ─── Background maintenance ─────────────────────────────────────────────

  /** Reconciles attempts still in progress (run periodically). */
  async reconcileInProgress(limit = 100): Promise<number> {
    const rows = await this.prisma.payment.findMany({
      where: { status: { in: IN_PROGRESS } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const row of rows) await this.reconcile(row.id);
    return rows.length;
  }

  /** Expires bookings whose payment window has passed (run periodically, and before reads). */
  async expireOverdueBookings(
    filter: { userId?: string; bookingId?: string } = {},
  ): Promise<number> {
    const due = await this.prisma.booking.findMany({
      where: {
        status: 'PENDING',
        paymentMode: 'DEMO',
        paymentDueAt: { lte: this.now() },
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.bookingId ? { id: filter.bookingId } : {}),
      },
      select: { id: true },
      take: 200,
    });
    let expired = 0;
    for (const b of due) {
      if (await this.prisma.$transaction((tx) => expireIfOverdue(tx, this.now(), b.id)))
        expired += 1;
    }
    return expired;
  }

  // ─── Presentation ───────────────────────────────────────────────────────

  present(row: PaymentRow): Payment {
    const provider = this.providerFor(row.provider);
    const inProgress = IN_PROGRESS.includes(row.status);
    return {
      id: row.id,
      bookingReference: row.booking.reference,
      attempt: row.attempt,
      status: row.status.toLowerCase() as PaymentStatus,
      mode: row.mode === 'DEMO' ? 'demo' : 'live',
      demo: row.mode === 'DEMO',
      providerName: provider?.name ?? row.provider,
      amount: { amountMinor: row.amountMinor.toString(), currency: row.currency },
      demoScenario: (row.demoScenario as DemoPaymentScenario | null) ?? null,
      failure:
        row.failureCode && row.failureMessage
          ? { code: row.failureCode, message: row.failureMessage }
          : null,
      cancellable: inProgress && Boolean(provider?.capabilities.cancel),
      refund: { required: row.refundRequired, supported: Boolean(provider?.capabilities.refund) },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      history: row.events.map((e) => ({
        status: e.toStatus.toLowerCase() as PaymentStatus,
        at: e.createdAt.toISOString(),
        by: e.actorType === 'USER' ? 'you' : e.actorType === 'PROVIDER' ? 'provider' : 'wayora',
        note: e.note,
      })),
      notice: row.mode === 'DEMO' ? DEMO_PAYMENT_NOTICE : null,
    };
  }
}
