# Trip planner

Phase 18 adds a trip planner: signed-in users create **planned trips** (title,
destination, dates, notes, optional preferences) and build a **day-by-day
itinerary** of activities, with schedule warnings and sample suggestions.

A planned trip is a plan, never a booking. Nothing is reserved, priced or paid
for; saving a plan never creates or changes a booking, and the planner lives
under its own **Trip planner** entry (`/plans`), apart from **My trips**
(`/trips`, the user's demo bookings).

Phase 19 makes plans **collaborative**: the owner can invite other Wayora
accounts as editors or viewers, members edit one shared itinerary with
conflict detection, changes reach other members' open pages live, and every
change is kept in a readable history. See [Collaboration](#collaboration).
A plan nobody was invited to works exactly as before.

Phase 20 adds a **budget and shared expenses** to each plan: a budget,
expenses with exact splits, balances and settlement suggestions — without
moving any money. See [Budget and expenses](#budget-and-expenses).

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

## Collaboration

### Roles and permissions

A plan has exactly **one owner** — the account that created it
(`planned_trips.user_id`) — and any number of **members**, each an
**editor** or a **viewer**.

| Action                                                     | Owner | Editor | Viewer |
| ---------------------------------------------------------- | :---: | :----: | :----: |
| See the plan, its itinerary, members, history, suggestions |   ✓   |   ✓    |   ✓    |
| Add, edit, move, duplicate, delete and reorder activities  |   ✓   |   ✓    |        |
| Edit title, dates, destination, notes and preferences      |   ✓   |   ✓    |        |
| Invite people, withdraw invitations, change roles, remove  |   ✓   |        |        |
| Link (or unlink) one of their own confirmed bookings       |   ✓   |        |        |
| Delete the plan                                            |   ✓   |        |        |
| Leave the plan                                             |       |   ✓    |   ✓    |

- Access is resolved on **every request** from the database
  (`modules/planner/access.ts`), never from the client. Someone who is
  neither the owner nor a member gets the **same 404** as for a plan that
  doesn't exist, so a plan id reveals nothing. A member whose role doesn't
  allow an action gets 403.
- The owner is **not** a member row: a database trigger refuses making the
  owner a member or an invitee, and another refuses changing
  `planned_trips.user_id`. So a plan always has exactly one owner, who can't
  be demoted, removed or replaced — through the API or directly in SQL.
  Ownership transfer isn't supported.
- `owner` is not a valid role in any request body; role changes accept only
  `editor` or `viewer`, and only from the owner. Nobody can promote
  themselves.
- Writes lock the plan row before checking access, and membership changes
  lock it too, so a member removed a moment ago can't slip in a change: their
  next request is refused (tested).
- The owner's linked booking is the owner's own: members never see it.
- Members see each other's **display names and initials only**, never email
  addresses. The owner sees invitees' addresses **masked** (`a•••@example.com`).

### Invitations

- The owner invites an **existing, active Wayora account by email**, as
  editor or viewer. Unknown addresses, inactive accounts, the owner, existing
  members and people with an open invitation are refused with a clear
  message. A plan can have up to 20 members and open invitations.
- Delivery is **in-app only**: the invitee gets a notification and sees the
  invitation under Trip planner. **No email is sent** — no email provider is
  configured (see [notifications.md](notifications.md#delivery)), and the
  page says so. The owner can also copy a link to the invitation
  (`/plans/invitations/:id`), but the link grants nothing: only the invited
  account, signed in, can open, accept or decline it. Anyone else gets 404.
  There is **no bearer token** and no public "anyone with the link" access.
- Lifecycle: `pending` → `accepted` | `declined` | `revoked` (owner
  withdrew it) | `expired` (14 days). Expiry is applied when the invitation is
  next touched (answering, inviting the same person again) and lists hide
  expired ones. Any answered, withdrawn or expired invitation is closed:
  answering it again is refused (`INVITATION_CLOSED`, 409).
- At most one open invitation per person and plan (a partial unique index;
  two simultaneous invitations create one, the other gets 409).
- Accepting is atomic: it locks the plan, then the invitation, marks it
  accepted and adds the membership in one transaction. Two simultaneous
  accepts join once; accept and revoke racing settle one way.

### Concurrent editing

Optimistic concurrency, no merging. A write based on data that changed since
the client read it is refused with `PLAN_OUT_OF_DATE` (409, with a
`details[].path` naming the stale field), and nothing is overwritten:

- **Plan details** carry `version` (Phase 18).
- **Activities** carry their own `version`, bumped on every edit; an edit
  must send the version it was based on.
- **Reorders** send `previousOrder`; if the day's order changed since, the
  reorder is refused. The list must still contain exactly that day's
  activities.
- A deleted activity answers 404 to anyone who still had it open.

The web app explains the conflict ("Someone else changed this activity since
you opened it"), keeps the user's dialog, and offers **Load the latest
version**; a refused reorder puts back the server's order.
Transactions, the plan-row lock and the deferrable position constraint keep
the itinerary consistent under concurrent requests from several members
(tested: two simultaneous edits of one version → exactly one succeeds).

### Live updates

Collaborators' open plan pages update **live** over Server-Sent Events,
reusing the Phase 17 mechanism ([trips.md](trips.md#live-updates)), now
shared code (`services/signal-hub.ts`, `services/signal-stream.ts`):

1. Every history row (one per change) is announced by a database trigger:
   `pg_notify('wayora_planner_activity', {tripId, seq: revision})`, on commit.
2. Each API instance LISTENs once and forwards announcements to streams
   following that plan: `GET /planner/trips/:tripId/events` (session cookie;
   members only; at most 5 open streams per user per instance).
3. Messages carry the new **revision only** (`event: plan-changed`). The
   browser re-reads the plan, members and history through the normal
   endpoints, so repeated or missed messages can't duplicate or lose
   anything; announcements not newer than what the page shows are ignored.
4. Before each message the stream re-checks that the user is still a member
   (and fails closed if it can't tell), and every minute re-checks the
   session. A removed member's stream ends (`event: end`,
   `access-ended`); so does a signed-out one.
5. Reconnects send `Last-Event-ID` and get anything newer at once; a safety
   re-read runs every 30 s; streams end after 30 minutes and reconnect
   (re-authenticated).
6. If the stream can't be used (no `EventSource`, or three failures), the page
   **polls every 30 s while visible**, and says so. Streams and timers are
   closed when the page unmounts.

Only **shared** plans (with members) open a stream; personal plans don't.

### Activity history

`planner_activities` keeps one row per change: the actor, the type, safe
details (ids, roles, changed field names, activity titles and days — no email
addresses, tokens or free-text notes) and the time. `revision` is the plan's
revision after the change and is unique per plan, so each change is recorded
**exactly once**; an idempotent retry that replays a stored outcome records
nothing (tested). The table is append-only (a trigger refuses rewrites).

Recorded: details updated (with the changed fields), activity added /
updated / moved / duplicated / deleted, day reordered, member invited,
invitation accepted / declined / withdrawn, role changed, member removed,
member left. Members read it newest first, paged
(`GET …/activity?before=&limit=`), as sentences written by Wayora ("You
moved “Fort Aguada” to another day", "Asha made Ravi an editor"), with a
"Show day" link where one applies. It is separate from the booking timeline
(Phase 17): plan edits never appear on a booking.

### Notifications

In-app notifications through the existing system (unread count, bell,
`/notifications`), each with a unique dedupe key, so a retry never notifies
twice:

| Type                       | Who                       | When                                              |
| -------------------------- | ------------------------- | ------------------------------------------------- |
| `plan_invitation`          | The invitee               | Invited (links to the invitation)                 |
| `plan_invitation_accepted` | The owner                 | Accepted (links to the plan)                      |
| `plan_invitation_declined` | The owner                 | Declined                                          |
| `plan_member_changed`      | The member / the owner    | Role changed, removed (no link), or a member left |
| `plan_updated`             | Everyone else on the plan | Dates or destination changed                      |

Ordinary itinerary edits don't notify anyone (too noisy): they show live and
in the history. Planner notifications are **in-app only** — no email delivery
rows are created, so nothing is ever reported as emailed. Links are built by
the server and dropped when the recipient can no longer open the plan.

### Collaboration API

| Method | Path                                                            | Who                                    |
| ------ | --------------------------------------------------------------- | -------------------------------------- |
| GET    | `/api/v1/planner/trips/:tripId/members`                         | Members (open invitations: owner only) |
| POST   | `/api/v1/planner/trips/:tripId/invitations`                     | Owner; `{ email, role }`; 201          |
| DELETE | `/api/v1/planner/trips/:tripId/invitations/:invitationId`       | Owner (withdraw)                       |
| PATCH  | `/api/v1/planner/trips/:tripId/members/:memberId`               | Owner; `{ role: editor \| viewer }`    |
| DELETE | `/api/v1/planner/trips/:tripId/members/:memberId`               | Owner (remove) or the member (leave)   |
| GET    | `/api/v1/planner/trips/:tripId/activity?before=&limit=`         | Members                                |
| GET    | `/api/v1/planner/trips/:tripId/events`                          | Members (Server-Sent Events)           |
| GET    | `/api/v1/planner/invitations?status=pending\|all`               | Your own invitations                   |
| GET    | `/api/v1/planner/invitations/:invitationId`                     | The invitee only                       |
| POST   | `/api/v1/planner/invitations/:invitationId/accept` · `/decline` | The invitee only                       |

Plan list and plan responses now include `access` (`role`, `canEdit`,
`canManage`), the `owner`'s display name, `memberCount` and `revision`;
activities include `version` and `addedBy`. Bodies are strict (unknown
fields refused). Writes need a trusted `Origin` and count against
`PLANNER_RATE_LIMIT_MAX`; sending invitations is also limited per user per
hour (`PLANNER_INVITE_RATE_LIMIT_MAX`). Error codes: `NOT_FOUND` (no access),
`FORBIDDEN` (role), `PLAN_OUT_OF_DATE`, `PLAN_LIMIT_REACHED`, `CONFLICT`
(already a member / already invited), `INVITATION_CLOSED`.

### Collaboration data model

Migration `20261028000000_plan_collaboration` (additive):

- `trip_members` (`trip_id`, `user_id`, `role`, `invited_by_id`,
  `joined_at`; unique `(trip_id, user_id)`; trigger keeping the owner out).
- `trip_invitations` (`trip_id`, `invitee_id`, `invited_by_id`, `role`,
  `status`, `expires_at`, `responded_at`; partial unique index: one
  `PENDING` per `(trip_id, invitee_id)`; CHECKs: answered exactly when
  accepted/declined/revoked, expiry after creation; trigger keeping the
  owner out).
- `planner_activities` (`trip_id`, `revision`, `actor_id`, `type`, `data`;
  unique `(trip_id, revision)`; append-only and announce triggers).
- `planned_trips.revision`, `itinerary_items.version` and
  `itinerary_items.created_by_id`; `notifications.planned_trip_id` and
  `notifications.trip_invitation_id`; five `notification_type` values.
- Trigger `planned_trips_owner_fixed_check`: the owner can't change.

Deleting a plan deletes its members, invitations and history; its
notifications stay, without a link.

## Budget and expenses

Phase 20 adds a budget and shared expenses to every plan
(`/plans/:tripId/budget`): an optional trip budget with category budgets,
expenses with who paid and who shares each one, per-person balances, and
suggested ways to settle up.

**Wayora doesn't move money.** Nothing on these pages charges, transfers,
refunds or converts anything. Settlement suggestions are recommendations;
members pay each other outside Wayora (cash, UPI, bank transfer…) and can
then _record_ that a payment was made, which only changes the balances shown.
A recorded payment is the member's statement, not something Wayora verified.

### Planned costs and recorded expenses

- An expense is **paid** (it happened: it has payers and a split and counts in
  balances) or **planned** (an estimate: no payers, no split, never in
  balances). Totals always show the two separately.
- Itinerary activities are never treated as costs or as paid.
- A linked booking is never counted automatically. The owner can add it as an
  expense **once** (a partial unique index enforces this). It is added as
  **paid** — by the owner, split equally between current members unless a
  split is given — only when the booking is not a demo booking **and** a
  payment for it has `SUCCEEDED`. Otherwise (every demo booking, or an
  unconfirmed payment) it is added as **planned**, with the note “Demo
  booking: no money was charged.” for demo bookings.

### Money

- Amounts are integer **minor units** (`BIGINT` in PostgreSQL, strings of
  digits in JSON, `bigint` in code) with an ISO currency; never floating
  point. Accepted currencies: INR, USD, EUR, GBP, AED, SGD (two minor digits
  each). Expenses are positive and at most 10¹² minor units.
- Typed amounts (`1,499.50`) are parsed by string arithmetic
  (`parseMoneyInput`), percentages to basis points (`parsePercentInput`,
  `33.33` → 3333). Display uses `formatMoney` from `@wayora/ui` (Intl, exact
  decimal strings).
- **No currency conversion.** No exchange-rate provider exists. Each expense
  keeps its currency; totals, balances and suggestions are per currency; the
  budget compares only expenses in the budget's own currency, and other
  currencies are listed separately as “not converted”.

### Splits

Every paid expense stores one row per person (`plan_expense_parts`) with what
they **paid** and their **share**; Σ paid = Σ shares = amount, exactly. Payers
and participants can be different people, and several people can pay.

| Method    | Input                   | Rule                                                                                                                                                  |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `equal`   | participants            | Everyone gets ⌊amount ÷ n⌋; the leftover units (< n) go one each to participants first in id order. ₹1,000.00 ÷ 3 = 333.34 + 333.33 + 333.33.         |
| `custom`  | an amount per person    | Must add up to the amount exactly; nothing is adjusted.                                                                                               |
| `percent` | basis points per person | Must total 10,000 (100.00%). Each share is rounded down; leftover units go to the largest remainders (ties: id order) — the largest-remainder method. |

The functions (`splitEqual`, `splitByBasisPoints`) live in
`@wayora/contracts`, so the form previews exactly what the API stores; the
API recomputes everything itself. Everyone on an expense must be a current
member (people already on an expense may stay on it when it's edited after
they left). Editing replaces the whole expense, including the split, in one
transaction, and needs the `version` it was based on — nothing is adjusted
silently, and a stale edit is refused. The database checks the totals again
with deferred constraint triggers, so no write path can leave an expense
unbalanced.

### Balances

For each currency and person: `net = paid − share + sent − received`, from
paid expenses and recorded payments only (deleted expenses are gone; planned
ones never count). **Sign convention:** positive = others owe this person
(“is owed”); negative = this person owes others (“owes”). The nets in each
currency always add up to zero. Balances are computed by the API from saved
rows on every request; the browser never computes them.

### Settlement suggestions

`suggestSettlements` (deterministic greedy): repeatedly, the person who owes
most pays the person owed most (ties: id order) the smaller of the two
amounts. It uses at most n − 1 payments, and applying them brings every net
balance to exactly zero (tested). They are labelled as recommendations; the
**Record as paid outside Wayora** action opens a form to record a payment that
already happened.

### Budget permissions

| Action                               | Owner | Editor                   | Viewer                         |
| ------------------------------------ | ----- | ------------------------ | ------------------------------ |
| See budget, expenses, balances       | ✓     | ✓                        | ✓                              |
| Set, change or remove the budget     | ✓     | ✓                        | —                              |
| Add an expense                       | ✓     | ✓                        | —                              |
| Edit or delete an expense            | ✓ all | only the ones they added | —                              |
| Add the linked booking as an expense | ✓     | —                        | —                              |
| Record a payment                     | ✓     | ✓                        | only one they made or received |
| Delete a recorded payment            | ✓     | the one who recorded it  | the one who recorded it        |

Enforced by the API on every request through the Phase 19 access check
(non-members get `404`; wrong role `403`). Removal takes effect immediately.
Members see each other's display names only (no emails). Former members stay
on the expenses they were part of (shown as “former member”) so history and
balances stay correct, but can't be added to new ones.

### Budget API

| Method         | Path                                                      | Notes                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/api/v1/planner/trips/:tripId/budget`                    | Budget, progress, totals per currency, people, booking offer                                                                                                                          |
| PUT            | `/api/v1/planner/trips/:tripId/budget`                    | `{ version?, currency, totalMinor, categories[] }`; `version` required once one exists                                                                                                |
| DELETE         | `/api/v1/planner/trips/:tripId/budget?version=`           | Removes the budget only; expenses are unchanged                                                                                                                                       |
| GET            | `/api/v1/planner/trips/:tripId/expenses`                  | Filters: `category`, `status`, `payer`, `participant`, `from`, `to`, `currency`; `sort` (`date-desc`, `date-asc`, `amount-desc` — by currency, then amount); `page`, `pageSize` ≤ 100 |
| POST           | `/api/v1/planner/trips/:tripId/expenses`                  | `Idempotency-Key`; 201                                                                                                                                                                |
| POST           | `/api/v1/planner/trips/:tripId/expenses/from-booking`     | Owner; `Idempotency-Key`; optional `split`                                                                                                                                            |
| GET/PUT/DELETE | `/api/v1/planner/trips/:tripId/expenses/:expenseId`       | PUT replaces the expense and needs `version`                                                                                                                                          |
| GET            | `/api/v1/planner/trips/:tripId/balances`                  | Per-currency balances and suggestions, recorded payments                                                                                                                              |
| POST           | `/api/v1/planner/trips/:tripId/settlements`               | `Idempotency-Key`; `{ fromId, toId, amountMinor, currency, settledOn, note? }`                                                                                                        |
| DELETE         | `/api/v1/planner/trips/:tripId/settlements/:settlementId` | Deletes the record only                                                                                                                                                               |

Bodies are strict (unknown fields such as `tripId`, `createdById` or `parts`
are refused — no mass assignment). Writes need a trusted `Origin`, count
against `PLANNER_RATE_LIMIT_MAX`, run in one transaction with the plan
locked, bump the plan's revision (live updates) and add a history entry
(“Ravi added the expense “Ferry” (INR 900.00)”). Expense notes are visible
to members but never copied into the history. POST retries with the same
key return the first result (no duplicates). Limits: 500 expenses and 500
recorded payments per plan. Errors: `VALIDATION_FAILED` (with the field),
`NOT_FOUND`, `FORBIDDEN`, `PLAN_OUT_OF_DATE` (stale `version`), `CONFLICT`
(booking already added or not addable), `PLAN_LIMIT_REACHED`.

Budget changes don't notify anyone (they show live and in the history), and
no email is sent.

### Budget data model

Migration `20261029000000_plan_budget` (additive):

- `plan_budgets` (one per plan: `currency`, `total_amount_minor`, `version`)
  and `plan_category_budgets` (`(trip_id, category)` primary key).
- `plan_expenses` (`description`, `category`, `amount_minor`, `currency`,
  `spent_on`, `status`, `split_method`, `notes`, `booking_id`,
  `created_by_id`, `version`; index `(trip_id, spent_on, id)`; partial unique
  index `plan_expenses_one_per_booking`; trigger: the booking must belong to
  the plan's owner).
- `plan_expense_parts` (`(expense_id, user_id)` primary key — no duplicate
  allocations; `paid_minor`, `share_minor`, `basis_points`).
- `plan_settlements` (`from_id`, `to_id`, `amount_minor`, `currency`,
  `settled_on`, `note`, `recorded_by_id`).
- CHECKs: positive bounded amounts, ISO currency codes, a split method exactly
  when paid, parts non-negative and not both zero, basis points 1–10,000,
  payer ≠ payee. Deferred constraint triggers: a paid expense's parts add up
  to its amount on both sides; a planned one has none.
- Seven new `planner_activity_type` values.

Deleting a plan deletes its budget, expenses and recorded payments. Users on
expenses can't be deleted from under them (`RESTRICT`).

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
- **Collaboration (Phase 19):** the plan header shows the owner, member
  avatars, your role and the live-update state (in text). **Share** (owner) /
  **Members** opens the member list: roles as badges, a role selector and
  **Remove** for the owner, **Leave plan** for members, open invitations with
  **Withdraw**, and the invite form. Destructive actions confirm first.
  **History** lists changes newest first. Viewers see no edit controls
  (the API refuses their writes regardless). `/plans` lists invitations
  waiting for you with **Accept** / **Decline**; each invitation also has its
  own page, `/plans/invitations/:id`.
- **Budget (Phase 20):** the plan page shows a budget card (budget, recorded,
  remaining) linking to `/plans/:tripId/budget`: summary figures, a
  utilization meter (`role="meter"` with the value in text), planned costs,
  other currencies (not converted), a category table (bars are decorative;
  every figure is text), the expense list with filters (category, status,
  payer, sharer, dates) and sorting, balances with the sign convention
  explained, suggested payments and recorded payments. Expenses are added
  and edited in a dialog that previews each share exactly; validation moves
  focus to the field to fix; deletes confirm first; a stale edit shows a
  conflict message instead of saving. Viewers see no edit controls (they can
  record a payment they made or received).

## Configuration

| Variable                        | Default | Meaning                                        |
| ------------------------------- | ------- | ---------------------------------------------- |
| `PLANNER_RATE_LIMIT_MAX`        | 120     | Planner writes per signed-in user/minute       |
| `PLANNER_INVITE_RATE_LIMIT_MAX` | 30      | Invitations sent per signed-in user/hour (P19) |

No other variables: there is no external provider to configure, and live
updates reuse the API's existing database connection settings.

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

### Rollback (Phase 19)

`20261028000000_plan_collaboration` is additive. To remove it (members,
invitations and history are lost; plans and itineraries stay):

```sql
BEGIN;
-- The Phase 18 code doesn't know these notification types.
DELETE FROM "notifications" WHERE "type" IN ('PLAN_INVITATION', 'PLAN_INVITATION_ACCEPTED',
  'PLAN_INVITATION_DECLINED', 'PLAN_MEMBER_CHANGED', 'PLAN_UPDATED');
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "trip_invitation_id",
  DROP COLUMN IF EXISTS "planned_trip_id";
DROP TABLE IF EXISTS "planner_activities";
DROP TABLE IF EXISTS "trip_invitations";
DROP TABLE IF EXISTS "trip_members";
DROP TRIGGER IF EXISTS "planned_trips_owner_fixed_check" ON "planned_trips";
DROP FUNCTION IF EXISTS "planned_trips_owner_fixed"();
DROP FUNCTION IF EXISTS "trip_members_not_owner"();
DROP FUNCTION IF EXISTS "planner_activities_append_only"();
DROP FUNCTION IF EXISTS "planner_activities_announce"();
ALTER TABLE "itinerary_items" DROP COLUMN IF EXISTS "created_by_id",
  DROP COLUMN IF EXISTS "version";
ALTER TABLE "planned_trips" DROP COLUMN IF EXISTS "revision";
DROP TYPE IF EXISTS "planner_activity_type";
DROP TYPE IF EXISTS "trip_invitation_status";
DROP TYPE IF EXISTS "trip_member_role";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261028000000_plan_collaboration';
COMMIT;
```

PostgreSQL can't remove enum values: the five `PLAN_*` values stay in
`notification_type`, unused. Then deploy the Phase 18 API and web. Tested:
apart from those enum values, rollback leaves the Phase 18 schema, and
re-applying works.

### Rollback (Phase 20)

`20261029000000_plan_budget` is additive. To remove it (budgets, expenses and
recorded payments are lost; plans, members and history stay):

```sql
BEGIN;
-- The Phase 19 code doesn't know these history types.
DELETE FROM "planner_activities" WHERE "type" IN ('BUDGET_UPDATED', 'BUDGET_REMOVED',
  'EXPENSE_ADDED', 'EXPENSE_UPDATED', 'EXPENSE_DELETED', 'SETTLEMENT_RECORDED',
  'SETTLEMENT_DELETED');
DROP TABLE IF EXISTS "plan_settlements";
DROP TABLE IF EXISTS "plan_expense_parts";
DROP TABLE IF EXISTS "plan_expenses";
DROP TABLE IF EXISTS "plan_category_budgets";
DROP TABLE IF EXISTS "plan_budgets";
DROP FUNCTION IF EXISTS "plan_expenses_balanced"();
DROP FUNCTION IF EXISTS "plan_expense_check"(UUID);
DROP FUNCTION IF EXISTS "plan_expenses_booking_owner"();
DROP TYPE IF EXISTS "expense_split_method";
DROP TYPE IF EXISTS "expense_status";
DROP TYPE IF EXISTS "expense_category";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029000000_plan_budget';
COMMIT;
```

History entries can be deleted (only updates are refused), so the
budget entries go; the revision numbers of the remaining entries are
unchanged. The seven
`planner_activity_type` values stay (PostgreSQL can't remove enum values),
unused. Then deploy the Phase 19 API and web. Tested: apart from those enum
values, rollback leaves the Phase 19 schema, and re-applying works.

## Tests

```bash
# Unit (no services): dates across time zones, text safety, schedule warnings,
# the curated catalog and the suggestion rules
npm test -w @wayora/api -- planner-unit
# Integration (PostgreSQL; see docs/auth.md#running-the-tests)
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/planner
# Web: list, create, plan page, reordering, suggestions, dialogs
npm test -w @wayora/web -- planner
# Collaboration (Phase 19): unit, integration (PostgreSQL), web
npm test -w @wayora/api -- planner-collaboration-unit
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/planner-collaboration
npm test -w @wayora/web -- planner-collaboration
# Budget (Phase 20): split and balance rules, integration (PostgreSQL), web
npm test -w @wayora/contracts -- budget
TEST_DATABASE_URL=postgresql://…/wayora_test npm test -w @wayora/api -- integration/planner-budget
npm test -w @wayora/web -- planner-budget
```

The budget suites cover: money input parsing; equal splits with remainders
(₹1,000 ÷ 3), percentage splits (largest remainder, large amounts), custom
splits, multiple payers, payers different from participants; balances (the
sign convention, different participant sets, several currencies never
mixed, settlements); suggestions that settle everyone in at most n − 1
payments, deterministically. Against PostgreSQL: budget tracking,
over-budget, utilization, planned vs recorded, stale and invalid budgets,
removing a budget leaves expenses; every split rule and refusal (totals that
don't match, non-members, duplicates, zero or negative amounts, floats);
the database refusing unbalanced or duplicate parts directly; balances
matching the A/B example, deleted expenses not counting, settlements;
viewer, editor, owner, stranger and cross-plan permissions, removed and
former members; an edit replacing the split, stale versions, two
simultaneous edits (one wins); idempotent retries; history without notes;
filters and sorting; booking import (demo → planned, once; real paid
booking → paid). The web suite covers loading, empty, error and saved
states, setting a budget (minor units, focus on errors), the exact split
preview, validation that sends nothing, planned estimates, conflicts,
delete confirmation, balances wording, suggestions recorded only as
payments made outside Wayora, viewer controls and the plan-page card.

The collaboration suites cover: personal plans unchanged; inviting,
accepting and joining with the role; unknown, inactive, own, existing and
already-invited recipients; simultaneous duplicate invitations; declined,
withdrawn and expired invitations can't be used; only the recipient sees or
answers an invitation and only the owner sends or withdraws one;
simultaneous accepts join once; editor, viewer and stranger permissions on
every endpoint; role changes (and attempts to become owner); removal taking
effect at once, leaving, and the owner never removable; the database's
one-owner rules; the linked booking hidden from members; stale activity,
detail and reorder edits refused, two simultaneous edits → one wins, edits of
deleted activities; history (who, what, paging, members only, once per
change, retries record nothing); notifications (once, and not for minor
edits); the invitation rate limit; live updates over real LISTEN/NOTIFY to
members only, ending when access ends, `Last-Event-ID` catch-up without
repeats. The web suite covers viewer/editor/owner controls, inviting (with
the in-app wording), role changes, removal and leaving with confirmation,
invitation pages and states, notification links, conflict messages and
reloading, the history, live re-reads (ignoring repeats), the polling
fallback and its cleanup, and no stream for personal plans.

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
- Collaboration: invitations reach existing Wayora accounts only, in-app
  (no email provider exists). Inviting by email tells the owner whether an
  address has an account (and its display name) — limited by the invitation
  rate limit, and registration already reveals as much.
- No ownership transfer; the owner can't leave their own plan (they can
  delete it).
- Conflicts are refused, not merged: the second editor reloads and redoes
  their change.
- Live updates need the API's LISTEN connection; open-stream caps are per
  API instance. Without a stream the page polls every 30 s.
- Expired invitations are marked expired when next touched (no background
  sweep); they are hidden and unusable either way.
- Budget: no currency conversion (no exchange-rate provider) — each currency
  is totalled and balanced separately, and only budget-currency expenses
  count toward the budget. Six currencies are accepted.
- Wayora doesn't send, receive or verify payments between members:
  suggestions are recommendations and recorded payments are members'
  statements. There's no payment-provider integration for settling up.
- Simplified suggestions: greedy (at most n − 1 payments), not guaranteed
  to be the absolute minimum number of payments.
- No receipts or attachments, no recurring expenses, and no budget
  notifications (changes show live and in the history).
