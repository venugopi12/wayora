# Architecture

## Overview

```text
                ┌──────────────────────┐
  Browser ───▶  │  apps/web (Vite SPA) │  React Router · TanStack Query · Motion
                └──────────┬───────────┘
                           │ HTTPS JSON  /api/v1/*   (contracts validated both sides)
                ┌──────────▼───────────┐
                │  apps/api (Express)  │  modular monolith
                │  system · catalog ·  │
                │  (future modules)    │
                └───┬─────────────┬────┘
        essential   │             │ optional (cache, rate limits, enqueue)
           ┌────────▼───┐   ┌─────▼──────┐
           │ PostgreSQL │   │   Redis    │◀────┐
           └────────▲───┘   └────────────┘     │ BullMQ queues
                    │                     ┌────┴────────────┐
                    └─────────────────────│ apps/worker     │
                      (from later phases) │ (BullMQ Worker) │
                                          └─────────────────┘
```

| Workspace            | Depends on                             | Never depends on      |
| -------------------- | -------------------------------------- | --------------------- |
| `packages/contracts` | `zod`                                  | any app               |
| `packages/ui`        | nothing at runtime                     | any app               |
| `packages/config`    | nothing                                | anything              |
| `database`           | Prisma                                 | any app               |
| `apps/api`           | contracts, database                    | web, worker           |
| `apps/worker`        | contracts (database from later phases) | web, api              |
| `apps/web`           | contracts, ui                          | api, database, worker |

The web app never imports server code. It shares only Zod contracts, which hold no
secrets or server logic.

## Why a modular monolith

One deployable API keeps transactions, debugging and deploys simple while the
team and traffic are small. Domain boundaries are enforced in code (folders,
explicit service interfaces, contracts) so a module can be extracted into its own
service later, if scale or team structure demands it, without a rewrite.

### Module rules

1. A module lives in `apps/api/src/modules/<domain>/` and owns its routes,
   service logic and (later) its repository and tables.
2. Routes do HTTP only: validate input with contracts, call the service, send the envelope.
3. Services are framework-agnostic and receive dependencies via constructor or factory,
   so tests can pass fakes.
4. Modules call each other only through an exported service function or interface,
   never by importing another module's internals or querying its tables.
5. Cross-module side effects (send a confirmation after payment) go through worker
   jobs, not synchronous chains.

### Planned module boundaries

| Module        | Owns                                                                                                                                                                    | Notes                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| identity      | `users`, `travellers`, `sessions`                                                                                                                                       | Built (Phase 8): `modules/auth`, `modules/users`                                           |
| flights       | flight search cache, fare rules                                                                                                                                         | Provider adapters behind a `FlightProvider` interface                                      |
| hotels        | hotel content, rate snapshots                                                                                                                                           | `HotelProvider` interface                                                                  |
| trains        | train availability, PNR status                                                                                                                                          | `RailProvider` interface                                                                   |
| buses         | operators, seat layouts                                                                                                                                                 | `BusProvider` interface                                                                    |
| metro         | city ticket products                                                                                                                                                    | Per-city adapters                                                                          |
| cabs          | quotes, rides                                                                                                                                                           | Quote → book → track                                                                       |
| holidays      | packages, itineraries                                                                                                                                                   | Composes other modules' services                                                           |
| bookings      | `bookings`, `booking_travellers`, `booking_status_events`                                                                                                               | Built (Phase 12, demo only): `modules/bookings`                                            |
| orders        | `orders`, `booking_items`, `idempotency_keys`                                                                                                                           | The only writer of order state                                                             |
| notifications | `notifications`, `notification_deliveries`, `notification_preferences`                                                                                                  | Built (Phase 14): `modules/notifications` (API), `notifications/` (worker)                 |
| payments      | `payments`, `payment_status_events`, `webhook_events`                                                                                                                   | Built (Phase 13, demo provider): `modules/payments`; never sees card data                  |
| planner       | `planned_trips`, `itinerary_items`, `trip_members`, `trip_invitations`, `planner_activities`, `plan_budgets`, `plan_expenses`, `plan_expense_parts`, `plan_settlements` | Built (Phases 18–20): `modules/planner`; plans only, never creates bookings or moves money |
| notifications | templates, delivery log                                                                                                                                                 | Executed by the worker                                                                     |

