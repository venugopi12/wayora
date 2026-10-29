import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminBookingDetailSchema,
  adminBookingListSchema,
  bookingRequirementsFor,
  bookingSchema,
  offerResponseSchema,
  type Booking,
  type SearchResult,
} from '@wayora/contracts';
import { createProviderRegistry, createReservationService } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
import { DEMO_PROVIDERS } from '../../src/modules/providers/demo/index.js';
import {
  FIXTURE_CONFIG,
  FixtureSupplierServer,
  createFixtureAirProvider,
  type FixtureReservationOptions,
} from '../fixture-supplier.js';
import { buildTestApp, validEnvSource } from '../helpers.js';
import { NO_RETRY, VALID_INPUTS } from '../search-support.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Supplier reservations against a real PostgreSQL (Phase 23,
 * docs/bookings.md#supplier-reservations), through the TEST-ONLY fictional
 * supplier (fixture-supplier.ts). No real supplier is integrated: these
 * tests prove the lifecycle, not compatibility with any real API.
 */

const PASSWORD = 'blue river morning';
const MINUTE = 60_000;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the reservation tests would be skipped.',
  );
}

const BASE_ENV: Partial<Env> = {
  SEARCH_DEMO_PROVIDERS: 'false',
  SUPPLIER_RESERVATIONS_ENABLED: 'true',
  SUPPLIER_RESERVATION_TIMEOUT_MS: 1_000,
  BOOKING_RATE_LIMIT_MAX: 1000,
  // Moving the clock past checks must not sign anyone out.
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
};
const RECOVERY = {
  baseDelayMs: 30_000,
  maxDelayMs: 10 * MINUTE,
  maxChecks: 4,
  maxResends: 3,
  notFoundGraceMs: 15 * MINUTE,
  unsentGraceMs: MINUTE,
};

function setup(
  options: {
    reservations?: FixtureReservationOptions;
    env?: Partial<Env>;
    withDemo?: boolean;
  } = {},
) {
  const server = new FixtureSupplierServer();
  const clock = testClock();
  const provider = createFixtureAirProvider(FIXTURE_CONFIG, {
    fetch: server.fetch,
    reservations: options.reservations ?? { lookup: true, cancel: true },
  });
  const providers = [provider, ...(options.withDemo ? DEMO_PROVIDERS : [])];
  const envOverrides = { ...BASE_ENV, ...options.env };
  const app = buildTestApp({
    prisma: testPrisma(),
    env: envOverrides,
    logger: pino({ level: 'silent' }),
    searchProviders: providers,
    providerConfig: FIXTURE_CONFIG,
    searchResilience: NO_RETRY,
    now: clock.now,
    reservations: { recovery: RECOVERY, random: () => 0.5 },
  });
  // What the server's recovery timer runs: same providers, same database.
  const env: Env = { ...parseEnv(validEnvSource), ...envOverrides };
  const recovery = createReservationService(
    testPrisma(),
    env,
    pino({ level: 'silent' }),
    createProviderRegistry(env, FIXTURE_CONFIG, providers),
    { now: clock.now, recovery: RECOVERY, random: () => 0.5 },
  );
  return { app, server, clock, recovery };
}

async function signedIn(target: ReturnType<typeof setup>['app'], email = 'asha@example.com') {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function searchFlights(agent: Agent) {
  const { serviceType: _t, ...body } = VALID_INPUTS.flights;
  const res = await agent.post('/api/v1/search/flights').set('Origin', ORIGIN).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    searchId: res.body.data.searchId as string,
    offer: (res.body.data.results as SearchResult[])[0]!,
  };
}

function bookingBody(searchId: string, offer: SearchResult, extra: object = {}) {
  const requirements = bookingRequirementsFor(offer);
  return {
    serviceType: offer.serviceType,
    searchId,
    offerId: offer.id,
    travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
    acceptedPrice: offer.price,
    acceptSupplierTerms: true,
    ...extra,
  };
}

const post = (agent: Agent, body: object, key: string = randomUUID()) =>
  agent.post('/api/v1/bookings').set('Origin', ORIGIN).set('Idempotency-Key', key).send(body);

