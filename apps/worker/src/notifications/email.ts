/*
 * Email delivery boundary (docs/notifications.md#email). No email provider is
 * configured in Wayora yet: the only implementation is NotConfiguredEmailProvider,
 * which sends nothing and makes the dispatcher record NOT_CONFIGURED (never
 * "sent"). A real provider implements EmailProvider and is chosen in main.ts.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly id: string;
  /** False: nothing is ever sent; deliveries are recorded as NOT_CONFIGURED. */
  readonly configured: boolean;
  /**
   * Sends one message. `idempotencyKey` (the delivery id) lets providers that
   * support it drop a repeated send after a crash between "sent" and "recorded".
   * Throws EmailDeliveryError; returns the provider's message id.
   */
  send(message: EmailMessage, idempotencyKey: string): Promise<{ messageId: string }>;
}

/** `transient`: may succeed later (retried with backoff). `permanent`: never retried. */
export class EmailDeliveryError extends Error {
  constructor(
    readonly kind: 'transient' | 'permanent',
    /** A short, safe code for the record (no addresses or provider bodies). */
    readonly code: string,
  ) {
    super(`Email delivery failed (${kind}: ${code})`);
    this.name = 'EmailDeliveryError';
  }
}

export class NotConfiguredEmailProvider implements EmailProvider {
  readonly id = 'none';
  readonly configured = false;
  send(): Promise<{ messageId: string }> {
    return Promise.reject(new EmailDeliveryError('permanent', 'not_configured'));
  }
}
