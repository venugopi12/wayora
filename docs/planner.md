# Trip planner

Phase 18 adds a trip planner: signed-in users create **planned trips** (title,
destination, dates, notes, optional preferences) and build a **day-by-day
itinerary** of activities, with schedule warnings and sample suggestions.

A planned trip is a plan, never a booking. Nothing is reserved, priced or paid
for; saving a plan never creates or changes a booking, and the planner lives
under its own **Trip planner** entry (`/plans`), apart from **My trips**
(`/trips`, the user's demo bookings).

What it is not, today:

- **No live place data.** Suggestions come from a hand-written sample dataset
  (below). No places, maps or opening-hours provider is integrated.
- **No AI.** Suggestions are ranked by fixed, documented rules.
- **No travel-time validation.** No routing source exists, so the planner never
  says two activities are reachable in time; every plan is labelled “not
  travel-time-validated” (`travelTimeValidated: false` in the API).

## Data model

Migration `20261027000000_trip_planner` adds two tables (all user-owned rows
cascade from `users`):

- **`planned_trips`** — `user_id`, `title`, `destination_id` (a curated sample
  destination such as `goa`, or null) and `destination_name` (free text when
  not curated), `start_date` and `end_date` (`DATE`), `notes`, the optional
  preferences `pace`, `budget`, `group_type`, `interests` (enum array),
  `booking_id` (optional link, see below), `version` (optimistic concurrency),
  timestamps.
- **`itinerary_items`** — `trip_id`, `day` (`DATE`), `position` (0-based,
  gap-free within a day), `title`, `category`, `start_minute` (wall-clock
  minutes after midnight, 0–1439), `duration_minutes` (5–720), `location`,
  `notes`, `suggestion_id` (the curated suggestion it came from), timestamps.

There is no separate "itinerary day" table: a trip's days are the dates from
start to end. Each activity stores its own date, so changing the trip's dates
never deletes or silently moves anything — activities left outside the new
dates are returned as `outsideDates` with a warning, for the user to move or
delete.

Constraints and indexes (hand-written ones are marked ✱):

- CHECKs: non-blank title and destination name; `end_date >= start_date` and at
  most 30 days ✱; `version >= 1` ✱; position, start minute and duration ranges ✱.
- `UNIQUE (trip_id, day, position) DEFERRABLE INITIALLY IMMEDIATE` ✱ — no two
  activities can share a slot. It is deferrable so a reorder can swap
  positions in one statement; it also serves the itinerary read.
- Partial unique index `(trip_id, suggestion_id) WHERE suggestion_id IS NOT
NULL` ✱ — a curated suggestion appears at most once per trip.
- Trigger `planned_trips_booking_owner_check` ✱ — a linked booking must belong
  to the plan's owner, even if the API were bypassed.
- Indexes: `planned_trips (user_id, start_date, id)` for the list,
  `planned_trips (booking_id)`.

## Dates and time zones

- Trip and itinerary dates are destination-local **calendar dates**
  (`YYYY-MM-DD`), stored as `DATE`. They are never converted between zones:
  the server reads and writes them as UTC-midnight values and formats them
  with `toISOString().slice(0, 10)`; the web app formats them with
  `timeZone: 'UTC'`. So "12 Nov in Goa" stays 12 Nov for a browser in
  California or a server in Tokyo (tested with several `TZ` values).
- Activity times are **wall-clock `HH:MM`** at the destination, stored as
  minutes after midnight — not instants. Curated destinations show their
  IANA zone for reference ("Times are local to Goa (Asia/Kolkata)"); free-text
  destinations have none.
- "Not in the past" uses the server clock with a one-day allowance (yesterday
  in UTC still counts as today), like search dates. A trip that has already
  started keeps its start date when edited. Trips may start up to two years
  ahead and last 1–30 days.

## API

All routes need a session, act only on the session's own plans (no route
takes a user id), and answer 404 — with the same message — for a plan that
doesn't exist or belongs to someone else. Writes return the whole updated
trip, so the client never merges.

