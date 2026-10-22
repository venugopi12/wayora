import { z } from 'zod';
import type { DemoPaymentScenario } from '@wayora/contracts';

/*
 * The boundary between Wayora's payment lifecycle and a payment provider
 * (docs/payments.md#providers). The booking and payment services only talk
 * to this interface, so a real gateway can be added as another
 * implementation without touching booking logic.
 *
 * Providers never decide Wayora state directly: everything they report is a
 * ProviderPaymentEvent, and every event goes through PaymentEventProcessor
 * (dedupe by event id, allowed transitions only, booking effects in one
 * transaction), whether it came back from a call, from polling, or from a
 * verified webhook.
 */

export const PROVIDER_EVENT_TYPES = [
  'payment.pending',
  'payment.succeeded',
  'payment.failed',
  'payment.cancelled',
  'refund.pending',
  'refund.succeeded',
  'refund.failed',
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/** A provider's statement about one payment. Validated before anything uses it. */
export const providerPaymentEventSchema = z
  .object({
    /** The provider's unique event id: the de-duplication key. */
    id: z.string().min(1).max(255),
    type: z.enum(PROVIDER_EVENT_TYPES),
    /** The provider's id for the payment (as returned when it was created). */
    providerReference: z.string().min(1).max(128),
    occurredAt: z.iso.datetime({ offset: true }),
    /** For failures: a provider code. Wayora maps it to its own wording. */
    failureCode: z
      .string()
      .regex(/^[a-z0-9_.-]{1,64}$/)
      .optional(),
  })
  .strict();
export type ProviderPaymentEvent = z.infer<typeof providerPaymentEventSchema>;

/** What a provider is told about an attempt. Never card or bank details: Wayora has none. */
export interface ProviderAttempt {
  /** Wayora's payment id: also the provider-side idempotency key. */
  paymentId: string;
  bookingReference: string;
  amountMinor: bigint;
  currency: string;
  /** Known once created. */
  providerReference: string | null;
  /** Demo scenario (demo provider only). */
  demoScenario: DemoPaymentScenario | null;
  createdAt: Date;
  /** Wayora's current status for the attempt (the demo simulator keeps no state of its own). */
  status: string;
}

export interface ProviderCallResult {
  providerReference: string;
  /** What the provider reported, in order. */
  events: ProviderPaymentEvent[];
}

export interface PaymentProvider {
  /** Stable id stored with each payment, e.g. `demo`. */
  readonly id: string;
  readonly name: string;
  /** `DEMO` providers simulate; `LIVE` providers move real money. */
  readonly mode: 'DEMO' | 'LIVE';
  readonly capabilities: {
    /** Pending attempts can be cancelled. */
    cancel: boolean;
    /** Refunds can be requested AND are confirmed by the provider. */
    refund: boolean;
    /** Signed webhooks (requires verifyEvent). */
    webhooks: boolean;
  };
  /** Starts an attempt. Must be idempotent on `attempt.paymentId`. */
  createAttempt(attempt: ProviderAttempt, signal?: AbortSignal): Promise<ProviderCallResult>;
  /** Everything the provider has to say about the attempt so far (for reconciliation). */
  retrieve(attempt: ProviderAttempt, signal?: AbortSignal): Promise<ProviderCallResult>;
  /** Cancels a pending attempt, or throws ProviderPaymentError('not_cancellable'). */
  cancel(attempt: ProviderAttempt, signal?: AbortSignal): Promise<ProviderCallResult>;
  /** Requests a refund. Only providers whose capabilities say `refund` implement it. */
  refund?(attempt: ProviderAttempt, signal?: AbortSignal): Promise<ProviderCallResult>;
  /**
   * Verifies an inbound webhook (signature over the raw body, timestamp
   * tolerance) and returns its events. Throws on anything not authentic.
   */
  verifyEvent?(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): ProviderPaymentEvent[];
}

/**
 * Provider failures. `kind` decides what Wayora may conclude:
 * - `rejected`: the provider definitely did not create/take the payment
 *   (safe to mark the attempt failed),
 * - `not_cancellable`: the attempt has already settled,
 * - `unknown`: timeout or outage, the outcome is unknown; never assume either
 *   way, reconcile later with `retrieve`.
 */
export class ProviderPaymentError extends Error {
  constructor(
    readonly kind: 'rejected' | 'not_cancellable' | 'unknown',
    message: string,
    readonly code = kind,
  ) {
    super(message);
    this.name = 'ProviderPaymentError';
  }
}

/** Raised by verifyEvent; never says which check failed to the caller. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}
