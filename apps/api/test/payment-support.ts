import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DemoPaymentProvider,
  type DemoPaymentProviderOptions,
} from '../src/modules/payments/providers/demo.js';
import {
  ProviderPaymentError,
  WebhookVerificationError,
  type PaymentProvider,
  type ProviderAttempt,
  type ProviderCallResult,
  type ProviderPaymentEvent,
} from '../src/modules/payments/providers/types.js';

/*
 * Test-only payment providers. Never registered by the application.
 */

/** The demo simulator, with a delay before it answers (network timeouts). */
export class SlowDemoProvider extends DemoPaymentProvider {
  constructor(
    options: DemoPaymentProviderOptions,
    private readonly delayMs: number,
  ) {
    super(options);
  }
  override async createAttempt(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.createAttempt(attempt);
  }
}

/** Fails every createAttempt as the given kind (outage, refusal). */
export class FailingProvider extends DemoPaymentProvider {
  constructor(
    options: DemoPaymentProviderOptions,
    private readonly kind: 'rejected' | 'unknown',
  ) {
    super(options);
  }
  override createAttempt(): Promise<ProviderCallResult> {
    return Promise.reject(
      new ProviderPaymentError(this.kind, 'upstream said: secret=sk_live_123 failed'),
    );
  }
}

export const WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret';
export const SIGNATURE_HEADER = 'x-test-signature';
const TOLERANCE_S = 300;

export function sign(body: string, timestamp: number, secret = WEBHOOK_SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * A stand-in for a real gateway: asynchronous outcomes only by signed webhook
 * (HMAC-SHA256 over "timestamp.body", 5-minute tolerance), and refunds.
 * Shows what a real adapter must provide; nothing here moves money.
 */
export class SignedTestGateway implements PaymentProvider {
  readonly id = 'test-gateway';
  readonly name = 'Test gateway';
  readonly mode = 'LIVE' as const;
  readonly capabilities = { cancel: true, refund: true, webhooks: true };
  constructor(private readonly now: () => Date = () => new Date()) {}

  static reference(paymentId: string) {
    return `tg_${paymentId.replace(/-/g, '')}`;
  }

  createAttempt(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    const ref = SignedTestGateway.reference(attempt.paymentId);
    return Promise.resolve({
      providerReference: ref,
      events: [
        {
          id: `evt_${ref}_pending`,
          type: 'payment.pending',
          providerReference: ref,
          occurredAt: this.now().toISOString(),
        },
      ],
    });
  }
  retrieve(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    // Outcomes arrive by webhook; polling only confirms "pending".
    return this.createAttempt(attempt);
  }
  cancel(): Promise<ProviderCallResult> {
    return Promise.reject(new ProviderPaymentError('not_cancellable', 'no'));
  }
  refund(attempt: ProviderAttempt): Promise<ProviderCallResult> {
    const ref = attempt.providerReference!;
    return Promise.resolve({
      providerReference: ref,
      events: [
        {
          id: `evt_${ref}_refund_pending`,
          type: 'refund.pending',
          providerReference: ref,
          occurredAt: this.now().toISOString(),
        },
      ],
    });
  }
  verifyEvent(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): ProviderPaymentEvent[] {
    const header = headers[SIGNATURE_HEADER];
    const match = header ? /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) : null;
    if (!match) throw new WebhookVerificationError('Missing or malformed signature.');
    const timestamp = Number(match[1]);
    if (Math.abs(this.now().getTime() / 1000 - timestamp) > TOLERANCE_S) {
      throw new WebhookVerificationError('Signature timestamp outside tolerance.');
    }
    const expected = Buffer.from(
      createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody.toString('utf8')}`)
        .digest('hex'),
    );
    const given = Buffer.from(match[2]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new WebhookVerificationError('Signature mismatch.');
    }
    const parsed = JSON.parse(rawBody.toString('utf8')) as { events?: unknown };
    if (!Array.isArray(parsed.events)) throw new WebhookVerificationError('No events.');
    return parsed.events as ProviderPaymentEvent[];
  }
}
