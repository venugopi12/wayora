import { z } from 'zod';
import { bookingReferenceSchema, demoPaymentScenarioSchema } from './bookings.js';
import { moneySchema } from './money.js';
import { offsetDateTimeSchema } from './search/common.js';

/*
 * Payments (Phase 13, docs/payments.md).
 *
 * A payment is an ATTEMPT to pay for one booking. It has its own lifecycle,
 * separate from the booking's: a successful payment never means a supplier
 * has reserved anything. Today the only provider is the demo simulator, so
 * every payment is `demo: true` and no money moves.
 */

/**
 * Lifecycle (server-enforced; docs/payments.md#states):
 *   created ─▶ pending ─▶ succeeded | failed | cancelled
 *   created ─▶ succeeded | failed | cancelled      (provider answered at once)
 *   succeeded ─▶ refund_pending ─▶ refunded        (only if the provider confirms a refund)
 *   refund_pending ─▶ succeeded                    (refund refused)
 * `failed`, `cancelled` and `refunded` are final. A status never moves backwards.
 */
export const paymentStatusSchema = z.enum([
  'created',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/** `demo`: simulated, no money moves. `live` is reserved for a real gateway. */
export const paymentModeSchema = z.enum(['demo', 'live']);
export type PaymentMode = z.infer<typeof paymentModeSchema>;

export const paymentIdSchema = z.uuid({ error: 'Not a valid payment id.' });

/**
 * POST /bookings/:reference/payments (with an `Idempotency-Key` header).
 *
 * `amount` is what the visitor saw and agreed to pay. It is NOT used as the
 * amount (the booking's own record is), only compared with it: a different
 * amount or currency is refused. There is no status field: only the provider
 * decides whether a payment succeeds. `demoScenario` asks the demo simulator
 * for a test outcome and is refused unless the server enables demo scenarios.
 * No card or bank details are ever sent: the demo provider takes none, and a
 * real gateway would collect them on its own hosted page.
 */
export const createPaymentRequestSchema = z
  .object({
    amount: moneySchema,
    demoScenario: demoPaymentScenarioSchema.optional(),
  })
  .strict();
export type CreatePaymentRequest = z.input<typeof createPaymentRequestSchema>;

export const paymentEventSchema = z.object({
  status: paymentStatusSchema,
  at: offsetDateTimeSchema,
  /** `you` (the account holder), `wayora` (the system) or `provider` (the payment provider). */
  by: z.enum(['you', 'wayora', 'provider']),
  note: z.string().nullable(),
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

/** One payment attempt, as its owner sees it. No provider secrets or references. */
export const paymentSchema = z.object({
  id: paymentIdSchema,
  bookingReference: bookingReferenceSchema,
  /** 1 for the first attempt on this booking, 2 for the next… */
  attempt: z.number().int().positive(),
  status: paymentStatusSchema,
  mode: paymentModeSchema,
  /** True for simulated payments: no money was taken. */
  demo: z.boolean(),
  providerName: z.string(),
  /** The amount, from the booking's record at the time of the attempt. */
  amount: moneySchema,
  /** The demo scenario that was simulated, if any. */
  demoScenario: demoPaymentScenarioSchema.nullable(),
  /** Why it failed, in safe words (no provider internals). */
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Whether it can still be cancelled (created or pending). */
  cancellable: z.boolean(),
  refund: z.object({
    /** It succeeded after the booking was cancelled or expired: the money would be owed back. */
    required: z.boolean(),
    /** Whether this payment's provider can refund. The demo provider can't (nothing was taken). */
    supported: z.boolean(),
  }),
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
  /** When it reached a final or settled status (succeeded, failed, cancelled, refunded). */
  completedAt: offsetDateTimeSchema.nullable(),
  history: z.array(paymentEventSchema).min(1),
  /** Shown with every demo payment; null for real ones. */
  notice: z.string().nullable(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const paymentListResponseSchema = z.object({ items: z.array(paymentSchema) });
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

export const paymentParamsSchema = z.object({ paymentId: paymentIdSchema });

/** Shown with every demo payment, and only with demo payments. */
export const DEMO_PAYMENT_NOTICE = 'Demo payment — no real money was charged.';

/** Statuses that are still in progress (the UI keeps checking). */
export const PAYMENT_IN_PROGRESS_STATUSES: readonly PaymentStatus[] = ['created', 'pending'];