Every travel vertical produces `Booking` + `BookingItem` rows through the orders
module, so one order can combine a flight, a hotel and a cab, and payment happens once.
Phase 12 demo bookings have no order (`order_id` is null) and no items; see
[bookings.md](bookings.md).

### Adding a module

1. Add request/response schemas to `packages/contracts/src/<domain>.ts` and export them.
2. Create `apps/api/src/modules/<domain>/<domain>.routes.ts` and `<domain>.service.ts`.
3. Mount the router in `apps/api/src/routes/v1.ts`.
4. Add tables to `database/schema.prisma` and run `npm run db:migrate` (see below).
5. Add tests next to the existing ones in `apps/api/test/`.
6. In the web app, add `src/services/<domain>.ts`, `src/features/<domain>/`, and a
   lazy route in `src/app/routes.tsx`.

## API request pipeline

```text
requestId → pino-http access log → helmet → CORS → JSON body (100 kB)
→ rate limit (/api, health exempt) → /api/v1 router → 404 handler → error handler
```

`createApp()` builds the app from injected dependencies (env, logger, health checks,
rate-limit store) and opens no connections, which is what makes the HTTP tests
fast and hermetic. `server.ts` owns connections, listening and graceful shutdown.

### Dependencies: essential vs optional

| Dependency | API           | Worker        | When down                                                                                                                                                                                       |
| ---------- | ------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | **essential** | (later)       | Readiness 503; data endpoints fail with errors                                                                                                                                                  |
| Redis      | optional      | **essential** | API: readiness `degraded`, rate limiting falls back to memory, **search answers 503** (sessions live in Redis; no fallback). Worker: reconnects and logs, processes nothing until Redis returns |

The API starts even if PostgreSQL is down at boot (liveness stays 200, readiness 503) so orchestrators can restart dependencies independently. Redis commands fail
fast (no offline queue) so a Redis outage never stalls HTTP requests.

### Graceful shutdown

On `SIGTERM`/`SIGINT`:

- **API:** stop accepting connections, let in-flight requests finish, close idle
  keep-alive sockets, disconnect Prisma and Redis, exit 0. Forced exit 1 after
  `SHUTDOWN_TIMEOUT_MS`.
- **Worker:** `worker.close()` stops fetching new jobs and waits for active ones,
  then exits. Forced exit after `SHUTDOWN_TIMEOUT_MS`. Interrupted jobs are retried
  by BullMQ (stalled-job detection), so handlers must be idempotent.

## Worker

- One queue per concern (`wayora-system` today). Queue and job names, and payload
  schemas, live in `packages/contracts/src/jobs.ts`.
- Payloads carry IDs and non-sensitive metadata only. Schemas are `.strict()` so
  extra fields (an email, a token) are rejected rather than silently enqueued.
- Invalid payloads and unknown job names throw `UnrecoverableError`, so they fail
  once instead of burning retries.
- Completed jobs are kept 24 h (max 1000), failed jobs 7 days.
- Add a job: define its schema and name in contracts, write a pure handler in
  `apps/worker/src/jobs/`, register it in `processor.ts`, add tests.

