import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { pino } from 'pino';
import webpush from 'web-push';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@wayora/database';
import { validateWorkerEnv, vapidConfig } from '../src/config.js';
import {
  NotConfiguredPushSender,
  PushDeliveryError,
  PushDispatcher,
  classifyPushStatus,
  pushPayload,
  pushTarget,
  webPushOptions,
  type PushMessageOptions,
  type PushSender,
  type PushTarget,
} from '../src/notifications/push.js';

/*
 * Browser push (Phase 30, docs/pwa.md#push): the Web Push request itself
 * (VAPID signature, aes128gcm encryption, headers) checked by decrypting it
 * as a browser would, and the push outbox against a real PostgreSQL.
 */

const b64url = (b: Buffer) => b.toString('base64url');

/** A browser-side subscription: its key pair and auth secret, like PushManager makes. */
function browserSubscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const target: PushTarget = {
    endpoint: `https://push.example.test/send/${b64url(randomBytes(8))}`,
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
  };
  return { ecdh, auth, target };
}

describe('web push request (RFC 8030/8291/8292)', () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:ops@wayora.example' };
  const options: PushMessageOptions = { ttl: 86_400, topic: 'abc123', urgency: 'high' };

  it('is encrypted for the browser, signed with VAPID, and carries TTL, Topic and Urgency', () => {
    const { ecdh, auth, target } = browserSubscription();
    const payload = pushPayload({
      id: '01890000-0000-7000-8000-000000000001',
      title: 'Demo booking confirmed',
      message: 'Booking WYD-1 has a demo confirmation.',
      url: '/trips/WYD-1',
    });
    const req = webpush.generateRequestDetails(target, payload, webPushOptions(vapid, options));
    expect(req.method).toBe('POST');
    expect(req.endpoint).toBe(target.endpoint);
    expect(req.headers).toMatchObject({
      TTL: 86_400,
      Topic: 'abc123',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
    });
    // VAPID: a JWT signed by our private key, for this push service, with our public key.
    const authz = String(req.headers.Authorization);
    expect(authz).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    );
    const jwt = authz.slice(8, authz.indexOf(','));
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(claims).toMatchObject({ aud: 'https://push.example.test', sub: vapid.subject });
    // Only the browser can read it: decrypt with its private key and auth secret.
    const plain = ece.decrypt(req.body as Buffer, {
      version: 'aes128gcm',
      privateKey: ecdh,
      authSecret: auth.toString('base64url'),
    });
    expect(JSON.parse(plain.toString())).toEqual({
      title: 'Demo booking confirmed',
      body: 'Booking WYD-1 has a demo confirmation.',
      url: '/trips/WYD-1',
      tag: 'wayora-01890000-0000-7000-8000-000000000001',
    });
    // The payload isn't readable in transit.
    expect((req.body as Buffer).toString()).not.toContain('Demo booking');
  });

  it('classifies push service answers', () => {
    expect(classifyPushStatus(404)).toBe('gone');
    expect(classifyPushStatus(410)).toBe('gone');
    expect(classifyPushStatus(429)).toBe('transient');
    expect(classifyPushStatus(503)).toBe('transient');
    expect(classifyPushStatus(undefined)).toBe('transient');
    expect(classifyPushStatus(400)).toBe('permanent');
    expect(classifyPushStatus(413)).toBe('permanent');
  });

  it('links each notification to its page on this site', () => {
    const base = { paymentId: null, booking: null, supportTicket: null, type: 'BOOKING_CONFIRMED' };
    expect(pushTarget({ ...base, booking: { reference: 'WYD-1' } })).toBe('/trips/WYD-1');
    expect(pushTarget({ ...base, booking: { reference: 'WYD-1' }, paymentId: 'p1' })).toBe(
      '/trips/WYD-1/payments/p1',
    );
    expect(pushTarget({ ...base, supportTicket: { reference: 'SUP-1' } })).toBe('/support/SUP-1');
    expect(pushTarget({ ...base, type: 'REWARDS' })).toBe('/rewards');
    expect(pushTarget(base)).toBe('/notifications');
  });
});

