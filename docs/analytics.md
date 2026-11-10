# Analytics and business insights (Phase 31)

Staff-only reports on how Wayora is used: searches, the booking funnel,
bookings, payments and refunds, customers, providers, promotions and
loyalty, support and reviews. Every figure is computed from Wayora's own
records. Demo bookings and payments are always kept apart from real ones.
A figure that wasn't recorded is shown as "not recorded", never as 0.

- [Architecture](#architecture)
- [Event schema](#event-schema)
- [Event catalogue](#event-catalogue)
- [Tracking rules](#tracking-rules)
- [Search events](#search-events)
- [Client events](#client-events)
- [Metric definitions](#metric-definitions)
- [Revenue methodology](#revenue-methodology)
- [Funnel](#funnel)
- [Provider metrics](#provider-metrics)
- [Timezone](#timezone)
- [Access](#access)
- [API](#api)
- [Export](#export)
- [Caching](#caching)
- [Charts](#charts)
- [Retention](#retention)
- [Privacy](#privacy)
- [Historical limitations](#historical-limitations)
- [Not built](#not-built)

## Architecture

```
 booking / payment / refund / reservation / … rows ──(trigger, same transaction)──┐
 API: sign-in/out, daily activity, offer page, booking submitted ─(best effort)───┤
 web: "offer chosen" (skipped under Do Not Track / GPC) ─(POST, best effort)──────┤
                                                                                   ▼
                                                                         analytics_events
 search requests ──────────────────────────────────────────────────────▶ search_events (Phase 15, extended)
 destination / guide page views ───────────────────────────────────────▶ content_daily_counts (Phase 29)

 AnalyticsService (apps/api/src/modules/analytics) ── reads the above + source tables
   └─ /admin/analytics/:report  ── Redis cache ── admin web app (/admin/analytics)
 worker: analytics.purge (daily) ── deletes events past retention
```

- **Separate from transactional logic.** Nothing on a booking or payment
  request reads analytics, and nothing in analytics changes a business
  record. Business events are written by database triggers on the source
  rows (one insert in the same transaction; `ON CONFLICT DO NOTHING`). The
  API writes its few events after the request, without waiting for them.
- **Event-based where it adds something, source records where they are the
  truth.** Behaviour that leaves no other record (activity, offer views,
  booking submissions) comes from events. Money and booking counts come from
  the authoritative tables (bookings, payments, refunds, redemptions,
  reservations) through indexed timestamp columns, so they always agree with
  the records and cover history from before Phase 31.
- **No warehouse or streaming platform.** Reports are bounded to at most
  366 days and use indexes. Volumes are small; a separate store would add
  operations and a second copy of the truth. Revisit when a report regularly
  takes more than about a second on production data, or when events exceed
  tens of millions of rows. Then roll up closed days into daily tables in
  the worker first.

## Event schema

`analytics_events` (migration `20261110000000_analytics`):

| Column                     | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `type`                     | e.g. `payment.succeeded` (checked format `group.name`)                                        |
| `source`                   | `SERVER` (trigger or API) or `CLIENT` (web app)                                               |
| `dedupe_key`               | Unique. The same occurrence always has the same key, so it is recorded once                   |
| `user_id`                  | The customer, where a metric needs it (active, returning). No foreign key                     |
| `entity_type`              | `booking`, `payment`, `refund`, `reservation`, `user`, …                                      |
| `entity_id`                | The record's id                                                                               |
| `category`                 | Travel category                                                                               |
| `is_demo`                  | Simulated booking or payment (from the record, never from the client); null if not applicable |
| `currency`, `amount_minor` | Money, in minor units (BigInt), with its currency (checked: no amount without currency)       |
| `search_id`                | The search session, for funnel attribution                                                    |
| `metadata`                 | A JSON object of allow-listed fields only (below)                                             |
| `occurred_at`              | When it happened (the record's own timestamp where it has one)                                |
| `recorded_at`              | When the row was written                                                                      |

Metadata by type: `payment.initiated {attempt}`, `payment.failed
{failureCode}`, `refund.* {reason}`, `reservation.* {provider,
errorCategory}`, `coupon.applied {promotionId}`, `rewards.redeemed
{points}`, `support.ticket_created {category}`, `review.submitted
{verification, subjectType}`. Nothing else: no names, emails, phone
numbers, tokens, card data, free text or request bodies.

A marker row (`analytics.tracking_started`) records when tracking began;
reports use it to say from when event-based figures are complete.

## Event catalogue

The catalogue lives in `packages/contracts/src/analytics.ts`
(`ANALYTICS_EVENT_DEFINITIONS`). A unit test checks that the migration's
triggers write exactly the trigger-recorded types.

| Event                                                                                                       | Recorded by                              | Key (once per)               |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| `user.registered`                                                                                           | trigger (users)                          | account                      |
| `user.login`, `user.logout`                                                                                 | API (auth routes)                        | session                      |
| `user.active`                                                                                               | API (session loader)                     | customer and reporting day   |
| `user.profile_completed`                                                                                    | trigger (users, travellers)              | account, first time only     |
| `search.initiated`, `search.completed`, `search.no_results`, `search.filter_applied`, `search.sort_applied` | `search_events` rows                     | request                      |
| `offer.viewed`                                                                                              | API (offer page endpoint)                | search and offer             |
| `offer.selected`                                                                                            | web app                                  | search and offer             |
| `booking.initiated`                                                                                         | API (booking route)                      | customer and Idempotency-Key |
| `booking.created`, `booking.cancelled`                                                                      | trigger (bookings)                       | booking                      |
| `reservation.confirmed`, `reservation.failed`                                                               | trigger (supplier_reservations)          | reservation                  |
| `payment.initiated`, `payment.succeeded`, `payment.failed`                                                  | trigger (payments)                       | payment attempt              |
| `refund.initiated`, `refund.completed`                                                                      | trigger (refunds)                        | refund                       |
| `coupon.applied`                                                                                            | trigger (promotion_redemptions, coupons) | redemption                   |
| `rewards.redeemed`                                                                                          | trigger (reward_redemptions → CONSUMED)  | redemption                   |
| `support.ticket_created`                                                                                    | trigger (support_tickets)                | ticket                       |
| `review.submitted`                                                                                          | trigger (reviews)                        | review                       |
| `destination.viewed`, `guide.viewed`                                                                        | `content_daily_counts` (Phase 29)        | daily total                  |

Profile completion means a name and at least one saved traveller: those are
the profile details customers can give (there is no phone or other field to
complete).

## Tracking rules

- **Authoritative events are server-side.** Everything that involves a
  booking, payment, refund, reservation, coupon, reward, ticket or review is
  written by a trigger on the record itself. The web app can't create,
  change or fake them.
- **Idempotent.** Every event has a deterministic `dedupe_key`; retries,
  replays, double clicks and several API instances record it once
  (`createMany … skipDuplicates`, `ON CONFLICT DO NOTHING`).
- **Never blocking.** API events are fire-and-forget: a failed write is
  logged and the request answers normally. Triggers add one insert to a
  transaction that is already writing the record.
- **Demo flags come from the record** (`bookings.is_demo`,
  `payments.mode`), never from the client.
- **Staff are excluded** from customer events (`user.*` only for role
  `USER`).
- **Automatic requests aren't activity**: notification polling, live-update
  streams (`…/events`) and health checks don't make a customer "active".
- **Consent**: behavioural events (offer views, "offer chosen") are not
  recorded when the browser sends Do Not Track (`DNT: 1`) or Global Privacy
  Control (`Sec-GPC: 1`); the web app doesn't even send them. Business
  records are kept regardless: they are the service, not tracking.
- **No back-filling.** Events exist from the Phase 31 release. Records from
  before then have no events and none are invented.

## Search events

Phase 15 recorded one `search_events` row per search request (category,
outcome, timing, provider calls). Phase 31 adds coarse details, so popular
routes and travel periods can be reported:

- `origin_place`, `destination_place`: catalogue place ids (airports,
  stations, cities, cab localities). Never an address or free text.
- `travel_month`: the first day of the month of travel. Never the date.
- `filter_keys`: the names of the filter fields used (never their values).
- `sort`: the sort order, only when it isn't the category's default.
- `reused`: answered from an earlier identical search's session.

Still not recorded: who searched (no account, IP or user agent), travellers,
exact dates, request bodies. A **search** is a search session (one
`search_id`): refining, paging or repeating an identical search reuses the
session, so it counts once; each request is also counted as a _request_.
Failed requests have no session and count as one search each.

## Client events

`POST /api/v1/analytics/interactions` `{ events: [{ type: "offer.selected",
serviceType, searchId, offerId }] }` (up to 10), answered `202 { recorded }`.
Sent when someone continues from an offer page to book it. The request
carries no cookie or account (`credentials: omit`), is rate limited
(`ANALYTICS_RATE_LIMIT_MAX` per minute per address), accepts only that
shape (strict schema), and is recorded only for a search that really
happened in the last two days; unknown search ids are ignored, so the
endpoint can't inflate counts for made-up searches. Nothing is recorded under
Do Not Track or GPC.

## Metric definitions

All periods are calendar days in the [reporting timezone](#timezone). "In
the period" means the named timestamp falls in `[start, end)`. Every count
comes with the same figure for the comparison period (the same number of
days immediately before), or null when it wasn't recorded then.

### Overview and customers

| Metric                             | Definition                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customers                          | Accounts with role `USER` created before the period's end (staff excluded)                                                                                         |
| New customers / registrations      | Customer accounts created in the period                                                                                                                            |
| Active customers                   | Distinct customers with `user.active`, `user.login` or `user.registered` in the period. Partly covered before tracking began                                       |
| Returning customers                | Active customers whose account was created before the period                                                                                                       |
| Retention                          | Of the customers active in the previous period, the share active again in this one. Null unless the previous period was fully covered                              |
| Customers with a confirmed booking | Distinct customers with a booking confirmed (`confirmed_at`) in the period, per mode (real, demo)                                                                  |
| Repeat rate                        | Of those, the share with two or more confirmed bookings of the same mode, ever, up to the period's end                                                             |
| Bookings per customer              | Confirmed bookings in the period ÷ customers who had one                                                                                                           |
| Loyalty tiers                      | Current tier of each customer's loyalty account, per mode (a snapshot: now, not as it was)                                                                         |
| Rewards engagement                 | Customers with points earned, or points/credit redeemed, in the period; loyalty accounts                                                                           |
| Searches                           | Distinct search sessions first or again requested in the period, plus failed requests                                                                              |
| Search → booking                   | Of the distinct search sessions requested in the period, the share with a booking (any kind) made from that search                                                 |
| Bookings created                   | Bookings created in the period, real and demo separately                                                                                                           |
| Cancelled bookings                 | Bookings with `cancelled_at` in the period                                                                                                                         |
| Supplier reservations confirmed    | Supplier reservations with `confirmed_at` in the period (real only; demo bookings contact no supplier)                                                             |
| Payment success rate               | Payment attempts created in the period that finished: succeeded (incl. later refunded) ÷ (succeeded + failed + cancelled). Pending attempts are left out. Per mode |

Customer lifetime value is not calculated: there isn't enough real booking
history to estimate it honestly.

### Search and discovery

| Metric                   | Definition                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| By category              | Searches, requests, requests with no results (`EMPTY`), failed requests                                                |
| No-results rate          | `EMPTY` requests ÷ answered requests (not `FAILED`)                                                                    |
| Search → offer viewed    | Of the searches started in the period with results, the share where an offer page was opened (or later stages reached) |
| Abandoned after results  | Of those, the share that went no further: no offer viewed, nothing booked                                              |
| Popular routes           | Category, origin, destination with at least 5 distinct searches; top 20                                                |
| Travel periods           | Months of travel with at least 5 distinct searches                                                                     |
| Filters, sorts           | Requests using each filter field; requests choosing each non-default sort                                              |
| Most viewed destinations | Destination page views (Phase 29 daily totals, UTC days), top 10                                                       |

There is no "trending" figure: a period-on-period change on a handful of
searches would be noise presented as a trend.

### Marketing

| Metric                             | Definition                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Promoted bookings                  | Distinct bookings with a promotion redeemed in the period (counted once however many promotions applied), real and demo |
| Applied                            | Promotion redemptions created in the period (the code was accepted, or the automatic promotion attached)                |
| Redeemed                           | Of those, redeemed (the booking was paid with it), real and demo                                                        |
| Released                           | Of those, released or reversed (expired, cancelled before payment)                                                      |
| Discount                           | Discount of redemptions redeemed in the period, per currency, real and demo                                             |
| Coupon applied → paid              | Coupon redemptions created in the period that were redeemed ÷ all of them                                               |
| Points earned / redeemed / expired | Points on reward transactions in the period; redeemed is net of points given back (restored)                            |
| Credit issued / used / expired     | Travel credit amounts in the period per currency; used is net of credit given back                                      |

Listed promotions: those live now (active and within their dates), plus any
other promotion used in the period, marked "not live". Expired or inactive
promotions without use in the period are left out. No incremental revenue
is claimed: these show use, not what would have happened without them.

### Support and reviews

| Metric                                | Definition                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tickets opened / resolved / escalated | `created_at` / `resolved_at` / `escalated_at` in the period                                                                                                                                                                   |
| Open now                              | Tickets not resolved or closed (now)                                                                                                                                                                                          |
| First response                        | For tickets opened in the period: time to the first **public staff reply** (`first_response_at`, set only by an agent's reply; automatic acknowledgements and internal notes never set it). Median and average, calendar time |
| Resolution                            | For tickets resolved in the period: `resolved_at − created_at`. Median and average                                                                                                                                            |
| By category, workload                 | Tickets opened per category; open assigned tickets per staff member (display name)                                                                                                                                            |
| Reviews submitted                     | Reviews created in the period, by verification (verified booking, demo booking, unverified)                                                                                                                                   |
| Average published rating              | Overall rating of reviews **published** in the period and still published. Pending, rejected, flagged and removed never count                                                                                                 |
| Pending, flagged, open reports        | Now                                                                                                                                                                                                                           |

## Revenue methodology

Administrators only (`admin.analytics.financial`). Per mode (real = live
payments; demo = simulated) and per currency, never converted or summed
across currencies. All amounts are integer minor units (BigInt), as strings
on the wire.

| Figure                | Definition                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Gross booking value   | Sum of `bookings.total_amount_minor` (the offer price as booked, before discounts) of bookings **confirmed** in the period         |
| Confirmed bookings    | Those bookings with a fixed price. Bookings with a fare range (cabs) have no fixed total: counted separately, not in booking value |
| Promotion discount    | Redeemed automatic-promotion discounts of the bookings confirmed in the period                                                     |
| Coupon discount       | Redeemed coupon discounts of the bookings confirmed in the period                                                                  |
| Points redeemed       | Value of points used by the bookings confirmed in the period (consumed redemptions)                                                |
| Travel credit used    | Credit used by the bookings confirmed in the period (consumed redemptions)                                                         |
| Payments succeeded    | Payments that succeeded (`completed_at`) in the period, including ones later refunded                                              |
| Refunds completed     | Refunds that succeeded (`completed_at`) in the period                                                                              |
| Refunds pending       | Refunds created in the period and not succeeded (required, requested, pending, unknown). **Not deducted**                          |
| Net collected         | Payments succeeded − refunds completed                                                                                             |
| Average booking value | Gross booking value ÷ confirmed bookings with a fixed price, rounded half up in minor units                                        |

The rules behind this:

- **A booking amount is not revenue**, and **booking value is not profit**:
  gross booking value is labelled as such and shown next to money actually
  received.
- **A demo payment is not money**: demo figures sit in their own section
  labelled "Demo · simulated, not money" and are never added to real ones.
- **Pending is not success**: only succeeded payments and refunds count.
- **A refund request is not a completed refund**: pending refunds are shown
  apart and not deducted.
- **Travel credit is not a cash refund**, and **loyalty points are not an
  expense**: both are shown as discounts at their value at redemption.
- **Provider cost and commission** aren't recorded anywhere, so margin and
  profit are "not available" rather than estimated.
- Discounts and rewards use the same basis as booking value (bookings
  confirmed in the period), so booking value − discounts − points − credit
  is what those bookings were paid. Payments and refunds use their own
  completion time, so the two halves can differ at the period's edges.

## Funnel

The unit is a **search session**, and the cohort is the searches whose
first request falls in the period. Each is followed, up to now, to the
furthest stage it reached:

1. Search started (every search, including failed ones)
2. Results returned (a successful or partial answer)
3. Offer viewed (`offer.viewed`)
4. Offer chosen (`offer.selected`, from the web app)
5. Booking submitted (`booking.initiated`)
6. Booking created (a booking with this `search_id`)
7. Payment completed (a succeeded payment on that booking)
8. Supplier confirmed (a confirmed supplier reservation)

- **Attribution**: a booking belongs to the search whose session its offer
  came from (`bookings.search_id`, set by the server). A search counts once
  per stage, however many offers or bookings it led to.
- **Later stages imply earlier ones** for stages 1–6: a booking means an
  offer was viewed and chosen even if no event says so (the visitor declined
  tracking, or it happened before tracking began). Each stage also shows how
  many were **recorded directly** at that stage, so the inference is visible.
  Counts therefore never grow down the funnel.
- **Booking, payment and supplier stages stay distinct** and are measured
  against bookings created, split real/demo. Demo bookings are paid with
  simulated payments and never reach a supplier; real supplier bookings are
  paid to the supplier, not through Wayora, so "payment completed" for real
  bookings only counts live payments taken by Wayora.
- **Abandonment**: drop-off between stages; for search, "abandoned after
  results".
- **Recent searches** can still convert: a period that includes today says
  so.
- Device category is **not** collected (no user agent is stored), so there
  is no device breakdown.

## Provider metrics

From `search_events.providers` (one entry per provider call):

- **Calls** and outcomes (`success`, `empty`, `timeout`, `unavailable`,
  `error`), with the previous period's calls.
- **Answer rate** = (success + empty) ÷ calls. This is not uptime: a
  provider that wasn't called has no figure, and no availability is
  inferred from configuration.
- **Timeout rate**, **average** and **95th percentile** response time.
- **Kind**: live, demo or "no longer registered", from the provider
  registry. Demo providers return generated results; their figures say
  nothing about a real supplier. Compare like with like.

Supplier reservations started in the period, per provider, by their state
now; success rate = confirmed ÷ (confirmed + failed), settled outcomes only;
error categories as recorded. Each attempt's request id is in the booking's
reservation history (admin booking page) to correlate with logs.
Credentials and supplier payloads are never stored or shown.

## Timezone

`ANALYTICS_TIMEZONE` (API, default `Asia/Kolkata`; any IANA zone, validated
at start-up) decides what "today", a day, a week and a month are.

- A period is whole local days: `[local midnight of from, local midnight
after to)`. Midnights are worked out per day, so a 23- or 25-hour
  daylight-saving day is still exactly one day (tested with New York).
  India has no daylight saving.
- Presets: today, last 7 days, last 30 days (each ending today), this month
  (to today), last month, custom (`from`–`to` inclusive, at most 366 days,
  not in the future, real dates). A period that includes today ends now and
  is marked "to date".
- Comparison: the same number of days immediately before.
- Buckets: day, week (Monday to Sunday, ISO) or month; by default day up to
  62 days, week up to 186, then month. Partial first and last buckets are
  clipped to the period, never padded with days outside it.
- All widgets on a page use the same resolved period (one request).
- Exception: destination page views are Phase 29 daily totals kept per UTC
  day, so at the period's edges they can be off by the 5½-hour offset (noted
  on the page).

## Access

| Permission                  | user | support | admin | What it allows                                                                            |
| --------------------------- | ---- | ------- | ----- | ----------------------------------------------------------------------------------------- |
| `admin.analytics.read`      | –    | ✓       | ✓     | Every report except revenue; counts, rates, funnel, search, providers, marketing, support |
| `admin.analytics.financial` | –    | –       | ✓     | Revenue report, money in the overview                                                     |
| `admin.analytics.export`    | –    | –       | ✓     | CSV downloads (audited)                                                                   |

There is no separate finance or operations role: administrators hold the
financial permissions, and support staff (operations) read everything
except money. Support figures also need `admin.support.read`, review
figures `admin.reviews.read` (both roles have them today).

Enforcement is on the server, from the session's role, before validation
(`requirePermission`); a refused request is `403` and audited as
`admin.access_denied`. The server leaves out what a role may not see (money
is `null` for support staff), so hiding it in the web app is only
presentation. No analytics endpoint is public except the client events
endpoint, which only accepts "offer chosen".

User-level data never leaves the database: reports are aggregates. The
smallest groups shown are route pairs and travel months with at least 5
searches, and staff names in support workload (as on the support pages).

## API

```
GET /api/v1/admin/analytics/:report?preset=&from=&to=&granularity=
GET /api/v1/admin/analytics/:report/export?…            (CSV)
POST /api/v1/analytics/interactions                     (client events)
```

`report` is `overview`, `revenue`, `funnel`, `search`, `customers`,
`providers`, `marketing` or `support`. Responses are `no-store` and follow
the schemas in `packages/contracts/src/analytics.ts`. Each starts with the
resolved `period`, `previous` period, `timezone`, `granularity` and
`generatedAt`, and carries `notes` explaining coverage and definitions.
Invalid queries are `400 VALIDATION_FAILED`.

## Export

CSV only (no spreadsheet library exists in the project and none was added;
PDF isn't offered). `GET …/:report/export` needs `admin.analytics.read` and
`admin.analytics.export` (and `admin.analytics.financial` for revenue).

- The same computed report as the page (same cache entry), so the file and
  the screen agree.
- One long table: `section, metric, dimension, mode, currency, value,
previous`, after a few lines naming the report, period, comparison period,
  timezone and generation time. `mode` is `real` or `demo`; demo rows are
  simulated. Amounts are minor units.
- Bounded to 5,000 rows. No customer names, emails or ids.
- Cells a spreadsheet would treat as formulas (`= + - @`, tab, carriage
  return) are prefixed with `'`; plain numbers stay numbers.
- Every export is audited: `admin.analytics_exported`, with the report,
  preset, dates, granularity, timezone and role (no figures).

Scheduled reports aren't offered: there is no email provider configured
([notifications.md](notifications.md)), so a scheduled report would have
nowhere to go.

## Caching

Reports are cached in Redis (`analytics:v1:<report>:<scope>:<timezone|from|to|granularity>`;
per-process memory without Redis):

- 60 seconds for a period that includes today, 15 minutes for one that has
  ended. Invalidation is by expiry only; each report shows when it was
  generated.
- The key includes the viewer's scope (financial / support / reviews), so a
  report computed for an administrator is never served to support staff.
- Authorization runs before the cache is read.
- A Redis failure is a cache miss, never an error.
- Late records (a refund completing today for last month's payment) appear
  under the day they happened; an ended period can therefore change for up
  to 15 minutes after such a record, then shows it.
- Bump `CACHE_VERSION` when a report's shape or calculation changes.

## Charts

No chart library existed, so the dashboard has small SVG charts
(`apps/web/src/features/admin/charts.tsx`) instead of adding one:

- Line charts for trends, with the previous period as a dashed grey line
  (optional), bar lists for categories, a donut only for parts of one whole
  (tiers, review verification), a funnel, and tables.
- Value axes start at zero with round ticks; money axes in compact currency.
- Gaps where data wasn't recorded (null), never a zero line.
- Legends name the series (never colour alone); a tooltip on hover and on
  keyboard focus (arrow keys, Home, End); "Show data" opens the numbers as a
  table.
- Four categorical colours in fixed order (brand blue, orange, aqua, amber),
  checked for colour-vision deficiency; the lighter two rely on the legend
  and table.

## Retention

The worker deletes analytics events older than `ANALYTICS_RETENTION_DAYS`
(default 400, minimum 90) once a day (`analytics.purge`), in batches, and
moves the tracking marker to the cutoff so reports know events are complete
only from there. Source records (bookings, payments, users, …) and
`search_events` are not touched by it.

## Privacy

- No passwords, tokens, payment credentials, names, emails, phone numbers,
  IP addresses, user agents, free text or request bodies in any event.
- `user_id` only on customer events where a metric needs it; behavioural
  events (offer views, "offer chosen", searches) carry none.
- Do Not Track and GPC switch off behavioural events, in the browser and on
  the server.
- Reports are aggregates; small groups are suppressed (routes, months).
- Event rows have no foreign key to users, and nothing in them identifies a
  person on its own; they are deleted after the retention period.

## Historical limitations

- Event-based figures (active, returning, retention, offer views, "offer
  chosen", booking submissions, profile completion, logins) start at the
  Phase 31 release. Before that they are "not recorded"; the funnel infers
  earlier stages only from later, real ones.
- Search routes, travel months, filters and sorts start at Phase 31. Search
  counts start at Phase 15.
- Bookings, payments, refunds, redemptions, reservations, tickets and
  reviews are complete records, so those figures cover all history.
- Today every booking and payment is a demo: there is no real revenue, and
  the reports say so instead of showing zeros as if they were results.
- "Offer chosen" depends on the browser: blocked scripts, Do Not Track and
  GPC mean it undercounts (shown as "recorded at this stage").

## Not built

- A finance or operations role (administrators cover finance; support
  staff cover operations), scheduled or emailed reports, Excel or PDF export.
- Device breakdowns (no user agent is collected), customer lifetime value,
  incremental-revenue attribution, "trending" labels.
- Daily roll-up tables: not needed at current volumes (see
  [Architecture](#architecture) for when to add them).
