import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AnalyticsEventType, AnalyticsInteraction } from '@wayora/contracts';
import type { Prisma, PrismaClient, TravelCategory } from '@wayora/database';
import type { AuthLocals } from '../../middleware/session.js';
import { CATEGORY } from '../../utils/categories.js';
import type { Logger } from '../../utils/logger.js';

/*
 * Events the API records (docs/analytics.md#event-schema). Business events
 * that change money or bookings are recorded by database triggers, in the
 * same transaction as the change; this covers the rest: sign-in and out,
 * daily activity, offer views, booking submissions and the web app's
 * behavioural events.
 *
 * Writes are idempotent (the dedupe key is unique; duplicates are skipped),
 * off the request path (never awaited by the request, never failing it),
 * and carry no personal data beyond the internal user id where a metric
 * needs it.
 */

/** Event types this module may write (the triggers write the others). */
export type ApiEventType = Extract<
  AnalyticsEventType,
  | 'user.login'
  | 'user.logout'
  | 'user.active'
  | 'offer.viewed'
  | 'offer.selected'
  | 'booking.initiated'
>;

export interface ApiEvent {
  type: ApiEventType;
  /** Unique per occurrence: the same key is never recorded twice. */
  dedupeKey: string;
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  category?: TravelCategory | null;
  searchId?: string | null;
  occurredAt?: Date;
}

export interface AnalyticsRecorder {
  /** Fire and forget. */
  record(event: ApiEvent): void;
  /** Awaitable form (tests, batches). Resolves to how many were new. */
  recordNow(events: readonly ApiEvent[]): Promise<number>;
}

/** Hashes an opaque, possibly long identifier into a fixed-length key part. */
export const keyPart = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

export function prismaAnalyticsRecorder(
  prisma: PrismaClient,
  logger: Logger,
  now: () => Date = () => new Date(),
): AnalyticsRecorder {
  const log = logger.child({ component: 'analytics' });
  const toRow = (e: ApiEvent): Prisma.AnalyticsEventCreateManyInput => ({
    type: e.type,
    source: e.type === 'offer.selected' ? 'CLIENT' : 'SERVER',
    dedupeKey: e.dedupeKey.slice(0, 200),
    userId: uuidOrNull(e.userId),
    entityType: e.entityType ?? null,
    entityId: uuidOrNull(e.entityId),
    category: e.category ?? null,
    searchId: uuidOrNull(e.searchId),
    metadata: {},
    occurredAt: e.occurredAt ?? now(),
  });
  const recordNow = async (events: readonly ApiEvent[]) => {
    if (events.length === 0) return 0;
    const { count } = await prisma.analyticsEvent.createMany({
      data: events.map(toRow),
      skipDuplicates: true,
    });
    return count;
  };
  return {
    recordNow,
    record(event) {
      void recordNow([event]).catch((err: unknown) =>
        log.warn(
          { err: { message: (err as Error).message }, type: event.type },
          'Could not record an analytics event',
        ),
      );
    },
  };
}

/** For tests and for running without a database: remembers nothing. */
export const noAnalytics: AnalyticsRecorder = {
  record: () => undefined,
  recordNow: () => Promise.resolve(0),
};

/**
 * The visitor asked not to be tracked: Do Not Track or Global Privacy
 * Control (`Sec-GPC: 1`). Behavioural events are then not recorded at all.
 * Business records (bookings, payments) are kept regardless: they are the
 * service itself, not tracking.
 */
export function declinedTracking(req: { get(name: string): string | undefined }): boolean {
  return req.get('dnt') === '1' || req.get('sec-gpc') === '1';
}

/** One local day for `user.active` keys (the reporting timezone's calendar). */
export type DayOf = (at: Date) => string;

/**
 * Daily activity: at most one `user.active` per customer per reporting day.
 * An in-process set skips repeat writes; the dedupe key keeps several API
 * instances to one row. Staff accounts and automatic polling don't count.
 */
export function activityTracker(
  recorder: AnalyticsRecorder,
  dayOf: DayOf,
  now: () => Date = () => new Date(),
  capacity = 50_000,
) {
  const seen = new Set<string>();
  return (user: { id: string; role: string }, path: string): boolean => {
    if (user.role !== 'USER' || isAutomatic(path)) return false;
    const at = now();
    const day = dayOf(at);
    const key = `user.active:${user.id}:${day}`;
    if (seen.has(key)) return false;
    if (seen.size >= capacity) seen.clear();
    seen.add(key);
    recorder.record({
      type: 'user.active',
      dedupeKey: key,
      userId: user.id,
      entityType: 'user',
      entityId: user.id,
      occurredAt: at,
    });
    return true;
  };
}

/** Requests the web app makes on its own (timers, live update streams), not because someone used it. */
const AUTOMATIC: readonly RegExp[] = [
  /^\/api\/v1\/notifications\/unread-count(?:\?|$)/,
  /\/events(?:\?|$)/,
  /^\/api\/v1\/health(?:[/?]|$)/,
];
export const isAutomatic = (path: string) => AUTOMATIC.some((r) => r.test(path));

/** The event for an offer page load (once per search and offer). */
export function offerViewed(
  serviceType: keyof typeof CATEGORY,
  searchId: string,
  offerId: string,
): ApiEvent {
  return {
    type: 'offer.viewed',
    dedupeKey: `offer.viewed:${searchId}:${keyPart(offerId)}`,
    category: CATEGORY[serviceType],
    searchId,
  };
}

/** The event for the web app's "Book this" (once per search and offer). */
export function offerSelected(e: AnalyticsInteraction): ApiEvent {
  return {
    type: 'offer.selected',
    dedupeKey: `offer.selected:${e.searchId}:${keyPart(e.offerId)}`,
    category: CATEGORY[e.serviceType],
    searchId: e.searchId,
  };
}

/**
 * Records the web app's behavioural events (POST /analytics/interactions):
 * nothing when the visitor declined tracking, and only for searches that
 * really happened recently (an unknown or stale search id is ignored), so
 * the endpoint can't be used to inflate offer counts for made-up searches.
 */
export function interactionRecorder(
  prisma: PrismaClient,
  recorder: AnalyticsRecorder,
  now: () => Date = () => new Date(),
) {
  return async (
    req: { get(name: string): string | undefined },
    events: readonly AnalyticsInteraction[],
  ) => {
    if (declinedTracking(req)) return 0;
    const ids = [...new Set(events.map((e) => e.searchId))];
    const known = await prisma.searchEvent.findMany({
      where: {
        searchId: { in: ids },
        createdAt: { gte: new Date(now().getTime() - 2 * 86_400_000) },
      },
      select: { searchId: true },
      distinct: ['searchId'],
    });
    const valid = new Set(known.map((k) => k.searchId));
    return recorder.recordNow(events.filter((e) => valid.has(e.searchId)).map(offerSelected));
  };
}

/** Runs the session loader, then notes the signed-in customer's activity for the day. */
export function withActivity(
  load: RequestHandler,
  track: (user: { id: string; role: string }, path: string) => unknown,
): RequestHandler {
  return (req, res, next) => {
    void load(req, res, (err?: unknown) => {
      if (!err) {
        const auth = (res.locals as AuthLocals).auth;
        if (auth) track(auth.user, req.originalUrl);
      }
      next(err);
    });
  };
}