describe('push configuration', () => {
  const base = { REDIS_URL: 'redis://localhost:6379' };
  it('is off without keys, on with all three, and refuses partial or malformed keys', () => {
    const off = validateWorkerEnv(base);
    expect(off.ok && vapidConfig(off.env)).toBeNull();
    const keys = webpush.generateVAPIDKeys();
    const on = validateWorkerEnv({
      ...base,
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'https://wayora.example/contact',
    });
    expect(on.ok && vapidConfig(on.env)).toMatchObject({ publicKey: keys.publicKey });
    for (const bad of [
      { VAPID_PUBLIC_KEY: keys.publicKey },
      {
        VAPID_PUBLIC_KEY: 'short',
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'mailto:a@b.c',
      },
      {
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'ops',
      },
    ]) {
      const result = validateWorkerEnv({ ...base, ...bad });
      expect(result.ok).toBe(false);
      // Never the key itself in the message.
      if (!result.ok) expect(result.issues.join(' ')).not.toContain(keys.privateKey);
    }
  });
});

// ─── The push outbox (real PostgreSQL) ──────────────────────────────────

const URL_ = process.env.TEST_DATABASE_URL;
if (process.env.CI && !URL_) {
  throw new Error(
    'CI is set but TEST_DATABASE_URL is not: the push outbox tests would be skipped.',
  );
}
if (URL_ && !new URL(URL_).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error('Refusing to run: TEST_DATABASE_URL must name a database ending in _test.');
}

/** Records sends; answers per endpoint with the given failure kinds (in order). */
class FakeSender implements PushSender {
  readonly configured = true;
  sent: { endpoint: string; payload: string; options: PushMessageOptions }[] = [];
  constructor(private readonly answers: Record<string, PushDeliveryError['kind'][]> = {}) {}
  async send(target: PushTarget, payload: string, options: PushMessageOptions) {
    const next = this.answers[target.endpoint]?.shift();
    if (next) throw new PushDeliveryError(next, `test_${next}`);
    this.sent.push({ endpoint: target.endpoint, payload, options });
  }
}

let prisma: PrismaClient;
const silent = pino({ level: 'silent' });

async function seed(devices: { endpoint: string; revoked?: boolean }[]) {
  const user = await prisma.user.create({
    data: {
      email: `p${Date.now()}${Math.random()}@example.com`.toLowerCase(),
      displayName: 'Test',
    },
  });
  for (const d of devices) {
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...(d.revoked ? { revokedAt: new Date() } : {}),
      },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        endpoint: d.endpoint,
        p256dh: `B${'x'.repeat(86)}`,
        auth: 'a1b2c3d4e5f6g7h8i9j0kw',
      },
    });
  }
  const n = await prisma.notification.create({
    data: {
      userId: user.id,
      type: 'BOOKING_CONFIRMED',
      title: 'Demo booking confirmed',
      message: 'Booking WYD-3333 has a demo confirmation.',
      isDemo: true,
      dedupeKey: `push:${user.id}`,
      deliveries: { create: { channel: 'PUSH', nextAttemptAt: new Date(Date.now() - 1000) } },
    },
    include: { deliveries: true },
  });
  return { user, notification: n, deliveryId: n.deliveries[0]!.id };
}

const run = (sender: PushSender, now?: () => Date) =>
  new PushDispatcher({ prisma, sender, logger: silent, ...(now ? { now } : {}) }).run();

