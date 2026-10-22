import { describe, expect, it } from 'vitest';
import {
  DEMO_PAYMENT_NOTICE,
  DEMO_PAYMENT_SCENARIOS,
  bookingPaymentSchema,
  bookingStatusSchema,
  createPaymentRequestSchema,
  paymentIdSchema,
  paymentSchema,
  paymentStatusSchema,
} from '../src/index.js';

const amount = { amountMinor: '2340000', currency: 'INR' };

describe('payment contracts', () => {
  it('a payment request carries an amount to compare and, optionally, a demo scenario; never a status', () => {
    expect(createPaymentRequestSchema.parse({ amount })).toEqual({ amount });
    expect(createPaymentRequestSchema.parse({ amount, demoScenario: 'pending' }).demoScenario).toBe(
      'pending',
    );
    for (const body of [
      { amount, status: 'succeeded' },
      { amount, demoScenario: 'refund' },
      { amount, card: { number: '4242424242424242' } },
      { amount: { amountMinor: '12.5', currency: 'INR' } },
      { amount: { amountMinor: '100', currency: 'inr' } },
      {},
    ]) {
      expect(createPaymentRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('names the documented statuses and demo scenarios', () => {
    expect(paymentStatusSchema.options).toEqual([
      'created',
      'pending',
      'succeeded',
      'failed',
      'cancelled',
      'refund_pending',
      'refunded',
    ]);
    expect(DEMO_PAYMENT_SCENARIOS).toEqual(['succeed', 'decline', 'pending', 'pending-decline']);
    expect(bookingStatusSchema.options).toContain('expired');
    expect(DEMO_PAYMENT_NOTICE).toBe('Demo payment — no real money was charged.');
  });

  it('payment ids are UUIDs', () => {
    expect(paymentIdSchema.safeParse('01890000-0000-7000-8000-000000000001').success).toBe(true);
    expect(paymentIdSchema.safeParse('../../etc').success).toBe(false);
  });

  it('a payment response has no provider reference or secret fields', () => {
    for (const key of Object.keys(paymentSchema.shape)) {
      expect(key).not.toMatch(/secret|token|card|providerReference|signature/i);
    }
  });

  it('a booking’s payment side', () => {
    expect(
      bookingPaymentSchema.parse({
        mode: 'demo',
        state: 'unpaid',
        amount,
        dueAt: '2026-10-22T10:30:00.000Z',
        canPay: true,
        activePaymentId: null,
        demoScenarios: ['succeed'],
      }).state,
    ).toBe('unpaid');
  });
});
