import type { DemoPaymentScenario } from '@wayora/contracts';
import {
  ProviderPaymentError,
  type PaymentProvider,
  type ProviderAttempt,
  type ProviderCallResult,
  type ProviderPaymentEvent,
} from './types.js';

/*
 * The demo payment provider (docs/payments.md#demo-provider): a deterministic
 * simulator inside the API process.
 *
 * - No money moves. No card, bank or wallet details exist anywhere in the
 *   flow, and it makes no network calls.
 * - Its outcome is a pure function of the attempt (scenario, creation time,
 *   Wayora's recorded status) and the clock, so it needs no storage and the
 *   same question always gets the same answer, with the same event ids.
 * - It can't refund: nothing was taken. Payments it approves are labelled
 *   "Demo payment — no real money was charged" everywhere.
 * - The scenario comes from the request only when the server enables demo
 *   scenarios (PAYMENT_DEMO_SCENARIOS); otherwise every attempt is `succeed`.
 *   The client never sends a status.
 */

export const DEMO_PROVIDER_ID = 'demo';

export interface DemoPaymentProviderOptions {
  /** How long `pending` scenarios stay pending before they settle. */
  pendingMs: number;
  now?: () => Date;
}

export class DemoPaymentProvider implements PaymentProvider {
  readonly id = DEMO_PROVIDER_ID;
  readonly name = 'Wayora demo payments (simulated)';
  readonly mode = 'DEMO' as const;
  readonly capabilities = { cancel: true, refund: false, webhooks: false };
  private readonly now: () => Date;

  constructor(private readonly options: DemoPaymentProviderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Derived from Wayora's payment id, so it is stable across retries. */
  static reference(paymentId: string): string {
    return `demo_pay_${paymentId.replace(/-/g, '')}`;
  }

  private scenario(attempt: ProviderAttempt): DemoPaymentScenario {
    return attempt.demoScenario ?? 'succeed';
  }

  private settlesAt(attempt: ProviderAttempt): Date {
    return new Date(attempt.createdAt.getTime() + this.options.pendingMs);
  }

  private event(
    reference: string,
    type: ProviderPaymentEvent['type'],
    at: Date,
    failureCode?: string,
  ): ProviderPaymentEvent {
    return {
      id: `${reference}:${type}`,
      type,
      providerReference: reference,
      occurredAt: at.toISOString(),
      ...(failureCode ? { failureCode } : {}),
    };
  }

  /** Everything that has "happened" to the attempt by now. */
  private history(attempt: ProviderAttempt): ProviderPaymentEvent[] {
    const reference = DemoPaymentProvider.reference(attempt.paymentId);
    const created = attempt.createdAt;
    switch (this.scenario(attempt)) {
      case 'succeed':
        return [this.event(reference, 'payment.succeeded', created)];
      case 'decline':
        return [this.event(reference, 'payment.failed', created, 'demo_declined')];
      case 'pending':
      case 'pending-decline': {
        const events = [this.event(reference, 'payment.pending', created)];
        // A cancelled attempt never settles (Wayora's record is the simulator's state).
        if (attempt.status === 'CANCELLED') return events;
        const settle = this.settlesAt(attempt);
        if (this.now().getTime() >= settle.getTime()) {
          events.push(
            this.scenario(attempt) === 'pending'
              ? this.event(reference, 'payment.succeeded', settle)
              : this.event(reference, 'payment.failed', settle, 'demo_declined'),
          );
        }
        return events;
      }
    }
  }

  createAttempt(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    return Promise.resolve({
      providerReference: DemoPaymentProvider.reference(attempt.paymentId),
      events: this.history(attempt),
    });
  }

  retrieve(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    return this.createAttempt(attempt);
  }

  cancel(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    const reference = DemoPaymentProvider.reference(attempt.paymentId);
    const settled =
      !this.scenario(attempt).startsWith('pending') ||
      this.now().getTime() >= this.settlesAt(attempt).getTime();
    if (settled) {
      return Promise.reject(
        new ProviderPaymentError('not_cancellable', 'The demo payment has already settled.'),
      );
    }
    return Promise.resolve({
      providerReference: reference,
      events: [this.event(reference, 'payment.cancelled', this.now())],
    });
  }
}
