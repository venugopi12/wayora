import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TRAVELLERS_PER_USER } from '@wayora/contracts';
import { hashSessionToken } from '../../src/modules/auth/session-token.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  buildAccountsApp,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PASSWORD = 'blue river morning';
const COOKIE = 'wayora_session';

type Agent = ReturnType<typeof request.agent>;

/** Pulls the session token out of a response's Set-Cookie header. */
function sessionTokenFrom(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith(`${COOKIE}=`));
  const value = cookie?.split(';')[0]?.split('=')[1];
  return value ? decodeURIComponent(value) : undefined;
}

const register = (agent: Agent, body: Record<string, unknown> = {}) =>
  agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email: 'asha@example.com', password: PASSWORD, ...body });

const login = (agent: Agent, email = 'asha@example.com', password = PASSWORD) =>
  agent.post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password });

// Without TEST_DATABASE_URL this suite is reported as skipped (see docs/auth.md#running-the-tests).
// In CI it must run: a skipped suite would let the pipeline pass untested.
if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the integration tests would be skipped.',
  );
}

describe.skipIf(!TEST_DATABASE_URL)('accounts (integration, real PostgreSQL)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  describe('POST /auth/register', () => {
    it('creates the account, hashes the password and starts a session', async () => {
      const agent = request.agent(buildAccountsApp());
      const res = await register(agent, { email: '  Asha@Example.COM ', name: '  Asha   Rao ' });

      expect(res.status).toBe(201);
      expect(res.body.data.user).toEqual({
        id: expect.any(String),
        name: 'Asha Rao',
        email: 'asha@example.com',
        emailVerified: false,
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|blue river/);
      expect(res.headers['cache-control']).toBe('no-store');

      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cookie).toMatch(/^wayora_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Max-Age=2592000/);
      expect(cookie).not.toMatch(/Domain=/);

      const row = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'asha@example.com' },
      });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.emailVerifiedAt).toBeNull();
      // Only the hash of the token is stored.
      const token = sessionTokenFrom(res)!;
      const sessions = await testPrisma().session.findMany({ where: { userId: row.id } });
      expect(sessions.map((s) => s.tokenHash)).toEqual([hashSessionToken(token)]);

      expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    });

    it('rejects a duplicate email regardless of case, without revealing more', async () => {
      await register(request.agent(buildAccountsApp()));
      const res = await register(request.agent(buildAccountsApp()), { email: 'ASHA@example.com' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toMatch(/couldn't create an account/i);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await testPrisma().user.count()).toBe(1);
    });

    it('validates input and never echoes the password', async () => {
      const app = buildAccountsApp();
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: '', email: 'not-an-email', password: 'password123', role: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(
        expect.arrayContaining(['body.name', 'body.email', 'body.password', 'body']),
      );
      expect(JSON.stringify(res.body)).not.toContain('password123');

      const short = await request(app)
        .post('/api/v1/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: 'Asha', email: 'a@example.com', password: 'short' });
      expect(short.status).toBe(400);
      const long = await request(app)
        .post('/api/v1/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: 'Asha', email: 'a@example.com', password: 'x'.repeat(129) });
      expect(long.status).toBe(400);
      expect(await testPrisma().user.count()).toBe(0);
    });
  });

  describe('POST /auth/login', () => {
    it('verifies the password and starts a fresh session', async () => {
      await register(request.agent(buildAccountsApp()));
      const agent = request.agent(buildAccountsApp());
      const res = await login(agent, '  ASHA@example.com ');
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('asha@example.com');
      expect(sessionTokenFrom(res)).toBeDefined();
      expect((await agent.get('/api/v1/auth/me')).body.data.user.name).toBe('Asha Rao');
    });

    it('fails identically for a wrong password, an unknown email and a password-less account', async () => {
      const app = buildAccountsApp();
      await register(request.agent(app));
      await testPrisma().user.create({ data: { email: 'seed@example.com', displayName: 'Seed' } });

      const responses = await Promise.all([
        login(request.agent(app), 'asha@example.com', 'wrong password here'),
        login(request.agent(app), 'nobody@example.com', PASSWORD),
        login(request.agent(app), 'seed@example.com', PASSWORD),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      expect(new Set(responses.map((r) => r.body.error.message)).size).toBe(1);
    });

    it('rotates the session: signing in again revokes the session the browser held', async () => {
      const agent = request.agent(buildAccountsApp());
      const first = sessionTokenFrom(await register(agent))!;
      const second = sessionTokenFrom(await login(agent))!;
      expect(second).not.toBe(first);

      const old = await request(buildAccountsApp())
        .get('/api/v1/auth/me')
        .set('Cookie', `${COOKIE}=${first}`);
      expect(old.status).toBe(401);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    });

    it('refuses suspended accounts, and their existing sessions stop working', async () => {
      const agent = request.agent(buildAccountsApp());
      await register(agent);
      await testPrisma().user.update({
        where: { email: 'asha@example.com' },
        data: { status: 'SUSPENDED' },
      });
      expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
      expect((await login(request.agent(buildAccountsApp()))).status).toBe(401);
    });

    it('upgrades hashes made with older Argon2 parameters on successful login', async () => {
      const old = await hash(PASSWORD, {
        algorithm: 2,
        memoryCost: 4096,
        timeCost: 3,
        parallelism: 1,
      });
      await testPrisma().user.create({
        data: { email: 'old@example.com', displayName: 'Old', passwordHash: old },
      });
      expect((await login(request.agent(buildAccountsApp()), 'old@example.com')).status).toBe(200);
      const row = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'old@example.com' },
      });
      expect(row.passwordHash).toMatch(/\$m=19456,t=2,p=1\$/);
    });
  });

  describe('sessions', () => {
    it('GET /auth/me is 401 without a cookie, with garbage, or with an unknown token', async () => {
      const app = buildAccountsApp();
      for (const cookie of [undefined, `${COOKIE}=garbage`, `${COOKIE}=${'A'.repeat(43)}`]) {
        const req = request(app).get('/api/v1/auth/me');
        const res = cookie ? await req.set('Cookie', cookie) : await req;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('GET /auth/session answers 200 with user null when signed out, and clears a dead cookie', async () => {
      const app = buildAccountsApp();
      const anonymous = await request(app).get('/api/v1/auth/session');
      expect(anonymous.status).toBe(200);
      expect(anonymous.body.data).toEqual({ user: null });
      expect(anonymous.headers['cache-control']).toBe('no-store');
      expect(anonymous.headers['set-cookie']).toBeUndefined();

      for (const cookie of [`${COOKIE}=garbage`, `${COOKIE}=${'A'.repeat(43)}`]) {
        const res = await request(app).get('/api/v1/auth/session').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ user: null });
        const cleared = (res.headers['set-cookie'] as unknown as string[])[0]!;
        expect(cleared).toMatch(/^wayora_session=;/);
        expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      }
    });

    it('GET /auth/session returns the safe user for a valid session, and null once it is revoked', async () => {
      const agent = request.agent(buildAccountsApp());
      const registered = await register(agent);
      const token = sessionTokenFrom(registered)!;

      const res = await agent.get('/api/v1/auth/session');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ user: registered.body.data.user });
      expect(res.headers['set-cookie']).toBeUndefined();
      // Neither the token nor its hash is ever echoed.
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toContain(hashSessionToken(token));

      await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN);
      const replay = await request(buildAccountsApp())
        .get('/api/v1/auth/session')
        .set('Cookie', `${COOKIE}=${token}`);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual({ user: null });
    });

    it('never accepts a client-supplied user id as identity', async () => {
      const agent = request.agent(buildAccountsApp());
      const { body } = await register(agent);
      const res = await request(buildAccountsApp())
        .get('/api/v1/users/me')
        .set('X-User-Id', body.data.user.id)
        .query({ userId: body.data.user.id });
      expect(res.status).toBe(401);
    });

    it('expires after the idle timeout, and activity slides it forward', async () => {
      const clock = testClock();
      const app = buildAccountsApp({ now: clock.now });
      const agent = request.agent(app);
      await register(agent);

      clock.advance(6 * DAY);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(200); // touches the session
      clock.advance(6 * DAY);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(200); // 12 days in, still active
      clock.advance(7 * DAY + HOUR);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(401); // idle for > 7 days
    });

    it('ends at the absolute lifetime however active it is', async () => {
      const clock = testClock();
      const agent = request.agent(buildAccountsApp({ now: clock.now }));
      await register(agent);
      for (let day = 5; day < 30; day += 5) {
        clock.advance(5 * DAY);
        expect((await agent.get('/api/v1/auth/me')).status, `day ${day}`).toBe(200);
      }
      clock.advance(5 * DAY + HOUR); // past day 30
      expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    });

    it('logout revokes the session server-side, clears the cookie, and is repeatable', async () => {
      const agent = request.agent(buildAccountsApp());
      const token = sessionTokenFrom(await register(agent))!;

      const out = await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN);
      expect(out.status).toBe(200);
      expect(out.body.data).toEqual({ signedOut: true });
      const cleared = (out.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cleared).toMatch(/^wayora_session=;/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/HttpOnly/);
      expect(cleared).toMatch(/SameSite=Lax/);

      // Replaying the old cookie value doesn't work.
      const replay = await request(buildAccountsApp())
        .get('/api/v1/auth/me')
        .set('Cookie', `${COOKIE}=${token}`);
      expect(replay.status).toBe(401);
      const row = await testPrisma().session.findUniqueOrThrow({
        where: { tokenHash: hashSessionToken(token) },
      });
      expect(row.revokedAt).not.toBeNull();

      // Again, and with no cookie at all: still fine.
      expect((await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN)).status).toBe(200);
      expect(
        (await request(buildAccountsApp()).post('/api/v1/auth/logout').set('Origin', ORIGIN))
          .status,
      ).toBe(200);
    });

    it('logout-all revokes every session of that user only', async () => {
      const app = buildAccountsApp();
      const laptop = request.agent(app);
      const phone = request.agent(app);
      const other = request.agent(app);
      await register(laptop);
      await login(phone);
      await register(other, { email: 'ben@example.com', name: 'Ben' });

      const res = await phone.post('/api/v1/auth/logout-all').set('Origin', ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.data.sessionsRevoked).toBe(2);
      expect((await laptop.get('/api/v1/auth/me')).status).toBe(401);
      expect((await phone.get('/api/v1/auth/me')).status).toBe(401);
      expect((await other.get('/api/v1/auth/me')).status).toBe(200);
    });

    it('purges expired and long-revoked sessions', async () => {
      const clock = testClock();
      const agent = request.agent(buildAccountsApp({ now: clock.now }));
      await register(agent);
      const { createSessionService } = await import('../../src/app.js');
      const { parseEnv } = await import('../../src/config/env.js');
      const { validEnvSource } = await import('../helpers.js');
      const later = testClock(clock.now().getTime() + 40 * DAY);
      const service = createSessionService(testPrisma(), parseEnv(validEnvSource), later.now);
      expect(await service.purgeExpired()).toBe(1);
      expect(await testPrisma().session.count()).toBe(0);
    });
  });

  describe('CSRF and rate limits', () => {
    it('rejects state-changing requests from other origins before doing anything', async () => {
      await register(request.agent(buildAccountsApp()));
      const res = await request(buildAccountsApp())
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'asha@example.com', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await testPrisma().session.count()).toBe(1);
    });

    it('limits sign-in attempts per IP', async () => {
      const app = buildAccountsApp({ env: { AUTH_RATE_LIMIT_MAX: 3 } });
      for (let i = 0; i < 3; i += 1) {
        expect((await login(request.agent(app), `n${i}@example.com`)).status).toBe(401);
      }
      const blocked = await login(request.agent(app), 'n9@example.com');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });

    it('limits failed logins per email, counting failures only', async () => {
      const app = buildAccountsApp({
        env: { AUTH_RATE_LIMIT_MAX: 100, LOGIN_FAILURES_PER_EMAIL_MAX: 2 },
      });
      await register(request.agent(app));
      expect((await login(request.agent(app))).status).toBe(200); // successes don't count
      expect((await login(request.agent(app), 'asha@example.com', 'wrong one!!')).status).toBe(401);
      expect((await login(request.agent(app), 'ASHA@example.com', 'wrong two!!')).status).toBe(401);
      // Third attempt for this address is blocked even with the right password…
      expect((await login(request.agent(app))).status).toBe(429);
      // …while other addresses are unaffected.
      expect((await login(request.agent(app), 'someone@example.com')).status).toBe(401);
    });
  });

  describe('profile', () => {
    it('requires a session', async () => {
      const app = buildAccountsApp();
      expect((await request(app).get('/api/v1/users/me')).status).toBe(401);
      expect(
        (await request(app).patch('/api/v1/users/me').set('Origin', ORIGIN).send({ name: 'X' }))
          .status,
      ).toBe(401);
    });

    it('returns and updates the permitted fields', async () => {
      const agent = request.agent(buildAccountsApp());
      await register(agent);
      const me = await agent.get('/api/v1/users/me');
      expect(me.status).toBe(200);
      expect(me.body.data.email).toBe('asha@example.com');

      const res = await agent
        .patch('/api/v1/users/me')
        .set('Origin', ORIGIN)
        .send({ name: '  Asha  R. ' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Asha R.');
      expect((await agent.get('/api/v1/auth/me')).body.data.user.name).toBe('Asha R.');
    });

    it('rejects privileged or unknown fields and leaves the account unchanged', async () => {
      const agent = request.agent(buildAccountsApp());
      await register(agent);
      for (const body of [
        { name: 'Ok', status: 'SUSPENDED' },
        { name: 'Ok', email: 'new@example.com' },
        { name: 'Ok', passwordHash: '$argon2id$x' },
        { name: 'Ok', role: 'admin' },
        { name: 'Ok', emailVerifiedAt: '2026-01-01T00:00:00Z' },
        {},
        { name: '' },
      ]) {
        const res = await agent.patch('/api/v1/users/me').set('Origin', ORIGIN).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const row = await testPrisma().user.findUniqueOrThrow({
        where: { email: 'asha@example.com' },
      });
      expect(row).toMatchObject({
        displayName: 'Asha Rao',
        status: 'ACTIVE',
        emailVerifiedAt: null,
      });
    });
  });

  describe('saved travellers', () => {
    const base = '/api/v1/users/me/travellers';

    it('creates, lists, edits and deletes travellers', async () => {
      const agent = request.agent(buildAccountsApp());
      await register(agent);
      expect((await agent.get(base)).body.data).toEqual([]);

      const created = await agent
        .post(base)
        .set('Origin', ORIGIN)
        .send({ firstName: 'Ravi', lastName: 'Rao', dateOfBirth: '2015-06-01', nationality: 'in' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        firstName: 'Ravi',
        lastName: 'Rao',
        dateOfBirth: '2015-06-01',
        nationality: 'IN',
      });
      const id = created.body.data.id as string;

      const edited = await agent
        .patch(`${base}/${id}`)
        .set('Origin', ORIGIN)
        .send({ firstName: 'Ravindra', dateOfBirth: null });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({
        firstName: 'Ravindra',
        lastName: 'Rao',
        dateOfBirth: null,
      });

      expect((await agent.get(base)).body.data).toHaveLength(1);
      const removed = await agent.delete(`${base}/${id}`).set('Origin', ORIGIN);
      expect(removed.status).toBe(200);
      expect((await agent.get(base)).body.data).toEqual([]);
      expect((await agent.delete(`${base}/${id}`).set('Origin', ORIGIN)).status).toBe(404);
    });

    it('validates traveller fields', async () => {
      const agent = request.agent(buildAccountsApp());
      await register(agent);
      const future = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
      for (const body of [
        { lastName: 'Rao' },
        { firstName: 'Ravi', lastName: '' },
        { firstName: 'Ravi', lastName: 'Rao', dateOfBirth: '2015-02-30' },
        { firstName: 'Ravi', lastName: 'Rao', dateOfBirth: future },
        { firstName: 'Ravi', lastName: 'Rao', nationality: 'IND' },
        { firstName: 'Ravi', lastName: 'Rao', passportNumber: 'X1234567' },
        { firstName: 'Ravi', lastName: 'Rao', userId: '01890000-0000-7000-8000-000000000000' },
      ]) {
        const res = await agent.post(base).set('Origin', ORIGIN).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(
        (await agent.patch(`${base}/not-a-uuid`).set('Origin', ORIGIN).send({ firstName: 'A' }))
          .status,
      ).toBe(400);
      expect(await testPrisma().traveller.count()).toBe(0);
    });

    it("enforces ownership: another user's traveller is simply not found", async () => {
      const app = buildAccountsApp();
      const asha = request.agent(app);
      const ben = request.agent(app);
      await register(asha);
      await register(ben, { email: 'ben@example.com', name: 'Ben' });
      const { body } = await asha
        .post(base)
        .set('Origin', ORIGIN)
        .send({ firstName: 'Ravi', lastName: 'Rao' });
      const id = body.data.id as string;

      expect((await ben.get(base)).body.data).toEqual([]);
      const edit = await ben
        .patch(`${base}/${id}`)
        .set('Origin', ORIGIN)
        .send({ firstName: 'Hacked' });
      expect(edit.status).toBe(404);
      expect(edit.body.error.message).toBe('That traveller was not found.');
      expect((await ben.delete(`${base}/${id}`).set('Origin', ORIGIN)).status).toBe(404);

      const row = await testPrisma().traveller.findUniqueOrThrow({ where: { id } });
      expect(row.firstName).toBe('Ravi');
    });

    it(`caps saved travellers at ${MAX_TRAVELLERS_PER_USER}`, async () => {
      const agent = request.agent(buildAccountsApp());
      const { body } = await register(agent);
      await testPrisma().traveller.createMany({
        data: Array.from({ length: MAX_TRAVELLERS_PER_USER }, (_, i) => ({
          userId: body.data.user.id as string,
          firstName: `T${String.fromCharCode(65 + i)}`,
          lastName: 'Rao',
        })),
      });
      const res = await agent
        .post(base)
        .set('Origin', ORIGIN)
        .send({ firstName: 'One', lastName: 'More' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('requires a session', async () => {
      expect((await request(buildAccountsApp()).get(base)).status).toBe(401);
    });
  });
});