While running, the worker also writes a liveness heartbeat to Redis
(`wayora:worker:heartbeat`, every 15 s, 60 s expiry), which the admin health
page reads so "worker running" isn't confused with "Redis reachable"
([admin.md](admin.md#platform-health)).

Jobs today: `system.heartbeat`, and `notifications.dispatch` (Phase 14), a
BullMQ job scheduler that works through the notification email outbox in
PostgreSQL (the worker has database access for it; see
[notifications.md](notifications.md#delivery)). Payment reconciliation, booking
expiry and travel reminders run in the API process (`server.ts`) because they
use the API's services. Planned: webhook processing in the worker, booking
status polling with providers.

## Database

PostgreSQL 16 via Prisma 7 (TypeScript client with the `pg` driver adapter; no
native query engine at runtime).

### Phase 1 tables

| Table              | Purpose                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `users`            | Account holders; `password_hash` (Argon2id) added in Phase 8                             |
| `travellers`       | People who travel; may differ from the account holder                                    |
| `orders`           | Customer purchase, unit of payment; human reference like `WY-7KQ2-M9XD`                  |
| `bookings`         | One supplier reservation per order and category; unique `(provider, provider_reference)` |
| `booking_items`    | Priced lines (seat, room-night, fare component)                                          |
| `idempotency_keys` | Stored outcomes of mutating requests, unique `(scope, key)`                              |
| `webhook_events`   | Inbound provider/PSP webhooks, de-duplicated on `(provider, external_id)`                |
| `audit_logs`       | Append-only record of security- and money-relevant actions                               |

Phase 8 added `sessions` (hashed session tokens with expiry and revocation); see
[auth.md](auth.md). Phase 12 gave `bookings` its first writer (demo bookings, owned
by a user, with an immutable offer snapshot) and added `booking_travellers` and
`booking_status_events`; see [bookings.md](bookings.md#database). Phase 13 added
`payments` (one row per attempt) and `payment_status_events`, gave
`webhook_events` its first writer (provider-event de-duplication), and added a
payment mode and due time to bookings; see [payments.md](payments.md#database).
Phase 14 added `notifications`, the `notification_deliveries` outbox and
`notification_preferences`; see [notifications.md](notifications.md#database).
Phase 15 added `users.role` (with a trigger that audits every change) and
`search_events` (search analytics without personal data), plus indexes for
the admin views; see [admin.md](admin.md#database). Phase 17 added the
append-only `trip_events` timeline (filled by triggers on the booking and
payment histories, and by the API), `trip_statuses` and `trip_disruptions`;
new timeline rows are announced with `pg_notify` and streamed to browsers over
Server-Sent Events; see [trips.md](trips.md). Phase 18 added the trip planner:
`planned_trips` and `itinerary_items` (date-only days, gap-free positions under
a deferrable unique constraint, an optional link to the owner's confirmed
booking); see [planner.md](planner.md#data-model). Phase 19 made plans
collaborative: `trip_members`, `trip_invitations` and the append-only
`planner_activities` history (announced with `pg_notify` and streamed to
members over Server-Sent Events through the same signal hub as trip
tracking, now in `services/signal-hub.ts`); see
[planner.md](planner.md#collaboration). Phase 20 added plan budgets and shared
expenses: `plan_budgets`, `plan_category_budgets`, `plan_expenses`,
`plan_expense_parts` (what each person paid and owes, in integer minor
units, balanced by deferred constraint triggers) and `plan_settlements`
(payments members record as made outside Wayora); balances and settlement
suggestions are computed by the API from those rows, per currency, with no
conversion. See [planner.md](planner.md#budget-and-expenses). Phase 21 added the travel assistant
(`modules/assistant`): a small server-side provider interface (the
rule-based demo, an Anthropic Messages API adapter, or off), context built
from authorized plan data only, validated structured replies, and a fixed set
of confirmed apply actions that go through the planner and budget services;
`assistant_conversations`, `assistant_messages`, `assistant_requests` and
`assistant_actions` hold what users saw, provider outcomes and applied
proposals. See [assistant.md](assistant.md). Phase 22 prepared search for
real suppliers without integrating one: a supplier toolkit in
`modules/providers` (`http.ts`, `credentials.ts`, `normalize.ts`, and
`live/index.ts`, where adapters are registered; empty today), optional
supplier-only result fields (flight fare and baggage, hotel cancellation
policy), per-call provider logs with attempts, provider health in the admin
dashboard, and supplier offers refused at checkout. See
[providers.md](providers.md). Phase 23 completed the booking lifecycle: a
supplier reservation per non-demo booking (`supplier_reservations`, with an
append-only history), tickets and vouchers only as suppliers issue them
(`travel_documents`), refunds as their own lifecycle (`refunds`), an adapter
boundary for supplier reservations (`providers/reservations.ts`), recovery of
unknown outcomes in the API's maintenance timers, and two audited admin
actions. No real supplier implements reservations; see
[bookings.md](bookings.md#supplier-reservations-phase-23).

### Conventions

- **IDs:** UUIDv7 (`@default(uuid(7))`, native `uuid`). Time-ordered, so B-tree
  inserts stay local, and they're safe to expose.
- **Timestamps:** `timestamptz(3)`, written in UTC. The Compose database runs with `TZ=UTC`.
- **Money:** `BIGINT` minor units (`*_amount_minor`) plus `CHAR(3)` currency. CHECK
  constraints enforce non-negative amounts and ISO-4217-shaped codes. Arithmetic
  uses `bigint`. Never `float`.
- **Enums:** explicit Postgres enums for every status.
- **Naming:** snake_case tables and columns via `@@map` / `@map`; PascalCase models.
- **Integrity in the database, not only in code:** FKs with deliberate `onDelete`
  (orders `RESTRICT` user deletion; bookings cascade from orders), CHECK
  constraints, and a trigger that makes `audit_logs` append-only.
- **No card data, ever.** Payment details stay with the PSP; we store PSP references.
- **No identity documents yet.** Passport/ID numbers need field-level encryption and
  a retention policy before they get a column.

### Changing the schema

1. Edit `database/schema.prisma`.
2. `npm run db:migrate -- --name <short_description>` creates
   `database/migrations/<timestamp>_<name>/migration.sql` and applies it locally.
3. Review the SQL. Prisma cannot express CHECK constraints, partial indexes or
   triggers: add those by hand at the end of the generated file (see the init
   migration for the pattern), or create an empty migration with
   `npm run db:migrate -- --create-only --name <name>` and write SQL.
4. Commit schema and migration together. Never edit a migration that has been applied
   anywhere shared; add a new one.
5. Deploy with `npm run db:migrate:deploy` before rolling out code that needs it.

Zero-downtime rules for later phases:

- **Expand, then contract.** Add the new column (nullable or with a default), deploy
  code that writes both, backfill in batches, switch reads, then drop the old column
  in a later release.
- Create indexes on large tables with `CREATE INDEX CONCURRENTLY` in a create-only
  migration (one statement per migration, since it cannot run in a transaction).
- Never rename a column or table in place on a live system.
- Adding an enum value is additive and safe; removing one needs a data migration first.

> The init migration was written to match Prisma's generated SQL and verified
> against PostgreSQL 16 (all tables, indexes, FKs, CHECK constraints and the
> audit trigger). On first `npm run db:migrate`, Prisma confirms the schema and
> history agree. If it reports drift, see "Unfinished work" in the Phase 1 report.

## Web app

```text
src/
├── app/         App providers (QueryClient, Motion, Router) and the route table
├── routes/      Route components: Home, NotFound, RouteErrorBoundary
├── components/  Layouts (RootLayout, MarketingLayout, ContentPage), header, footer,
│                route handles + breadcrumbs, page-level feedback, GlobalErrorBoundary
├── features/    Feature folders: home (hero, travel selector, moods, destinations,
│                experience, closing CTA, media manifest), catalog (API categories), system (status),
│                discover (destination discovery: sample data, search, pages),
│                navigation (header, mega menu, search, drawer),
│                search (search and results pages for the seven services, Phases 9–10),
│                offers (offer detail pages, Phase 10),
│                info (about, help, legal drafts),
│                auth (session provider, guards, sign-in/registration),
│                account (profile, saved travellers),
│                bookings (demo checkout, confirmation, My trips, Phase 12;
│                  demo payment review and status, Phase 13),
│                notifications (header bell, panel, /notifications, Phase 14),
│                preferences (display currency),
│                design-system (dev-only showcase)
├── services/    API calls per domain, built on the shared api client
├── lib/         env, api-client, query-client
├── hooks/       Shared hooks
├── styles/      Tailwind entry + base layer
└── types/       Ambient types (import.meta.env)
```

- **Data:** components call hooks (`useCategories`), hooks call `services/*`, and
  services call `lib/api-client`, which validates every response against its contract.
  Components never call `fetch`.
- **Errors:** `GlobalErrorBoundary` wraps the providers, the router's `errorElement`
  handles route errors and 404s, and query errors render inline `ErrorState`s with
  a retry. The catalog falls back to the contract's bundled list when the API is
  unreachable and says so.
- **Design system:** tokens, brand assets and shared components live in
  `packages/ui` (source-consumed internal package). App code composes them and
  never uses raw hex values. See [design-system.md](design-system.md).
- **Motion:** one orchestrated moment (the hero route drawing in) plus small
  entrances and responsive feedback. `MotionConfig reducedMotion="user"` and a CSS media query honour
  reduced-motion settings.
- **Accessibility:** skip link, labelled navigation, visible focus rings, labelled
  inputs with `aria-invalid` / `aria-describedby`, `role="alert"` and `role="status"`
  for async feedback, semantic headings.
- **Fonts:** Plus Jakarta Sans, self-hosted from npm
  (`@fontsource-variable/plus-jakarta-sans`), so there are no third-party font requests.
  A metric-matched local fallback (`Plus Jakarta Sans Fallback` in
  `packages/ui/src/styles/base.css`) keeps text from rewrapping when the font
  swaps in.
- **Routes:** `/` (cinematic homepage, header overlay), `/status` (API readiness), `/discover` (filters in the URL: `?q`, `?mood`, `?region`; old `?destination=` links redirect), `/discover/:slug` (destination pages), `/about`, `/help` (Help Center: `/help?q=`, `/help/topics/:category`, `/help/articles/:slug`, see [support.md](support.md#help-center)), `/legal/privacy` and `/legal/terms` (draft placeholders), `/login` and `/register` (auth layout; `/sign-in` redirects), `/profile` and `/profile/travellers` (signed in only), one route per travel service (`/flights` … `/holidays`, search and results pages since Phases 9–10, see [search.md](search.md); `?to=<destination>` prefills the destination), `/offers/:serviceType/:resultId` (offer details), `/book/:serviceType/:resultId` (demo checkout), `/trips`, `/trips/:reference` and `/trips/:reference/confirmation` (demo bookings, signed in only, see [bookings.md](bookings.md)), `/trips/:reference/pay` and `/trips/:reference/payments/:paymentId` (demo payments, see [payments.md](payments.md)), `/notifications` (see [notifications.md](notifications.md)), `/plans`, `/plans/new`, `/plans/:tripId`, `/plans/:tripId/budget` and `/plans/invitations/:invitationId` (trip planner, plan budget and expenses, and plan invitations, signed in only, see [planner.md](planner.md)), `/assistant` and `/assistant/:conversationId` (travel assistant, signed in only, see [assistant.md](assistant.md)), `/rewards` (loyalty points, tiers and travel credit, signed in only, see [rewards.md](rewards.md)), `/promotions` (running offers and coupons, see [promotions.md](promotions.md)), `/support`, `/support/new` and `/support/:reference` (support requests, signed in only, see [support.md](support.md)), `/admin…` (staff-only dashboard in its own layout, see [admin.md](admin.md)), dev-only `/design-system`, and a not-found fallback. Layouts, route handles, containers, breadcrumbs and the footer: see [layouts.md](layouts.md).
- **Code splitting:** the homepage, not-found page and error boundary ship in the
  main bundle. `/status`, `/discover`, `/discover/:slug`, `/sign-in`, the info
  and legal pages and the seven service pages load on first visit through React
  Router `lazy` (the seven search pages share one chunk, the info pages another; Discover and destination pages share
  another, which also carries the destinations' long-form copy, so the homepage
  and header search only bundle the light destination summaries). While a lazy page loads, the router's hydration fallback renders
  the header with the brand loader in `<main>`
  (`<MarketingLayout footer={false}><PageLoader /></MarketingLayout>`); the footer appears
  with the page, so nothing visible jumps when the chunk arrives.
- **Dev-only routes:** `/design-system` exists only in development builds (see design-system.md).
