import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { bookingReferenceSchema, type SearchResult } from '@wayora/contracts';
import { newBookingReference } from '../src/modules/bookings/bookings.service.js';
import { errorCategoryOf } from '../src/modules/bookings/reservations.service.js';
import { ProviderError } from '../src/modules/providers/provider.js';
import { ProviderRegistry } from '../src/modules/providers/registry.js';
import {
  cancellationOutcomeSchema,
  reservationOutcomeSchema,
} from '../src/modules/providers/reservations.js';
import { TimeoutError } from '../src/modules/search/concurrency.js';
import {
  FIXTURE_CONFIG,
  FixtureSupplierServer,
  createFixtureAirProvider,
} from './fixture-supplier.js';

/*
 * Supplier reservations without a database (Phase 23): what the adapter
 * boundary accepts, how unanswered calls are classified, and how the
 * test-only fixture supplier maps its fictional API.
 */

describe('supplier answers are validated before use', () => {
  it('a confirmation needs a real-looking reference; documents are bounded and typed', () => {
    const ok = {
      status: 'confirmed',
      supplierReference: 'ABC123',
      price: { amountMinor: '452050', currency: 'INR' },
      documents: [{ type: 'ticket', reference: '0981234567890', travellerIndex: 0 }],
    };
    expect(reservationOutcomeSchema.parse(ok)).toEqual(ok);
    const bad = (patch: object) => reservationOutcomeSchema.safeParse({ ...ok, ...patch }).success;
    expect(bad({ supplierReference: '' })).toBe(false);
    expect(bad({ supplierReference: '   ' })).toBe(false);
    expect(bad({ supplierReference: 'has space' })).toBe(false);
    expect(bad({ supplierReference: 'x'.repeat(129) })).toBe(false);
    expect(bad({ price: { amountMinor: '4520.50', currency: 'INR' } })).toBe(false); // no decimals
    expect(bad({ price: { amountMinor: '452050', currency: 'rupees' } })).toBe(false);
    expect(bad({ documents: [{ type: 'pnr', reference: 'X', travellerIndex: 0 }] })).toBe(false);
    expect(bad({ documents: [{ type: 'ticket', reference: '', travellerIndex: 0 }] })).toBe(false);
    expect(bad({ documents: [{ type: 'ticket', reference: 'T', travellerIndex: -1 }] })).toBe(
      false,
    );
    expect(bad({ status: 'probably-confirmed' })).toBe(false);
    expect(
      reservationOutcomeSchema.safeParse({ status: 'rejected', reason: 'because' }).success,
    ).toBe(false);
    expect(cancellationOutcomeSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
    expect(
      cancellationOutcomeSchema.safeParse({ status: 'cancelled', cancellationReference: null })
        .success,
    ).toBe(true);
  });

  it('a call without a usable answer gets a normalized category, never supplier text', () => {
    expect(errorCategoryOf(new TimeoutError(1000))).toBe('TIMEOUT');
    expect(errorCategoryOf(new ProviderError('unavailable', 'x answered 503'))).toBe('UNAVAILABLE');
    expect(errorCategoryOf(new ProviderError('error', 'x answered malformed JSON'))).toBe(
      'INVALID_RESPONSE',
    );
    expect(errorCategoryOf(new ZodError([]))).toBe('INVALID_RESPONSE');
    expect(errorCategoryOf(new Error('socket hang up'))).toBe('UNKNOWN');
  });
});

describe('who can book', () => {
  it('declared and implemented booking must agree; demo providers never book', () => {
    const registry = () => new ProviderRegistry({ demoEnabled: true, isConfigured: () => true });
    const base = createFixtureAirProvider(FIXTURE_CONFIG);
    expect(() =>
      registry().register({ ...base, operations: { ...base.operations, book: 'supported' } }),
    ).toThrow(/must agree/);
    const booking = createFixtureAirProvider(FIXTURE_CONFIG, { reservations: {} });
    expect(() =>
      registry().register({
        ...booking,
        operations: { ...booking.operations, book: 'unsupported' },
      }),
    ).toThrow(/must agree/);
    expect(() => registry().register({ ...booking, kind: 'demo' })).toThrow(/demo providers/);
    expect(registry().register(booking).describe()[0]!.operations.book).toBe('supported');
  });

  it('Wayora’s own references: WYD- for demo, WY- for supplier bookings', () => {
    const demo = newBookingReference('demo');
    const supplier = newBookingReference('supplier');
    expect(demo).toMatch(/^WYD-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/);
    expect(supplier).toMatch(/^WY-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/);
    expect(bookingReferenceSchema.parse(supplier.toLowerCase())).toBe(supplier);
    expect(bookingReferenceSchema.safeParse('WYX-2345-6789').success).toBe(false);
  });
});

describe('the fixture supplier’s adapter (test-only)', () => {
  const server = new FixtureSupplierServer();
  const provider = createFixtureAirProvider(FIXTURE_CONFIG, {
    fetch: server.fetch,
    reservations: { lookup: true, cancel: true },
  });
  const ops = provider.reservations!;
  const offer = {
    serviceType: 'flights',
    id: 'fixture-air:FA-1001',
    providerId: 'fixture-air',
    source: 'live',
    offerRef: 'FA-1001',
  } as unknown as SearchResult;
  const request = {
    idempotencyKey: '01890000-0000-7000-8000-000000000001',
    bookingReference: 'WY-2345-6789',
    offer,
    expectedPrice: {
      kind: 'total' as const,
      total: { amountMinor: '452050', currency: 'INR' },
      perUnit: null,
    },
    travellers: [{ firstName: 'Asha', lastName: 'Rao', type: 'adult' as const }],
    contactPhone: null,
    partySize: 1,
  };
  const context = () => ({ signal: new AbortController().signal, now: new Date() });

  it('maps confirmations, refusals and lookups; never invents a reference', async () => {
    expect(ops.settlement).toBe('supplier');
    expect(ops.idempotentReserve).toBe(false);
    const confirmed = await ops.reserve(request, context());
    expect(reservationOutcomeSchema.parse(confirmed)).toMatchObject({
      status: 'confirmed',
      supplierReference: 'FXR00001',
      price: { amountMinor: '452050', currency: 'INR' },
      documents: [{ type: 'ticket', travellerIndex: 0 }],
    });
    for (const [status, reason] of [
      [409, 'offer-unavailable'],
      [422, 'price-changed'],
      [400, 'invalid-details'],
    ] as const) {
      server.reserveBehaviour = { kind: 'reject', status };
      expect(await ops.reserve(request, context())).toEqual({ status: 'rejected', reason });
    }
    // An answer it can't read is thrown (unknown outcome), never a refusal.
    server.reserveBehaviour = { kind: 'store-then-garble' };
    await expect(ops.reserve(request, context())).rejects.toBeInstanceOf(ProviderError);
    server.reserveBehaviour = { kind: 'store-then-status', status: 500 };
    await expect(ops.reserve(request, context())).rejects.toMatchObject({ kind: 'unavailable' });

    expect(
      await ops.lookup!({ ...request, idempotencyKey: 'nope', supplierReference: null }, context()),
    ).toEqual({ status: 'not-found' });
    expect(await ops.lookup!({ ...request, supplierReference: null }, context())).toMatchObject({
      status: 'confirmed',
    });
    expect(
      await ops.cancel!(
        { cancellationKey: 'k', supplierReference: 'FXR00001', bookingReference: 'WY-2345-6789' },
        context(),
      ),
    ).toEqual({ status: 'cancelled', cancellationReference: 'FXC00001' });
    // The request carried the server's price as a decimal and the booking's key.
    expect(server.callsTo('POST', '/api/v1/reservations')[0]!.body).toMatchObject({
      idempotencyKey: request.idempotencyKey,
      expectedTotal: { amount: '4520.50', currency: 'INR' },
    });
  });
});
