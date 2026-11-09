import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PUSH_NOT_CONFIGURED_STATUS, notificationPreferencesSchema } from '@wayora/contracts';
import { notify } from '../../src/modules/notifications/notify.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  buildAccountsApp,
  disconnect,
  resetAccounts,
  testPrisma,
} from './db.js';

/*
 * Browser push subscriptions (Phase 30, docs/pwa.md#push) against a real
 * PostgreSQL: saved per session, owned, taken over on a shared browser,
 * removed, and push deliveries queued only for signed-in devices whose
 * owner wants that topic.
 */

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the push tests would be skipped.');
}

/** A syntactically valid VAPID public key (the API only hands it to browsers). */
const PUBLIC_KEY = `B${'A'.repeat(86)}`;
const PASSWORD = 'blue river morning';
const NAMES = ['Asha Rao', 'Ravi Kumar', 'Lena Das'];
let counter = 0;

const endpoint = () => `https://push.example.test/send/${randomUUID()}`;
const subscription = (url = endpoint()) => ({
  endpoint: url,
  expirationTime: null,
  keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'a1b2c3d4e5f6g7h8i9j0kw' },
});

function app(withPush = true) {
  return buildAccountsApp(withPush ? { env: { VAPID_PUBLIC_KEY: PUBLIC_KEY } } : {});
}

async function signUp(target: ReturnType<typeof app>) {
  const email = `push-${(counter += 1)}-${randomUUID().slice(0, 6)}@example.com`;
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name: NAMES[counter % NAMES.length], email, password: PASSWORD });
  expect(res.status).toBe(201);
  const user = await testPrisma().user.findUniqueOrThrow({ where: { email } });
  return { agent, email, userId: user.id };
}

const subscribe = (agent: request.Agent, body: object) =>
  agent.post('/api/v1/notifications/push/subscriptions').set('Origin', ORIGIN).send(body);

async function notifyBooking(userId: string, dedupeKey = `push-test:${randomUUID()}`) {
  await testPrisma().$transaction((tx) =>
    notify(tx, new Date(), {
      userId,
      type: 'BOOKING_CONFIRMED',
      title: 'Demo booking confirmed',
      message: 'Booking WYD-TEST has a demo confirmation.',
      isDemo: true,
      dedupeKey,
    }),
  );
  return testPrisma().notification.findUniqueOrThrow({
    where: { dedupeKey },
    include: { deliveries: true },
  });
}