describe.skipIf(!URL_)('push outbox (real PostgreSQL)', () => {
  beforeEach(async () => {
    prisma ??= createPrismaClient({ url: URL_!, maxConnections: 4 });
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "notifications", "notification_deliveries" CASCADE',
    );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('without VAPID keys: NOT_CONFIGURED, nothing sent', async () => {
    const { deliveryId } = await seed([{ endpoint: 'https://push.example.test/a' }]);
    expect(await run(new NotConfiguredPushSender())).toMatchObject({
      claimed: 1,
      notConfigured: 1,
    });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'NOT_CONFIGURED',
      sentAt: null,
    });
  });

  it('sends to every signed-in device once, with a tag and topic per notification', async () => {
    const { deliveryId, notification } = await seed([
      { endpoint: 'https://push.example.test/a' },
      { endpoint: 'https://push.example.test/b' },
      { endpoint: 'https://push.example.test/revoked', revoked: true },
    ]);
    const sender = new FakeSender();
    expect(await run(sender)).toMatchObject({ claimed: 1, sent: 1 });
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example.test/a',
      'https://push.example.test/b',
    ]);
    const payload = JSON.parse(sender.sent[0]!.payload) as Record<string, string>;
    expect(payload).toEqual({
      title: 'Demo booking confirmed',
      body: 'Booking WYD-3333 has a demo confirmation.',
      url: '/notifications',
      tag: `wayora-${notification.id}`,
    });
    expect(sender.sent[0]!.options).toEqual({
      ttl: 86_400,
      topic: notification.id.replace(/-/g, '').slice(0, 32),
      urgency: 'high',
    });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'SENT',
    });
    // Done: a second run sends nothing more.
    expect(await run(sender)).toMatchObject({ claimed: 0 });
    expect(sender.sent).toHaveLength(2);
  });

  it('forgets devices the push service says are gone', async () => {
    const { deliveryId } = await seed([
      { endpoint: 'https://push.example.test/gone' },
      { endpoint: 'https://push.example.test/ok' },
    ]);
    const sender = new FakeSender({ 'https://push.example.test/gone': ['gone'] });
    expect(await run(sender)).toMatchObject({ sent: 1, removedSubscriptions: 1 });
    expect((await prisma.pushSubscription.findMany()).map((s) => s.endpoint)).toEqual([
      'https://push.example.test/ok',
    ]);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } })).status,
    ).toBe('SENT');
  });

  it('retries with backoff only when every device failed temporarily, then gives up', async () => {
    let t = Date.now();
    const now = () => new Date(t);
    const { deliveryId } = await seed([{ endpoint: 'https://push.example.test/busy' }]);
    const sender = new FakeSender({
      'https://push.example.test/busy': [
        'transient',
        'transient',
        'transient',
        'transient',
        'transient',
      ],
    });
    expect(await run(sender, now)).toMatchObject({ retried: 1 });
    let row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row).toMatchObject({ status: 'PENDING', lastError: 'transient:test_transient' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t);
    // Not due yet: nothing happens.
    expect(await run(sender, now)).toMatchObject({ claimed: 0 });
    for (let i = 0; i < 4; i += 1) {
      t += 2 * 60 * 60 * 1000;
      await run(sender, now);
    }
    row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(sender.sent).toHaveLength(0);
    const device = await prisma.pushSubscription.findFirstOrThrow();
    expect(device.failureCount).toBe(5);
  });

  it('marks it FAILED when no signed-in device is left', async () => {
    const { deliveryId } = await seed([{ endpoint: 'https://push.example.test/x', revoked: true }]);
    const sender = new FakeSender();
    expect(await run(sender)).toMatchObject({ failed: 1 });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'FAILED',
      lastError: 'no_active_devices',
    });
    expect(sender.sent).toHaveLength(0);
  });

  it('never claims email rows (and the email dispatcher never claims push rows)', async () => {
    const { notification } = await seed([{ endpoint: 'https://push.example.test/a' }]);
    await prisma.notificationDelivery.create({
      data: {
        notificationId: notification.id,
        channel: 'EMAIL',
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    expect(await run(new FakeSender())).toMatchObject({ claimed: 1 });
    const email = await prisma.notificationDelivery.findFirstOrThrow({
      where: { channel: 'EMAIL' },
    });
    expect(email).toMatchObject({ status: 'PENDING', attempts: 0 });
  });
});
