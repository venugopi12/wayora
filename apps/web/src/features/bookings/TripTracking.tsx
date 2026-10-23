import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  CreditCard,
  Luggage,
  Plane,
  PlaneLanding,
  PlaneTakeoff,
  RefreshCw,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  TripDisruption,
  TripEvent,
  TripFreshness,
  TripLeg,
  TripLegState,
  TripStatus,
} from '@wayora/contracts';
import { Badge, Button, ErrorState, Skeleton, cn, formatMoney, type BadgeTone } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  getTripDisruptions,
  getTripStatus,
  getTripTimeline,
  refreshTripStatus,
  tripEventsUrl,
} from '../../services/trips';
import { Panel } from '../account/AccountShell';
import { notificationKeys } from '../notifications/keys';
import { bookingKeys, tripKeys } from './keys';

/*
 * Trip tracking on the booking page (docs/trips.md#web): travel status,
 * disruptions and the timeline.
 *
 * Honesty: every status says how fresh it is and where it came from;
 * simulated (demo) information is labelled on every item; times a provider
 * didn't give are simply not shown. "Updates automatically" describes this
 * page receiving changes, never that a journey is being tracked live.
 */

// ─── Time formatting ─────────────────────────────────────────────────────

/** Timeline times: the viewer's own time zone, named. */
const stampFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
export const formatStamp = (iso: string) => stampFormat.format(new Date(iso));

const offsetOf = (iso: string): number => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};

/** Journey times: local to the station, in the offset of the booked time ("07:30"). */
export function stationTime(iso: string, bookedIso: string): string {
  return new Date(Date.parse(iso) + offsetOf(bookedIso)).toISOString().slice(11, 16);
}

