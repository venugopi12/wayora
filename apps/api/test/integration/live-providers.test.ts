import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminHealthSchema, bookingRequirementsFor, type SearchResult } from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
import { DEMO_PROVIDERS } from '../../src/modules/providers/demo/index.js';
import type { ResilienceOptions } from '../../src/modules/search/search.service.js';
import {
  FIXTURE_CONFIG,
  FixtureSupplierServer,
  createFixtureAirProvider,
} from '../fixture-supplier.js';
import { buildTestApp } from '../helpers.js';
import { NO_RETRY, VALID_INPUTS } from '../search-support.js';
import { ORIGIN, TEST_DATABASE_URL, disconnect, resetAccounts, testPrisma } from './db.js';

/*
 * Live supplier offers against a real PostgreSQL (docs/providers.md): a
 * live offer is never booked through the demo flow, and admin health
 * reports each search provider from what is actually known (recent calls
 * and the circuit breaker), never "up" by default.
 */

const PASSWORD = 'blue river morning';
const KEY = FIXTURE_CONFIG.FIXTURE_AIR_API_KEY;
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the live provider tests would be skipped.',
  );
}

function app(
  server: FixtureSupplierServer,
  options: { demo?: boolean; resilience?: Partial<ResilienceOptions> } = {},
) {
  const env: Partial<Env> = {
    BOOKING_RATE_LIMIT_MAX: 1000,
    PAYMENT_PROVIDER: 'none',
    SEARCH_DEMO_PROVIDERS: options.demo ? 'true' : 'false',
  };
  return buildTestApp({
    prisma: testPrisma(),
    env,
    logger: pino({ level: 'silent' }),
    searchProviders: [
      createFixtureAirProvider(FIXTURE_CONFIG, { fetch: server.fetch }),
      ...DEMO_PROVIDERS,
    ],
    providerConfig: FIXTURE_CONFIG,
    searchResilience: { ...NO_RETRY, ...options.resilience },
  });
}

async function register(target: ReturnType<typeof app>, email: string): Promise<Agent> {
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
  return agent.post('/api/v1/search/flights').set('Origin', ORIGIN).send(body);
}

/** Search events are written off the request path; wait until `n` exist. */
async function searchEvents(n: number) {
  for (let i = 0; i < 50; i += 1) {
    if ((await testPrisma().searchEvent.count()) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} search events`);
}

async function health(target: ReturnType<typeof app>, email: string) {
  const agent = request.agent(target);
  await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password: PASSWORD })
    .expect(200);
  const res = await agent.get('/api/v1/admin/health');
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain(KEY);
  return adminHealthSchema.parse(res.body.data);
}

describe.skipIf(!TEST_DATABASE_URL)('live supplier offers (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  it('refuses to book a live offer: no booking, no reference, nothing sent to the supplier', async () => {
    const server = new FixtureSupplierServer();
    const agent = await register(app(server), 'asha@example.com');
    const search = await searchFlights(agent);
    expect(search.status).toBe(200);
    const offer = search.body.data.results[0] as SearchResult;
    expect(offer.source).toBe('live');
    const requirements = bookingRequirementsFor(offer);
    const callsBefore = server.calls.length;

    const res = await agent
      .post('/api/v1/bookings')
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({
        serviceType: 'flights',
        searchId: search.body.data.searchId,
        offerId: offer.id,
        travellers: requirements.namedTravellers.map(() => ({
          firstName: 'Asha',
          lastName: 'Rao',
        })),
        ...(requirements.contactPhone === 'required' ? { contactPhone: '+919876543210' } : {}),
        acceptedPrice: offer.price,
        acceptDemoTerms: true,
      });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/WAY-|reference|PNR|ticket/i);
    expect(await testPrisma().booking.count()).toBe(0);
    // Wayora has no supplier booking call: the supplier saw nothing after the search.
    expect(
      server.calls.slice(callsBefore).filter((c) => !c.url.pathname.endsWith('/price')),
    ).toEqual([]);
  });

  it('reports search providers as unknown, up or down from what is actually known', async () => {
    const server = new FixtureSupplierServer();
    const first = app(server, { demo: true });
    await register(first, 'admin@example.com');
    await setUserRole(testPrisma(), {
      email: 'admin@example.com',
      role: 'admin',
      reason: 'Test setup',
      actor: 'test',
    });

    // No calls yet: unknown, not "up".
    let h = await health(first, 'admin@example.com');
    const fixture = () => h.searchProviders.find((p) => p.id === 'fixture-air')!;
    expect(fixture()).toMatchObject({
      kind: 'live',
      enabled: true,
      status: 'unknown',
      breaker: 'closed',
      callsLastHour: 0,
      failedLastHour: 0,
      revalidates: true,
    });
    expect(h.searchProviders.filter((p) => p.kind === 'demo').length).toBe(DEMO_PROVIDERS.length);

    // A successful search: up.
    const user = await register(app(server, { demo: true }), 'ravi@example.com');
    expect((await searchFlights(user)).status).toBe(200);
    await searchEvents(1);
    h = await health(app(server, { demo: true }), 'admin@example.com');
    expect(fixture()).toMatchObject({ status: 'up', callsLastHour: 1, failedLastHour: 0 });

    // Failing calls: degraded, then down while the breaker is open.
    server.searchBehaviour = { kind: 'status', status: 503 };
    const breaking = app(server, {
      demo: true,
      resilience: { breaker: { failureThreshold: 1, cooldownMs: 60_000 } },
    });
    const ravi = request.agent(breaking);
    await ravi
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'ravi@example.com', password: PASSWORD })
      .expect(200);
    expect((await searchFlights(ravi)).status).toBe(200); // demo results still answer
    await searchEvents(2);
    h = await health(app(server, { demo: true }), 'admin@example.com');
    expect(fixture()).toMatchObject({ status: 'degraded', callsLastHour: 2, failedLastHour: 1 });
    h = await health(breaking, 'admin@example.com');
    expect(fixture()).toMatchObject({ status: 'down', breaker: 'open' });

    // Unconfigured: not configured, never called.
    const unconfigured = buildTestApp({
      prisma: testPrisma(),
      logger: pino({ level: 'silent' }),
      searchProviders: [createFixtureAirProvider({}, { fetch: server.fetch }), ...DEMO_PROVIDERS],
      providerConfig: {},
    });
    h = await health(unconfigured, 'admin@example.com');
    expect(fixture()).toMatchObject({
      enabled: false,
      status: 'not-configured',
      disabledReason: 'Not configured.',
    });
  });
});
