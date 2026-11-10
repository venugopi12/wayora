import { createPrismaClient, type PrismaClient } from '@wayora/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeAnalyticsEvents } from '../src/jobs/analytics-purge.js';

/*
 * Analytics retention against a real PostgreSQL (TEST_DATABASE_URL, a
 * database ending in _test): old events go in batches, recent ones stay,
 * and the tracking marker moves to the cutoff so reports know where
 * complete data begins.
 */

const URL_ = process.env.TEST_DATABASE_URL;
if (process.env.CI && !URL_) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the purge tests would be skipped.');
}
if (URL_ && !new URL(URL_).pathname.endsWith('_test')) {
  throw new Error('Refusing to run: TEST_DATABASE_URL must name a database ending in _test.');
}

const MARKER = 'analytics.tracking_started';
const NOW = new Date('2026-06-01T00:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!URL_)('analytics purge (real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let markerAt: Date;
  beforeEach(async () => {
    prisma ??= createPrismaClient({ url: URL_!, maxConnections: 2 });
    markerAt = (await prisma.analyticsEvent.findUniqueOrThrow({ where: { dedupeKey: MARKER } }))
      .occurredAt;
    await prisma.analyticsEvent.deleteMany({ where: { dedupeKey: { startsWith: 'purge-test:' } } });
    await prisma.analyticsEvent.update({
      where: { dedupeKey: MARKER },
      data: { occurredAt: new Date(NOW.getTime() - 900 * DAY) },
    });
  });
  afterAll(async () => {
    await prisma?.analyticsEvent.deleteMany({
      where: { dedupeKey: { startsWith: 'purge-test:' } },
    });
    await prisma?.analyticsEvent.update({
      where: { dedupeKey: MARKER },
      data: { occurredAt: markerAt },
    });
    await prisma?.$disconnect();
  });

  it('deletes events past retention in batches, keeps the rest, and moves the marker', async () => {
    const ages = [500, 450, 401, 399, 10];
    await prisma.analyticsEvent.createMany({
      data: ages.map((age, i) => ({
        type: 'user.login',
        source: 'SERVER' as const,
        dedupeKey: `purge-test:${i}`,
        occurredAt: new Date(NOW.getTime() - age * DAY),
      })),
    });
    const result = await purgeAnalyticsEvents(prisma, {
      retentionDays: 400,
      now: NOW,
      batchSize: 2,
    });
    expect(result.deleted).toBe(3);
    const left = await prisma.analyticsEvent.findMany({
      where: { dedupeKey: { startsWith: 'purge-test:' } },
      orderBy: { dedupeKey: 'asc' },
    });
    expect(left.map((e) => e.dedupeKey)).toEqual(['purge-test:3', 'purge-test:4']);
    const marker = await prisma.analyticsEvent.findUniqueOrThrow({ where: { dedupeKey: MARKER } });
    expect(marker.occurredAt.toISOString()).toBe(result.cutoff);

    // Idempotent: a second run deletes nothing and leaves the marker.
    expect((await purgeAnalyticsEvents(prisma, { retentionDays: 400, now: NOW })).deleted).toBe(0);
  });
});