| Method | Path                                                    | Notes                                                      |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/v1/planner/destinations`                          | The 12 curated sample destinations (`sample: true`)        |
| GET    | `/api/v1/planner/trips?page=&pageSize=`                 | Your plans by start date (`pageSize` ≤ 50), with `total`   |
| POST   | `/api/v1/planner/trips`                                 | Create; `Idempotency-Key` required; 201                    |
| GET    | `/api/v1/planner/trips/:tripId`                         | Plan, days, `outsideDates`, `warnings`                     |
| PATCH  | `/api/v1/planner/trips/:tripId`                         | Details, preferences, booking link; needs `version`        |
| DELETE | `/api/v1/planner/trips/:tripId`                         | Deletes the plan and its activities                        |
| POST   | `/api/v1/planner/trips/:tripId/items`                   | Add an activity; `Idempotency-Key` required; 201           |
| PATCH  | `/api/v1/planner/trips/:tripId/items/:itemId`           | Edit; `day` moves it, `position` places it                 |
| DELETE | `/api/v1/planner/trips/:tripId/items/:itemId`           | Remove; the day's order closes up                          |
| POST   | `/api/v1/planner/trips/:tripId/items/:itemId/duplicate` | Copy to the end of `day` (default: same day); key required |
| PUT    | `/api/v1/planner/trips/:tripId/days/:day/order`         | `{ itemIds }`: exactly that day's activities, new order    |
| GET    | `/api/v1/planner/trips/:tripId/suggestions?category=`   | Curated sample suggestions with reasons                    |

### Validation rules

- Bodies are strict: unknown fields (`userId`, `id`, `version` on create,
  `createdAt`, …) are refused, so ownership and server-managed fields can't be
  mass-assigned.
- Text is trimmed (one-line fields also collapse whitespace) and must not
  contain control characters or bidirectional overrides; notes keep line
  breaks. Limits: title 120, destination 120, location 160, activity notes
  1000, trip notes 2000. Everything is stored and rendered as plain text.
- Dates must be real calendar dates; end ≥ start; 1–30 days; activity days
  within the trip dates (adding, moving and duplicating).
- Times `HH:MM` (00:00–23:59); durations 5–720 whole minutes.
- Limits: 50 plans per account, 20 activities per day, 200 per plan
  (`PLAN_LIMIT_REACHED`, 409).
- A reorder must list every activity on that day exactly once; anything else
  (stale, partial, foreign or duplicated ids) changes nothing
  (`PLAN_OUT_OF_DATE`, 409).
- A curated suggestion must belong to the plan's destination and can be added
  once (409 on a second add).
- Linking a booking: only the user's own booking (else 404) and only while it
  is `confirmed` (else 409). `bookingReference: null` unlinks.

### Errors

Standard envelope ([api-conventions.md](api-conventions.md)). Planner-specific
codes: `PLAN_OUT_OF_DATE` (409 — trip edited elsewhere since `version`, or a
reorder list that doesn't match the day) and `PLAN_LIMIT_REACHED` (409).
Idempotency errors are the booking ones (`IDEMPOTENCY_IN_PROGRESS`,
`IDEMPOTENCY_KEY_REUSED`).

### Reliability

- Every itinerary write runs in one transaction that first locks the plan row
  (`SELECT … FOR UPDATE`), so concurrent writes to one plan are serialized and
  positions stay unique and gap-free (tested with concurrent adds, moves,
  deletes and reorders). Trip creation locks the user row so the per-account
  limit holds.
- Creating POSTs (plan, activity, duplicate) use the existing idempotency keys
  (scoped per operation and user; only the new row's id is stored, never the
  body): a retry replays, a concurrent duplicate is refused.
- Trip-detail edits carry `version`; an edit based on an older version is
  refused (`PLAN_OUT_OF_DATE`) instead of overwriting someone else's change.
  Itinerary writes don't need it: each is checked against the locked state.
- Writes are rate limited per user (`PLANNER_RATE_LIMIT_MAX`, default 120 per
  minute); reads use the API-wide limit.
- Reads are bounded (one query for the plan with its ≤ 200 activities; the
  list is one paginated query with counts) — no N+1 queries.
- Logs carry ids only; plan titles, notes and places are never logged.

## Schedule warnings

Computed by the API on every read (`apps/api/src/modules/planner/schedule.ts`)
from the user's own times and durations only. They never block saving and
never move or remove anything.

| Code                 | When                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `overlap`            | Two timed activities overlap (or start at the same minute)              |
| `outside_trip_dates` | Activities on a day outside the trip dates (after the dates changed)    |
| `missing_start_time` | A day mixes timed and untimed activities, so the order can't be checked |
| `out_of_order`       | Timed activities are listed out of time order ("Sort by time" fixes it) |
| `ends_next_day`      | An activity runs past midnight                                          |
| `long_day`           | Durations on a day add up to more than 12 hours (travel not included)   |

An activity without a duration only overlaps one starting at the same
minute: without a duration there is no data to say more. Nothing is said about
travel between activities.

## Recommendations

Source: **curated sample data**, ranked by **deterministic rules**.

- Data: `apps/api/src/modules/planner/catalog.ts` — 7–9 well-known places
  and experiences for each of the 12 sample destinations of the discover pages
  (same ids). Each has a category, area, a one-line description, a planning
  estimate of how long to allow, a rough cost level, when it's commonly
  enjoyed, an intensity and the groups it suits. It has **no** opening hours,
  prices, availability, ratings or travel times, and the UI labels the
  estimates as estimates ("Allow about 2 h (estimate)", "Usually free or low
  cost — check before you go"). Seasonal or access caveats say "check before
  you go" instead of stating schedules. Suggestion ids are stored on
  activities, so existing ids must never be renamed or reused.
- Rules (`recommend.ts`): never suggest what's already planned (same
  suggestion id, or the same title); leave out activities not tagged for the
  chosen group (e.g. nightlife for families); score interest match +3, budget
  fit +2/+1 or clash −2/−1, group fit +1, pace fit +1 or clash −1, a category
  not yet planned +1; ties keep catalog order. Every rule that adds points
  becomes a "Why it's suggested" reason; with no preferences set, the order is
  the catalog order and the reason is "A sample highlight of …".
- The trip's length and pace give a capacity hint (relaxed 2, balanced 3,
  packed 4 activities a day) shown above the list.
- Destinations outside the sample list (free text) get `available: false` and
  an explanation; the rest of the planner works the same.
- Adding a suggestion creates an ordinary activity (title, category, the
  estimate as duration, the area as location, no start time) linked by
  `suggestion_id`; duplicating it makes an unlinked copy.

No AI provider or paid places API is used or configured. To add a real
provider later, put it behind the same `suggestions` response (with a source
other than `curated-sample` and visible data freshness), and keep its
credentials on the API.

## Preferences

Optional, per plan: pace (relaxed, balanced, packed), budget (shoestring,
moderate, premium), travelling as (solo, couple, family, friends) and
interests (activity categories). Defaults are "no preference", which gives the
default suggestion order. They only affect suggestion ranking, are editable at
any time, are part of the user's own plan (never visible to other accounts),
and hold nothing sensitive or inferred. There is no separate profile: they
live on the plan.

## Booking links

In **Edit details**, a user may link one of their own **confirmed** bookings
(listed from My trips) to a plan, for reference. Linking changes nothing about
the booking, adds nothing to its timeline, and never marks the plan as booked;
the plan shows the booking's reference, category, status and whether it's a
demo. If the booking is later cancelled, the link stays and shows that status.
Nothing in the planner creates bookings.

## Web

- `/plans` — the user's plans (loading, empty, error states; pagination).
- `/plans/new` — create (`?destination=goa` preselects a sample destination;
  each discover destination page has a **Plan this trip** link). Validated
  with the same contract as the API; one idempotency key per distinct
  request; leaving with unsaved changes asks first.
- `/plans/:tripId` — notices (plan not booking; local times; not
  travel-time-validated), warnings (text and icon, never colour alone, with
  "Show day" links), activities outside the dates, day tabs (with counts and a
  warning marker), each day's schedule as a numbered list of activity cards,
  and sample suggestions beside it (below it on small screens).
- **Reordering:** each activity has **Move up** / **Move down** buttons (44 px,
  keyboard-operable; focus stays on the moved activity; the move is announced
  to screen readers). Moves show at once and are sent as **one** reorder
  request after a short pause (several presses = one request); if saving
  fails, the saved order comes back and a message says so. A day can also be
  sorted by time in one step. There is **no drag and drop**: it couldn't be
  made reliably accessible (keyboard and touch) with the current stack, so the
  buttons are the only reorder method.
- Add / edit happen in a dialog (validation, a saving state that ignores
  repeat clicks, the server's message on failure); closing with unsaved
  changes asks first. **Move to another day**, **Duplicate** and **Delete**
  (with confirmation) are in each activity's menu. Deleting a plan asks
  first and says bookings aren't affected.
- Leaving the page while a reorder is waiting sends it first. Other dialogs
  keep their unsaved state until the user confirms discarding it.
- Requests are cancelled when their component unmounts (React Query signals);
  timers are cleared.

## Configuration

| Variable                 | Default | Meaning                                  |
| ------------------------ | ------- | ---------------------------------------- |
| `PLANNER_RATE_LIMIT_MAX` | 120     | Planner writes per signed-in user/minute |

No other variables: there is no external provider to configure.

## Migration

Apply with the usual `npm run db:migrate:deploy` ([deployment.md](deployment.md)).
It is additive (two tables, four enums, one trigger); no existing table or row
changes.

### Rollback

```sql
BEGIN;
DROP TABLE IF EXISTS "itinerary_items";
DROP TABLE IF EXISTS "planned_trips";
DROP FUNCTION IF EXISTS "planned_trips_booking_owner"();
DROP TYPE IF EXISTS "planning_group";
DROP TYPE IF EXISTS "planning_budget";
DROP TYPE IF EXISTS "planning_pace";
DROP TYPE IF EXISTS "activity_category";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261027000000_trip_planner';
COMMIT;
```

This deletes every plan. Then deploy the Phase 17 API and web. Tested:
rollback leaves the Phase 17 schema, and re-applying works.

## Tests

```bash
# Unit (no services): dates across time zones, text safety, schedule warnings,
# the curated catalog and the suggestion rules
npm test -w @wayora/api -- planner-unit
# Integration (PostgreSQL; see docs/auth.md#running-the-tests)
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/planner
# Web: list, create, plan page, reordering, suggestions, dialogs
npm test -w @wayora/web -- planner
```

The integration suite covers: creation and every date rule (end before start,
over 30 days, past, too far ahead, impossible dates), strict bodies (no
`userId`, `id`, `version` or timestamps), text rules, idempotent creation
(retry, concurrent duplicate, reused key), optimistic concurrency, dates
shrinking around activities, the plan limit; adding, editing, moving between
and within days, reordering (and refusing stale, partial, foreign or duplicate
lists), duplicating, deleting, positions under concurrent writes, the
per-day limit; every warning; suggestions (ranking and reasons,
deduplication by id and title, group filtering, determinism, category filter,
no data for free-text destinations, wrong-destination suggestions); booking
links (own confirmed only, nothing about the booking or its timeline
changes, the database trigger); and for another user — read, list, edit,
delete, add, edit, move, delete, duplicate and reorder (including through
their own plan) all fail and change nothing; plus 401, CSRF, invalid ids and
the write rate limit.

## Limitations

- Suggestions are sample data for 12 destinations; no live places, hours,
  prices, availability, ratings, maps or travel times.
- No travel-time validation: warnings only use the user's own times and
  durations, so a plan can look fine and still be impossible to travel.
- Reordering is by buttons only (no drag and drop).
- Preferences are per plan, not account-wide defaults.
- Times are wall-clock and have no time zone of their own; a trip that
  crosses time zones (e.g. a multi-city plan) is treated as one destination.
- Plans can't be shared with other people.