describe.skipIf(!TEST_DATABASE_URL)('browser push subscriptions (PostgreSQL)', () => {
  beforeEach(() => resetAccounts());
  afterAll(() => disconnect());

  it('says push isn’t set up, and refuses subscriptions, without VAPID keys', async () => {
    const { agent } = await signUp(app(false));
    const prefs = notificationPreferencesSchema.parse(
      (await agent.get('/api/v1/notifications/preferences')).body.data,
    );
    expect(prefs.push).toEqual({
      active: false,
      status: PUSH_NOT_CONFIGURED_STATUS,
      publicKey: null,
    });
    const res = await subscribe(agent, subscription());
    expect(res.status).toBe(503);
    expect(await testPrisma().pushSubscription.count()).toBe(0);
  });

  it('gives browsers the public key and saves a subscription against the session', async () => {
    const target = app();
    const { agent, userId } = await signUp(target);
    const prefs = notificationPreferencesSchema.parse(
      (await agent.get('/api/v1/notifications/preferences')).body.data,
    );
    expect(prefs.push).toMatchObject({ active: true, publicKey: PUBLIC_KEY });
    expect(prefs.pushBookings).toBe(true);

    const body = subscription();
    const res = await subscribe(agent, body);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ subscribed: true });
    expect(res.headers['cache-control']).toBe('no-store');
    // The same browser again: still one row.
    expect((await subscribe(agent, body)).status).toBe(201);
    const rows = await testPrisma().pushSubscription.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    const session = await testPrisma().session.findFirstOrThrow({ where: { userId } });
    expect(rows[0]).toMatchObject({ endpoint: body.endpoint, sessionId: session.id });
  });

  it('validates subscriptions, needs a session and a trusted origin', async () => {
    const target = app();
    const { agent } = await signUp(target);
    for (const bad of [
      { ...subscription(), endpoint: 'http://push.example.test/x' },
      { ...subscription(), keys: { p256dh: 'not a key!', auth: 'x' } },
      { ...subscription(), extra: true },
      { endpoint: endpoint() },
    ]) {
      expect((await subscribe(agent, bad)).status).toBe(400);
    }
    const anonymous = await request(target)
      .post('/api/v1/notifications/push/subscriptions')
      .set('Origin', ORIGIN)
      .send(subscription());
    expect(anonymous.status).toBe(401);
    const foreign = await agent
      .post('/api/v1/notifications/push/subscriptions')
      .set('Origin', 'https://evil.example')
      .send(subscription());
    expect(foreign.status).toBe(403);
    expect(await testPrisma().pushSubscription.count()).toBe(0);
  });

  it('on a shared browser the subscription moves to whoever turned push on last', async () => {
    const target = app();
    const first = await signUp(target);
    const second = await signUp(target);
    const body = subscription();
    await subscribe(first.agent, body);
    await subscribe(second.agent, body);
    const row = await testPrisma().pushSubscription.findUniqueOrThrow({
      where: { endpoint: body.endpoint },
    });
    expect(row.userId).toBe(second.userId);
    // The first user can't remove the second user's subscription.
    const res = await first.agent
      .delete('/api/v1/notifications/push/subscriptions')
      .set('Origin', ORIGIN)
      .send({ endpoint: body.endpoint });
    expect(res.status).toBe(200);
    expect(await testPrisma().pushSubscription.count()).toBe(1);
    // Its owner can.
    await second.agent
      .delete('/api/v1/notifications/push/subscriptions')
      .set('Origin', ORIGIN)
      .send({ endpoint: body.endpoint });
    expect(await testPrisma().pushSubscription.count()).toBe(0);
  });

  it('queues a push only for signed-in devices, and only for topics the user wants', async () => {
    const target = app();
    const { agent, userId } = await signUp(target);

    // No device: email only (the in-app notification is always kept).
    let n = await notifyBooking(userId);
    expect(n.deliveries.map((d) => d.channel)).toEqual(['EMAIL']);

    await subscribe(agent, subscription());
    n = await notifyBooking(userId);
    expect(n.deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'PUSH']);
    expect(n.deliveries.find((d) => d.channel === 'PUSH')?.status).toBe('PENDING');

    // The same event again adds nothing.
    const key = `push-test:${randomUUID()}`;
    await notifyBooking(userId, key);
    await notifyBooking(userId, key);
    expect(
      await testPrisma().notificationDelivery.count({
        where: { notification: { dedupeKey: key }, channel: 'PUSH' },
      }),
    ).toBe(1);

    // Topic turned off: no push.
    await agent
      .patch('/api/v1/notifications/preferences')
      .set('Origin', ORIGIN)
      .send({ pushBookings: false })
      .expect(200);
    n = await notifyBooking(userId);
    expect(n.deliveries.map((d) => d.channel)).toEqual(['EMAIL']);
    await agent
      .patch('/api/v1/notifications/preferences')
      .set('Origin', ORIGIN)
      .send({ pushBookings: true })
      .expect(200);

    // Signed out: the device's session is revoked, so nothing more is pushed to it.
    await agent.post('/api/v1/auth/logout').set('Origin', ORIGIN).expect(200);
    n = await notifyBooking(userId);
    expect(n.deliveries.map((d) => d.channel)).toEqual(['EMAIL']);
  });

  it('removes subscriptions with their session', async () => {
    const target = app();
    const { agent, userId } = await signUp(target);
    await subscribe(agent, subscription());
    await testPrisma().session.deleteMany({ where: { userId } });
    expect(await testPrisma().pushSubscription.count()).toBe(0);
  });
});
