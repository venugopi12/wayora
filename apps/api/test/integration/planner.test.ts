import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingRequirementsFor,
  bookingSchema,
  plannedTripListSchema,
  plannedTripSchema,
  suggestionsResponseSchema,
  utcDateFromToday,
  type Booking,
  type PlannedTrip,
  type SearchResult,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { buildTestApp } from '../helpers.js';
import { VALID_INPUTS } from '../search-support.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Trip planner against a real PostgreSQL (docs/planner.md): trips and their
 * date rules, itinerary writes (add, edit, move, duplicate, reorder, delete)
 * with gap-free ordering under concurrency, schedule warnings, curated
 * suggestions, booking links, idempotency, limits, and — on every endpoint —
 * that one user can never read or change another user's plan.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the planner tests would be skipped.');
}

type Agent = ReturnType<typeof request.agent>;

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  PLANNER_RATE_LIMIT_MAX: 1000,
  RATE_LIMIT_MAX: 5000,
  PAYMENT_PROVIDER: 'demo',
};

function app(env: Partial<Env> = {}) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...env },
    logger: pino({ level: 'silent' }),
    now: testClock().now,
  });
}

async function signedIn(target: ReturnType<typeof app>, email = 'asha@example.com') {
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: 'blue river morning' });
  expect(res.status).toBe(201);
  return agent;
}

const D = (days: number) => utcDateFromToday(days);
const START = D(10);
const DAY2 = D(11);
const END = D(12);

const post = (agent: Agent, path: string, body: unknown, key: string | null = randomUUID()) => {
  const req = agent.post(`/api/v1/planner${path}`).set('Origin', ORIGIN);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body as object);
};
const patch = (agent: Agent, path: string, body: unknown) =>
  agent
    .patch(`/api/v1/planner${path}`)
    .set('Origin', ORIGIN)
    .send(body as object);
const put = (agent: Agent, path: string, body: unknown) =>
  agent
    .put(`/api/v1/planner${path}`)
    .set('Origin', ORIGIN)
    .send(body as object);
const del = (agent: Agent, path: string) =>
  agent.delete(`/api/v1/planner${path}`).set('Origin', ORIGIN);

async function createTrip(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await post(agent, '/trips', {
    title: 'Goa with friends',
    destinationId: 'goa',
    startDate: START,
    endDate: END,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return plannedTripSchema.parse(res.body.data);
}

async function addItem(agent: Agent, tripId: string, body: Record<string, unknown>) {
  const res = await post(agent, `/trips/${tripId}/items`, {
    day: START,
    title: 'Activity',
    category: 'sightseeing',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return plannedTripSchema.parse(res.body.data);
}

async function getTrip(agent: Agent, tripId: string): Promise<PlannedTrip> {
  const res = await agent.get(`/api/v1/planner/trips/${tripId}`);
  expect(res.status).toBe(200);
  return plannedTripSchema.parse(res.body.data);
}

const day = (trip: PlannedTrip, date: string) => trip.days.find((d) => d.date === date);
const titles = (trip: PlannedTrip, date: string) => day(trip, date)?.items.map((i) => i.title);
const positions = (trip: PlannedTrip, date: string) =>
  day(trip, date)?.items.map((i) => i.position);

async function book(agent: Agent, pay: boolean): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS.hotels;
  const search = await agent.post('/api/v1/search/hotels').set('Origin', ORIGIN).send(body);
  expect(search.status).toBe(200);
  const offer = search.body.data.results[0] as SearchResult;
  const requirements = bookingRequirementsFor(offer);
  const res = await agent
    .post('/api/v1/bookings')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceType: offer.serviceType,
      searchId: search.body.data.searchId,
      offerId: offer.id,
      travellers: requirements.namedTravellers.map(() => ({ firstName: 'Asha', lastName: 'Rao' })),
      acceptedPrice: offer.price,
      acceptDemoTerms: true,
    });
  expect(res.status).toBe(201);
  const booking = bookingSchema.parse(res.body.data);
  if (pay && booking.payment.canPay) {
    const paid = await agent
      .post(`/api/v1/bookings/${booking.reference}/payments`)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: booking.payment.amount });
    expect(paid.status).toBe(201);
  }
  return bookingSchema.parse((await agent.get(`/api/v1/bookings/${booking.reference}`)).body.data);
}

