import { createPrismaClient, type PrismaClient } from '@wayora/database';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  NotificationDispatcher,
  backoffMs,
} from '../src/notifications/dispatcher.js';
import {
  EmailDeliveryError,
  NotConfiguredEmailProvider,
  type EmailMessage,
  type EmailProvider,
} from '../src/notifications/email.js';
import { DEMO_FOOTER, renderEmail } from '../src/notifications/templates.js';

/*
 * The notification outbox against a real PostgreSQL (TEST_DATABASE_URL, a
 * *_test database): leasing, not-configured, retries with backoff, permanent
 * failures, concurrent dispatchers and recovery after a worker dies.
 */

const URL_ = process.env.TEST_DATABASE_URL;
if (process.env.CI && !URL_) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the dispatcher tests would be skipped.');
}
if (URL_ && !new URL(URL_).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error('Refusing to run: TEST_DATABASE_URL must name a database ending in _test.');
}

let prisma: PrismaClient;
const silent = pino({ level: 'silent' });

/** Records what it "sends"; can fail the first N sends. */
class RecordingProvider implements EmailProvider {
  readonly id = 'test';
  readonly configured = true;
  sent: { message: EmailMessage; key: string }[] = [];
  constructor(
    private failures: { kind: 'transient' | 'permanent'; times: number } | null = null,
    private readonly delayMs = 0,
  ) {}
  async send(message: EmailMessage, key: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failures && this.failures.times > 0) {
      this.failures.times -= 1;
      throw new EmailDeliveryError(this.failures.kind, 'test_failure');
    }
    this.sent.push({ message, key });
    return { messageId: `msg_${this.sent.length}` };
  }
}

function clock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

async function seed(count = 1, title = 'Demo booking confirmed') {
  const user = await prisma.user.create({
    data: {
      email: `u${Date.now()}${Math.random()}@example.com`.toLowerCase(),
      displayName: 'Test',
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'BOOKING_CONFIRMED',
        title,
        message: 'Booking WYD-2222-2222 has a demo confirmation.',
        isDemo: true,
        dedupeKey: `test:${user.id}:${i}`,
        deliveries: { create: { channel: 'EMAIL', nextAttemptAt: new Date(Date.now() - 1000) } },
      },
      include: { deliveries: true },
    });
    ids.push(n.deliveries[0]!.id);
  }
  return { user, ids };
}

const dispatcher = (provider: EmailProvider, now?: () => Date) =>
  new NotificationDispatcher({
    prisma,
    provider,
    logger: silent,
    webOrigin: 'https://wayora.example',
    ...(now ? { now } : {}),
  });

