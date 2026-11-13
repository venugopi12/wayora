# Wayora

Wayora is a travel platform for flights, hotels, trains, buses, metro, cabs and
holiday packages. This repository holds the platform foundation, design system,
navigation, cinematic homepage, shared UI and motion library, destination
discovery, the global footer and layout system (Phases 1–7), accounts (Phase 8),
demo search, results and offers for all seven categories (Phases 9–11), demo
bookings with My trips (Phase 12), a payment lifecycle with a simulated demo
payment provider (Phase 13), and in-app notifications with an email outbox
(Phase 14; no email provider is configured, so no email is sent). Search and Discover run on small, labelled sample
datasets. Bookings are **demo bookings** and payments are **demo payments**: no
supplier reservation, ticket or real charge is ever made.

| Workspace            | What it is                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web`           | React 19 + Vite 8 + Tailwind 4 web app (React Router, TanStack Query, Motion)                    |
| `apps/api`           | Express 5 REST API, modular monolith under `/api/v1`                                             |
| `apps/worker`        | BullMQ background worker                                                                         |
| `packages/contracts` | Zod request/response and job contracts shared by all apps                                        |
| `packages/ui`        | Design system: tokens, brand assets, accessible React components ([docs](docs/design-system.md)) |
| `packages/config`    | Shared TypeScript presets                                                                        |
| `database`           | Prisma 7 schema, migrations, seed and client (PostgreSQL)                                        |
| `infra/docker`       | Docker Compose for local PostgreSQL 16 and Redis 7                                               |

## Quick start

Requires **Node.js ≥ 22.12**, **npm ≥ 10** and **Docker** (for PostgreSQL and Redis).

```bash
npm install            # installs every workspace and generates the Prisma client
npm run setup          # creates .env files from the .env.example files
npm run infra:up       # starts PostgreSQL + Redis and waits until healthy
npm run db:migrate     # applies migrations
npm run db:seed        # optional: one fictional dev user
npm run dev            # API :4000, worker, web :5173
```

Open http://localhost:5173 for the homepage (API readiness is at /status). The design-system showcase is at
http://localhost:5173/design-system (development only). In another terminal, `npm run job:example` sends a
job through Redis to the worker and prints the result.

Full instructions and troubleshooting: [docs/SETUP.md](docs/SETUP.md).

## Scripts

| Script                                       | Purpose                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run setup`                              | Copy every `.env.example` to `.env` (never overwrites)                                            |
| `npm run dev`                                | Build shared packages, then run API, worker and web                                               |
| `npm run dev:api` / `dev:worker` / `dev:web` | Run one app in watch mode                                                                         |
| `npm run build`                              | Build packages, API, worker and web for production                                                |
| `npm run start:api` / `start:worker`         | Run the built API / worker                                                                        |
| `npm run lint` / `lint:fix`                  | ESLint across the monorepo                                                                        |
| `npm run format` / `format:check`            | Prettier                                                                                          |
| `npm run typecheck`                          | Strict TypeScript in every workspace                                                              |
| `npm test`                                   | Vitest in every workspace (no external services needed)                                           |
| `npm run check`                              | lint + format check + typecheck + tests (also run by CI, `.github/workflows/ci.yml`)              |
| `npm run test:e2e -w @wayora/web`            | End-to-end journey in Chromium against a running build ([testing.md](docs/testing.md#end-to-end)) |
| `npm run infra:up` / `infra:down`            | Start / stop PostgreSQL and Redis                                                                 |
| `npm run infra:reset`                        | Stop and **delete** local database and Redis volumes                                              |
| `npm run infra:logs` / `infra:ps`            | Follow logs / list containers                                                                     |
| `npm run db:migrate`                         | Create/apply migrations in development (`prisma migrate dev`)                                     |
| `npm run db:migrate:deploy`                  | Apply committed migrations (CI / production)                                                      |
| `npm run db:migrate:check`                   | Fail (exit 2) if the migrated database differs from `schema.prisma` (CI)                          |
| `npm run db:migrate:status`                  | Show migration status                                                                             |
| `npm run db:generate`                        | Regenerate the Prisma client                                                                      |
| `npm run db:seed`                            | Seed development data (refuses in production)                                                     |
| `npm run db:reset`                           | Drop, re-migrate and re-seed the dev database                                                     |
| `npm run db:studio`                          | Prisma Studio                                                                                     |
| `npm run job:example`                        | Enqueue the example worker job and wait for its result                                            |
| `npm run admin:role -- --email … --role …`   | Grant or remove a staff role (audited; [admin.md](docs/admin.md#provisioning))                    |

## Environment

Each app validates its own environment at startup and exits with a list of what
is missing. See the `.env.example` next to each app and
[docs/SETUP.md](docs/SETUP.md#environment-variables).

## Documentation

- [Architecture](docs/architecture.md): structure, module boundaries, database conventions, how to extend
- [Local setup](docs/SETUP.md): install, run, troubleshoot
- [API conventions](docs/api-conventions.md): envelopes, errors, versioning, validation
- [Design system](docs/design-system.md): brand, tokens, components, motion, accessibility
- [UI and motion library](docs/ui-library.md): `@wayora/ui` components, `@wayora/ui/motion` presets, reduced-motion policy
- [Homepage](docs/homepage.md): sections, motion budget, content rules; [media assets](docs/media-assets.md)
- [Layouts and footer](docs/layouts.md): route tree, containers and spacing tokens, breadcrumbs, footer config, content that needs legal review
- [Destination discovery](docs/discover.md): `/discover` and `/discover/:slug`, the sample dataset, search and filters, how to add a destination
- [Travel search, results and offers](docs/search.md): provider adapters, contracts, Redis search sessions, offer validation and revalidation, error codes, timeouts/retries/circuit breakers, filters and sorting, results pages, offer details, URL state, demo data, adding a supplier
- [Bookings](docs/bookings.md): demo bookings (journey, statuses, API, idempotency, database and migration with rollback, My trips) and, since Phase 23, the supplier reservation lifecycle (separate reservation, payment, document, cancellation and refund states; idempotency; recovery of unknown outcomes; staff handling of ambiguous reservations; rollback). No real supplier implements reservations yet
- [Payments](docs/payments.md): booking/payment rules, states, demo provider, API, idempotency, provider events and webhooks, refunds, migration (with rollback), steps before a real gateway
- [Notifications](docs/notifications.md): events, idempotency, API and ownership, bell and panel, preferences, email outbox and worker, enabling an email provider, migration (with rollback)
- [Trip tracking](docs/trips.md): trip timeline, travel status and freshness, the (simulated) demo status provider, disruptions, notifications, live updates (Server-Sent Events), migration (with rollback)
- [Trip planner](docs/planner.md): planned trips and day-by-day itineraries, API and validation, date handling, schedule warnings, curated sample suggestions (rule-based), booking links; collaboration (Phase 19): roles, in-app invitations, conflict handling, live updates, history, notifications; budget and shared expenses (Phase 20): exact splits, balances, settlement suggestions (no money moved, no currency conversion); migrations (with rollback)
- [Travel assistant](docs/assistant.md) (Phase 21): AI provider interface (demo rule-based assistant, Anthropic adapter, or off), configuration, authorized minimal context, prompt-injection defences, validated structured replies, confirmed apply actions (itinerary, activity, budget, moves), persistent conversations, rate limits and cost controls; migration (with rollback)
- [Launch readiness](docs/launch-readiness.md): what is production-ready, demo-only or missing; prioritized issues; release checklist and plan
- [Testing](docs/testing.md): unit, integration and end-to-end tests, and how to run them
- [Performance](docs/performance.md): lab measurements and what changed because of them
- [Analytics](docs/analytics.md): event schema and tracking rules, metric definitions, revenue methodology, funnel attribution, timezone, access, CSV export, retention and privacy
- [Admin dashboard](docs/admin.md): roles and permissions, provisioning, API, metric definitions, search analytics, platform health and worker heartbeat, audit log, migration (with rollback)
- [Authentication and accounts](docs/auth.md): sessions, cookies and CSRF, endpoints, migration, how to run the account tests, limitations
- [Travel providers](docs/providers.md) (Phase 22): what is demo and what isn't (no live supplier is integrated), the supplier toolkit (HTTP, credentials, exact money conversion), normalized fare/baggage/cancellation fields, offer revalidation, failures and retries, provider health, honest labels, and how to add a real supplier
- [Security](docs/security.md): current controls and the plan for payments and providers
- [Deployment and release](docs/deployment.md): production configuration, build, backup and migrations, deploying the API/worker/web, health checks, smoke tests, rollback, logs, web server headers
- [Deploying to Vercel](docs/deployment-vercel.md): one project with the web app and the API on one domain, Neon and Upstash from the Marketplace, migrations at build, maintenance by Cron Job

## API at a glance

| Method                | Path                                                                                     | Description                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET                   | `/api/v1/health`                                                                         | Liveness. Always 200 while the process is up                                                                         |
| GET                   | `/api/v1/health/ready`                                                                   | Readiness. 200 ready/degraded, 503 unready                                                                           |
| GET                   | `/api/v1/catalog/categories`                                                             | Travel categories (`?availability=beta`)                                                                             |
| GET                   | `/api/v1/catalog/categories/:slug`                                                       | One category                                                                                                         |
| POST                  | `/api/v1/auth/register` · `/login` · `/logout` · `/logout-all`                           | Accounts and sessions ([auth.md](docs/auth.md))                                                                      |
| GET                   | `/api/v1/auth/session`                                                                   | The signed-in user, or `null` (always 200; used on app start-up)                                                     |
| GET                   | `/api/v1/auth/me`                                                                        | The signed-in user (401 when signed out)                                                                             |
| GET/PATCH             | `/api/v1/users/me`                                                                       | Profile                                                                                                              |
| GET/POST/PATCH/DELETE | `/api/v1/users/me/travellers[/:id]`                                                      | Saved travellers                                                                                                     |
| POST                  | `/api/v1/search/:serviceType`                                                            | Demo search for one category ([search.md](docs/search.md))                                                           |
| GET                   | `/api/v1/search/:serviceType/sessions/:searchId/offer`                                   | One validated offer from a stored search ([search.md](docs/search.md#offer-validation))                              |
| POST                  | `/api/v1/bookings`                                                                       | Create a demo booking (`Idempotency-Key` required; [bookings.md](docs/bookings.md))                                  |
| GET                   | `/api/v1/bookings[/:reference]`                                                          | Your demo bookings (`?view=upcoming\|past\|cancelled&page=`), or one                                                 |
| POST                  | `/api/v1/bookings/:reference/cancel`                                                     | Cancel a demo booking (status change only)                                                                           |
| POST/GET              | `/api/v1/bookings/:reference/payments`                                                   | Start a demo payment (`Idempotency-Key`), or list attempts ([payments.md](docs/payments.md))                         |
| GET                   | `/api/v1/payments/:paymentId`                                                            | One payment (reconciled with the provider while in progress)                                                         |
| POST                  | `/api/v1/payments/:paymentId/cancel`                                                     | Cancel a payment still in progress                                                                                   |
| GET                   | `/api/v1/notifications[/unread-count]`                                                   | Your notifications, newest first, or the unread count ([notifications.md](docs/notifications.md))                    |
| PATCH/POST            | `/api/v1/notifications/:id/read` · `/read-all`                                           | Mark one or all as read                                                                                              |
| GET/PATCH             | `/api/v1/notifications/preferences`                                                      | Email preferences (email isn't configured yet)                                                                       |
| GET                   | `/api/v1/providers`                                                                      | Search provider capabilities                                                                                         |
| GET                   | `/api/v1/bookings/:reference/timeline` · `/status` · `/disruptions`                      | Trip timeline, travel status and disruptions ([trips.md](docs/trips.md#api))                                         |
| POST                  | `/api/v1/bookings/:reference/status/refresh`                                             | Ask the (demo) status provider now (throttled)                                                                       |
| GET                   | `/api/v1/bookings/:reference/events`                                                     | Live updates for one booking (Server-Sent Events)                                                                    |
| GET/POST              | `/api/v1/planner/trips`                                                                  | Your planned trips, or create one (`Idempotency-Key`; [planner.md](docs/planner.md#api))                             |
| GET/PATCH/DELETE      | `/api/v1/planner/trips/:tripId`                                                          | One plan with its itinerary and warnings; edit (with `version`); delete                                              |
| POST/PATCH/DELETE     | `/api/v1/planner/trips/:tripId/items[/:itemId[/duplicate]]`                              | Add, edit or move, delete, duplicate activities                                                                      |
| PUT                   | `/api/v1/planner/trips/:tripId/days/:day/order`                                          | Reorder one day                                                                                                      |
| GET                   | `/api/v1/planner/trips/:tripId/suggestions` · `/planner/destinations`                    | Curated sample suggestions (rule-based, not AI) and sample destinations                                              |
| GET/POST/PATCH/DELETE | `/api/v1/planner/trips/:tripId/members[/:memberId]` · `/invitations[/:id]`               | Plan members and invitations: owner manages, members may leave ([planner.md](docs/planner.md#collaboration-api))     |
| GET/POST              | `/api/v1/planner/invitations[/:id[/accept\|/decline]]`                                   | Invitations addressed to you                                                                                         |
| GET                   | `/api/v1/planner/trips/:tripId/activity` · `/events`                                     | Plan change history, and live updates for members (Server-Sent Events)                                               |
| GET/PUT/DELETE        | `/api/v1/planner/trips/:tripId/budget`                                                   | Plan budget and progress; set or remove it (with `version`) ([planner.md](docs/planner.md#budget-api))               |
| GET/POST/PUT/DELETE   | `/api/v1/planner/trips/:tripId/expenses[/:expenseId\|/from-booking]`                     | Shared expenses with exact splits (`Idempotency-Key` on POST)                                                        |
| GET/POST/DELETE       | `/api/v1/planner/trips/:tripId/balances` · `/settlements[/:id]`                          | Balances and suggested payments; record payments made outside Wayora                                                 |
| GET/POST/DELETE       | `/api/v1/assistant/status` · `/conversations[/:id[/messages[/:messageId/check\|apply]]]` | Travel assistant: conversations, replies (not streamed), confirmed proposals ([assistant.md](docs/assistant.md#api)) |
| GET                   | `/api/v1/assistant/trips/:tripId/context`                                                | What the assistant can see about a plan (members only)                                                               |
| GET                   | `/api/v1/admin/…`                                                                        | Staff-only, read-only operations views ([admin.md](docs/admin.md#api))                                               |
| GET                   | `/api/v1/admin/analytics/:report[/export]`                                               | Analytics reports and audited CSV exports ([analytics.md](docs/analytics.md#api))                                    |
| POST                  | `/api/v1/analytics/interactions`                                                         | "Offer chosen" events from the web app (no cookies; skipped under DNT/GPC)                                           |
| POST                  | `/api/v1/admin/bookings/:reference/reservation/{recheck,resolve}`                        | Admins only: one supplier status lookup, or record an outcome confirmed with the supplier (Phase 23)                 |
