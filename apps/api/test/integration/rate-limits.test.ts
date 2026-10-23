import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers.js';
import { ORIGIN, TEST_DATABASE_URL, disconnect, resetAccounts, testPrisma } from './db.js';

/*
 * Write limits on authenticated endpoints (Phase 16): notification writes are
 * limited per signed-in user, so one account can't hammer them and accounts
 * don't share a budget.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the rate-limit tests would be skipped.');
}

const app = () =>
  buildTestApp({
    prisma: testPrisma(),
    env: { NOTIFICATION_RATE_LIMIT_MAX: 3 },
    logger: pino({ level: 'silent' }),
  });

async function signedIn(target: ReturnType<typeof app>, email: string) {
  const agent = request.agent(target);
  await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: 'Asha Rao', email, password: 'blue river morning' })
    .expect(201);
  return agent;
}

describe.skipIf(!TEST_DATABASE_URL)('per-user write limits (integration)', () => {
  beforeEach(resetAccounts);
  afterAll(disconnect);

  it('limits notification writes per user, with the standard 429 envelope', async () => {
    const target = app();
    const a = await signedIn(target, 'a@example.com');
    const b = await signedIn(target, 'b@example.com');
    const write = (agent: typeof a) =>
      agent.post('/api/v1/notifications/read-all').set('Origin', ORIGIN);
    for (let i = 0; i < 3; i += 1) expect((await write(a)).status).toBe(200);
    const limited = await write(a);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.message).toMatch(/notification changes/);
    // Reads aren't limited by it, and another account has its own budget.
    expect((await a.get('/api/v1/notifications/unread-count')).status).toBe(200);
    expect((await write(b)).status).toBe(200);
  });
});
