import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingListResponseSchema,
  bookingRequirementsFor,
  bookingSchema,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import {
  BookingsService,
  TRANSITIONS,
  newBookingReference,
} from '../../src/modules/bookings/bookings.service.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { DEMO_PROVIDERS } from '../../src/modules/providers/demo/index.js';
import { SearchService } from '../../src/modules/search/search.service.js';
import { MemorySearchSessionStore } from '../../src/modules/search/sessions.js';
import { captureLogs } from '../fake-redis.js';
import { buildTestApp } from '../helpers.js';
import { NO_RETRY, VALID_INPUTS, parse } from '../search-support.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Demo bookings against a real PostgreSQL (TEST_DATABASE_URL, a *_test
 * database): persistence, ownership, idempotency under concurrency,
 * transactions, the lifecycle and the database's own guards.
 */

const PASSWORD = 'blue river morning';
const DAY = 24 * 60 * 60 * 1000;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the booking tests would be skipped.');
}

/** Long sessions, so moving the clock past travel dates doesn't sign anyone out. */
const LONG_SESSIONS: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
};

function app(
  options: { now?: () => Date; logs?: ReturnType<typeof captureLogs>; env?: Partial<Env> } = {},
) {
  return buildTestApp({
    prisma: testPrisma(),
    // Most tests make many bookings quickly; the limit has its own test.
    env: { ...LONG_SESSIONS, BOOKING_RATE_LIMIT_MAX: 1000, ...options.env },
    logger: options.logs ? pino({ level: 'info' }, options.logs.stream) : pino({ level: 'silent' }),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function signedIn(
  target: ReturnType<typeof app>,
  email = 'asha@example.com',
): Promise<Agent> {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

async function search(agent: Agent, type: SearchServiceType, overrides: object = {}) {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const res = await agent
    .post(`/api/v1/search/${type}`)
    .set('Origin', ORIGIN)
    .send({ ...body, ...overrides });
  expect(res.status).toBe(200);
  return {
    searchId: res.body.data.searchId as string,
    offers: res.body.data.results as SearchResult[],
  };
}

const NAMES = ['Asha', 'Ravi', 'Meera', 'Kabir', 'Tara', 'Dev'];

function bookingBody(searchId: string, offer: SearchResult, extra: object = {}) {
  const requirements = bookingRequirementsFor(offer);
  return {
    serviceType: offer.serviceType,
    searchId,
    offerId: offer.id,
    travellers: requirements.namedTravellers.map((_, i) => ({
      firstName: NAMES[i % NAMES.length],
      lastName: 'Rao',
    })),
    ...(requirements.contactPhone === 'required' ? { contactPhone: '+91 98765 43210' } : {}),
    acceptedPrice: offer.price,
    acceptDemoTerms: true,
    ...extra,
  };
}

const book = (agent: Agent, body: object, key: string = randomUUID()) =>
  agent.post('/api/v1/bookings').set('Origin', ORIGIN).set('Idempotency-Key', key).send(body);

const counts = async () => {
  const prisma = testPrisma();
  return {
    bookings: await prisma.booking.count(),
    travellers: await prisma.bookingTraveller.count(),
    events: await prisma.bookingStatusEvent.count(),
    keys: await prisma.idempotencyKey.count(),
  };
};

describe.skipIf(!TEST_DATABASE_URL)('demo bookings (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('creating', () => {
    it('books a flight: server price, typed passengers, immutable snapshot, demo confirmation', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'flights', { adults: 2, children: 1 });
      const offer = offers[0]!;
      const res = await book(agent, bookingBody(searchId, offer));
      expect(res.status).toBe(201);
      const booking = bookingSchema.parse(res.body.data);
      expect(booking.reference).toMatch(/^WYD-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(booking).toMatchObject({
        status: 'confirmed',
        demo: true,
        serviceType: 'flights',
        price: offer.price,
        partySize: 3,
        priceCheck: 'session',
        cancellable: true,
        contactPhone: null,
        offer,
      });
      expect(booking.travellers.map((t) => t.type)).toEqual(['adult', 'adult', 'child']);
      expect(booking.startsOn).toBe(
        offer.serviceType === 'flights' ? offer.itineraries[0]!.departAt.slice(0, 10) : null,
      );
      expect(booking.history.map((h) => [h.status, h.by])).toEqual([
        ['pending', 'you'],
        ['confirmed', 'wayora'],
      ]);
      expect(booking.history[1]!.note).toMatch(/simulated.*did not contact a supplier/i);

      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: booking.reference },
      });
      expect(row).toMatchObject({
        isDemo: true,
        providerReference: null, // no fake PNR
        provider: 'demo-flights',
        currency: 'INR',
        totalAmountMinor: BigInt(
          offer.price!.kind === 'total' ? offer.price!.total.amountMinor : 0,
        ),
        orderId: null,
        searchId,
      });
      expect(row.confirmedAt).not.toBeNull();
    });

    it.each([
      ['hotels', 1, null],
      ['trains', 1, null],
      ['buses', 1, null],
      ['metro', 0, null],
      ['cabs', 1, '+919876543210'],
      ['holidays', 2, null],
    ] as const)('books %s with the details that category needs', async (type, names, phone) => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, type);
      const res = await book(agent, bookingBody(searchId, offers[0]!));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.travellers).toHaveLength(names);
      expect(res.body.data.contactPhone).toBe(phone);
      if (type === 'metro') expect(res.body.data.startsOn).toBeNull();
      if (type === 'cabs') {
        // An estimate: no total is stored, the range is in the snapshot.
        const row = await testPrisma().booking.findUniqueOrThrow({
          where: { reference: res.body.data.reference },
        });
        expect(row.totalAmountMinor).toBeNull();
        expect(res.body.data.price.kind).toBe('range');
      }
    });

    it('validates the details each category needs', async () => {
      const agent = await signedIn(app());
      const flights = await search(agent, 'flights', { adults: 2 });
      const flight = flights.offers[0]!;
      const wrongCount = await book(agent, {
        ...bookingBody(flights.searchId, flight),
        travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
      });
      expect(wrongCount.status).toBe(400);
      expect(wrongCount.body.error.details).toEqual([
        expect.objectContaining({
          path: 'body.travellers',
          message: 'Enter 2 names for this booking.',
        }),
      ]);
      const badName = await book(agent, {
        ...bookingBody(flights.searchId, flight),
        travellers: [
          { firstName: 'Asha1', lastName: 'Rao' },
          { firstName: '', lastName: 'Rao' },
        ],
      });
      expect(badName.status).toBe(400);
      expect([...new Set(badName.body.error.details.map((d: { path: string }) => d.path))]).toEqual(
        ['body.travellers.0.firstName', 'body.travellers.1.firstName'],
      );
      // Cabs need a phone; hotels must not be sent one (it wouldn't be needed or stored).
      const cabs = await search(agent, 'cabs');
      const noPhone = await book(agent, {
        ...bookingBody(cabs.searchId, cabs.offers[0]!),
        contactPhone: undefined,
      });
      expect(noPhone.body.error.details).toEqual([
        expect.objectContaining({ path: 'body.contactPhone' }),
      ]);
      const hotels = await search(agent, 'hotels');
      const extraPhone = await book(agent, {
        ...bookingBody(hotels.searchId, hotels.offers[0]!),
        contactPhone: '+919876543210',
      });
      expect(extraPhone.status).toBe(400);
      expect(await counts()).toMatchObject({ bookings: 0, keys: 0 }); // failed attempts leave nothing
    });

    it('never takes the price from the client: tampered or stale prices are refused', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'hotels');
      const offer = offers[0]!;
      const cheaper = structuredClone(offer.price!);
      if (cheaper.kind === 'total') cheaper.total.amountMinor = '100';
      const tampered = await book(agent, bookingBody(searchId, offer, { acceptedPrice: cheaper }));
      expect(tampered.status).toBe(409);
      expect(tampered.body.error.code).toBe('PRICE_CHANGED');
      const otherCurrency = structuredClone(offer.price!);
      if (otherCurrency.kind === 'total') {
        otherCurrency.total.currency = 'USD';
        if (otherCurrency.perUnit) otherCurrency.perUnit.amount.currency = 'USD';
      }
      expect(
        (await book(agent, bookingBody(searchId, offer, { acceptedPrice: otherCurrency }))).body
          .error.code,
      ).toBe('PRICE_CHANGED');
      // A client total, a status or a user id are not part of the request at all.
      for (const extra of [{ total: '1' }, { status: 'confirmed' }, { userId: randomUUID() }]) {
        expect((await book(agent, bookingBody(searchId, offer, extra))).status).toBe(400);
      }
      expect(await counts()).toMatchObject({ bookings: 0 });
    });

    it('expired searches, unknown offers and category mix-ups are actionable errors', async () => {
      const clock = testClock();
      const target = app({ now: clock.now });
      const agent = await signedIn(target);
      const { searchId, offers } = await search(agent, 'hotels');
      const body = bookingBody(searchId, offers[0]!);
      const flights = await search(agent, 'flights');

      expect((await book(agent, { ...body, offerId: 'demo-hotels:nope' })).body.error.code).toBe(
        'OFFER_NOT_IN_SEARCH',
      );
      expect((await book(agent, { ...body, serviceType: 'flights' })).body.error.code).toBe(
        'CATEGORY_MISMATCH',
      );
      expect((await book(agent, { ...body, offerId: flights.offers[0]!.id })).body.error.code).toBe(
        'CATEGORY_MISMATCH',
      );
      clock.advance(11 * 60 * 1000); // past the 10-minute search session
      const expired = await book(agent, body);
      expect(expired.status).toBe(410);
      expect(expired.body.error).toMatchObject({
        code: 'SEARCH_EXPIRED',
        message: expect.stringMatching(/Search again/),
      });
      expect(await counts()).toMatchObject({ bookings: 0, keys: 0 });
    });

    it('requires a session, the demo terms, a trusted origin and an Idempotency-Key', async () => {
      const target = app();
      const agent = await signedIn(target);
      const { searchId, offers } = await search(agent, 'hotels');
      const body = bookingBody(searchId, offers[0]!);
      const anonymous = await request(target)
        .post('/api/v1/bookings')
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .send(body);
      expect(anonymous.status).toBe(401);
      expect((await book(agent, { ...body, acceptDemoTerms: false })).status).toBe(400);
      const noKey = await agent.post('/api/v1/bookings').set('Origin', ORIGIN).send(body);
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.message).toMatch(/Idempotency-Key/);
      expect((await book(agent, body, 'short')).status).toBe(400);
      const csrf = await agent
        .post('/api/v1/bookings')
        .set('Origin', 'https://evil.example')
        .set('Idempotency-Key', randomUUID())
        .send(body);
      expect(csrf.status).toBe(403);
      expect(await counts()).toMatchObject({ bookings: 0 });
    });

    it('limits booking writes per signed-in user, not per IP', async () => {
      const target = app({ env: { BOOKING_RATE_LIMIT_MAX: 2 } });
      const asha = await signedIn(target);
      const { searchId, offers } = await search(asha, 'hotels');
      const body = bookingBody(searchId, offers[0]!);
      expect((await book(asha, body)).status).toBe(201);
      expect((await book(asha, body)).status).toBe(201);
      const limited = await book(asha, body);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      // Reading isn't limited by it, and another account (same IP) has its own budget.
      expect((await asha.get('/api/v1/bookings')).status).toBe(200);
      const ravi = await signedIn(target, 'ravi@example.com');
      const other = await search(ravi, 'hotels');
      expect((await book(ravi, bookingBody(other.searchId, other.offers[0]!))).status).toBe(201);
      expect(await counts()).toMatchObject({ bookings: 3 });
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key returns the same booking (replayed), never a second one', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'trains');
      const body = bookingBody(searchId, offers[0]!);
      const key = randomUUID();
      const first = await book(agent, body, key);
      const retry = await book(agent, body, key);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data.reference).toBe(first.body.data.reference);
      expect(await counts()).toMatchObject({ bookings: 1, keys: 1 });
      // Only the reference is kept for replays: no names, no request body.
      const stored = await testPrisma().idempotencyKey.findFirstOrThrow();
      expect(stored.responseBody).toEqual({ reference: first.body.data.reference });
      expect(JSON.stringify(stored)).not.toMatch(/Asha|Rao/);
      expect(stored.scope).toMatch(/^POST \/bookings:/);
    });

    it('the same key with a different request is refused; keys are scoped per user', async () => {
      const target = app();
      const asha = await signedIn(target);
      const { searchId, offers } = await search(asha, 'holidays');
      const key = randomUUID();
      expect((await book(asha, bookingBody(searchId, offers[0]!), key)).status).toBe(201);
      const changed = await book(asha, bookingBody(searchId, offers[1]!), key);
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // Another person using the same key value gets their own booking.
      const ravi = await signedIn(target, 'ravi@example.com');
      const raviSearch = await search(ravi, 'holidays');
      const own = await book(ravi, bookingBody(raviSearch.searchId, raviSearch.offers[0]!), key);
      expect(own.status).toBe(201);
      expect(await counts()).toMatchObject({ bookings: 2 });
    });

    it('simultaneous duplicate requests create exactly one booking', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'buses');
      const body = bookingBody(searchId, offers[0]!);
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 6 }, () => book(agent, body, key)));
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      for (const r of responses.filter((x) => x.status === 409)) {
        expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      const references = new Set(
        responses.filter((r) => r.status === 201).map((r) => r.body.data.reference),
      );
      expect(references.size).toBe(1);
      expect(await counts()).toMatchObject({ bookings: 1, travellers: 1, events: 2, keys: 1 });
      // Afterwards a retry is a clean replay.
      const later = await book(agent, body, key);
      expect([later.status, later.body.data.reference]).toEqual([201, [...references][0]]);
    });

    it('a failed attempt releases its key, so the same key can be retried once fixed', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'cabs');
      const body = bookingBody(searchId, offers[0]!);
      const key = randomUUID();
      expect((await book(agent, { ...body, contactPhone: undefined }, key)).status).toBe(400);
      expect(await counts()).toMatchObject({ keys: 0 });
      expect((await book(agent, body, key)).status).toBe(201);
    });
  });

  describe('transactions and the database', () => {
    it('a database failure mid-transaction leaves no booking, travellers, history or key', async () => {
      const prisma = testPrisma();
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'hotels');
      const body = bookingBody(searchId, offers[0]!);
      const key = randomUUID();
      // A real database error on the second write of the transaction (the
      // confirmation event), not a test switch in application code.
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_fail_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.to_status = 'CONFIRMED' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END; $$`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER test_fail_confirmation BEFORE INSERT ON booking_status_events FOR EACH ROW EXECUTE FUNCTION test_fail_confirmation()',
      );
      try {
        const failed = await book(agent, body, key);
        expect(failed.status).toBe(500);
        expect(failed.body.error.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(failed.body)).not.toMatch(/simulated|trigger|booking_status_events/);
        expect(await counts()).toEqual({ bookings: 0, travellers: 0, events: 0, keys: 0 });
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER test_fail_confirmation ON booking_status_events',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION test_fail_confirmation()');
      }
      expect((await book(agent, body, key)).status).toBe(201);
    });

    it('references are unique: a collision is retried with a new reference', async () => {
      const prisma = testPrisma();
      const target = app();
      const agent = await signedIn(target);
      const user = await prisma.user.findFirstOrThrow();
      const { searchId, offers } = await search(agent, 'trains');
      const first = await book(agent, bookingBody(searchId, offers[0]!));
      const taken = first.body.data.reference as string;

      // A service whose generator first returns the taken reference.
      const registry = new ProviderRegistry({ demoEnabled: true });
      for (const p of DEMO_PROVIDERS) registry.register(p);
      const searchService = new SearchService({
        registry,
        logger: pino({ level: 'silent' }),
        sessions: new MemorySearchSessionStore(),
        resilience: NO_RETRY,
      });
      const issued = [taken, newBookingReference()];
      const service = new BookingsService({
        prisma,
        search: searchService,
        registry,
        logger: pino({ level: 'silent' }),
        newReference: () => issued.shift() ?? newBookingReference(),
      });
      const round = await searchService.search(parse(VALID_INPUTS.trains));
      const offer = round.results[0]!;
      const created = await service.create(
        user.id,
        {
          serviceType: 'trains',
          searchId: round.searchId,
          offerId: offer.id,
          travellers: [{ firstName: 'Asha', lastName: 'Rao' }],
          acceptedPrice: offer.price,
          acceptDemoTerms: true,
        },
        { x: 1 },
        randomUUID(),
      );
      expect(created.booking.reference).not.toBe(taken);
      expect(issued).toHaveLength(0); // the second draw was used
      await expect(
        prisma.booking.update({
          where: { reference: created.booking.reference },
          data: { reference: taken },
        }),
      ).rejects.toThrow();
    });

    it('the database keeps booked facts, travellers and history immutable', async () => {
      const prisma = testPrisma();
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'hotels');
      const { reference } = (await book(agent, bookingBody(searchId, offers[0]!))).body.data;
      const id = (await prisma.booking.findUniqueOrThrow({ where: { reference } })).id;
      const blocked = [
        `UPDATE bookings SET offer_snapshot = '{}'::jsonb WHERE id = '${id}'`,
        `UPDATE bookings SET total_amount_minor = 1 WHERE id = '${id}'`,
        `UPDATE bookings SET user_id = gen_random_uuid() WHERE id = '${id}'`,
        `UPDATE booking_travellers SET first_name = 'Mallory' WHERE booking_id = '${id}'`,
        `UPDATE booking_status_events SET note = 'x' WHERE booking_id = '${id}'`,
        `DELETE FROM booking_status_events WHERE booking_id = '${id}'`,
        `UPDATE bookings SET provider_reference = 'PNR123' WHERE id = '${id}'`, // demo: never a supplier reference
      ];
      for (const sql of blocked) {
        await expect(prisma.$executeRawUnsafe(sql), sql).rejects.toThrow();
      }
      const after = await agent.get(`/api/v1/bookings/${reference}`);
      expect(after.body.data.offer).toEqual(offers[0]);
      expect(after.body.data.travellers[0].firstName).toBe('Asha');
    });
  });

  describe('reading', () => {
    it('lists and shows only your own bookings; others are "not found", never "forbidden"', async () => {
      const target = app();
      const asha = await signedIn(target);
      const { searchId, offers } = await search(asha, 'hotels');
      const { reference } = (await book(asha, bookingBody(searchId, offers[0]!))).body.data;
      const ravi = await signedIn(target, 'ravi@example.com');

      for (const res of [
        await ravi.get(`/api/v1/bookings/${reference}`),
        await ravi.post(`/api/v1/bookings/${reference}/cancel`).set('Origin', ORIGIN),
        await ravi.get('/api/v1/bookings/WYD-2222-2222'),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({
          code: 'NOT_FOUND',
          message: "We couldn't find that booking.",
        });
      }
      const raviList = await ravi.get('/api/v1/bookings');
      expect(raviList.body.data.items).toEqual([]);
      expect(raviList.body.data.counts).toEqual({ upcoming: 0, past: 0, cancelled: 0 });
      expect((await request(target).get('/api/v1/bookings')).status).toBe(401);
      expect((await asha.get('/api/v1/bookings/not-a-reference')).status).toBe(400);
      // The reference is case-insensitive; responses are never cached.
      const mine = await asha.get(`/api/v1/bookings/${reference.toLowerCase()}`);
      expect(mine.status).toBe(200);
      expect(mine.headers['cache-control']).toBe('no-store');
      // Lists carry no names or phone numbers.
      const list = await asha.get('/api/v1/bookings');
      expect(JSON.stringify(list.body)).not.toMatch(/"travellers"|contactPhone/);
    });

    it('pages, and sorts bookings into upcoming, past and cancelled', async () => {
      const clock = testClock();
      const target = app({ now: clock.now });
      const agent = await signedIn(target);
      const references: string[] = [];
      for (const type of ['hotels', 'trains', 'holidays', 'metro'] as const) {
        const { searchId, offers } = await search(agent, type);
        const created = await book(agent, bookingBody(searchId, offers[0]!));
        expect(created.status, `${type}: ${JSON.stringify(created.body.error)}`).toBe(201);
        references.push(created.body.data.reference);
      }
      const page1 = bookingListResponseSchema.parse(
        (await agent.get('/api/v1/bookings?view=upcoming&pageSize=3')).body.data,
      );
      expect(page1.pagination).toEqual({ page: 1, pageSize: 3, totalResults: 4, totalPages: 2 });
      expect(page1.items).toHaveLength(3);
      // Dated trips first, soonest first; metro (no date) last.
      expect(page1.items.at(-1)?.serviceType).not.toBe('metro');
      const page2 = (await agent.get('/api/v1/bookings?view=upcoming&pageSize=3&page=2')).body.data;
      expect(page2.items.map((b: { serviceType: string }) => b.serviceType)).toEqual(['metro']);

      await agent.post(`/api/v1/bookings/${references[0]}/cancel`).set('Origin', ORIGIN);
      clock.advance(60 * DAY); // all dated trips are now over
      const counts_ = (await agent.get('/api/v1/bookings')).body.data.counts;
      expect(counts_).toEqual({ upcoming: 1, past: 2, cancelled: 1 });
      const past = (await agent.get('/api/v1/bookings?view=past')).body.data.items;
      expect(past.every((b: { cancellable: boolean }) => !b.cancellable)).toBe(true);
      expect((await agent.get('/api/v1/bookings?view=everything')).status).toBe(400);
      expect((await agent.get('/api/v1/bookings?pageSize=500')).status).toBe(400);
    });
  });

  describe('cancelling', () => {
    it('cancels a confirmed booking once, keeps its snapshot, records history, and says nothing is refunded', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'holidays');
      const created = (await book(agent, bookingBody(searchId, offers[0]!))).body.data;
      const res = await agent
        .post(`/api/v1/bookings/${created.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'cancelled',
        cancellable: false,
        offer: created.offer,
        price: created.price,
      });
      expect(
        res.body.data.history.map((h: { status: string; by: string }) => [h.status, h.by]),
      ).toEqual([
        ['pending', 'you'],
        ['confirmed', 'wayora'],
        ['cancelled', 'you'],
      ]);
      expect(res.body.data.history[2].note).toMatch(
        /no supplier was contacted.*nothing is refunded because nothing was paid/,
      );
      const again = await agent
        .post(`/api/v1/bookings/${created.reference}/cancel`)
        .set('Origin', ORIGIN);
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: 'BOOKING_NOT_CANCELLABLE',
        message: 'This booking is already cancelled.',
      });
      const audit = await testPrisma().auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['booking.created', 'booking.cancelled']);
      expect(JSON.stringify(audit)).not.toMatch(/Asha|Rao|\+91/);
    });

    it('concurrent cancellations: exactly one succeeds', async () => {
      const agent = await signedIn(app());
      const { searchId, offers } = await search(agent, 'trains');
      const { reference } = (await book(agent, bookingBody(searchId, offers[0]!))).body.data;
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          agent.post(`/api/v1/bookings/${reference}/cancel`).set('Origin', ORIGIN),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      const events = await testPrisma().bookingStatusEvent.count({
        where: { toStatus: 'CANCELLED' },
      });
      expect(events).toBe(1);
    });

    it('a trip that has started can no longer be cancelled', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ now: clock.now }));
      const { searchId, offers } = await search(agent, 'hotels');
      const { reference } = (await book(agent, bookingBody(searchId, offers[0]!))).body.data;
      clock.advance(30 * DAY);
      const res = await agent.post(`/api/v1/bookings/${reference}/cancel`).set('Origin', ORIGIN);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already started/);
    });

    it('the lifecycle allows only the documented transitions; terminal states are final', () => {
      expect(TRANSITIONS).toEqual({
        PENDING: ['CONFIRMED', 'FAILED', 'CANCELLED'],
        HELD: [],
        CONFIRMED: ['CANCELLED'],
        CANCELLED: [],
        FAILED: [],
      });
    });
  });

  describe('privacy', () => {
    it('traveller names and phone numbers never reach the logs', async () => {
      const logs = captureLogs();
      const agent = await signedIn(app({ logs }));
      const { searchId, offers } = await search(agent, 'cabs');
      const res = await book(agent, {
        ...bookingBody(searchId, offers[0]!),
        travellers: [{ firstName: 'Zebulon', lastName: 'Quixote' }],
        contactPhone: '+919811122233',
      });
      expect(res.status).toBe(201);
      await agent.get(`/api/v1/bookings/${res.body.data.reference}`);
      await agent.post(`/api/v1/bookings/${res.body.data.reference}/cancel`).set('Origin', ORIGIN);
      expect(logs.text).toMatch(/Demo booking created/);
      expect(logs.text).toContain(res.body.data.reference);
      expect(logs.text).not.toMatch(/Zebulon|Quixote|9811122233/);
    });
  });
});
