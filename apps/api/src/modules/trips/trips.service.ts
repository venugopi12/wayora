import { createHash } from 'node:crypto';
import {
  type DisruptionSeverity,
  type DisruptionType,
  type SearchResult,
  type TripDisruption,
  type TripDisruptionList,
  type TripLeg,
  type TripLegState,
  type TripStatus,
  type TripTimeline,
} from '@wayora/contracts';
import type {
  DisruptionSeverity as DbSeverity,
  DisruptionType as DbDisruptionType,
  Prisma,
  PrismaClient,
  TripEventSource,
  TripEventType,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import { errorForLog } from '../../utils/log-safety.js';
import type { Logger } from '../../utils/logger.js';
import { NOT_FOUND_MESSAGE, bookingSnapshotSchema } from '../bookings/bookings.service.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { notify } from '../notifications/notify.js';
import { TimeoutError } from '../search/concurrency.js';
import { CircuitBreaker, CircuitOpenError, callProvider } from '../search/resilience.js';
import { ProviderError } from '../providers/provider.js';
import { scheduledLegs, trackingEndsAt } from './legs.js';
import {
  DISRUPTION_NOTICE,
  SOURCE,
  disruptionDescription,
  disruptionTitle,
  presentEvent,
} from './presenter.js';
import {
  providerReportSchema,
  TravelStatusError,
  type ProviderReport,
  type ScheduledLeg,
  type StatusErrorCode,
  type TravelStatusProvider,
} from './providers/types.js';

/*
 * Trip tracking (docs/trips.md): the timeline, travel status and
 * disruptions of a booking.
 *
 * - Ownership: every read starts from (reference, signed-in user); someone
 *   else's booking is "not found", exactly like a missing one.
 * - Writes from a provider happen in one transaction per observation, under
 *   the booking's row lock: the latest status, the timeline entries it
 *   implies, disruption changes and their notifications commit together.
 * - Idempotency: every timeline entry and notification has a unique dedupe
 *   key, so a retried check, a second API instance or a restart adds nothing.
 * - Order: an observation older than (or as old as) the stored one is
 *   ignored, so late or repeated provider answers never overwrite newer ones.
 */

export interface TripsServiceOptions {
  prisma: PrismaClient;
  logger: Logger;
  /** Null when no travel-status provider is configured. */
  provider: TravelStatusProvider | null;
  /** A status observed within this window is "current". */
  freshMs: number;
  /** A booking's provider is asked at most this often. */
  minRefreshMs: number;
  /** Per-attempt provider time limit. */
  timeoutMs: number;
  now?: () => Date;
}

interface OwnedBooking {
  id: string;
  reference: string;
  userId: string;
  status: string;
  isDemo: boolean;
  offer: SearchResult;
}

type Tx = Prisma.TransactionClient;
type StoredLeg = {
  index: number;
  state: TripLegState;
  estimatedDeparture: string | null;
  estimatedArrival: string | null;
  delayMinutes: number | null;
};

const TRACKED_STATUS = 'CONFIRMED';
const upper = <T extends string>(v: string) => v.toUpperCase() as T;
const lower = <T extends string>(v: string) => v.toLowerCase() as T;

/** `occurredAtMs_seq` → the position after which the next page starts. */
function parseCursor(cursor: string | undefined): { at: Date; seq: bigint } | null {
  if (!cursor) return null;
  const [ms, seq] = cursor.split('_');
  return { at: new Date(Number(ms)), seq: BigInt(seq!) };
}

export class TripsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;
  private readonly breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });

  constructor(private readonly options: TripsServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  get providerConfigured(): boolean {
    return this.options.provider !== null;
  }

  get provider(): TravelStatusProvider | null {
    return this.options.provider;
  }

  // ─── Ownership ──────────────────────────────────────────────────────────

  /** The signed-in user's booking, or NOT_FOUND (also for someone else's). */
  async owned(userId: string, reference: string): Promise<OwnedBooking> {
    const row = await this.prisma.booking.findFirst({
      where: { reference, userId },
      select: {
        id: true,
        reference: true,
        userId: true,
        status: true,
        isDemo: true,
        offerSnapshot: true,
      },
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    return this.withOffer(row);
  }

  private withOffer(row: {
    id: string;
    reference: string;
    userId: string;
    status: string;
    isDemo: boolean;
    offerSnapshot: unknown;
  }): OwnedBooking {
    const parsed = bookingSnapshotSchema.safeParse(row.offerSnapshot);
    if (!parsed.success) {
      this.options.logger.error({ bookingId: row.id }, 'Stored booking snapshot is invalid');
      throw new AppError('INTERNAL_ERROR', 'This booking could not be read.');
    }
    return { ...row, offer: parsed.data.offer };
  }

  // ─── Timeline ───────────────────────────────────────────────────────────

  async timeline(
    userId: string,
    reference: string,
    query: { after?: string | undefined; limit: number },
  ): Promise<TripTimeline> {
    const booking = await this.owned(userId, reference);
    const cursor = parseCursor(query.after);
    const rows = await this.prisma.tripEvent.findMany({
      where: {
        bookingId: booking.id,
        ...(cursor
          ? {
              OR: [
                { occurredAt: { gt: cursor.at } },
                { occurredAt: cursor.at, seq: { gt: cursor.seq } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'asc' }, { seq: 'asc' }],
      take: query.limit + 1,
      select: {
        id: true,
        seq: true,
        type: true,
        source: true,
        occurredAt: true,
        observedAt: true,
        data: true,
      },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const context = { serviceType: booking.offer.serviceType, demo: booking.isDemo };
    return {
      reference: booking.reference,
      items: page.map((row) => presentEvent(row, context)),
      nextCursor:
        rows.length > query.limit && last ? `${last.occurredAt.getTime()}_${last.seq}` : null,
    };
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  async status(userId: string, reference: string): Promise<TripStatus> {
    return this.statusOf(await this.owned(userId, reference));
  }

  private trackable(booking: OwnedBooking, legs: ScheduledLeg[]): string | null {
    if (legs.length === 0) {
      return 'Travel status isn’t available for this kind of booking: there is no timetabled journey to follow.';
    }
    if (booking.status !== TRACKED_STATUS) {
      return 'Only confirmed bookings are followed; this booking isn’t confirmed.';
    }
    const provider = this.options.provider;
    if (!provider) {
      return 'No travel-status provider is configured, so only the booked times are shown.';
    }
    if (!provider.supports(booking.offer.serviceType)) {
      return 'The configured travel-status provider doesn’t cover this kind of journey.';
    }
    return null;
  }

  private async statusOf(booking: OwnedBooking): Promise<TripStatus> {
    const legs = scheduledLegs(booking.offer);
    const reason = this.trackable(booking, legs);
    const provider = this.options.provider;
    const row = await this.prisma.tripStatus.findUnique({ where: { bookingId: booking.id } });
    const now = this.now();
    const stored = new Map(
      ((row?.legs ?? []) as StoredLeg[]).map((leg) => [leg.index, leg] as const),
    );
    const presentLegs: TripLeg[] = legs.map((leg) => {
      const s = row?.observedAt ? stored.get(leg.index) : undefined;
      return {
        label: leg.label,
        origin: leg.origin,
        destination: leg.destination,
        scheduledDeparture: leg.departAt,
        scheduledArrival: leg.arriveAt,
        estimatedDeparture: s?.estimatedDeparture ?? null,
        estimatedArrival: s?.estimatedArrival ?? null,
        delayMinutes: s?.delayMinutes ?? null,
        state: s?.state ?? 'scheduled',
      };
    });
    const ends = trackingEndsAt(legs);
    const withinWindow = ends !== null && now.getTime() <= ends.getTime();
    const nextAllowed = row ? new Date(row.checkedAt.getTime() + this.options.minRefreshMs) : null;
    const base = {
      reference: booking.reference,
      legs: presentLegs,
      observedAt: row?.observedAt?.toISOString() ?? null,
      checkedAt: row?.checkedAt.toISOString() ?? null,
      source: row ? SOURCE[row.source] : null,
      providerName:
        row && provider?.id === row.providerId ? provider.name : row ? row.providerId : null,
      simulated: row?.source === 'DEMO_PROVIDER',
      refresh: {
        available: reason === null && withinWindow,
        nextAllowedAt:
          reason === null && withinWindow && nextAllowed && nextAllowed > now
            ? nextAllowed.toISOString()
            : null,
      },
    };

    if (reason !== null) {
      // Not followed now. Earlier provider data (e.g. before the provider was
      // switched off) is still shown, as stale.
      if (row?.observedAt && legs.length > 0 && booking.status === TRACKED_STATUS) {
        return { ...base, freshness: 'stale', explanation: reason };
      }
      return {
        ...base,
        freshness:
          legs.length > 0 && booking.status === TRACKED_STATUS && !provider
            ? 'unavailable'
            : 'unsupported',
        explanation: reason,
      };
    }
    if (!row) {
      return {
        ...base,
        freshness: 'pending',
        explanation: withinWindow
          ? 'Not checked yet. The times shown are the booked ones.'
          : 'This journey is over and was never checked; the times shown are the booked ones.',
      };
    }
    if (!row.observedAt) {
      return {
        ...base,
        freshness: 'unavailable',
        explanation:
          'The travel-status provider couldn’t be reached, so only the booked times are shown.',
      };
    }
    const age = now.getTime() - row.observedAt.getTime();
    if (row.lastErrorCode) {
      return {
        ...base,
        freshness: 'stale',
        explanation:
          'The latest check failed; this is the last status the provider reported, and it may have changed since.',
      };
    }
    if (age > this.options.freshMs) {
      return {
        ...base,
        freshness: 'stale',
        explanation: 'This is the last status the provider reported; it may have changed since.',
      };
    }
    return {
      ...base,
      freshness: 'current',
      explanation:
        row.source === 'DEMO_PROVIDER'
          ? 'Simulated by the demo status provider: not real travel information.'
          : 'As recently reported by the provider.',
    };
  }

  // ─── Disruptions ────────────────────────────────────────────────────────

  async disruptions(
    userId: string,
    reference: string,
    state: 'open' | 'all',
  ): Promise<TripDisruptionList> {
    const booking = await this.owned(userId, reference);
    const status = await this.statusOf(booking);
    const legs = scheduledLegs(booking.offer);
    const rows = await this.prisma.tripDisruption.findMany({
      where: { bookingId: booking.id, ...(state === 'open' ? { state: 'ACTIVE' } : {}) },
      orderBy: [{ firstDetectedAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const provider = this.options.provider;
    return {
      reference: booking.reference,
      notice: DISRUPTION_NOTICE,
      items: rows.map((d): TripDisruption => {
        const details = (d.details ?? {}) as Record<string, unknown>;
        const delay = typeof details.delayMinutes === 'number' ? details.delayMinutes : null;
        const type = lower<DisruptionType>(d.type);
        const severity = lower<DisruptionSeverity>(d.severity);
        const leg = d.legIndex !== null ? legs[d.legIndex] : undefined;
        const simulated = d.source === 'DEMO_PROVIDER';
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        return {
          id: d.id,
          type,
          severity,
          // Recorded as active but the status isn't current: it may have changed.
          state:
            d.state === 'RESOLVED'
              ? 'resolved'
              : status.freshness === 'current'
                ? 'active'
                : 'unknown',
          source: SOURCE[d.source],
          simulated,
          providerName: provider?.id === d.providerId ? provider.name : d.providerId,
          title: disruptionTitle(type, delay),
          description: disruptionDescription(type, severity, simulated),
          legLabel: legs.length > 1 ? (leg?.label ?? null) : null,
          changes: {
            scheduledDeparture: leg?.departAt ?? null,
            newDeparture: str(details.newDeparture),
            scheduledArrival: leg?.arriveAt ?? null,
            newArrival: str(details.newArrival),
            delayMinutes: delay,
          },
          firstDetectedAt: d.firstDetectedAt.toISOString(),
          lastObservedAt: d.lastObservedAt.toISOString(),
          resolvedAt: d.resolvedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  // ─── Refresh ────────────────────────────────────────────────────────────

  /**
   * POST /bookings/:reference/status/refresh. Asks the provider unless it
   * was asked within `minRefreshMs` (then the stored status is returned),
   * so travellers can't make Wayora hammer a provider.
   */
  async refresh(userId: string, reference: string): Promise<TripStatus> {
    const booking = await this.owned(userId, reference);
    const legs = scheduledLegs(booking.offer);
    const reason = this.trackable(booking, legs);
    if (reason) throw new AppError('TRIP_TRACKING_UNAVAILABLE', reason);
    const ends = trackingEndsAt(legs)!;
    if (this.now().getTime() > ends.getTime()) {
      throw new AppError(
        'TRIP_TRACKING_UNAVAILABLE',
        'This journey is over, so its status is no longer followed.',
      );
    }
    const row = await this.prisma.tripStatus.findUnique({
      where: { bookingId: booking.id },
      select: { checkedAt: true },
    });
    if (!row || this.now().getTime() - row.checkedAt.getTime() >= this.options.minRefreshMs) {
      await this.check(booking, legs);
    }
    return this.statusOf(booking);
  }

  /**
   * Background check of active trips (server.ts): confirmed timetabled
   * bookings travelling between yesterday and tomorrow whose status is older
   * than the freshness window. Bounded per run; safe on every instance.
   */
  async sweep(): Promise<{ checked: number }> {
    if (!this.options.provider) return { checked: 0 };
    const now = this.now();
    const day = 24 * 60 * 60 * 1000;
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const staleBefore = new Date(now.getTime() - this.options.freshMs);
    const due = await this.prisma.booking.findMany({
      where: {
        status: TRACKED_STATUS,
        category: { in: ['FLIGHT', 'TRAIN', 'BUS'] },
        startsOn: { gte: new Date(today.getTime() - day), lte: new Date(today.getTime() + day) },
        OR: [{ tripStatus: null }, { tripStatus: { checkedAt: { lt: staleBefore } } }],
      },
      select: {
        id: true,
        reference: true,
        userId: true,
        status: true,
        isDemo: true,
        offerSnapshot: true,
      },
      orderBy: { startsOn: 'asc' },
      take: 100,
    });
    let checked = 0;
    for (const row of due) {
      const booking = this.withOffer(row);
      const legs = scheduledLegs(booking.offer);
      if (this.trackable(booking, legs)) continue;
      const ends = trackingEndsAt(legs);
      if (!ends || now.getTime() > ends.getTime()) continue;
      await this.check(booking, legs);
      checked += 1;
    }
    return { checked };
  }

  /** One provider check: fetch, validate, then apply (or record the failure). */
  private async check(booking: OwnedBooking, legs: ScheduledLeg[]): Promise<void> {
    const provider = this.options.provider!;
    const log = this.options.logger.child({ booking: { reference: booking.reference } });
    const started = performance.now();
    let report: ProviderReport;
    try {
      const raw = await callProvider(
        {
          providerId: provider.id,
          timeoutMs: this.options.timeoutMs,
          deadline: started + this.options.timeoutMs * 2 + 500,
          retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 400 },
          breaker: this.breaker,
          idempotent: true,
        },
        async (signal) => {
          try {
            return await provider.fetchStatus(
              { reference: booking.reference, serviceType: booking.offer.serviceType, legs },
              signal,
            );
          } catch (error) {
            // Transient provider failures may be retried once.
            if (error instanceof TravelStatusError && error.code === 'unavailable') {
              throw new ProviderError('unavailable', error.message, { cause: error });
            }
            throw error;
          }
        },
      );
      const parsed = providerReportSchema.safeParse(raw);
      if (!parsed.success) throw new TravelStatusError('invalid', 'Unusable status answer');
      report = parsed.data;
    } catch (error) {
      const code = errorCode(error);
      log.warn(
        { provider: provider.id, code, err: errorForLog(error) },
        'Travel status check failed',
      );
      await this.recordFailure(booking.id, provider, code);
      return;
    }
    await this.apply(booking, legs, provider, report);
  }

  private async recordFailure(
    bookingId: string,
    provider: TravelStatusProvider,
    code: StatusErrorCode,
  ): Promise<void> {
    const now = this.now();
    const source: TripEventSource = provider.kind === 'demo' ? 'DEMO_PROVIDER' : 'LIVE_PROVIDER';
    // Keeps the last good observation; only the check time and error change.
    await this.prisma.tripStatus.upsert({
      where: { bookingId },
      create: {
        bookingId,
        providerId: provider.id,
        source,
        legs: [],
        observedAt: null,
        checkedAt: now,
        lastErrorCode: code,
      },
      update: { checkedAt: now, lastErrorCode: code },
    });
  }

  /** Applies one validated observation. Public for tests of ordering and idempotency. */
  async apply(
    booking: { id: string; reference: string; userId: string; isDemo: boolean },
    legs: ScheduledLeg[],
    provider: TravelStatusProvider,
    report: ProviderReport,
  ): Promise<{ applied: boolean }> {
    const now = this.now();
    const observedAt = new Date(report.observedAt);
    const source: TripEventSource = provider.kind === 'demo' ? 'DEMO_PROVIDER' : 'LIVE_PROVIDER';
    const simulated = provider.kind === 'demo';
    const known = new Set(legs.map((l) => l.index));
    const reportedLegs: StoredLeg[] = report.legs
      .filter((l) => known.has(l.index))
      .map((l) => ({
        index: l.index,
        state: l.state,
        estimatedDeparture: l.estimatedDeparture ?? null,
        estimatedArrival: l.estimatedArrival ?? null,
        delayMinutes:
          l.delayMinutes ??
          (l.estimatedDeparture
            ? Math.round(
                (Date.parse(l.estimatedDeparture) - Date.parse(legs[l.index]!.departAt)) / 60_000,
              )
            : null),
      }));

    return this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, booking.id);
      const current = await tx.tripStatus.findUnique({ where: { bookingId: booking.id } });
      // Out of order or repeated: never let an older observation win.
      if (current?.observedAt && observedAt.getTime() <= current.observedAt.getTime()) {
        await tx.tripStatus.update({
          where: { bookingId: booking.id },
          data: { checkedAt: now, lastErrorCode: null },
        });
        return { applied: false };
      }
      const previous = new Map(
        ((current?.observedAt ? current.legs : []) as StoredLeg[]).map((l) => [l.index, l]),
      );
      await tx.tripStatus.upsert({
        where: { bookingId: booking.id },
        create: {
          bookingId: booking.id,
          providerId: provider.id,
          source,
          legs: reportedLegs,
          observedAt,
          checkedAt: now,
          lastErrorCode: null,
        },
        update: {
          providerId: provider.id,
          source,
          legs: reportedLegs,
          observedAt,
          checkedAt: now,
          lastErrorCode: null,
        },
      });

      // Status changes worth a timeline entry (not every repeated poll).
      for (const leg of reportedLegs) {
        const before = previous.get(leg.index)?.state ?? 'scheduled';
        if (leg.state === before || leg.state === 'unknown') continue;
        await this.event(tx, {
          bookingId: booking.id,
          type: 'STATUS_CHANGED',
          source,
          dedupeKey: `status:${booking.id}:${provider.id}:${leg.index}:${leg.state}`,
          occurredAt: observedAt,
          observedAt,
          data: {
            legIndex: leg.index,
            legLabel: legs.length > 1 ? legs[leg.index]!.label : null,
            state: leg.state,
            delayMinutes: leg.delayMinutes,
          },
        });
      }

      await this.applyDisruptions(tx, booking, legs, provider, source, simulated, report, now);
      return { applied: true };
    });
  }

  private async applyDisruptions(
    tx: Tx,
    booking: { id: string; reference: string; userId: string; isDemo: boolean },
    legs: ScheduledLeg[],
    provider: TravelStatusProvider,
    source: TripEventSource,
    simulated: boolean,
    report: ProviderReport,
    now: Date,
  ): Promise<void> {
    const observedAt = new Date(report.observedAt);
    const existing = await tx.tripDisruption.findMany({
      where: { bookingId: booking.id, providerId: provider.id },
    });
    const byKey = new Map(existing.map((d) => [d.externalKey, d]));
    const seen = new Set<string>();
    const legLabel = (index: number | null) =>
      index !== null && legs.length > 1 ? (legs[index]?.label ?? null) : null;

    for (const d of report.disruptions) {
      seen.add(d.key);
      const legIndex = d.legIndex ?? null;
      if (legIndex !== null && !legs[legIndex]) continue;
      const details = {
        newDeparture: d.newDeparture ?? null,
        newArrival: d.newArrival ?? null,
        delayMinutes: d.delayMinutes ?? null,
      };
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([d.type, d.severity, details]))
        .digest('hex')
        .slice(0, 16);
      const eventData = {
        disruptionType: d.type,
        severity: d.severity,
        legIndex,
        legLabel: legLabel(legIndex),
        ...details,
      };
      const row = byKey.get(d.key);
      if (!row) {
        // Only something that is (or was) happening is recorded.
        if (d.state !== 'active') continue;
        const created = await tx.tripDisruption.create({
          data: {
            bookingId: booking.id,
            providerId: provider.id,
            source,
            externalKey: d.key,
            type: upper<DbDisruptionType>(d.type),
            severity: upper<DbSeverity>(d.severity),
            state: 'ACTIVE',
            legIndex,
            details: { ...details, fingerprint },
            firstDetectedAt: observedAt,
            lastObservedAt: observedAt,
          },
        });
        await this.disruptionChanged(tx, booking, created.id, 'reported', eventData, {
          source,
          simulated,
          observedAt,
          now,
          key: 'reported',
        });
        continue;
      }
      if (observedAt.getTime() <= row.lastObservedAt.getTime()) continue;
      const before = (row.details ?? {}) as { fingerprint?: string };
      if (d.state === 'resolved') {
        if (row.state === 'RESOLVED') {
          await tx.tripDisruption.update({
            where: { id: row.id },
            data: { lastObservedAt: observedAt },
          });
          continue;
        }
        await tx.tripDisruption.update({
          where: { id: row.id },
          data: { state: 'RESOLVED', resolvedAt: observedAt, lastObservedAt: observedAt },
        });
        await this.disruptionChanged(tx, booking, row.id, 'resolved', eventData, {
          source,
          simulated,
          observedAt,
          now,
          key: 'resolved',
        });
        continue;
      }
      const reopened = row.state === 'RESOLVED';
      const changed = reopened || before.fingerprint !== fingerprint;
      await tx.tripDisruption.update({
        where: { id: row.id },
        data: {
          state: 'ACTIVE',
          resolvedAt: null,
          type: upper<DbDisruptionType>(d.type),
          severity: upper<DbSeverity>(d.severity),
          legIndex,
          details: { ...details, fingerprint },
          lastObservedAt: observedAt,
        },
      });
      if (changed) {
        await this.disruptionChanged(tx, booking, row.id, 'updated', eventData, {
          source,
          simulated,
          observedAt,
          now,
          key: `updated:${fingerprint}:${reopened ? observedAt.getTime() : ''}`,
        });
      }
    }

    // Active disruptions this (newer) observation no longer reports are over.
    for (const row of existing) {
      if (seen.has(row.externalKey) || row.state !== 'ACTIVE') continue;
      if (observedAt.getTime() <= row.lastObservedAt.getTime()) continue;
      await tx.tripDisruption.update({
        where: { id: row.id },
        data: { state: 'RESOLVED', resolvedAt: observedAt, lastObservedAt: observedAt },
      });
      await this.disruptionChanged(
        tx,
        booking,
        row.id,
        'resolved',
        {
          disruptionType: lower(row.type),
          severity: lower(row.severity),
          legIndex: row.legIndex,
          legLabel: legLabel(row.legIndex),
        },
        { source, simulated, observedAt, now, key: 'resolved' },
      );
    }
  }

  /** A disruption change: one timeline entry and one notification, each once. */
  private async disruptionChanged(
    tx: Tx,
    booking: { id: string; reference: string; userId: string; isDemo: boolean },
    disruptionId: string,
    change: 'reported' | 'updated' | 'resolved',
    data: Record<string, unknown>,
    meta: { source: TripEventSource; simulated: boolean; observedAt: Date; now: Date; key: string },
  ): Promise<void> {
    const type: TripEventType =
      change === 'reported'
        ? 'DISRUPTION_REPORTED'
        : change === 'updated'
          ? 'DISRUPTION_UPDATED'
          : 'DISRUPTION_RESOLVED';
    const dedupeKey = `disruption:${disruptionId}:${meta.key}`;
    await this.event(tx, {
      bookingId: booking.id,
      type,
      source: meta.source,
      dedupeKey,
      occurredAt: meta.observedAt,
      observedAt: meta.observedAt,
      data: { ...data, disruptionId },
    });
    const kind = (data.disruptionType as DisruptionType | undefined) ?? 'service_disruption';
    const delay = typeof data.delayMinutes === 'number' ? data.delayMinutes : null;
    const what = disruptionTitle(kind, delay);
    const sim = meta.simulated ? ' (simulated)' : '';
    const title =
      change === 'resolved'
        ? `Trip update${sim}: disruption over`
        : `Trip update${sim}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
    const message =
      change === 'resolved'
        ? `The disruption reported for booking ${booking.reference} is over.${meta.simulated ? ' This was simulated by the demo status provider.' : ''}`
        : `${what} for booking ${booking.reference}.${meta.simulated ? ' Simulated by the demo status provider: not real travel information.' : ''} ${DISRUPTION_NOTICE}`;
    await notify(tx, meta.now, {
      type: 'TRIP_DISRUPTION',
      title,
      message,
      userId: booking.userId,
      isDemo: booking.isDemo || meta.simulated,
      bookingId: booking.id,
      dedupeKey,
    });
  }

  private async event(
    tx: Tx,
    input: {
      bookingId: string;
      type: TripEventType;
      source: TripEventSource;
      dedupeKey: string;
      occurredAt: Date;
      observedAt: Date | null;
      data: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const created = await tx.tripEvent.createManyAndReturn({
      data: [{ ...input, data: input.data as Prisma.InputJsonValue }],
      skipDuplicates: true,
      select: { id: true },
    });
    return created.length === 1;
  }

  /** Reminder entries (notifications/reminders.ts), idempotent by key. */
  static async reminder(
    tx: Tx,
    input: {
      bookingId: string;
      type: 'TRAVEL_REMINDER' | 'CHECK_OUT_REMINDER';
      on: string;
      now: Date;
    },
  ): Promise<boolean> {
    const created = await tx.tripEvent.createManyAndReturn({
      data: [
        {
          bookingId: input.bookingId,
          type: input.type,
          source: 'WAYORA',
          dedupeKey: `reminder:${input.bookingId}:${input.type === 'TRAVEL_REMINDER' ? 'DAY_BEFORE' : 'CHECK_OUT'}`,
          occurredAt: input.now,
          observedAt: null,
          data: { on: input.on },
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    return created.length === 1;
  }

  /** The newest timeline entry's sequence id (live updates), or null. */
  async latestSeq(bookingId: string): Promise<string | null> {
    const row = await this.prisma.tripEvent.findFirst({
      where: { bookingId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return row ? row.seq.toString() : null;
  }

  /** For the status page: bookings with a failed check in the last hour. */
  async recentFailures(sinceMs = 60 * 60 * 1000): Promise<number> {
    return this.prisma.tripStatus.count({
      where: {
        lastErrorCode: { not: null },
        checkedAt: { gte: new Date(this.now().getTime() - sinceMs) },
      },
    });
  }
}

function errorCode(error: unknown): StatusErrorCode {
  if (error instanceof TravelStatusError) return error.code;
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof CircuitOpenError) return 'unavailable';
  if (error instanceof ProviderError) return 'unavailable';
  return 'error';
}