async function book(agent: Agent, extra: object = {}, key?: string) {
  const { searchId, offer } = await searchFlights(agent);
  const res = await post(agent, bookingBody(searchId, offer, extra), key);
  return { res, searchId, offer };
}

const parsed = (body: { data: unknown }): Booking => bookingSchema.parse(body.data);
const reservationRow = async (reference: string) =>
  testPrisma().supplierReservation.findFirstOrThrow({
    where: { booking: { reference } },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
const getBooking = async (agent: Agent, reference: string) =>
  parsed((await agent.get(`/api/v1/bookings/${reference}`)).body);

/**
 * A supplier booking whose reservation was recorded but never sent (as if
 * the API stopped between committing and sending), copied from an existing
 * booking's offer. Its first check is due a minute after `now`.
 */
async function unsentReservation(from: string, now: Date) {
  const prisma = testPrisma();
  const source = await prisma.booking.findUniqueOrThrow({
    where: { reference: from },
    include: { travellers: true },
  });
  const booking = await prisma.booking.create({
    data: {
      reference: 'WY-2345-6789',
      userId: source.userId,
      category: source.category,
      status: 'PENDING',
      isDemo: false,
      provider: source.provider,
      offerSnapshot: source.offerSnapshot as object,
      partySize: source.partySize,
      currency: source.currency,
      totalAmountMinor: source.totalAmountMinor,
      paymentMode: 'NONE',
      travellers: {
        create: source.travellers.map((t) => ({
          position: t.position,
          type: t.type,
          firstName: t.firstName,
          lastName: t.lastName,
        })),
      },
      events: { create: { toStatus: 'PENDING', actorType: 'USER', note: 'Test' } },
    },
  });
  return prisma.supplierReservation.create({
    data: {
      bookingId: booking.id,
      provider: source.provider!,
      idempotencyKey: randomUUID(),
      nextCheckAt: new Date(now.getTime() + MINUTE),
    },
  });
}

describe.skipIf(!TEST_DATABASE_URL)('supplier reservations (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('making a reservation', () => {
    it('confirmed only by the supplier: reference, ticket, separate states, server-trusted request', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      const { res, offer } = await book(agent);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const booking = parsed(res.body);
      expect(booking.reference).toMatch(/^WY-/);
      expect(booking).toMatchObject({
        status: 'confirmed',
        demo: false,
        reservation: {
          kind: 'supplier',
          state: 'confirmed',
          supplierReference: 'FXR00001',
          priceMismatch: false,
          needsAttention: false,
        },
        payment: { mode: 'none', state: 'not-required' },
        refund: { state: 'not-applicable' },
        documents: {
          state: 'issued',
          items: [{ type: 'ticket', reference: '098000010001', travellerName: 'Asha Rao' }],
        },
      });
      expect(booking.reservation.explanation).toBe(
        'Fixture Air (test supplier) confirmed this reservation.',
      );
      expect(booking.history.map((h) => [h.status, h.by])).toEqual([
        ['pending', 'you'],
        ['confirmed', 'supplier'],
      ]);

      // Exactly one request, built from the server's records (never the client's).
      const sent = server.callsTo('POST', '/api/v1/reservations');
      expect(sent).toHaveLength(1);
      const row = await reservationRow(booking.reference);
      expect(sent[0]!.body).toEqual({
        offerRef: offer.offerRef,
        idempotencyKey: row.idempotencyKey,
        bookingReference: booking.reference,
        expectedTotal: { amount: '4520.50', currency: 'INR' },
        passengers: [{ firstName: 'Asha', lastName: 'Rao', type: 'adult' }],
        contactPhone: null,
      });
      expect(row).toMatchObject({ status: 'CONFIRMED', attempts: 1, ambiguous: false });
      expect(row.events.map((e) => [e.fromStatus, e.toStatus, e.actorType])).toEqual([
        [null, 'PENDING', 'USER'],
        ['PENDING', 'IN_PROGRESS', 'SYSTEM'],
        ['IN_PROGRESS', 'CONFIRMED', 'PROVIDER'],
      ]);
      const db = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: booking.reference },
        select: { isDemo: true, providerReference: true, paymentMode: true },
      });
      expect(db).toEqual({ isDemo: false, providerReference: 'FXR00001', paymentMode: 'NONE' });
      const notes = await testPrisma().notification.findMany({ orderBy: { createdAt: 'asc' } });
      expect(notes.map((n) => [n.type, n.isDemo])).toEqual([
        ['BOOKING_CREATED', false],
        ['BOOKING_CONFIRMED', false],
      ]);
      expect(notes[1]!.message).toContain('FXR00001');
      expect(
        await testPrisma().auditLog.count({ where: { action: 'reservation.confirmed' } }),
      ).toBe(1);
    });

    it('a refusal fails it: nothing reserved, no reference, a plain reason', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'reject', status: 409 };
      const { res } = await book(agent);
      expect(res.status).toBe(201);
      const booking = parsed(res.body);
      expect(booking).toMatchObject({
        status: 'failed',
        reservation: { state: 'failed', supplierReference: null },
        documents: { state: 'none-issued', items: [] },
        cancellation: { available: false },
      });
      expect(booking.reservation.explanation).toContain('the offer was no longer available');
      expect((await reservationRow(booking.reference)).errorCategory).toBe('OFFER_UNAVAILABLE');
      expect(
        (await testPrisma().notification.findFirstOrThrow({ where: { type: 'BOOKING_FAILED' } }))
          .isDemo,
      ).toBe(false);
    });

    it('a supplier that accepts without confirming stays in progress until a lookup confirms it', async () => {
      const { app, server, clock, recovery } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'pending' };
      const booking = parsed((await book(agent)).res.body);
      expect(booking).toMatchObject({ status: 'pending', reservation: { state: 'in-progress' } });
      expect(booking.reservation.supplierReference).toBeNull(); // not confirmed yet

      clock.advance(MINUTE);
      server.confirmPending();
      expect(await recovery.reconcileDue()).toBe(1);
      const after = await getBooking(agent, booking.reference);
      expect(after).toMatchObject({ status: 'confirmed', reservation: { state: 'confirmed' } });
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });

    it('a different confirmed price is still a confirmation, flagged for staff', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'confirm', total: { amount: '4999.00', currency: 'INR' } };
      const booking = parsed((await book(agent)).res.body);
      expect(booking).toMatchObject({
        status: 'confirmed',
        reservation: { state: 'confirmed', priceMismatch: true, needsAttention: true },
      });
      expect(booking.reservation.explanation).toMatch(/different from the one you booked/);
    });
  });

  describe('ambiguous outcomes: never assumed, never sent blindly again', () => {
    it('a timeout after the supplier reserved it: unknown, then the lookup settles it', async () => {
      const { app, server, clock, recovery } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const key = randomUUID();
      const { res, searchId, offer } = await book(agent, {}, key);
      const booking = parsed(res.body);
      expect(booking).toMatchObject({
        status: 'pending',
        reservation: { state: 'unknown', supplierReference: null },
        cancellation: { available: false },
      });
      expect(booking.reservation.explanation).toMatch(/won’t send another request/);
      const row = await reservationRow(booking.reference);
      expect(row).toMatchObject({ status: 'UNKNOWN', ambiguous: true, errorCategory: 'TIMEOUT' });

      // The same request again: the same booking, and nothing more sent.
      const replay = await post(agent, bookingBody(searchId, offer), key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.data.reference).toBe(booking.reference);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);

      // Not due yet: nothing happens.
      expect(await recovery.reconcileDue()).toBe(0);
      clock.advance(MINUTE);
      expect(await recovery.reconcileDue()).toBe(1);
      const after = await getBooking(agent, booking.reference);
      expect(after).toMatchObject({
        status: 'confirmed',
        reservation: { state: 'confirmed', supplierReference: 'FXR00001' },
      });
      expect(server.reservations).toHaveLength(1); // one reservation at the supplier
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
      expect(server.callsTo('GET', '/api/v1/reservations')).toHaveLength(1);
      expect((await reservationRow(booking.reference)).events.map((e) => e.toStatus)).toEqual([
        'PENDING',
        'IN_PROGRESS',
        'UNKNOWN',
        'CONFIRMED',
      ]);
    });

    it('server errors and unreadable answers are unknown, never failed', async () => {
      const cases = [
        [{ kind: 'store-then-status', status: 500 }, 'UNAVAILABLE'],
        [{ kind: 'store-then-status', status: 503 }, 'UNAVAILABLE'],
        [{ kind: 'store-then-garble' }, 'INVALID_RESPONSE'],
      ] as const;
      for (const [behaviour, category] of cases) {
        await resetAccounts();
        const { app, server } = setup();
        const agent = await signedIn(app);
        server.reserveBehaviour = behaviour;
        const booking = parsed((await book(agent)).res.body);
        expect([booking.status, booking.reservation.state], behaviour.kind).toEqual([
          'pending',
          'unknown',
        ]);
        expect((await reservationRow(booking.reference)).errorCategory).toBe(category);
      }
    });

    it('the supplier has no record of it: failed only after a grace period', async () => {
      const { app, server, clock, recovery } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'status', status: 502 }; // never stored
      const booking = parsed((await book(agent)).res.body);
      expect(booking.reservation.state).toBe('unknown');
      clock.advance(MINUTE);
      await recovery.reconcileDue();
      expect((await getBooking(agent, booking.reference)).reservation.state).toBe('unknown');
      clock.advance(16 * MINUTE);
      await recovery.reconcileDue();
      const after = await getBooking(agent, booking.reference);
      expect(after).toMatchObject({ status: 'failed', reservation: { state: 'failed' } });
      expect(after.reservation.explanation).toContain('it has no record of the request');
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });

    it('without a lookup, only a de-duplicating supplier gets the request again (same key)', async () => {
      const { app, server, clock, recovery } = setup({
        reservations: { lookup: false, cancel: false, idempotent: true },
      });
      server.dedupe = true;
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const booking = parsed((await book(agent)).res.body);
      expect(booking.reservation.state).toBe('unknown');
      server.reserveBehaviour = { kind: 'confirm', tickets: false };
      clock.advance(MINUTE);
      await recovery.reconcileDue();
      const after = await getBooking(agent, booking.reference);
      expect(after.reservation.state).toBe('confirmed');
      const sent = server.callsTo('POST', '/api/v1/reservations');
      expect(sent).toHaveLength(2);
      const keys = sent.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(server.reservations).toHaveLength(1); // the supplier de-duplicated it
      expect((await reservationRow(booking.reference)).attempts).toBe(2);
    });

    it('without a lookup or de-duplication: handed to staff, never resent', async () => {
      const { app, server, clock, recovery } = setup({
        reservations: { lookup: false, cancel: false, idempotent: false },
      });
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const booking = parsed((await book(agent)).res.body);
      expect(booking.reservation).toMatchObject({ state: 'unknown', needsAttention: true });
      expect(booking.reservation.explanation).toMatch(/Our team is confirming it/);
      clock.advance(60 * MINUTE);
      expect(await recovery.reconcileDue()).toBe(0);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });

    it('a lookup that keeps failing stops after a bounded number of checks', async () => {
      const { app, server, clock, recovery } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      server.lookupStatus = 503;
      const booking = parsed((await book(agent)).res.body);
      for (let i = 0; i < 10; i += 1) {
        clock.advance(20 * MINUTE);
        await recovery.reconcileDue();
      }
      const row = await reservationRow(booking.reference);
      expect(row).toMatchObject({ status: 'UNKNOWN', needsAttention: true, checks: 4 });
      expect(server.callsTo('GET', '/api/v1/reservations')).toHaveLength(4);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });

    it('a reservation recorded but never sent (the process stopped) is sent by recovery, once', async () => {
      const { app, server, clock, recovery } = setup();
      const agent = await signedIn(app);
      const first = parsed((await book(agent)).res.body);
      // The crash window: a booking and reservation committed, nothing sent.
      const unsent = await unsentReservation(first.reference, clock.now());
      const sentBefore = server.callsTo('POST', '/api/v1/reservations').length;
      // Not due before the grace period; then two recoveries race for it.
      expect(await recovery.reconcileDue()).toBe(0);
      clock.advance(MINUTE);
      await Promise.all([recovery.reconcileDue(), recovery.reconcileDue()]);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(sentBefore + 1);
      const after = await testPrisma().booking.findUniqueOrThrow({
        where: { id: unsent.bookingId },
        include: { reservation: true },
      });
      expect([after.status, after.reservation?.status, after.reservation?.attempts]).toEqual([
        'CONFIRMED',
        'CONFIRMED',
        1,
      ]);
      // Settled rows are never touched again.
      clock.advance(60 * MINUTE);
      expect(await recovery.reconcileDue()).toBe(0);
    });
  });

  describe('duplicate protection', () => {
    it('concurrent requests with one key make one booking and one supplier request', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      const { searchId, offer } = await searchFlights(agent);
      const key = randomUUID();
      const body = bookingBody(searchId, offer);
      const results = await Promise.all([post(agent, body, key), post(agent, body, key)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      expect(statuses).toContain(201);
      expect(await testPrisma().booking.count()).toBe(1);
      expect(await testPrisma().supplierReservation.count()).toBe(1);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });

    it('a key reused with a different request is refused before anything is sent', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      const { searchId, offer } = await searchFlights(agent);
      const key = randomUUID();
      expect((await post(agent, bookingBody(searchId, offer), key)).status).toBe(201);
      const reused = await post(
        agent,
        bookingBody(searchId, offer, { travellers: [{ firstName: 'Ravi', lastName: 'Rao' }] }),
        key,
      );
      expect([reused.status, reused.body.error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
    });
  });

  describe('what can be booked, and when', () => {
    it('off unless switched on; an open breaker or estimate prices refuse before recording anything', async () => {
      const off = setup({ env: { SUPPLIER_RESERVATIONS_ENABLED: 'false' } });
      const agent = await signedIn(off.app);
      const { res } = await book(agent);
      expect([res.status, res.body.error.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
      const { searchId, offer } = await searchFlights(agent);
      const shown = await agent.get(
        `/api/v1/search/flights/sessions/${searchId}/offer?id=${encodeURIComponent(offer.id)}`,
      );
      expect(offerResponseSchema.parse(shown.body.data).booking).toMatchObject({
        available: false,
        kind: 'supplier',
      });
      expect(off.server.callsTo('POST', '/api/v1/reservations')).toHaveLength(0);
      expect(await testPrisma().booking.count()).toBe(0);

      await resetAccounts();
      const on = setup();
      const agent2 = await signedIn(on.app);
      const found = await searchFlights(agent2);
      const offerPage = await agent2.get(
        `/api/v1/search/flights/sessions/${found.searchId}/offer?id=${encodeURIComponent(found.offer.id)}`,
      );
      expect(offerResponseSchema.parse(offerPage.body.data).booking).toEqual({
        available: true,
        kind: 'supplier',
        reason: null,
      });
      // The demo terms don't cover a supplier booking.
      const demoTerms = await post(
        agent2,
        bookingBody(found.searchId, found.offer, {
          acceptSupplierTerms: undefined,
          acceptDemoTerms: true,
        }),
      );
      expect(demoTerms.status).toBe(400);
      expect(demoTerms.body.error.details[0].path).toBe('body.acceptSupplierTerms');
      expect(await testPrisma().booking.count()).toBe(0);
    });

    it('a supplier switched off after recording: nothing was sent, so it fails', async () => {
      const { app, server, clock } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'confirm' };
      const booking = parsed((await book(agent)).res.body);
      expect(booking.status).toBe('confirmed');
      // A reservation left unsent, then the supplier's configuration removed.
      const pending = await unsentReservation(booking.reference, clock.now());
      clock.advance(MINUTE);
      const env: Env = { ...parseEnv(validEnvSource), ...BASE_ENV };
      const unconfigured = createReservationService(
        testPrisma(),
        env,
        pino({ level: 'silent' }),
        createProviderRegistry(env, {}, [
          createFixtureAirProvider({}, { fetch: server.fetch, reservations: { lookup: true } }),
        ]),
        { now: clock.now },
      );
      const sentBefore = server.callsTo('POST', '/api/v1/reservations').length;
      await unconfigured.reconcileDue();
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(sentBefore);
      const after = await testPrisma().booking.findUniqueOrThrow({
        where: { id: pending.bookingId },
        include: { reservation: true },
      });
      expect([after.status, after.reservation?.status, after.reservation?.errorCategory]).toEqual([
        'FAILED',
        'FAILED',
        'UNAVAILABLE',
      ]);
    });
  });

  describe('cancellation', () => {
    async function confirmedBooking(options: Parameters<typeof setup>[0] = {}) {
      const ctx = setup(options);
      const agent = await signedIn(ctx.app);
      const booking = parsed((await book(agent)).res.body);
      expect(booking.status).toBe('confirmed');
      const cancel = () =>
        agent.post(`/api/v1/bookings/${booking.reference}/cancel`).set('Origin', ORIGIN);
      return { ...ctx, agent, booking, cancel };
    }

    it('cancelled only when the supplier confirms; a second request changes nothing', async () => {
      const { booking, cancel, server, agent } = await confirmedBooking();
      expect(booking.cancellation).toMatchObject({ available: true, state: 'not-requested' });
      const res = await cancel();
      expect(res.status).toBe(200);
      const after = parsed(res.body);
      expect(after).toMatchObject({
        status: 'cancelled',
        reservation: { state: 'cancelled', supplierReference: 'FXR00001' },
        cancellation: { state: 'cancelled', available: false },
        refund: { state: 'not-applicable' },
      });
      expect(after.history.at(-1)).toMatchObject({ status: 'cancelled', by: 'supplier' });
      const again = await cancel();
      expect([again.status, again.body.error.code]).toEqual([409, 'BOOKING_NOT_CANCELLABLE']);
      expect(server.callsTo('POST', '/api/v1/reservations/FXR00001/cancel')).toHaveLength(1);
      const row = await reservationRow(booking.reference);
      expect(row.cancellationReference).toBe('FXC00001');
      expect((await getBooking(agent, booking.reference)).status).toBe('cancelled');
    });

    it('a refused cancellation leaves it confirmed and says so', async () => {
      const { cancel, server, booking, agent } = await confirmedBooking();
      server.cancelBehaviour = { kind: 'refuse' };
      const res = await cancel();
      expect([res.status, res.body.error.code]).toEqual([409, 'BOOKING_NOT_CANCELLABLE']);
      expect(res.body.error.message).toMatch(
        /refused to cancel this booking, so it stays confirmed/,
      );
      const after = await getBooking(agent, booking.reference);
      expect(after).toMatchObject({ status: 'confirmed', reservation: { state: 'confirmed' } });
      expect((await reservationRow(booking.reference)).errorCategory).toBe('NOT_CANCELLABLE');
    });

    it('an unanswered cancellation stays pending (no duplicate calls) until a lookup confirms it', async () => {
      const { cancel, server, booking, agent, clock, recovery } = await confirmedBooking();
      server.cancelBehaviour = { kind: 'cancel-then-hang' };
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(parsed(res.body)).toMatchObject({
        status: 'confirmed',
        reservation: { state: 'cancellation-pending' },
        cancellation: { state: 'pending', available: false },
      });
      const twice = await cancel();
      expect(twice.status).toBe(409);
      expect(server.callsTo('POST', '/api/v1/reservations/FXR00001/cancel')).toHaveLength(1);
      clock.advance(MINUTE);
      await recovery.reconcileDue();
      expect(await getBooking(agent, booking.reference)).toMatchObject({
        status: 'cancelled',
        reservation: { state: 'cancelled' },
      });
    });

    it('a supplier without cancellation: refused with how to cancel, nothing sent', async () => {
      const { cancel, server, booking } = await confirmedBooking({
        reservations: { lookup: true, cancel: false },
      });
      expect(booking.cancellation.available).toBe(false);
      expect(booking.cancellation.explanation).toMatch(/isn’t available through Wayora/);
      const res = await cancel();
      expect([res.status, res.body.error.code]).toEqual([409, 'BOOKING_NOT_CANCELLABLE']);
      expect(server.callsTo('POST', '/api/v1/reservations/FXR00001/cancel')).toHaveLength(0);
    });

    it('a booking the supplier hasn’t confirmed can’t be cancelled', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const booking = parsed((await book(agent)).res.body);
      const res = await agent
        .post(`/api/v1/bookings/${booking.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect([res.status, res.body.error.code]).toEqual([409, 'BOOKING_NOT_CANCELLABLE']);
      expect(res.body.error.message).toMatch(/hasn’t confirmed this booking yet/);
    });
  });

  describe('ownership, staff and integrity', () => {
    it('another user can’t see or cancel it; support sees a masked reference and no actions', async () => {
      const { app } = setup();
      const asha = await signedIn(app);
      const booking = parsed((await book(asha)).res.body);
      const ravi = await signedIn(app, 'ravi@example.com');
      expect((await ravi.get(`/api/v1/bookings/${booking.reference}`)).status).toBe(404);
      const cancel = await ravi
        .post(`/api/v1/bookings/${booking.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(cancel.status).toBe(404);

      await signedIn(app, 'support@example.com');
      await setUserRole(testPrisma(), {
        email: 'support@example.com',
        role: 'support',
        reason: 'Test setup',
        actor: 'test',
      });
      const support = request.agent(app);
      await support
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'support@example.com', password: PASSWORD })
        .expect(200);
      const detail = adminBookingDetailSchema.parse(
        (await support.get(`/api/v1/admin/bookings/${booking.reference}`)).body.data,
      );
      expect(detail.reservation).toMatchObject({
        status: 'confirmed',
        supplierReference: '••••0001',
        actions: { recheck: false, resolve: false },
        capabilities: { lookup: true, cancel: true, idempotentReserve: false },
      });
      expect(detail.supplierReference).toBe('••••0001');
      expect(JSON.stringify(detail)).not.toContain('FXR00001');
      const denied = await support
        .post(`/api/v1/admin/bookings/${booking.reference}/reservation/recheck`)
        .set('Origin', ORIGIN);
      expect(denied.status).toBe(403);
      expect(await testPrisma().auditLog.count({ where: { action: 'admin.access_denied' } })).toBe(
        1,
      );
    });

    it('admins resolve what recovery can’t, with a reason, and never send a reservation', async () => {
      const { app, server } = setup({
        reservations: { lookup: false, cancel: false, idempotent: false },
      });
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const booking = parsed((await book(agent)).res.body);
      await signedIn(app, 'admin@example.com');
      await setUserRole(testPrisma(), {
        email: 'admin@example.com',
        role: 'admin',
        reason: 'Test setup',
        actor: 'test',
      });
      const admin = request.agent(app);
      await admin
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'admin@example.com', password: PASSWORD })
        .expect(200);
      const list = adminBookingListSchema.parse(
        (await admin.get('/api/v1/admin/bookings?attention=true')).body.data,
      );
      expect(list.items.map((b) => [b.reference, b.reservationStatus, b.needsAttention])).toEqual([
        [booking.reference, 'unknown', true],
      ]);
      const detail = adminBookingDetailSchema.parse(
        (await admin.get(`/api/v1/admin/bookings/${booking.reference}`)).body.data,
      );
      expect(detail.reservation).toMatchObject({
        status: 'unknown',
        ambiguous: true,
        needsAttention: true,
        errorCategory: 'TIMEOUT',
        attempts: 1,
        actions: { recheck: false, resolve: true },
      });
      // No lookup: recheck isn't offered.
      const recheck = await admin
        .post(`/api/v1/admin/bookings/${booking.reference}/reservation/recheck`)
        .set('Origin', ORIGIN);
      expect(recheck.status).toBe(409);

      const resolve = (body: object) =>
        admin
          .post(`/api/v1/admin/bookings/${booking.reference}/reservation/resolve`)
          .set('Origin', ORIGIN)
          .send(body);
      expect((await resolve({ outcome: 'confirmed', supplierReference: 'FXR00001' })).status).toBe(
        400,
      ); // a reason is required
      const done = await resolve({
        outcome: 'confirmed',
        supplierReference: 'FXR00001',
        reason: 'Confirmed by phone with the supplier desk.',
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(adminBookingDetailSchema.parse(done.body.data).reservation).toMatchObject({
        status: 'confirmed',
        supplierReference: 'FXR00001',
        needsAttention: false,
      });
      const mine = await getBooking(agent, booking.reference);
      expect(mine).toMatchObject({ status: 'confirmed', reservation: { state: 'confirmed' } });
      expect(mine.history.at(-1)!.by).toBe('wayora');
      expect(JSON.stringify(mine)).not.toContain('supplier desk'); // the reason stays staff-only
      expect(server.callsTo('POST', '/api/v1/reservations')).toHaveLength(1);
      const audit = await testPrisma().auditLog.findFirstOrThrow({
        where: { action: 'reservation.resolved_manually' },
      });
      expect(audit.metadata).toMatchObject({ outcome: 'confirmed', from: 'UNKNOWN' });
      // Nothing left to resolve.
      const again = await resolve({ outcome: 'failed', reason: 'Trying to undo it again.' });
      expect(again.status).toBe(409);
    });

    it('the database refuses what the rules forbid', async () => {
      const { app, server } = setup();
      const agent = await signedIn(app);
      server.reserveBehaviour = { kind: 'store-then-hang' };
      const booking = parsed((await book(agent)).res.body);
      const prisma = testPrisma();
      const row = await reservationRow(booking.reference);
      // A supplier booking can't be confirmed while its reservation isn't.
      await expect(
        prisma.$executeRaw`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE reference = ${booking.reference}`,
      ).rejects.toThrow(/must follow its supplier reservation/);
      // No ticket for an unconfirmed reservation.
      await expect(
        prisma.travelDocument.create({
          data: {
            reservationId: row.id,
            bookingId: row.bookingId,
            type: 'TICKET',
            reference: 'FAKE-1',
            issuedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/only a confirmed supplier reservation/);
      // Confirmed needs a supplier reference.
      await expect(
        prisma.supplierReservation.update({
          where: { id: row.id },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), ambiguous: false },
        }),
      ).rejects.toThrow(/supplier_reservations_confirmed_chk/);
      // The key is immutable; history is append-only.
      await expect(
        prisma.supplierReservation.update({
          where: { id: row.id },
          data: { idempotencyKey: randomUUID() },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.reservationEvent.deleteMany({ where: { reservationId: row.id } }),
      ).rejects.toThrow(/append-only/);
      // A demo booking can't get a supplier reservation.
      const demoApp = setup({ withDemo: true, env: { SEARCH_DEMO_PROVIDERS: 'true' } });
      const demoAgent = await signedIn(demoApp.app, 'demo@example.com');
      const { serviceType: _t, ...hotel } = VALID_INPUTS.hotels;
      const search = await demoAgent
        .post('/api/v1/search/hotels')
        .set('Origin', ORIGIN)
        .send(hotel);
      const demoOffer = search.body.data.results[0] as SearchResult;
      const demoBooking = await post(demoAgent, {
        ...bookingBody(search.body.data.searchId, demoOffer),
        acceptSupplierTerms: undefined,
        acceptDemoTerms: true,
        ...(bookingRequirementsFor(demoOffer).contactPhone === 'required'
          ? { contactPhone: '+919876543210' }
          : {}),
      });
      expect(demoBooking.status, JSON.stringify(demoBooking.body)).toBe(201);
      expect(demoBooking.body.data.reservation).toMatchObject({ kind: 'demo', state: null });
      expect(demoBooking.body.data.documents.state).toBe('not-applicable');
      const demoRow = await prisma.booking.findUniqueOrThrow({
        where: { reference: demoBooking.body.data.reference },
      });
      await expect(
        prisma.supplierReservation.create({
          data: {
            bookingId: demoRow.id,
            provider: demoRow.provider!,
            idempotencyKey: randomUUID(),
          },
        }),
      ).rejects.toThrow(/only a non-demo booking/);
    });
  });
});
