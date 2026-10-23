import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bookingRequirementsFor,
  bookingSchema,
  tripDisruptionListSchema,
  tripStatusSchema,
  tripTimelineSchema,
  type Booking,
  type SearchResult,
  type SearchServiceType,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { createTravelReminders } from '../../src/modules/notifications/reminders.js';
import {
  DemoTravelStatusProvider,
  type DemoScenario,
} from '../../src/modules/trips/providers/demo.js';
import {
  TravelStatusError,
  type StatusQuery,
  type TravelStatusProvider,
} from '../../src/modules/trips/providers/types.js';
import { scheduledLegs } from '../../src/modules/trips/legs.js';
import { PgTripEventHub, type TripEventHub } from '../../src/modules/trips/stream.js';
import { TripsService } from '../../src/modules/trips/trips.service.js';
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
 * Trip tracking against a real PostgreSQL (docs/trips.md): the timeline the
 * database builds from booking and payment changes, travel status with
 * explicit freshness, disruptions and their notifications (once each),
 * ordering and idempotency of provider observations, ownership on every
 * endpoint, and live updates over Server-Sent Events (including real
 * LISTEN/NOTIFY).
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the trip tests would be skipped.');
}

type Agent = ReturnType<typeof request.agent>;
const MINUTE = 60_000;

const BASE_ENV: Partial<Env> = {
  SESSION_IDLE_TIMEOUT_HOURS: 24 * 90,
  SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 120,
  BOOKING_RATE_LIMIT_MAX: 1000,
  PAYMENT_RATE_LIMIT_MAX: 1000,
  TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX: 1000,
  PAYMENT_PROVIDER: 'demo',
  PAYMENT_DEMO_SCENARIOS: 'true',
  TRAVEL_STATUS_FRESH_SECONDS: 300,
  TRAVEL_STATUS_MIN_REFRESH_SECONDS: 60,
  TRAVEL_STATUS_TIMEOUT_MS: 300,
};

/** Wraps the demo provider: counts calls, and can fail, hang or answer garbage. */
class TestProvider implements TravelStatusProvider {
  readonly id = 'demo-status';
  readonly name = 'Wayora demo status (simulated)';
  readonly kind = 'demo' as const;
  calls = 0;
  mode: 'ok' | 'unavailable' | 'hang' | 'invalid' | 'leaky' = 'ok';
  scenario: DemoScenario = 'delayed';
  private readonly inner: DemoTravelStatusProvider;
  constructor(now: () => Date) {
    this.inner = new DemoTravelStatusProvider({ now, scenarioFor: () => this.scenario });
  }
  supports(t: SearchServiceType) {
    return this.inner.supports(t);
  }
  async fetchStatus(query: StatusQuery, signal: AbortSignal) {
    this.calls += 1;
    if (this.mode === 'unavailable')
      throw new TravelStatusError(
        'unavailable',
        'upstream 503 from https://user:hunter2@status.example/x?key=abc',
      );
    if (this.mode === 'leaky') throw new Error('ECONNREFUSED 10.9.9.9:443 token=supersecret');
    if (this.mode === 'hang') {
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    }
    if (this.mode === 'invalid') return { observedAt: 'yesterday', legs: 'lots' };
    return this.inner.fetchStatus(query, signal);
  }
}

