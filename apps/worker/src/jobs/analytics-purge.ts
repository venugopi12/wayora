import type { PrismaClient } from '@wayora/database';

/*
 * Analytics retention (Phase 31, docs/analytics.md#retention). Events older
 * than the retention period are deleted in batches, then the tracking
 * marker moves forward to the cutoff, so reports know events are complete
 * only from there and never present a purged period as having had none.
 * Source records (bookings, payments, …) are never touched.
 */

const MARKER = 'analytics.tracking_started';

export interface PurgeResult {
  deleted: number;
  cutoff: string;
}

export async function purgeAnalyticsEvents(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  options: { retentionDays: number; now?: Date; batchSize?: number; maxBatches?: number },
): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 86_400_000);
  const batch = options.batchSize ?? 5000;
  let deleted = 0;
  for (let i = 0; i < (options.maxBatches ?? 200); i += 1) {
    const n = await prisma.$executeRaw`
      DELETE FROM analytics_events WHERE id IN (
        SELECT id FROM analytics_events
         WHERE occurred_at < ${cutoff} AND dedupe_key <> ${MARKER}
         LIMIT ${batch})`;
    deleted += n;
    if (n < batch) break;
  }
  await prisma.$executeRaw`
    UPDATE analytics_events SET occurred_at = ${cutoff}
     WHERE dedupe_key = ${MARKER} AND occurred_at < ${cutoff}`;
  return { deleted, cutoff: cutoff.toISOString() };
}