describe.skipIf(!TEST_DATABASE_URL)('trip planner (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('trips', () => {
    it('creates a trip with one date-only day per date, lists and reopens it', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent, {
        notes: 'Line one\nLine two',
        preferences: { pace: 'relaxed', interests: ['food', 'beach', 'food'] },
      });
      expect(trip.days.map((d) => [d.date, d.dayNumber])).toEqual([
        [START, 1],
        [DAY2, 2],
        [END, 3],
      ]);
      expect(trip).toMatchObject({
        title: 'Goa with friends',
        destination: { id: 'goa', name: 'Goa', timeZone: 'Asia/Kolkata', hasSuggestions: true },
        startDate: START,
        endDate: END,
        dayCount: 3,
        itemCount: 0,
        version: 1,
        notes: 'Line one\nLine two',
        preferences: { pace: 'relaxed', budget: null, group: null, interests: ['food', 'beach'] },
        linkedBooking: null,
        warnings: [],
        outsideDates: [],
        travelTimeValidated: false,
      });

      // Stored as DATE: exactly the calendar dates sent, whatever the server zone.
      const [row] = await testPrisma().$queryRaw<{ s: string; e: string }[]>`
        SELECT start_date::text AS s, end_date::text AS e FROM planned_trips WHERE id = ${trip.id}::uuid`;
      expect(row).toEqual({ s: START, e: END });

      const list = plannedTripListSchema.parse(
        (await agent.get('/api/v1/planner/trips')).body.data,
      );
      expect(list).toMatchObject({ total: 1, page: 1, limit: 50 });
      expect(list.items[0]).toMatchObject({ id: trip.id, dayCount: 3, itemCount: 0 });
      expect(await getTrip(agent, trip.id)).toEqual(trip);
    });

    it('lists trips by start date, paginated', async () => {
      const agent = await signedIn(app());
      await createTrip(agent, { title: 'Later', startDate: D(40), endDate: D(41) });
      await createTrip(agent, { title: 'Sooner', startDate: D(5), endDate: D(5) });
      await createTrip(agent, { title: 'Middle', startDate: D(20), endDate: D(22) });
      const page1 = plannedTripListSchema.parse(
        (await agent.get('/api/v1/planner/trips?pageSize=2')).body.data,
      );
      expect(page1.items.map((t) => t.title)).toEqual(['Sooner', 'Middle']);
      expect(page1.total).toBe(3);
      const page2 = plannedTripListSchema.parse(
        (await agent.get('/api/v1/planner/trips?pageSize=2&page=2')).body.data,
      );
      expect(page2.items.map((t) => t.title)).toEqual(['Later']);
      expect((await agent.get('/api/v1/planner/trips?pageSize=500')).status).toBe(400);
    });

    it('validates dates, destination and text, and refuses server-managed fields', async () => {
      const agent = await signedIn(app());
      const base = { title: 'Trip', destinationId: 'goa', startDate: START, endDate: END };
      const cases: [Record<string, unknown>, string][] = [
        [{ endDate: D(9) }, 'body.endDate'],
        [{ endDate: D(40) }, 'body.endDate'],
        [{ startDate: D(-3), endDate: D(-2) }, 'body.startDate'],
        [{ startDate: D(800), endDate: D(801) }, 'body.startDate'],
        [{ startDate: '2026-02-30' }, 'body.startDate'],
        [{ startDate: '12/11/2026' }, 'body.startDate'],
        [{ destinationId: undefined }, 'body.destinationName'],
        [{ destinationId: 'atlantis' }, 'body.destinationId'],
        [{ title: '   ' }, 'body.title'],
        [{ title: 'Bad\u0007bell' }, 'body.title'],
        [{ title: 'Hidden ‮txt.exe' }, 'body.title'],
        [{ notes: 'x'.repeat(2001) }, 'body.notes'],
        [{ userId: randomUUID() }, 'body'],
        [{ version: 7 }, 'body'],
        [{ id: randomUUID() }, 'body'],
        [{ createdAt: new Date().toISOString() }, 'body'],
        [{ preferences: { pace: 'frantic' } }, 'body.preferences.pace'],
        [{ preferences: { religion: 'x' } }, 'body.preferences'],
      ];
      for (const [overrides, path] of cases) {
        const res = await post(agent, '/trips', { ...base, ...overrides });
        expect(res.status, JSON.stringify(overrides)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(
          (res.body.error.details as { path: string }[]).some((d) => d.path.startsWith(path)),
          `${JSON.stringify(overrides)} → ${JSON.stringify(res.body.error.details)}`,
        ).toBe(true);
      }
      expect(await testPrisma().plannedTrip.count()).toBe(0);
    });

    it('accepts a free-text destination (no suggestions) and stores markup as plain text', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent, {
        destinationId: null,
        destinationName: '  Hampi   and Badami ',
        title: '<img src=x onerror=alert(1)>',
      });
      expect(trip.destination).toEqual({
        id: null,
        name: 'Hampi and Badami',
        country: null,
        timeZone: null,
        hasSuggestions: false,
      });
      expect(trip.title).toBe('<img src=x onerror=alert(1)>');
    });

    it('creates once per Idempotency-Key: a retry replays, a different body is refused, no key is refused', async () => {
      const agent = await signedIn(app());
      const key = randomUUID();
      const body = { title: 'Once', destinationId: 'goa', startDate: START, endDate: END };
      const [a, b] = await Promise.all([
        post(agent, '/trips', body, key),
        post(agent, '/trips', body, key),
      ]);
      // A concurrent duplicate is refused or replayed; never a second trip.
      expect([a.status, b.status].sort()).toEqual(
        b.status === 409 || a.status === 409 ? [201, 409] : [201, 201],
      );
      const retry = await post(agent, '/trips', body, key);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await testPrisma().plannedTrip.count()).toBe(1);

      const reused = await post(agent, '/trips', { ...body, title: 'Other' }, key);
      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await post(agent, '/trips', body, null)).status).toBe(400);
    });

    it('updates details with optimistic concurrency, and deletes with its itinerary', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      await addItem(agent, trip.id, { title: 'Fort' });

      const updated = await patch(agent, `/trips/${trip.id}`, {
        version: 1,
        title: 'Goa, slowly',
        notes: '',
        preferences: { budget: 'shoestring', group: 'family' },
      });
      expect(updated.status).toBe(200);
      expect(plannedTripSchema.parse(updated.body.data)).toMatchObject({
        title: 'Goa, slowly',
        notes: null,
        version: 2,
        preferences: { pace: null, budget: 'shoestring', group: 'family', interests: [] },
      });

      // An edit based on version 1 (another tab) is refused, not merged.
      const stale = await patch(agent, `/trips/${trip.id}`, { version: 1, title: 'Lost edit' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('PLAN_OUT_OF_DATE');
      expect((await getTrip(agent, trip.id)).title).toBe('Goa, slowly');

      expect(
        (await patch(agent, `/trips/${trip.id}`, { version: 2, startDate: D(1) })).status,
      ).toBe(400);
      expect(
        (await patch(agent, `/trips/${trip.id}`, { version: 2, userId: randomUUID() })).status,
      ).toBe(400);
      const custom = await patch(agent, `/trips/${trip.id}`, {
        version: 2,
        destinationId: null,
        destinationName: 'Gokarna',
      });
      expect(custom.body.data.destination).toMatchObject({ id: null, name: 'Gokarna' });

      const deleted = await del(agent, `/trips/${trip.id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toEqual({ deleted: true });
      expect((await agent.get(`/api/v1/planner/trips/${trip.id}`)).status).toBe(404);
      expect((await del(agent, `/trips/${trip.id}`)).status).toBe(404);
      expect(await testPrisma().itineraryItem.count()).toBe(0);
    });

    it('keeps activities when the dates shrink, and flags them instead of moving or dropping them', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      const withItem = await addItem(agent, trip.id, { day: END, title: 'Last-day beach' });
      const res = await patch(agent, `/trips/${trip.id}`, {
        version: withItem.version,
        startDate: START,
        endDate: DAY2,
      });
      expect(res.status).toBe(200);
      const after = plannedTripSchema.parse(res.body.data);
      expect(after.days.map((d) => d.date)).toEqual([START, DAY2]);
      expect(after.outsideDates.map((i) => [i.title, i.day])).toEqual([['Last-day beach', END]]);
      expect(after.itemCount).toBe(1);
      expect(after.warnings).toEqual([
        expect.objectContaining({ code: 'outside_trip_dates', day: END }),
      ]);
      // It can be moved back onto a trip day.
      const item = after.outsideDates[0]!;
      const moved = await patch(agent, `/trips/${trip.id}/items/${item.id}`, {
        version: item.version,
        day: DAY2,
      });
      expect(moved.status).toBe(200);
      expect(plannedTripSchema.parse(moved.body.data).warnings).toEqual([]);
    });

    it('enforces the per-account trip limit', async () => {
      const agent = await signedIn(app());
      const prisma = testPrisma();
      const user = await prisma.user.findFirstOrThrow();
      await prisma.plannedTrip.createMany({
        data: Array.from({ length: 50 }, (_, n) => ({
          userId: user.id,
          title: `Trip ${n}`,
          destinationName: 'Somewhere',
          startDate: new Date(`${START}T00:00:00Z`),
          endDate: new Date(`${START}T00:00:00Z`),
        })),
      });
      const res = await post(agent, '/trips', {
        title: 'One too many',
        destinationId: 'goa',
        startDate: START,
        endDate: END,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });
  });

  describe('itinerary', () => {
    it('adds activities in order, edits them, and persists everything', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      await addItem(agent, trip.id, {
        title: 'Fort Aguada',
        startTime: '09:00',
        durationMinutes: 90,
      });
      await addItem(agent, trip.id, { title: 'Lunch', category: 'food', location: 'Panaji' });
      const after = await addItem(agent, trip.id, {
        title: 'Dinner',
        category: 'food',
        notes: 'Book a table?\nMaybe',
      });
      expect(titles(after, START)).toEqual(['Fort Aguada', 'Lunch', 'Dinner']);
      expect(positions(after, START)).toEqual([0, 1, 2]);
      const fort = day(after, START)!.items[0]!;
      expect(fort).toMatchObject({
        startTime: '09:00',
        durationMinutes: 90,
        endTime: '10:30',
        endsNextDay: false,
      });

      const edited = await patch(agent, `/trips/${trip.id}/items/${fort.id}`, {
        version: fort.version,
        title: 'Fort Aguada and lighthouse',
        startTime: null,
        durationMinutes: 120,
        location: '  Candolim ',
      });
      expect(edited.status).toBe(200);
      const reopened = await getTrip(agent, trip.id);
      expect(day(reopened, START)!.items[0]).toMatchObject({
        title: 'Fort Aguada and lighthouse',
        startTime: null,
        endTime: null,
        durationMinutes: 120,
        location: 'Candolim',
      });
      expect(day(reopened, START)!.items[2]!.notes).toBe('Book a table?\nMaybe');
      expect(reopened.itemCount).toBe(3);
    });

    it('validates activities: days within the trip, times, durations and fields', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      const cases: [Record<string, unknown>, string][] = [
        [{ day: D(9) }, 'body.day'],
        [{ day: D(13) }, 'body.day'],
        [{ day: '2026-13-01' }, 'body.day'],
        [{ startTime: '24:00' }, 'body.startTime'],
        [{ startTime: '9:00' }, 'body.startTime'],
        [{ durationMinutes: 2 }, 'body.durationMinutes'],
        [{ durationMinutes: 721 }, 'body.durationMinutes'],
        [{ durationMinutes: 30.5 }, 'body.durationMinutes'],
        [{ category: 'party' }, 'body.category'],
        [{ title: '' }, 'body.title'],
        [{ position: 0 }, 'body'],
        [{ tripId: randomUUID() }, 'body'],
        [{ suggestionId: 'jaipur:amber-fort' }, 'body.suggestionId'],
        [{ suggestionId: 'goa:nope' }, 'body.suggestionId'],
      ];
      for (const [overrides, path] of cases) {
        const res = await post(agent, `/trips/${trip.id}/items`, {
          day: START,
          title: 'X',
          category: 'other',
          ...overrides,
        });
        expect(res.status, JSON.stringify(overrides)).toBe(400);
        expect(
          (res.body.error.details as { path: string }[]).some((d) => d.path.startsWith(path)),
          `${JSON.stringify(overrides)} → ${JSON.stringify(res.body.error.details)}`,
        ).toBe(true);
      }
      expect(await testPrisma().itineraryItem.count()).toBe(0);
      const item = (await addItem(agent, trip.id, {})).days[0]!.items[0]!;
      const outside = await patch(agent, `/trips/${trip.id}/items/${item.id}`, {
        version: 1,
        day: D(30),
      });
      expect(outside.status).toBe(400);
      expect(
        (await patch(agent, `/trips/${trip.id}/items/${item.id}`, { version: 1 })).status,
      ).toBe(400);
      expect(
        (await patch(agent, `/trips/${trip.id}/items/${item.id}`, { title: 'X' })).status,
      ).toBe(400);
    });

    it('moves activities between days and within a day, keeping both days gap-free', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      for (const title of ['A', 'B', 'C']) await addItem(agent, trip.id, { title });
      for (const title of ['X', 'Y']) await addItem(agent, trip.id, { title, day: DAY2 });
      let t = await getTrip(agent, trip.id);
      const b = day(t, START)!.items[1]!;

      // B to day 2, between X and Y.
      t = plannedTripSchema.parse(
        (
          await patch(agent, `/trips/${trip.id}/items/${b.id}`, {
            version: 1,
            day: DAY2,
            position: 1,
          })
        ).body.data,
      );
      expect(titles(t, START)).toEqual(['A', 'C']);
      expect(positions(t, START)).toEqual([0, 1]);
      expect(titles(t, DAY2)).toEqual(['X', 'B', 'Y']);
      expect(positions(t, DAY2)).toEqual([0, 1, 2]);

      // To an empty day, position past the end clamps to the end.
      const y = day(t, DAY2)!.items[2]!;
      t = plannedTripSchema.parse(
        (
          await patch(agent, `/trips/${trip.id}/items/${y.id}`, {
            version: 1,
            day: END,
            position: 9,
          })
        ).body.data,
      );
      expect(titles(t, END)).toEqual(['Y']);
      expect(positions(t, END)).toEqual([0]);

      // Within a day: X to the end.
      const x = day(t, DAY2)!.items[0]!;
      t = plannedTripSchema.parse(
        (await patch(agent, `/trips/${trip.id}/items/${x.id}`, { version: 1, position: 5 })).body
          .data,
      );
      expect(titles(t, DAY2)).toEqual(['B', 'X']);
      expect(positions(t, DAY2)).toEqual([0, 1]);
    });

    it('reorders a day in one request and refuses stale, partial or foreign lists', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      for (const title of ['A', 'B', 'C']) await addItem(agent, trip.id, { title });
      const other = await addItem(agent, trip.id, { title: 'Z', day: DAY2 });
      const [a, b, c] = day(other, START)!.items.map((i) => i.id);
      const z = day(other, DAY2)!.items[0]!.id;

      const res = await put(agent, `/trips/${trip.id}/days/${START}/order`, {
        itemIds: [c, a, b],
        previousOrder: [a, b, c],
      });
      expect(res.status).toBe(200);
      const t = plannedTripSchema.parse(res.body.data);
      expect(titles(t, START)).toEqual(['C', 'A', 'B']);
      expect(positions(t, START)).toEqual([0, 1, 2]);

      for (const itemIds of [
        [c, a],
        [c, a, b, z],
        [c, a, randomUUID()],
        [c, a, a],
      ]) {
        const bad = await put(agent, `/trips/${trip.id}/days/${START}/order`, {
          itemIds,
          previousOrder: [c, a, b],
        });
        expect([400, 409], JSON.stringify(itemIds)).toContain(bad.status);
      }
      expect(titles(await getTrip(agent, trip.id), START)).toEqual(['C', 'A', 'B']);
      expect(titles(await getTrip(agent, trip.id), DAY2)).toEqual(['Z']);
    });

    it('duplicates an activity (as the user’s own copy) and deletes closing the gap', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      await addItem(agent, trip.id, {
        title: 'Fort Aguada',
        suggestionId: 'goa:fort-aguada',
        startTime: '10:00',
      });
      const t1 = await addItem(agent, trip.id, { title: 'Beach' });
      const fort = day(t1, START)!.items[0]!;
      const dup = await post(agent, `/trips/${trip.id}/items/${fort.id}/duplicate`, { day: END });
      expect(dup.status).toBe(201);
      const t2 = plannedTripSchema.parse(dup.body.data);
      expect(day(t2, END)!.items[0]).toMatchObject({
        title: 'Fort Aguada',
        startTime: '10:00',
        suggestionId: null,
      });

      const removed = await del(agent, `/trips/${trip.id}/items/${fort.id}`);
      expect(removed.status).toBe(200);
      const t3 = plannedTripSchema.parse(removed.body.data);
      expect(titles(t3, START)).toEqual(['Beach']);
      expect(positions(t3, START)).toEqual([0]);
      expect((await del(agent, `/trips/${trip.id}/items/${fort.id}`)).status).toBe(404);
    });

    it('keeps positions unique and gap-free under concurrent writes', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          post(agent, `/trips/${trip.id}/items`, {
            day: START,
            title: `Item ${n}`,
            category: 'other',
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      const t = await getTrip(agent, trip.id);
      expect(positions(t, START)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      // Concurrent moves and a reorder never corrupt the order either.
      const ids = day(t, START)!.items.map((i) => i.id);
      await Promise.all([
        patch(agent, `/trips/${trip.id}/items/${ids[0]}`, { version: 1, day: DAY2 }),
        patch(agent, `/trips/${trip.id}/items/${ids[1]}`, { version: 1, day: DAY2 }),
        patch(agent, `/trips/${trip.id}/items/${ids[2]}`, { version: 1, position: 7 }),
        del(agent, `/trips/${trip.id}/items/${ids[3]}`),
      ]);
      const after = await getTrip(agent, trip.id);
      expect(positions(after, START)).toEqual([0, 1, 2, 3, 4]);
      expect(positions(after, DAY2)).toEqual([0, 1]);
    });

    it('limits activities per day', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      const prisma = testPrisma();
      await prisma.itineraryItem.createMany({
        data: Array.from({ length: 20 }, (_, n) => ({
          tripId: trip.id,
          day: new Date(`${START}T00:00:00Z`),
          position: n,
          title: `Item ${n}`,
          category: 'OTHER' as const,
        })),
      });
      const res = await post(agent, `/trips/${trip.id}/items`, {
        day: START,
        title: 'More',
        category: 'other',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(
        (
          await post(agent, `/trips/${trip.id}/items`, {
            day: DAY2,
            title: 'Fine',
            category: 'other',
          })
        ).status,
      ).toBe(201);
    });

    it('adds an activity once per Idempotency-Key', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      const key = randomUUID();
      const body = { day: START, title: 'Once', category: 'other' };
      expect((await post(agent, `/trips/${trip.id}/items`, body, key)).status).toBe(201);
      const again = await post(agent, `/trips/${trip.id}/items`, body, key);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(await testPrisma().itineraryItem.count()).toBe(1);
      expect((await post(agent, `/trips/${trip.id}/items`, body, null)).status).toBe(400);
    });
  });

  describe('schedule warnings', () => {
    it('flags overlaps, missing times, out-of-order, past-midnight and long days — and still saves', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent);
      await addItem(agent, trip.id, {
        title: 'Breakfast',
        startTime: '09:00',
        durationMinutes: 60,
      });
      await addItem(agent, trip.id, { title: 'Market', startTime: '09:30', durationMinutes: 60 });
      await addItem(agent, trip.id, { title: 'Early walk', startTime: '07:00' });
      await addItem(agent, trip.id, { title: 'Somewhere' });
      await addItem(agent, trip.id, {
        title: 'Night show',
        startTime: '23:00',
        durationMinutes: 120,
        day: DAY2,
      });
      await addItem(agent, trip.id, {
        title: 'Long hike',
        startTime: '06:00',
        durationMinutes: 720,
        day: END,
      });
      const t = await addItem(agent, trip.id, {
        title: 'Dinner',
        startTime: '18:30',
        durationMinutes: 90,
        day: END,
      });

      const codes = t.warnings.map((w) => [w.code, w.day]);
      expect(codes).toEqual([
        ['overlap', START],
        ['missing_start_time', START],
        ['out_of_order', START],
        ['ends_next_day', DAY2],
        ['long_day', END],
      ]);
      const ids = Object.fromEntries(t.days.flatMap((d) => d.items).map((i) => [i.title, i.id]));
      expect(t.warnings[0]).toMatchObject({ itemIds: [ids.Breakfast, ids.Market] });
      expect(t.warnings[0]!.message).toBe(
        '“Breakfast” (09:00–10:00) overlaps “Market” (09:30–10:30).',
      );
      expect(t.warnings[1]!.itemIds).toEqual([ids.Somewhere]);
      expect(t.warnings[2]!.itemIds).toEqual([ids['Early walk']]);
      expect(t.warnings[4]!.message).toContain('13 h 30 min, before any travel');
      expect(day(t, DAY2)!.items[0]).toMatchObject({ endTime: '01:00', endsNextDay: true });
      expect(t.travelTimeValidated).toBe(false);
      expect(t.itemCount).toBe(7);

      // Sorting the day by time (one reorder) clears the order warning.
      const sorted = [...day(t, START)!.items]
        .sort((a, b) => (a.startTime ?? '99').localeCompare(b.startTime ?? '99'))
        .map((i) => i.id);
      const res = await put(agent, `/trips/${trip.id}/days/${START}/order`, {
        itemIds: sorted,
        previousOrder: day(t, START)!.items.map((i) => i.id),
      });
      const after = plannedTripSchema.parse(res.body.data);
      expect(after.warnings.map((w) => w.code)).not.toContain('out_of_order');
    });
  });

  describe('suggestions', () => {
    it('ranks the curated sample by preferences with reasons, and never repeats planned activities', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent, {
        preferences: {
          budget: 'shoestring',
          interests: ['beach'],
          pace: 'relaxed',
          group: 'couple',
        },
      });
      const res = await agent.get(`/api/v1/planner/trips/${trip.id}/suggestions`);
      expect(res.status).toBe(200);
      const s = suggestionsResponseSchema.parse(res.body.data);
      expect(s).toMatchObject({
        available: true,
        source: 'curated-sample',
        method: 'rules',
        capacity: { days: 3, perDay: 2, planned: 0 },
      });
      expect(s.suggestions[0]).toMatchObject({ id: 'goa:palolem-beach', category: 'beach' });
      expect(s.suggestions[0]!.reasons).toEqual([
        'Matches your interest in beach',
        'Usually free or low cost — fits a shoestring budget',
        'Suits couples’ trips',
        'Easy-going — suits a relaxed pace',
      ]);
      for (const suggestion of s.suggestions) {
        expect(suggestion.reasons.length).toBeGreaterThan(0);
        expect(suggestion).not.toHaveProperty('price');
        expect(suggestion).not.toHaveProperty('rating');
        expect(suggestion).not.toHaveProperty('openingHours');
      }

      // Add the top one; it (and anything with the same title) is no longer suggested.
      await addItem(agent, trip.id, {
        title: 'Palolem Beach',
        category: 'beach',
        suggestionId: 'goa:palolem-beach',
      });
      await addItem(agent, trip.id, { title: 'fort aguada', category: 'sightseeing' });
      const again = suggestionsResponseSchema.parse(
        (await agent.get(`/api/v1/planner/trips/${trip.id}/suggestions`)).body.data,
      );
      const ids = again.suggestions.map((x) => x.id);
      expect(ids).not.toContain('goa:palolem-beach');
      expect(ids).not.toContain('goa:fort-aguada');
      expect(again.capacity.planned).toBe(2);
      expect(
        again.suggestions.some((x) => x.reasons.some((r) => r.startsWith('Adds variety'))),
      ).toBe(true);

      // Adding the same suggestion twice is refused.
      const twice = await post(agent, `/trips/${trip.id}/items`, {
        day: DAY2,
        title: 'Palolem again',
        category: 'beach',
        suggestionId: 'goa:palolem-beach',
      });
      expect(twice.status).toBe(409);

      const food = suggestionsResponseSchema.parse(
        (await agent.get(`/api/v1/planner/trips/${trip.id}/suggestions?category=food`)).body.data,
      );
      expect(food.suggestions.every((x) => x.category === 'food')).toBe(true);
      expect(
        (await agent.get(`/api/v1/planner/trips/${trip.id}/suggestions?category=x`)).status,
      ).toBe(400);
    });

    it('is deterministic, leaves out activities that do not suit the group, and has a default order', async () => {
      const agent = await signedIn(app());
      const family = await createTrip(agent, {
        destinationId: 'delhi',
        preferences: { group: 'family' },
      });
      const a = (await agent.get(`/api/v1/planner/trips/${family.id}/suggestions`)).body.data;
      const b = (await agent.get(`/api/v1/planner/trips/${family.id}/suggestions`)).body.data;
      expect(a).toEqual(b);
      expect(a.suggestions.map((x: { id: string }) => x.id)).not.toContain('delhi:hauz-khas');

      const plain = await createTrip(agent, { destinationId: 'delhi' });
      const d = suggestionsResponseSchema.parse(
        (await agent.get(`/api/v1/planner/trips/${plain.id}/suggestions`)).body.data,
      );
      expect(d.suggestions.map((x) => x.id)).toContain('delhi:hauz-khas');
      expect(d.suggestions[0]!.reasons).toEqual(['A sample highlight of Delhi']);
      expect(d.capacity.perDay).toBe(3);
    });

    it('says when there is no sample data for the destination', async () => {
      const agent = await signedIn(app());
      const trip = await createTrip(agent, { destinationId: null, destinationName: 'Hampi' });
      const s = suggestionsResponseSchema.parse(
        (await agent.get(`/api/v1/planner/trips/${trip.id}/suggestions`)).body.data,
      );
      expect(s).toMatchObject({ available: false, suggestions: [] });
      const res = await post(agent, `/trips/${trip.id}/items`, {
        day: START,
        title: 'Fort',
        category: 'sightseeing',
        suggestionId: 'goa:fort-aguada',
      });
      expect(res.status).toBe(400);
    });

    it('lists the curated sample destinations', async () => {
      const agent = await signedIn(app());
      const res = await agent.get('/api/v1/planner/destinations');
      expect(res.status).toBe(200);
      expect(res.body.data.sample).toBe(true);
      expect(res.body.data.items).toHaveLength(12);
      expect(res.body.data.items[0]).toEqual({
        id: 'goa',
        name: 'Goa',
        country: 'India',
        timeZone: 'Asia/Kolkata',
        hasSuggestions: true,
      });
    });
  });

  describe('booking links', () => {
    it('links only the user’s own confirmed booking, by explicit choice, without touching its timeline', async () => {
      const target = app();
      const asha = await signedIn(target);
      const ravi = await signedIn(target, 'ravi@example.com');
      const confirmed = await book(asha, true);
      const pending = await book(asha, false);
      const ravis = await book(ravi, true);
      expect(confirmed.status).toBe('confirmed');
      const trip = await createTrip(asha);
      expect(trip.linkedBooking).toBeNull();

      const prisma = testPrisma();
      const eventsBefore = await prisma.tripEvent.count();
      const bookingBefore = await prisma.booking.findUniqueOrThrow({
        where: { reference: confirmed.reference },
      });

      const foreign = await patch(asha, `/trips/${trip.id}`, {
        version: 1,
        bookingReference: ravis.reference,
      });
      expect(foreign.status).toBe(404);
      const notConfirmed = await patch(asha, `/trips/${trip.id}`, {
        version: 1,
        bookingReference: pending.reference,
      });
      expect(notConfirmed.status).toBe(409);

      const linked = await patch(asha, `/trips/${trip.id}`, {
        version: 1,
        bookingReference: confirmed.reference,
      });
      expect(linked.status).toBe(200);
      expect(linked.body.data.linkedBooking).toMatchObject({
        reference: confirmed.reference,
        category: 'hotels',
        status: 'confirmed',
        demo: true,
      });
      // Nothing about the booking changed, and no timeline entries were added.
      expect(await prisma.tripEvent.count()).toBe(eventsBefore);
      expect(
        await prisma.booking.findUniqueOrThrow({ where: { reference: confirmed.reference } }),
      ).toEqual(bookingBefore);

      const unlinked = await patch(asha, `/trips/${trip.id}`, {
        version: 2,
        bookingReference: null,
      });
      expect(unlinked.body.data.linkedBooking).toBeNull();

      // The database refuses a cross-user link even if the API were bypassed.
      const ravisBooking = await prisma.booking.findUniqueOrThrow({
        where: { reference: ravis.reference },
      });
      await expect(
        prisma.plannedTrip.update({ where: { id: trip.id }, data: { bookingId: ravisBooking.id } }),
      ).rejects.toThrow();
    });
  });

  describe('access control', () => {
    it('never lets another user read, change, reorder, move or delete a plan', async () => {
      const target = app();
      const asha = await signedIn(target);
      const ravi = await signedIn(target, 'ravi@example.com');
      const trip = await createTrip(asha);
      const t = await addItem(asha, trip.id, { title: 'A' });
      await addItem(asha, trip.id, { title: 'B' });
      const itemId = day(t, START)!.items[0]!.id;
      const raviTrip = await createTrip(ravi, { title: 'Ravi trip' });

      const attempts = [
        ravi.get(`/api/v1/planner/trips/${trip.id}`),
        ravi.get(`/api/v1/planner/trips/${trip.id}/suggestions`),
        patch(ravi, `/trips/${trip.id}`, { version: 1, title: 'Hijacked' }),
        del(ravi, `/trips/${trip.id}`),
        post(ravi, `/trips/${trip.id}/items`, { day: START, title: 'Injected', category: 'other' }),
        patch(ravi, `/trips/${trip.id}/items/${itemId}`, { version: 1, title: 'Changed' }),
        patch(ravi, `/trips/${trip.id}/items/${itemId}`, { version: 1, day: DAY2 }),
        del(ravi, `/trips/${trip.id}/items/${itemId}`),
        post(ravi, `/trips/${trip.id}/items/${itemId}/duplicate`, {}),
        put(ravi, `/trips/${trip.id}/days/${START}/order`, {
          itemIds: [itemId],
          previousOrder: [itemId],
        }),
        // Asha's activity through Ravi's own trip: still not found.
        patch(ravi, `/trips/${raviTrip.id}/items/${itemId}`, { version: 1, title: 'Stolen' }),
        del(ravi, `/trips/${raviTrip.id}/items/${itemId}`),
        post(ravi, `/trips/${raviTrip.id}/items/${itemId}/duplicate`, {}),
        put(ravi, `/trips/${raviTrip.id}/days/${START}/order`, {
          itemIds: [itemId],
          previousOrder: [itemId],
        }),
      ];
      const results = await Promise.all(attempts);
      // All "not found" — except reordering Ravi's own (empty) day with Asha's
      // activity id, which is refused as a list that doesn't match the day.
      expect(results.map((r) => r.status)).toEqual([...Array(13).fill(404), 409]);
      for (const res of results) {
        expect(JSON.stringify(res.body)).not.toContain('Goa with friends');
      }
      const list = plannedTripListSchema.parse((await ravi.get('/api/v1/planner/trips')).body.data);
      expect(list.items.map((x) => x.title)).toEqual(['Ravi trip']);

      const unchanged = await getTrip(asha, trip.id);
      expect(unchanged.title).toBe('Goa with friends');
      expect(titles(unchanged, START)).toEqual(['A', 'B']);
      expect(unchanged.version).toBe(1);
      expect((await getTrip(ravi, raviTrip.id)).itemCount).toBe(0);
    });

    it('requires a session, a trusted origin, valid ids and respects the write rate limit', async () => {
      const target = app({ PLANNER_RATE_LIMIT_MAX: 3 });
      expect((await request(target).get('/api/v1/planner/trips')).status).toBe(401);
      expect((await request(target).get('/api/v1/planner/destinations')).status).toBe(401);
      const agent = await signedIn(target);
      expect((await agent.get('/api/v1/planner/trips/not-a-uuid')).status).toBe(400);
      const crossSite = await agent
        .post('/api/v1/planner/trips')
        .set('Origin', 'https://evil.example')
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'x', destinationId: 'goa', startDate: START, endDate: END });
      expect(crossSite.status).toBe(403);

      const statuses: number[] = [];
      for (let n = 0; n < 4; n += 1) {
        statuses.push(
          (
            await post(agent, '/trips', {
              title: `T${n}`,
              destinationId: 'goa',
              startDate: START,
              endDate: END,
            })
          ).status,
        );
      }
      // The refused cross-site attempt above didn't reach the limiter.
      expect(statuses).toEqual([201, 201, 201, 429]);
      // Reads are not write-limited.
      expect((await agent.get('/api/v1/planner/trips')).status).toBe(200);
    });
  });
});