function app(options: {
  clock: ReturnType<typeof testClock>;
  provider?: TravelStatusProvider | null;
  env?: Partial<Env>;
  hub?: TripEventHub;
  stream?: Record<string, number>;
}) {
  return buildTestApp({
    prisma: testPrisma(),
    env: { ...BASE_ENV, ...options.env },
    logger: pino({ level: 'silent' }),
    now: options.clock.now,
    travelStatus: {
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.stream ? { stream: options.stream } : {}),
    },
    ...(options.hub ? { tripEvents: options.hub } : {}),
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

async function book(agent: Agent, type: SearchServiceType, pay = true): Promise<Booking> {
  const { serviceType: _t, ...body } = VALID_INPUTS[type];
  const search = await agent.post(`/api/v1/search/${type}`).set('Origin', ORIGIN).send(body);
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
      ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
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

const timeline = async (agent: Agent, ref: string, q = '') => {
  const res = await agent.get(`/api/v1/bookings/${ref}/timeline${q}`);
  expect(res.status).toBe(200);
  return tripTimelineSchema.parse(res.body.data);
};
const status = async (agent: Agent, ref: string) => {
  const res = await agent.get(`/api/v1/bookings/${ref}/status`);
  expect(res.status).toBe(200);
  return tripStatusSchema.parse(res.body.data);
};
const refresh = (agent: Agent, ref: string) =>
  agent.post(`/api/v1/bookings/${ref}/status/refresh`).set('Origin', ORIGIN);
const disruptions = async (agent: Agent, ref: string, state = 'open') => {
  const res = await agent.get(`/api/v1/bookings/${ref}/disruptions?state=${state}`);
  expect(res.status).toBe(200);
  return tripDisruptionListSchema.parse(res.body.data);
};
const tripNotifications = () =>
  testPrisma().notification.findMany({
    where: { type: 'TRIP_DISRUPTION' },
    orderBy: { createdAt: 'asc' },
  });

describe.skipIf(!TEST_DATABASE_URL)('trip tracking (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('timeline', () => {
    it('is built by the database from booking and payment changes, oldest first, without traveller details', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent, 'hotels');
      const t = await timeline(agent, booking.reference);
      // The payment and the confirmation it caused share one instant (one
      // transaction); entries at the same instant keep their recorded order.
      expect(t.items.map((e) => e.type)).toEqual([
        'booking_created',
        'booking_confirmed',
        'payment_succeeded',
      ]);
      expect(t.items.every((e) => e.source === 'wayora' && e.observedAt === null)).toBe(true);
      expect(t.items[2]).toMatchObject({
        title: 'Demo payment succeeded',
        kind: 'payment',
        amount: booking.payment.amount,
        paymentId: expect.any(String),
      });
      expect(t.items[1]!.title).toBe('Demo booking confirmed');
      expect(JSON.stringify(t)).not.toMatch(/Asha|Rao|\+91/);
      const times = t.items.map((e) => Date.parse(e.occurredAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(t.nextCursor).toBeNull();
    });

    it('pages with a cursor: complete and without repeats; bad cursors are refused', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent, 'hotels');
      await agent
        .post(`/api/v1/bookings/${booking.reference}/cancel`)
        .set('Origin', ORIGIN)
        .expect(200);
      const all = (await timeline(agent, booking.reference)).items.map((e) => e.id);
      expect(all).toHaveLength(4);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await timeline(
          agent,
          booking.reference,
          `?limit=1${cursor ? `&after=${cursor}` : ''}`,
        );
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all);
      for (const q of ['?limit=0', '?limit=101', '?after=abc', '?after=1', '?orderBy=id']) {
        expect(
          (await agent.get(`/api/v1/bookings/${booking.reference}/timeline${q}`)).status,
          q,
        ).toBe(400);
      }
    });

    it('is append-only in the database', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      await book(agent, 'hotels');
      await expect(testPrisma().$executeRaw`UPDATE trip_events SET data = '{}'`).rejects.toThrow();
      await expect(testPrisma().$executeRaw`DELETE FROM trip_events`).rejects.toThrow();
    });

    it('reminders go on the timeline once, including a stay’s check-out', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent, 'hotels');
      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: booking.reference },
      });
      const dayBefore = (d: Date) => new Date(d.getTime() - 24 * 3600_000 + 12 * 3600_000);
      await createTravelReminders(testPrisma(), dayBefore(row.startsOn!));
      await createTravelReminders(testPrisma(), dayBefore(row.startsOn!));
      await createTravelReminders(testPrisma(), dayBefore(row.endsOn!));
      await createTravelReminders(testPrisma(), dayBefore(row.endsOn!));
      const types = (await timeline(agent, booking.reference)).items.map((e) => e.type);
      expect(types.filter((t) => t === 'travel_reminder')).toHaveLength(1);
      expect(types.filter((t) => t === 'check_out_reminder')).toHaveLength(1);
      const titles = (await timeline(agent, booking.reference)).items.map((e) => e.title);
      expect(titles).toEqual(
        expect.arrayContaining(['Check-in is tomorrow', 'Check-out is tomorrow']),
      );
    });
  });

  describe('ownership and validation', () => {
    it('signed out: 401; someone else’s booking: 404 on every endpoint', async () => {
      const clock = testClock();
      const target = app({ clock });
      const owner = await signedIn(target);
      const booking = await book(owner, 'flights');
      const other = await signedIn(target, 'mallory@example.com');
      const paths = ['timeline', 'status', 'disruptions', 'events'];
      for (const p of paths) {
        expect(
          (await request(target).get(`/api/v1/bookings/${booking.reference}/${p}`)).status,
          p,
        ).toBe(401);
        const res = await other.get(`/api/v1/bookings/${booking.reference}/${p}`);
        expect(res.status, p).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(booking.reference.slice(4));
      }
      expect((await refresh(other, booking.reference)).status).toBe(404);
      // Cross-site refresh is refused before anything else.
      const forged = await owner
        .post(`/api/v1/bookings/${booking.reference}/status/refresh`)
        .set('Origin', 'https://evil.example');
      expect(forged.status).toBe(403);
      expect(
        (await owner.get(`/api/v1/bookings/${booking.reference}/status?refresh=1`)).status,
      ).toBe(400);
      expect(
        (await owner.get(`/api/v1/bookings/${booking.reference}/disruptions?state=fake`)).status,
      ).toBe(400);
    });

    it('users can’t write status or disruptions: no such endpoints exist', async () => {
      const clock = testClock();
      const agent = await signedIn(app({ clock }));
      const booking = await book(agent, 'flights');
      for (const [method, path] of [
        ['patch', 'status'],
        ['put', 'status'],
        ['post', 'disruptions'],
        ['patch', 'disruptions'],
        ['post', 'timeline'],
      ] as const) {
        const res = await agent[method](`/api/v1/bookings/${booking.reference}/${path}`)
          .set('Origin', ORIGIN)
          .send({ state: 'resolved', verified: true });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });
  });

  describe('travel status', () => {
    it('stays and unconfirmed bookings are unsupported; no provider means unavailable', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      const agent = await signedIn(app({ clock, provider }));
      const stay = await book(agent, 'hotels');
      const s = await status(agent, stay.reference);
      expect(s).toMatchObject({
        freshness: 'unsupported',
        legs: [],
        refresh: { available: false },
      });
      const r = await refresh(agent, stay.reference);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('TRIP_TRACKING_UNAVAILABLE');

      const unpaid = await book(agent, 'flights', false);
      expect((await status(agent, unpaid.reference)).freshness).toBe('unsupported');
      expect(provider.calls).toBe(0);

      const none = await signedIn(app({ clock, provider: null }), 'b@example.com');
      const flight = await book(none, 'flights');
      const n = await status(none, flight.reference);
      expect(n.freshness).toBe('unavailable');
      // The booking itself is unaffected: booked times are still shown.
      expect(n.legs[0]).toMatchObject({
        state: 'scheduled',
        estimatedDeparture: null,
        delayMinutes: null,
      });
      expect(n.legs[0]!.scheduledDeparture).toBe(
        flight.offer.serviceType === 'flights' ? flight.offer.itineraries[0]!.departAt : '',
      );
      expect((await refresh(none, flight.reference)).status).toBe(409);
    });

    it('pending → current (simulated) → stale; refreshes are throttled per booking', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'on_time';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      expect((await status(agent, flight.reference)).freshness).toBe('pending');

      const r = await refresh(agent, flight.reference);
      expect(r.status).toBe(200);
      const s = tripStatusSchema.parse(r.body.data);
      expect(s).toMatchObject({ freshness: 'current', source: 'demo', simulated: true });
      expect(s.explanation).toMatch(/Simulated/);
      expect(provider.calls).toBe(1);

      // Within the minimum interval: no provider call, the stored status.
      await refresh(agent, flight.reference).expect(200);
      expect(provider.calls).toBe(1);
      clock.advance(61_000);
      await refresh(agent, flight.reference).expect(200);
      expect(provider.calls).toBe(2);

      clock.advance(6 * MINUTE);
      const stale = await status(agent, flight.reference);
      expect(stale.freshness).toBe('stale');
      expect(stale.explanation).toMatch(/may have changed/);
    });

    it('a failing provider never shows as current, and its text never leaks', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'on_time';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');

      for (const mode of ['unavailable', 'leaky', 'invalid', 'hang'] as const) {
        provider.mode = mode;
        clock.advance(61_000);
        const res = await refresh(agent, flight.reference);
        expect(res.status, mode).toBe(200);
        expect(res.body.data.freshness, mode).toBe('unavailable');
        expect(JSON.stringify(res.body)).not.toMatch(
          /hunter2|supersecret|10\.9\.9\.9|503|ECONNREFUSED/,
        );
      }
      const stored = await testPrisma().tripStatus.findFirstOrThrow();
      expect(stored.lastErrorCode).toBe('timeout');

      provider.mode = 'ok';
      clock.advance(61_000);
      expect((await refresh(agent, flight.reference)).body.data.freshness).toBe('current');
      provider.mode = 'unavailable';
      clock.advance(61_000);
      const after = tripStatusSchema.parse((await refresh(agent, flight.reference)).body.data);
      expect(after.freshness).toBe('stale'); // last good status kept, marked stale
      expect(after.observedAt).not.toBeNull();
    });

    it('rate-limits refreshes per user', async () => {
      const clock = testClock();
      const agent = await signedIn(
        app({
          clock,
          provider: new TestProvider(clock.now),
          env: { TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX: 2 },
        }),
      );
      const flight = await book(agent, 'flights');
      await refresh(agent, flight.reference).expect(200);
      await refresh(agent, flight.reference).expect(200);
      const third = await refresh(agent, flight.reference);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('disruptions', () => {
    it('a delay: one timeline entry, one disruption, one notification — however often it is checked', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'delayed';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      for (let i = 0; i < 3; i += 1) {
        await refresh(agent, flight.reference).expect(200);
        clock.advance(61_000);
      }
      expect(provider.calls).toBe(3);
      const s = await status(agent, flight.reference);
      expect(s.legs[0]).toMatchObject({ state: 'delayed', delayMinutes: 45 });
      const d = await disruptions(agent, flight.reference);
      expect(d.items).toHaveLength(1);
      expect(d.items[0]).toMatchObject({
        type: 'departure_delay',
        severity: 'minor',
        state: 'active',
        source: 'demo',
        simulated: true,
        changes: { delayMinutes: 45 },
      });
      expect(d.notice).toMatch(/nothing is cancelled, rebooked, refunded or compensated/);
      const types = (await timeline(agent, flight.reference)).items.map((e) => e.type);
      expect(types.filter((t) => t === 'disruption_reported')).toHaveLength(1);
      expect(types.filter((t) => t === 'status_changed')).toHaveLength(1);
      const notes = await tripNotifications();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ isDemo: true });
      expect(notes[0]!.title).toMatch(/simulated/);
      expect(notes[0]!.message).toContain(flight.reference);
      // Shown through the existing notifications API, linked to the booking.
      const list = await agent.get('/api/v1/notifications');
      expect(list.body.data.items[0]).toMatchObject({
        type: 'trip_disruption',
        category: 'trip',
        link: { kind: 'booking', bookingReference: flight.reference },
      });
    });

    it('a cancellation is reported but never cancels the booking', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'cancelled';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      await refresh(agent, flight.reference).expect(200);
      const d = await disruptions(agent, flight.reference);
      expect(d.items[0]).toMatchObject({
        type: 'cancellation',
        severity: 'severe',
        state: 'active',
      });
      expect((await status(agent, flight.reference)).legs[0]!.state).toBe('cancelled');
      const after = await agent.get(`/api/v1/bookings/${flight.reference}`);
      expect(after.body.data.status).toBe('confirmed');
      expect(await testPrisma().payment.count({ where: { refundRequired: true } })).toBe(0);
    });

    it('state is unknown when the status is stale; resolved when no longer reported (once)', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'schedule_change';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      await refresh(agent, flight.reference).expect(200);
      clock.advance(10 * MINUTE);
      expect((await disruptions(agent, flight.reference)).items[0]!.state).toBe('unknown');

      provider.scenario = 'on_time';
      await refresh(agent, flight.reference).expect(200);
      clock.advance(61_000);
      await refresh(agent, flight.reference).expect(200);
      expect((await disruptions(agent, flight.reference)).items).toHaveLength(0);
      const all = await disruptions(agent, flight.reference, 'all');
      expect(all.items[0]).toMatchObject({ state: 'resolved', resolvedAt: expect.any(String) });
      const types = (await timeline(agent, flight.reference)).items.map((e) => e.type);
      expect(types.filter((t) => t === 'disruption_resolved')).toHaveLength(1);
      expect((await tripNotifications()).map((n) => n.title)).toEqual([
        'Trip update (simulated): schedule changed',
        'Trip update (simulated): disruption over',
      ]);
    });

    it('older or repeated observations never overwrite newer ones, and add nothing', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'delayed';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: flight.reference },
      });
      const service = new TripsService({
        prisma: testPrisma(),
        logger: pino({ level: 'silent' }),
        provider,
        freshMs: 300_000,
        minRefreshMs: 60_000,
        timeoutMs: 300,
        now: clock.now,
      });
      const legs = scheduledLegs(flight.offer);
      const at = (offsetMs: number) => new Date(clock.now().getTime() + offsetMs).toISOString();
      const delayed = (observedAt: string, delayMinutes: number) => ({
        observedAt,
        legs: [{ index: 0, state: 'delayed' as const, delayMinutes }],
        disruptions: [
          {
            key: 'k1',
            type: 'departure_delay' as const,
            severity: 'minor' as const,
            state: 'active' as const,
            legIndex: 0,
            delayMinutes,
          },
        ],
      });
      expect((await service.apply(row, legs, provider, delayed(at(0), 30))).applied).toBe(true);
      expect((await service.apply(row, legs, provider, delayed(at(60_000), 90))).applied).toBe(
        true,
      );
      // Arrives late: older than what is stored.
      expect((await service.apply(row, legs, provider, delayed(at(30_000), 30))).applied).toBe(
        false,
      );
      // The same observation again.
      expect((await service.apply(row, legs, provider, delayed(at(60_000), 90))).applied).toBe(
        false,
      );
      // Newer, but nothing changed.
      expect((await service.apply(row, legs, provider, delayed(at(120_000), 90))).applied).toBe(
        true,
      );

      const stored = await testPrisma().tripStatus.findUniqueOrThrow({
        where: { bookingId: row.id },
      });
      expect((stored.legs as { delayMinutes: number }[])[0]!.delayMinutes).toBe(90);
      const types = (await timeline(agent, flight.reference)).items.map((e) => e.type);
      expect(types.filter((t) => t.startsWith('disruption_'))).toEqual([
        'disruption_reported',
        'disruption_updated',
      ]);
      expect(await tripNotifications()).toHaveLength(2);

      // Concurrent duplicates: one result.
      await Promise.all([
        service.apply(row, legs, provider, delayed(at(180_000), 120)),
        service.apply(row, legs, provider, delayed(at(180_000), 120)),
      ]);
      expect(await tripNotifications()).toHaveLength(3);
    });

    it('the background sweep checks only trips travelling around today, idempotently', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      provider.scenario = 'delayed';
      const agent = await signedIn(app({ clock, provider }));
      const flight = await book(agent, 'flights');
      const row = await testPrisma().booking.findUniqueOrThrow({
        where: { reference: flight.reference },
      });
      const service = new TripsService({
        prisma: testPrisma(),
        logger: pino({ level: 'silent' }),
        provider,
        freshMs: 300_000,
        minRefreshMs: 60_000,
        timeoutMs: 300,
        now: clock.now,
      });
      expect(await service.sweep()).toEqual({ checked: 0 }); // travels in weeks, not today
      // The evening before departure (the delay is still ahead).
      clock.advance(row.startsOn!.getTime() - clock.now().getTime() - 12 * 3600_000);
      expect(await service.sweep()).toEqual({ checked: 1 });
      expect(await service.sweep()).toEqual({ checked: 0 }); // fresh now
      clock.advance(6 * MINUTE);
      expect(await service.sweep()).toEqual({ checked: 1 });
      expect(await tripNotifications()).toHaveLength(1);
    });
  });

  describe('live updates (Server-Sent Events)', () => {
    let server: Server | undefined;
    let hub: TripEventHub | undefined;
    afterEach(async () => {
      await hub?.close();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
      hub = undefined;
    });

    async function serve(target: ReturnType<typeof app>) {
      server = target.listen(0);
      await new Promise((r) => server!.once('listening', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    async function register(base: string, email: string) {
      const res = await fetch(`${base}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ name: 'Asha Rao', email, password: 'blue river morning' }),
      });
      expect(res.status).toBe(201);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    }
    function reader(res: Response) {
      const r = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      return {
        async until(pattern: RegExp, timeoutMs = 5000): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          while (!pattern.test(text)) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`Timed out waiting for ${pattern}; got: ${text}`);
            const chunk = await Promise.race([
              r.read(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
            ]);
            if (!chunk) continue;
            if (chunk.done) break;
            text += decoder.decode(chunk.value);
          }
          return text;
        },
        get text() {
          return text;
        },
        cancel: () => r.cancel(),
      };
    }

    it('pushes new timeline entries to the owner via PostgreSQL LISTEN/NOTIFY', async () => {
      const clock = testClock();
      const provider = new TestProvider(clock.now);
      hub = new PgTripEventHub(TEST_DATABASE_URL!, pino({ level: 'silent' }));
      const target = app({ clock, provider, hub, stream: { catchUpMs: 600_000 } });
      const agent = await signedIn(target);
      const flight = await book(agent, 'flights');
      const base = await serve(target);
      const cookie = await register(base, 'stranger@example.com');
      for (let i = 0; i < 50 && !hub.live; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(hub.live).toBe(true);

      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ email: 'asha@example.com', password: 'blue river morning' }),
      });
      const owner = login.headers.get('set-cookie')!.split(';')[0]!;
      const res = await fetch(`${base}/api/v1/bookings/${flight.reference}/events`, {
        headers: { Cookie: owner },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const sse = reader(res);
      await sse.until(/event: ready\ndata: \{"live":true\}/);

      // A disruption made through the API (another request) reaches the stream.
      await refresh(agent, flight.reference).expect(200);
      const text = await sse.until(/event: trip-event/);
      expect(text).toContain(`"reference":"${flight.reference}"`);
      expect(text).not.toMatch(/Asha|delay|provider/i);
      await sse.cancel();

      // Someone else can't open it.
      const strangerStream = await fetch(`${base}/api/v1/bookings/${flight.reference}/events`, {
        headers: { Cookie: cookie },
      });
      expect(strangerStream.status).toBe(404);
      expect((await fetch(`${base}/api/v1/bookings/${flight.reference}/events`)).status).toBe(401);
    });

    it('a reconnect with Last-Event-ID catches up from the database; sign-out ends the stream; too many streams are refused', async () => {
      const clock = testClock();
      const target = app({
        clock,
        provider: new TestProvider(clock.now),
        stream: { sessionCheckMs: 100, catchUpMs: 600_000, maxPerUser: 2 },
      });
      const base = await serve(target);
      const cookie = await register(base, 'asha@example.com');
      const agent = request.agent(target);
      await agent
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'asha@example.com', password: 'blue river morning' })
        .expect(200);
      const flight = await book(agent, 'flights');

      // Missed while away: everything after id 0.
      const res = await fetch(`${base}/api/v1/bookings/${flight.reference}/events`, {
        headers: { Cookie: cookie, 'Last-Event-ID': '0' },
      });
      const sse = reader(res);
      const text = await sse.until(/event: ready/);
      expect(text).toMatch(/id: \d+\nevent: trip-event/);

      const second = await fetch(`${base}/api/v1/bookings/${flight.reference}/events`, {
        headers: { Cookie: cookie },
      });
      expect(second.status).toBe(200);
      const third = await fetch(`${base}/api/v1/bookings/${flight.reference}/events`, {
        headers: { Cookie: cookie },
      });
      expect(third.status).toBe(429);
      await second.body?.cancel();

      // Signing out everywhere ends open streams at the next session check.
      await fetch(`${base}/api/v1/auth/logout-all`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN },
      });
      await sse.until(/event: end\ndata: \{"reason":"signed-out"\}/, 3000);
    });
  });
});