describe.skipIf(!URL_)('notification outbox dispatcher (real PostgreSQL)', () => {
  beforeEach(async () => {
    prisma ??= createPrismaClient({ url: URL_!, maxConnections: 4 });
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "notifications", "notification_deliveries" CASCADE',
    );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('without an email provider: NOT_CONFIGURED, never SENT, nothing sent, done once', async () => {
    const { ids } = await seed(3);
    const run = dispatcher(new NotConfiguredEmailProvider());
    expect(await run.run()).toMatchObject({ claimed: 3, notConfigured: 3, sent: 0 });
    const rows = await prisma.notificationDelivery.findMany({ where: { id: { in: ids } } });
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'NOT_CONFIGURED',
        sentAt: null,
        attempts: 1,
        lockedUntil: null,
      });
    }
    expect(await run.run()).toMatchObject({ claimed: 0 });
  });

  it('sends with the delivery id as idempotency key, a demo-labelled escaped template, and records SENT', async () => {
    const { ids, user } = await seed(1, 'Demo <b>booking</b> confirmed');
    const provider = new RecordingProvider();
    expect(await dispatcher(provider).run()).toMatchObject({ sent: 1 });
    const [sent] = provider.sent;
    expect(sent!.key).toBe(ids[0]);
    expect(sent!.message.to).toBe(user.email);
    expect(sent!.message.subject).toBe('[Demo] Demo <b>booking</b> confirmed – Wayora');
    expect(sent!.message.html).toContain('Demo &lt;b&gt;booking&lt;/b&gt; confirmed');
    expect(sent!.message.html).not.toContain('<b>booking');
    expect(sent!.message.text).toContain(DEMO_FOOTER);
    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'msg_1', attempts: 1 });
    expect(row.sentAt).not.toBeNull();
    expect(await dispatcher(provider).run()).toMatchObject({ claimed: 0 });
    expect(provider.sent).toHaveLength(1);
  });

  it('retries transient failures with growing backoff, then sends; notifications are never duplicated', async () => {
    const c = clock();
    const { ids } = await seed(1);
    const provider = new RecordingProvider({ kind: 'transient', times: 2 });
    const run = dispatcher(provider, c.now);
    expect(await run.run()).toMatchObject({ retried: 1 });
    let row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'transient:test_failure',
    });
    expect(row.nextAttemptAt.getTime() - c.now().getTime()).toBe(backoffMs(1));
    // Not due yet.
    expect(await run.run()).toMatchObject({ claimed: 0 });
    c.advance(backoffMs(1));
    expect(await run.run()).toMatchObject({ retried: 1 });
    c.advance(backoffMs(2));
    expect(await run.run()).toMatchObject({ sent: 1 });
    row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row).toMatchObject({ status: 'SENT', attempts: 3, lastError: null });
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
    expect(await prisma.notification.count()).toBe(1);
  });

  it('gives up on permanent failures at once, and on transient ones after the attempt limit', async () => {
    const c = clock();
    const {
      ids: [permanentId],
    } = await seed(1);
    expect(
      await dispatcher(new RecordingProvider({ kind: 'permanent', times: 99 }), c.now).run(),
    ).toMatchObject({ failed: 1 });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: permanentId! } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      sentAt: null,
    });

    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "notifications", "notification_deliveries" CASCADE',
    );
    const {
      ids: [flakyId],
    } = await seed(1);
    const flaky = dispatcher(new RecordingProvider({ kind: 'transient', times: 99 }), c.now);
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      await flaky.run();
      c.advance(backoffMs(i));
    }
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: flakyId! } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: MAX_ATTEMPTS,
    });
    expect(await flaky.run()).toMatchObject({ claimed: 0 });
  });

  it('concurrent dispatchers never take the same delivery', async () => {
    await seed(12);
    const provider = new RecordingProvider(null, 5);
    const results = await Promise.all([1, 2, 3].map(() => dispatcher(provider).run()));
    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(12);
    expect(provider.sent).toHaveLength(12);
    expect(new Set(provider.sent.map((s) => s.key)).size).toBe(12);
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(12);
  });

  it('after a worker dies, its leased rows are picked up once the lease expires; live leases are left alone', async () => {
    const c = clock();
    const { ids } = await seed(2);
    // Row 0: leased by a worker that died (lease in the past). Row 1: leased by a live worker.
    await prisma.notificationDelivery.update({
      where: { id: ids[0]! },
      data: { attempts: 1, lockedUntil: new Date(c.now().getTime() - 1000) },
    });
    await prisma.notificationDelivery.update({
      where: { id: ids[1]! },
      data: { attempts: 1, lockedUntil: new Date(c.now().getTime() + 60_000) },
    });
    const provider = new RecordingProvider();
    expect(await dispatcher(provider, c.now).run()).toMatchObject({ claimed: 1, sent: 1 });
    expect(provider.sent.map((s) => s.key)).toEqual([ids[0]]);
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids[1]! } }),
    ).toMatchObject({
      status: 'PENDING',
    });
  });

  it('a worker that lost its lease can’t overwrite the newer outcome', async () => {
    const { ids } = await seed(1);
    // A slow send; meanwhile the lease is taken over (as after expiry).
    const slow = new RecordingProvider(null, 200);
    const pending = dispatcher(slow).run();
    await new Promise((r) => setTimeout(r, 50));
    await prisma.notificationDelivery.update({
      where: { id: ids[0]! },
      data: { lockedUntil: new Date(Date.now() + 999_999) },
    });
    expect(await pending).toMatchObject({ claimed: 1, sent: 0 });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ids[0]! } }),
    ).toMatchObject({
      status: 'PENDING',
      sentAt: null,
    });
  });
});

describe('email templates', () => {
  it('links, demo wording and escaping', () => {
    const email = renderEmail({
      to: 'a@example.com',
      title: 'Demo payment succeeded',
      message: 'No real money was charged. "Quotes" & <tags>.',
      isDemo: true,
      url: 'https://wayora.example/trips/WYD-2222-2222',
    });
    expect(email.subject).toBe('[Demo] Demo payment succeeded – Wayora');
    expect(email.html).toContain('&quot;Quotes&quot; &amp; &lt;tags&gt;.');
    expect(email.text).toContain('View it in Wayora: https://wayora.example/trips/WYD-2222-2222');
    const live = renderEmail({
      to: 'a@example.com',
      title: 'Payment received',
      message: 'x',
      isDemo: false,
      url: null,
    });
    expect(live.subject).toBe('Payment received – Wayora');
    expect(live.text).not.toContain(DEMO_FOOTER);
  });
});