const lateText = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''} late`
    : `${minutes} min late`;

// ─── Live updates ────────────────────────────────────────────────────────

export type LiveMode = 'connecting' | 'live' | 'polling' | 'off';

/** Polling fallback interval (only while the page is visible). */
export const POLL_MS = 60_000;

/**
 * Follows the booking's live-update stream (Server-Sent Events). On any
 * announcement the persisted timeline, status and disruptions are re-read,
 * so duplicates and missed messages don't matter. If the stream can't be
 * kept open, the page falls back to re-reading every minute while visible.
 */
export function useTripLiveUpdates(reference: string, enabled: boolean): LiveMode {
  const queryClient = useQueryClient();
  const supported = typeof EventSource !== 'undefined';
  // The stream's state, for this booking (a different booking starts over).
  const [stream, setStream] = useState<{
    reference: string;
    state: 'connecting' | 'live' | 'failed' | 'ended';
  }>({ reference, state: 'connecting' });
  const state = stream.reference === reference ? stream.state : 'connecting';
  const mode: LiveMode = !enabled
    ? 'off'
    : !supported || state === 'failed'
      ? 'polling'
      : state === 'ended'
        ? 'off'
        : state;

  useEffect(() => {
    if (!enabled || !supported) return;
    const refreshAll = () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.all(reference) });
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(reference) });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    };
    const source = new EventSource(tripEventsUrl(reference), { withCredentials: true });
    let failures = 0;
    let readyBefore = false;
    source.addEventListener('ready', () => {
      // After a reconnect, re-read once: something may have changed meanwhile.
      if (readyBefore) refreshAll();
      readyBefore = true;
      failures = 0;
      setStream({ reference, state: 'live' });
    });
    source.addEventListener('trip-event', refreshAll);
    source.addEventListener('end', (event) => {
      const reason = (() => {
        try {
          return (JSON.parse((event as MessageEvent<string>).data) as { reason?: string }).reason;
        } catch {
          return undefined;
        }
      })();
      if (reason === 'signed-out') {
        source.close();
        setStream({ reference, state: 'ended' });
        // Re-reading answers 401, which signs this tab out.
        refreshAll();
      }
    });
    source.onerror = () => {
      failures += 1;
      if (source.readyState === EventSource.CLOSED || failures >= 3) {
        source.close();
        setStream({ reference, state: 'failed' });
      }
    };
    return () => source.close();
  }, [enabled, supported, queryClient, reference]);

  // Fallback: re-read every minute, only while the page is visible.
  useEffect(() => {
    if (mode !== 'polling') return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: tripKeys.all(reference) });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [mode, queryClient, reference]);

  return mode;
}

// ─── Status ──────────────────────────────────────────────────────────────

const FRESHNESS: Record<TripFreshness, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  current: { label: 'Up to date', tone: 'success', icon: CircleCheck },
  stale: { label: 'May be out of date', tone: 'warning', icon: Clock },
  pending: { label: 'Not checked yet', tone: 'neutral', icon: CircleDashed },
  unavailable: { label: 'Status unavailable', tone: 'neutral', icon: CircleSlash },
  unsupported: { label: 'Not available for this booking', tone: 'neutral', icon: CircleSlash },
};

const LEG_STATE: Record<TripLegState, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  scheduled: { label: 'On schedule', tone: 'neutral', icon: CalendarClock },
  delayed: { label: 'Delayed', tone: 'warning', icon: Clock },
  departed: { label: 'Departed', tone: 'brand', icon: PlaneTakeoff },
  arrived: { label: 'Arrived', tone: 'success', icon: PlaneLanding },
  cancelled: { label: 'Cancelled by the operator', tone: 'danger', icon: CircleX },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDashed },
};

function IconBadge({
  tone,
  icon: Icon,
  label,
}: {
  tone: BadgeTone;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Badge tone={tone}>
      <Icon className="mr-1 inline size-3.5" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const SimulatedBadge = () => <Badge tone="brand">Simulated</Badge>;

function LegRow({ leg, status }: { leg: TripLeg; status: TripStatus }) {
  const state = LEG_STATE[leg.state];
  // Provider times only from a status that isn't "pending"/"unsupported".
  const provider = status.freshness === 'current' || status.freshness === 'stale';
  const newDeparture =
    provider && leg.estimatedDeparture && leg.estimatedDeparture !== leg.scheduledDeparture
      ? stationTime(leg.estimatedDeparture, leg.scheduledDeparture)
      : null;
  const newArrival =
    provider && leg.estimatedArrival && leg.estimatedArrival !== leg.scheduledArrival
      ? stationTime(leg.estimatedArrival, leg.scheduledArrival)
      : null;
  const scheduled = (iso: string) => stationTime(iso, iso);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label">{leg.label}</p>
        {provider ? <IconBadge {...state} /> : null}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-body-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-caption text-ink-secondary">
            Departs {leg.origin.cityName}
            {leg.origin.code ? ` (${leg.origin.code})` : ''}
          </dt>
          <dd>
            <span className={cn(newDeparture && 'text-ink-secondary line-through')}>
              {scheduled(leg.scheduledDeparture)}
            </span>
            {newDeparture ? (
              <>
                <span className="sr-only"> booked; now expected </span>
                <span className="ml-1.5 font-semibold">{newDeparture}</span>
              </>
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-caption text-ink-secondary">
            Arrives {leg.destination.cityName}
            {leg.destination.code ? ` (${leg.destination.code})` : ''}
          </dt>
          <dd>
            <span className={cn(newArrival && 'text-ink-secondary line-through')}>
              {scheduled(leg.scheduledArrival)}
            </span>
            {newArrival ? (
              <>
                <span className="sr-only"> booked; now expected </span>
                <span className="ml-1.5 font-semibold">{newArrival}</span>
              </>
            ) : null}
          </dd>
        </div>
      </dl>
      {provider && leg.delayMinutes && leg.delayMinutes > 0 && leg.state !== 'cancelled' ? (
        <p className="text-body-sm text-warning-ink">About {lateText(leg.delayMinutes)}.</p>
      ) : null}
      <p className="text-caption text-ink-secondary">Local times at each station.</p>
    </li>
  );
}

export function TravelStatusPanel({
  reference,
  query,
  live,
}: {
  reference: string;
  query: UseQueryResult<TripStatus>;
  live: LiveMode;
}) {
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState('');
  const refresh = useMutation({
    mutationFn: () => refreshTripStatus(reference),
    onSuccess: (status) => {
      queryClient.setQueryData(tripKeys.status(reference), status);
      void queryClient.invalidateQueries({ queryKey: tripKeys.timeline(reference) });
      void queryClient.invalidateQueries({ queryKey: tripKeys.disruptions(reference) });
      setAnnouncement(`Travel status: ${FRESHNESS[status.freshness].label}.`);
    },
    onError: () => setAnnouncement('The status couldn’t be checked. Try again later.'),
  });

  if (query.isPending) {
    return (
      <Panel title="Travel status">
        <div role="status" aria-label="Loading travel status">
          <Skeleton className="h-24 rounded-lg" />
        </div>
      </Panel>
    );
  }
  if (query.isError) {
    return (
      <Panel title="Travel status">
        <ErrorState
          title="We couldn’t load the travel status"
          description="Your booking is unaffected. Check your connection, then try again."
          reference={
            query.error instanceof ApiClientError ? (query.error.requestId ?? undefined) : undefined
          }
          action={
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </Panel>
    );
  }
  const status = query.data;
  const freshness = FRESHNESS[status.freshness];
  const waitUntil = status.refresh.nextAllowedAt;
  const refreshError =
    refresh.error instanceof ApiClientError
      ? refresh.error.code === 'RATE_LIMITED'
        ? 'Too many checks in a short time. Wait a moment and try again.'
        : refresh.error.message
      : refresh.error
        ? 'The status couldn’t be checked. Try again later.'
        : null;

  return (
    <Panel title="Travel status" description={status.explanation}>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <IconBadge {...freshness} />
          {status.simulated ? <SimulatedBadge /> : null}
          {status.providerName ? (
            <span className="text-caption text-ink-secondary">Source: {status.providerName}</span>
          ) : null}
        </div>
        {status.legs.length > 0 ? (
          <ul aria-label="Journey" className="flex flex-col gap-3">
            {status.legs.map((leg) => (
              <LegRow key={leg.label} leg={leg} status={status} />
            ))}
          </ul>
        ) : null}
        {status.observedAt || status.checkedAt ? (
          <p className="text-caption text-ink-secondary">
            {status.observedAt ? <>Last reported {formatStamp(status.observedAt)}. </> : null}
            {status.checkedAt ? <>Last checked {formatStamp(status.checkedAt)}.</> : null}
          </p>
        ) : null}
        {status.refresh.available ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw aria-hidden="true" />
              Check now
            </Button>
            {waitUntil ? (
              <span className="text-caption text-ink-secondary">
                Checked recently: a new check asks the provider after {formatStamp(waitUntil)}.
              </span>
            ) : null}
          </div>
        ) : null}
        {refreshError ? (
          <p role="alert" className="text-body-sm text-danger-ink">
            {refreshError}
          </p>
        ) : null}
        {live !== 'off' ? (
          <p className="text-caption text-ink-secondary">
            {live === 'live'
              ? 'This page updates automatically when anything changes.'
              : live === 'polling'
                ? 'This page checks for changes every minute while it’s open.'
                : 'Connecting for updates…'}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

// ─── Disruptions ─────────────────────────────────────────────────────────

const SEVERITY: Record<TripDisruption['severity'], { label: string; tone: BadgeTone }> = {
  info: { label: 'Information', tone: 'neutral' },
  minor: { label: 'Minor', tone: 'warning' },
  major: { label: 'Major', tone: 'warning' },
  severe: { label: 'Severe', tone: 'danger' },
};

export function DisruptionsPanel({ reference }: { reference: string }) {
  const query = useQuery({
    queryKey: tripKeys.disruptions(reference),
    queryFn: ({ signal }) => getTripDisruptions(reference, signal),
  });
  // Nothing to say: no panel (the status panel covers "all normal").
  if (!query.data || query.data.items.length === 0) return null;
  const { items, notice } = query.data;
  return (
    <section
      aria-labelledby="disruptions-heading"
      className="rounded-xl border border-warning/40 bg-warning-soft p-5 shadow-xs sm:p-7"
    >
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle className="size-5 text-warning-ink" aria-hidden="true" />
        <h2 id="disruptions-heading" className="text-title">
          {items.length === 1 ? 'Travel disruption' : `${items.length} travel disruptions`}
        </h2>
      </div>
      <ul className="flex flex-col gap-4">
        {items.map((d) => (
          <li key={d.id} className="flex flex-col gap-1.5 rounded-lg bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-label">
                {d.legLabel ? `${d.legLabel}: ` : ''}
                {d.title}
              </p>
              <Badge tone={SEVERITY[d.severity].tone}>{SEVERITY[d.severity].label}</Badge>
              {d.state === 'unknown' ? <Badge tone="neutral">May have changed</Badge> : null}
              {d.simulated ? <SimulatedBadge /> : null}
            </div>
            {d.changes.newDeparture && d.changes.scheduledDeparture ? (
              <p className="text-body-sm">
                Departure: {stationTime(d.changes.scheduledDeparture, d.changes.scheduledDeparture)}{' '}
                →{' '}
                <span className="font-semibold">
                  {stationTime(d.changes.newDeparture, d.changes.scheduledDeparture)}
                </span>{' '}
                (local time)
              </p>
            ) : null}
            {d.changes.newArrival && d.changes.scheduledArrival ? (
              <p className="text-body-sm">
                Arrival: {stationTime(d.changes.scheduledArrival, d.changes.scheduledArrival)} →{' '}
                <span className="font-semibold">
                  {stationTime(d.changes.newArrival, d.changes.scheduledArrival)}
                </span>{' '}
                (local time)
              </p>
            ) : null}
            <p className="text-caption text-ink-secondary">
              Reported by {d.providerName} · first {formatStamp(d.firstDetectedAt)} · last updated{' '}
              {formatStamp(d.lastObservedAt)}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-body-sm">{notice}</p>
    </section>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────

const TYPE_ICON: Partial<Record<TripEvent['type'], LucideIcon>> = {
  booking_created: Luggage,
  booking_confirmed: CircleCheck,
  booking_cancelled: CircleX,
  booking_expired: Clock,
  booking_failed: CircleX,
  payment_succeeded: CreditCard,
  payment_failed: CreditCard,
  payment_refund_pending: CreditCard,
  payment_refunded: CreditCard,
  travel_reminder: BellRing,
  check_out_reminder: BellRing,
  status_changed: Plane,
  disruption_reported: AlertTriangle,
  disruption_updated: AlertTriangle,
  disruption_resolved: CircleCheck,
};

export function TripTimelinePanel({ reference }: { reference: string }) {
  const query = useInfiniteQuery({
    queryKey: tripKeys.timeline(reference),
    queryFn: ({ pageParam, signal }) => getTripTimeline(reference, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  return (
    <Panel
      title="Timeline"
      description="Everything that has happened to this booking, oldest first."
    >
      {query.isPending ? (
        <div role="status" aria-label="Loading the timeline" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title="We couldn’t load the timeline"
          description="Your booking is unaffected. Check your connection, then try again."
          action={
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {query.data.pages[0]!.items.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">Nothing has happened yet.</p>
          ) : (
            <ol aria-label="Booking timeline" className="relative flex flex-col gap-5">
              {query.data.pages
                .flatMap((p) => p.items)
                .map((event, i, all) => {
                  const Icon = TYPE_ICON[event.type] ?? CircleDashed;
                  const warning =
                    event.kind === 'disruption' && event.type !== 'disruption_resolved';
                  return (
                    <li key={event.id} className="relative flex gap-3">
                      {i < all.length - 1 ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-8 bottom-[-1.25rem] left-4 w-px bg-line"
                        />
                      ) : null}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'relative grid size-8 shrink-0 place-items-center rounded-full border',
                          warning
                            ? 'border-warning/50 bg-warning-soft text-warning-ink'
                            : 'border-line bg-brand-soft text-brand-ink',
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5 pt-1">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
                          <span className="font-semibold">{event.title}</span>
                          {event.source === 'demo' ? <SimulatedBadge /> : null}
                        </p>
                        <p className="text-caption text-ink-secondary">
                          <time dateTime={event.occurredAt}>{formatStamp(event.occurredAt)}</time>
                          {event.amount
                            ? ` · ${formatMoney(event.amount.amountMinor, event.amount.currency)}`
                            : ''}
                          {event.source === 'wayora' ? ' · Wayora' : ''}
                        </p>
                        {event.description ? (
                          <p className="text-caption text-ink-secondary">{event.description}</p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
            </ol>
          )}
          {query.hasNextPage ? (
            <div className="mt-4">
              <Button
                variant="ghost"
                size="sm"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

// ─── Wiring ──────────────────────────────────────────────────────────────

export function useTripStatus(reference: string) {
  return useQuery({
    queryKey: tripKeys.status(reference),
    queryFn: ({ signal }) => getTripStatus(reference, signal),
  });
}
