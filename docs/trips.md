# Trip tracking: timeline, travel status and disruptions (Phase 17)

The booking page (`/trips/:reference`) shows what has happened to a booking
(its **timeline**), the latest **travel status** of the journey, and any
travel **disruptions**, and updates itself while open.

**What is real and what isn't.** No real flight, train, bus or hotel status
provider is configured. Travel status and disruptions come from a **demo
provider that simulates them**; everything it produces is labelled
"Simulated" and "not real travel information", on the page, in the
timeline, in notifications and in the API (`source: "demo"`,
`simulated: true`). Wayora does not track any journey live. The timeline's
booking, payment and reminder entries are real records of what Wayora did.

- [Timeline](#timeline)
- [Travel status and freshness](#freshness)
- [Providers](#providers) and the [demo provider](#demo-provider)
- [Disruptions](#disruptions)
- [Notifications](#notifications)
- [Live updates](#live-updates)
- [Background checks](#background-checks)
- [API](#api)
- [Web](#web)
- [Database](#database) and [rollback](#rollback)
- [Configuration](#configuration)
- [Tests](#tests)
- [Limitations](#limitations)

## Timeline

`trip_events` holds one row per thing that happened to a booking, oldest
first by `occurred_at` (then insertion order, `seq`). It is **append-only**
(a trigger blocks `UPDATE` and `DELETE`); a correction is a new entry.

| Entries                                                                                          | Written by                                    | When                                                                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `booking_created`, `booking_confirmed`, `booking_cancelled`, `booking_expired`, `booking_failed` | A database trigger on `booking_status_events` | In the same transaction as the status change, whatever code made it                              |
| `payment_succeeded`, `payment_failed`, `payment_refund_pending`, `payment_refunded`              | A trigger on `payment_status_events`          | Likewise. Refund entries exist only when a provider confirmed the change (no demo refunds exist) |
| `travel_reminder`                                                                                | The reminder job                              | The day before the trip starts ("Check-in is tomorrow" for stays)                                |
| `check_out_reminder`                                                                             | The reminder job                              | Stays: the day before check-out                                                                  |
| `status_changed`                                                                                 | Travel status checks                          | A leg's state changed (on schedule → delayed → departed → arrived, or cancelled)                 |
| `disruption_reported`, `disruption_updated`, `disruption_resolved`                               | Travel status checks                          | A disruption appeared, changed materially, or ended                                              |

- **No duplicates:** every entry has a unique `dedupe_key` (e.g. the history
  row's id, `reminder:<booking>:DAY_BEFORE`,
  `status:<booking>:<provider>:<leg>:<state>`), inserted with
  `ON CONFLICT DO NOTHING`, so retries, repeated checks, several API
  instances and restarts add nothing.
- **Nothing that didn't happen:** entries are written only by the change
  they record (triggers fire only on committed history rows; status entries
  only for a validated, newer observation).
- **Times:** stored in UTC (`occurred_at`; `observed_at` for provider data,
  separately from `created_at`, when Wayora recorded it). The web app shows
  them in the viewer's time zone, named; journey times are shown in the
  station's local time, as booked.
- **Safe data only:** statuses, amounts, delays, times. Titles and
  descriptions are written by Wayora from these fields; no traveller names,
  contact details or provider text.
- Existing bookings got their timeline from their histories when the
  migration ran (backfill).

## Freshness

`GET /bookings/:reference/status` always answers, even with no provider: the
booking's own legs (from the offer snapshot) with their booked times, plus
whatever a provider reported.

| `freshness`   | Meaning                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `current`     | Observed by the provider within `TRAVEL_STATUS_FRESH_SECONDS` (default 5 min), and the latest check succeeded |
| `stale`       | Provider data that is older than that, or the latest check failed: shown with its age, never as current       |
| `pending`     | Tracking applies, but nothing has been checked yet                                                            |
| `unavailable` | No provider is configured, or it couldn't be reached and there is nothing earlier                             |
| `unsupported` | Not trackable: stays, holidays, metro and cabs (no timetabled journey), or a booking that isn't confirmed     |

Each answer includes a one-sentence `explanation`, `observedAt` (provider
time) and `checkedAt` (when Wayora last asked), the `source`
(`demo`/`live`) and `simulated`.

**Ordering:** an observation is applied only if it is newer than the stored
one (`observed_at`), under the booking's row lock, so late, repeated or
concurrent answers never overwrite newer information. A failed check keeps
the last good observation and records only a normalized error code
(`timeout`, `unavailable`, `invalid`, `not_found`, `error`), never provider
text.

## Providers

`apps/api/src/modules/trips/providers/types.ts` defines the contract:

- `supports(serviceType)` and `fetchStatus({ reference, serviceType, legs }, signal)`.
- The answer is validated against `providerReportSchema` before use:
  `observedAt`, per-leg `state`, `estimatedDeparture`, `estimatedArrival`,
  `delayMinutes`, and `disruptions` with a stable `key`, `type`, `severity`,
  `state` and the changed times. Anything else is rejected as `invalid`.
- Calls reuse the search resilience helpers: a per-attempt time limit
  (`TRAVEL_STATUS_TIMEOUT_MS`), one retry with jittered backoff for
  transient failures, and a circuit breaker (5 failures → 60 s pause).
- Adding a real provider: implement the interface, translate its payload to
  the report shape, keep its credentials in API environment variables (never
  `VITE_*`), respect its rate limits and terms, and select it in
  `createTripsService` (`apps/api/src/app.ts`) with a new
  `TRAVEL_STATUS_PROVIDER` value. Its data is then stored with source
  `LIVE_PROVIDER` and shown without the "simulated" labels.

Trackable bookings: confirmed flights (each itinerary is a leg), trains and
buses, until 12 hours after the last scheduled arrival.

### Demo provider

`DemoTravelStatusProvider` (`providers/demo.ts`, id `demo-status`) is on by
default in development and test (`TRAVEL_STATUS_PROVIDER=demo`) and off in
production unless enabled explicitly (a start-up warning says so).

- **Deterministic:** the scenario follows from the booking reference:
  `sha256(reference)[0] % 10` → 0–5 on time, 6–7 delayed 45 minutes,
  8 schedule change (+2 h, departure and arrival), 9 cancelled by the operator.
- Only the first leg is disrupted; later legs run as booked.
- Leg states follow the clock and the booked times: delayed/on schedule
  before departure, departed, then arrived (when a delay or schedule change
  is over).
- It never contacts anyone and changes nothing about the booking: a
  simulated cancellation leaves the booking confirmed.

## Disruptions

`trip_disruptions` holds one row per provider disruption
(`booking_id`, `provider_id`, `external_key` unique), with type
(`departure_delay`, `arrival_delay`, `cancellation`, `schedule_change`,
`service_disruption`, `booking_change`), severity (`info`, `minor`,
`major`, `severe`), lifecycle state, what changed, `first_detected_at`,
`last_observed_at` and `resolved_at`.

- **Reported:** first seen active → row `ACTIVE`, timeline entry, notification.
- **Updated:** the type, severity or changed times differ (a fingerprint of
  them) → timeline entry, notification. The same information polled again
  changes only `last_observed_at`.
- **Resolved:** reported resolved, or no longer reported by a newer
  observation → `RESOLVED`, timeline entry, notification.
- **Unknown (API only):** an active disruption is shown as `unknown` when
  the status isn't current, because it may have changed since.
- Only provider observations create disruptions (users have no endpoint to
  create, change or "verify" one).
- **Wayora never acts on a disruption:** no cancellation, rebooking, refund
  or compensation is made or promised; every disruption carries that notice.

## Notifications

Disruption changes create in-app notifications of the existing kind
(`trip_disruption`, category `trip`, shown in the header bell and on
`/notifications`), linked to the booking page. One per change: the
notification's dedupe key is the timeline entry's
(`disruption:<id>:reported|updated:<fingerprint>|resolved`), so retries and
repeated checks add nothing. Simulated ones say "(simulated)" in the title
and are flagged as demo. Status changes alone don't notify (only the
timeline records them). An email is queued per the user's "Booking updates"
preference; as before, no email provider is configured, so it is recorded as
"not configured" and nothing is sent.

## Live updates

`GET /bookings/:reference/events` is a **Server-Sent Events** stream for
the booking's owner (session cookie; someone else's booking is 404, signed
out is 401).

1. Every new `trip_events` row is announced by a database trigger with
   `pg_notify('wayora_trip_events', {bookingId, seq})`, delivered on
   commit to every listener.
2. Each API instance keeps one `LISTEN` connection
   (`database/src/listen.ts`, reconnects with backoff) and forwards
   announcements to the streams following that booking
   (`modules/trips/stream.ts`, on the shared `services/signal-hub.ts` and
   `services/signal-stream.ts`, also used by plan collaboration since
   Phase 19). No new infrastructure: it works across
   instances and for changes made by any process.
3. Messages carry ids only: `id: <seq>`, `event: trip-event`,
   `data: {"seq","reference"}`. The browser then re-reads the timeline,
   status and disruptions through the normal endpoints, so repeated or
   missed messages can't duplicate or lose anything.
4. Reconnects: the browser sends `Last-Event-ID`; anything newer is
   announced at once. After the LISTEN connection itself reconnects, every
   stream is told to re-read. A safety re-read runs every 30 s per stream.
5. Lifetime: heartbeats every 25 s; the session is re-checked every
   60 s (sign-out or "sign out everywhere" ends the stream with
   `event: end`, `reason: signed-out`); streams close after 30 minutes and
   the browser reconnects (authenticated again); at most 5 open streams per
   user per instance (more: 429); on shutdown every stream is ended first.

**Fallback:** if `EventSource` isn't available or the stream fails three
times, the page re-reads every 60 seconds while it is visible, and stops
when the page closes. Finished bookings (cancelled, expired, failed) don't
open a stream. The page says which mode it is in ("updates automatically" or
"checks every minute") — this describes the page, not the journey.

Deployment: a proxy in front of the API must not buffer
`text/event-stream` responses (the API sends `X-Accel-Buffering: no`) and
must allow long-lived requests; each API instance holds one extra
PostgreSQL connection for `LISTEN` (docs/deployment.md).

## Background checks

When a provider is configured, every API instance runs a sweep every
`TRAVEL_STATUS_SWEEP_SECONDS` (default 300; 0 turns it off): confirmed
flights, trains and buses travelling between yesterday and tomorrow (UTC
dates) whose status is older than the freshness window, at most 100 per
run, inside their tracking window. It is idempotent (dedupe keys,
newest-observation-wins), so several instances and restarts are safe.
Failures are logged (normalized code, scrubbed message) and counted on the
admin health page ("Travel status": provider, simulated or not, bookings
with a failed check in the last hour).

## API

All under `/api/v1`, signed in, `Cache-Control: no-store`, strict
validation (unknown query parameters are 400). The booking is addressed by
its reference; another user's booking is 404, like a missing one.

| Method and path                                        | Answer                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /bookings/:reference/timeline?after=&limit=`      | `{ reference, items[], nextCursor }`, oldest first; `limit` 1–100 (default 50); `after` is the opaque `nextCursor`                                                                                                                                                               |
| `GET /bookings/:reference/status`                      | Travel status with freshness ([above](#freshness))                                                                                                                                                                                                                               |
| `GET /bookings/:reference/disruptions?state=open\|all` | `{ reference, items[], notice }` (default `open`: active ones)                                                                                                                                                                                                                   |
| `POST /bookings/:reference/status/refresh`             | Asks the provider unless it was asked within `TRAVEL_STATUS_MIN_REFRESH_SECONDS` (then the stored status); `TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX` per user per minute (429 beyond); trusted `Origin` required; `409 TRIP_TRACKING_UNAVAILABLE` when the booking can't be tracked |
| `GET /bookings/:reference/events`                      | Server-Sent Events ([above](#live-updates))                                                                                                                                                                                                                                      |

Schemas: `packages/contracts/src/trips.ts`.

## Web

On `/trips/:reference` (`features/bookings/TripTracking.tsx`):

- **Travel status** panel: freshness badge (icon and text), "Simulated"
  badge and source, each leg's route with booked times and, when the
  provider reports them, the new times and delay; "Check now" when
  available (with the throttle explained); "Last reported" and "Last
  checked" in the viewer's time zone; loading, error with retry (the
  booking stays usable).
- **Travel disruption** box (only when there are open ones): what changed,
  severity, "May have changed" for `unknown`, source and times, and the
  "Wayora doesn't change your booking" notice.
- **Timeline** (replaces the old "History" list): icons and text by entry
  type, "Simulated" on demo entries, amounts for payments, "Show more" for
  long timelines.
- Status is never conveyed by colour alone; no animation beyond the design
  system's defaults (reduced motion respected).

## Database

Migration `20261026000000_trip_tracking` (additive):

- enums `trip_event_type`, `trip_event_source` (`WAYORA`, `DEMO_PROVIDER`,
  `LIVE_PROVIDER`), `disruption_type`, `disruption_severity`,
  `disruption_state`; `notification_type` gains `TRIP_DISRUPTION`;
- `trip_events` (unique `seq`, unique `dedupe_key`, index
  `(booking_id, occurred_at, seq)` for the timeline query; CHECKs: `data` is
  an object, `observed_at` set exactly for provider entries; append-only
  trigger; announce trigger);
- `trip_statuses` (one row per booking; index on `checked_at`);
- `trip_disruptions` (unique `(booking_id, provider_id, external_key)`,
  index `(booking_id, state)`; CHECK: resolved exactly when `resolved_at`
  is set);
- triggers copying booking and payment history rows into the timeline, and
  a backfill of existing histories and travel reminders.

### Rollback

```sql
BEGIN;
DROP TRIGGER IF EXISTS "booking_status_events_to_timeline" ON "booking_status_events";
DROP TRIGGER IF EXISTS "payment_status_events_to_timeline" ON "payment_status_events";
DROP FUNCTION IF EXISTS "trip_events_from_booking_status"();
DROP FUNCTION IF EXISTS "trip_events_from_payment_status"();
DROP TABLE IF EXISTS "trip_disruptions";
DROP TABLE IF EXISTS "trip_statuses";
DROP TABLE IF EXISTS "trip_events";
DROP FUNCTION IF EXISTS "trip_events_prevent_mutation"();
DROP FUNCTION IF EXISTS "trip_events_announce"();
DROP TYPE IF EXISTS "disruption_state";
DROP TYPE IF EXISTS "disruption_severity";
DROP TYPE IF EXISTS "disruption_type";
DROP TYPE IF EXISTS "trip_event_source";
DROP TYPE IF EXISTS "trip_event_type";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261026000000_trip_tracking';
COMMIT;
```

PostgreSQL can't remove an enum value: `TRIP_DISRUPTION` stays in
`notification_type`. Before deploying the Phase 16 code, delete those
notifications (`DELETE FROM notifications WHERE type = 'TRIP_DISRUPTION'`;
their outbox rows cascade), since the older code doesn't know the type.
Then deploy the Phase 16 API, worker and web. Tested: rollback leaves the
Phase 16 schema, and re-applying works (with the backfill).

## Configuration

API (`apps/api/.env.example`):

| Variable                               | Default                                | Meaning                                          |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `TRAVEL_STATUS_PROVIDER`               | `demo` (dev/test), `none` (production) | `demo` or `none`; no live provider exists yet    |
| `TRAVEL_STATUS_FRESH_SECONDS`          | 300                                    | Within this, a status is `current`               |
| `TRAVEL_STATUS_MIN_REFRESH_SECONDS`    | 60                                     | A booking's provider is asked at most this often |
| `TRAVEL_STATUS_TIMEOUT_MS`             | 5000                                   | Per-attempt provider time limit                  |
| `TRAVEL_STATUS_REFRESH_RATE_LIMIT_MAX` | 10                                     | Refreshes per user per minute                    |
| `TRAVEL_STATUS_SWEEP_SECONDS`          | 300                                    | Background check interval; 0 = off               |

## Tests

```bash
# Unit (no services): demo provider, report validation, wording, fan-out
npm test -w @wayora/api -- trips-unit
# Integration (PostgreSQL; see docs/auth.md#running-the-tests)
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/trips
# Web: status, disruptions, timeline, live updates and polling fallback
npm test -w @wayora/web -- trips
```

The integration suite covers: timeline built by the triggers, ordering and
cursor paging, append-only rows, reminders once each; 401/404 on every
endpoint for strangers and signed-out users, no write endpoints, CSRF;
unsupported, pending, current, stale and unavailable states, the refresh
throttle and rate limit; provider failures (unavailable, timeout, invalid
answer, leaky error text) never shown as current or leaked; delays, schedule
changes and cancellations (booking untouched); one notification per change;
out-of-order, repeated and concurrent observations; the background sweep;
and live updates over real LISTEN/NOTIFY, `Last-Event-ID` catch-up,
sign-out ending a stream and the per-user stream cap.

## Limitations

- **No real status provider:** all status and disruption data is simulated.
  Nothing on the page or in the API is verified travel information.
- No check-in information, gates, terminals, platforms, seats, tickets or
  PNRs are shown, because none exist.
- Hotel, holiday, metro and cab bookings have a timeline but no travel
  status.
- Status entries are deduplicated per state, so a leg returning to an
  earlier state (e.g. delayed → on schedule → delayed) records the second
  "delayed" only in the status, not as a new timeline entry.
- The sweep's "today" uses UTC dates; trips near midnight in other time
  zones are covered by the yesterday–tomorrow window.
- Stream limits (5 per user) are per API instance.
