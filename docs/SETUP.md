# Local setup

## Prerequisites

| Tool    | Version                           | Why                                              |
| ------- | --------------------------------- | ------------------------------------------------ |
| Node.js | ≥ 22.12                           | Runtime for all apps (Vite 8 / Vitest 5 minimum) |
| npm     | ≥ 10                              | Workspaces                                       |
| Docker  | Desktop or Engine with Compose v2 | Local PostgreSQL 16 and Redis 7                  |

Check with `node -v`, `npm -v`, `docker compose version`.

## First run

```bash
git clone <repo> wayora && cd wayora
npm install
npm run setup
npm run infra:up
npm run db:migrate
npm run db:seed        # optional
npm run dev
```

| Service   | URL                                       |
| --------- | ----------------------------------------- |
| Web       | http://localhost:5173                     |
| API       | http://localhost:4000/api/v1/health       |
| Readiness | http://localhost:4000/api/v1/health/ready |
| Postgres  | `localhost:5432` (user `wayora`)          |
| Redis     | `localhost:6379`                          |

Postgres and Redis ports bind to `127.0.0.1` only.

To use the admin dashboard (`/admin`), register an account in the app, then
make it an administrator from the command line (there is no UI for roles):

```bash
npm run admin:role -- --email you@example.com --role admin --reason "Local development"
```

See [admin.md](admin.md#provisioning).

### Run the example background job

With `npm run dev` (or `npm run dev:worker`) running:

```bash
npm run job:example
# Enqueued system.heartbeat (id 1) on wayora-system. Waiting for worker…
# Job completed with result: { processedAt: '…', queueLatencyMs: 12 }
```

## Environment variables

`npm run setup` copies each `.env.example` to `.env`. The defaults work with
Docker Compose out of the box. `.env` files are git-ignored.

### Root `.env` (Docker Compose)

| Variable            | Default                 | Notes                   |
| ------------------- | ----------------------- | ----------------------- |
| `POSTGRES_USER`     | `wayora`                |                         |
| `POSTGRES_PASSWORD` | `wayora_local_dev_only` | Local only              |
| `POSTGRES_DB`       | `wayora`                |                         |
| `POSTGRES_PORT`     | `5432`                  | Change if 5432 is taken |
| `REDIS_PORT`        | `6379`                  |                         |

### `apps/api/.env`

| Variable                           | Required | Default                       | Notes                                                                                                             |
| ---------------------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                         | no       | `development`                 | `development` \| `test` \| `production`                                                                           |
| `HOST` / `PORT`                    | no       | `0.0.0.0` / `4000`            |                                                                                                                   |
| `LOG_LEVEL`                        | no       | `info`                        | pino levels or `silent`                                                                                           |
| `LOG_FORMAT`                       | no       | `json`                        | `pretty` for local dev (ignored in production)                                                                    |
| `DATABASE_URL`                     | **yes**  |                               | `postgresql://…`. Essential dependency                                                                            |
| `REDIS_URL`                        | no       | (disabled)                    | `redis://` or `rediss://`. Optional dependency                                                                    |
| `CORS_ORIGIN`                      | **yes**  |                               | Comma-separated origins; `*` is rejected                                                                          |
| `WEB_ORIGIN`                       | **yes**  |                               | Canonical web URL (future email links/redirects)                                                                  |
| `API_BASE_URL`                     | **yes**  |                               | Public API URL (future webhook callbacks)                                                                         |
| `TRUST_PROXY`                      | no       | `false`                       | `true`, `false` or hop count behind a load balancer                                                               |
| `RATE_LIMIT_WINDOW_MS`             | no       | `60000`                       |                                                                                                                   |
| `RATE_LIMIT_MAX`                   | no       | `120`                         | Requests per window per client IP                                                                                 |
| `HEALTH_CHECK_TIMEOUT_MS`          | no       | `1500`                        | Per-dependency probe timeout                                                                                      |
| `SHUTDOWN_TIMEOUT_MS`              | no       | `10000`                       | Forced exit after this during shutdown                                                                            |
| `SESSION_IDLE_TIMEOUT_HOURS`       | no       | `168`                         | Sign-out after this long without activity ([auth.md](auth.md))                                                    |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS`   | no       | `720`                         | Maximum session length                                                                                            |
| `AUTH_RATE_LIMIT_MAX`              | no       | `20`                          | Sign-in + registration attempts per IP per 15 min                                                                 |
| `LOGIN_FAILURES_PER_EMAIL_MAX`     | no       | `10`                          | Failed sign-ins per email per 15 min                                                                              |
| `SEARCH_DEMO_PROVIDERS`            | no       | dev/test on, production off   | Demo search fixtures ([search.md](search.md))                                                                     |
| `SEARCH_DISABLED_PROVIDERS`        | no       | empty                         | Comma-separated provider ids to switch off                                                                        |
| `SEARCH_RATE_LIMIT_MAX`            | no       | `30`                          | Searches per IP per minute                                                                                        |
| `BOOKING_RATE_LIMIT_MAX`           | no       | `10`                          | Demo booking creations and cancellations per signed-in user per minute                                            |
| `PAYMENT_PROVIDER`                 | no       | `demo`; `none` in production  | `demo` (simulator, no money moves) or `none` (payments off) ([payments.md](payments.md#configuration-appsapienv)) |
| `PAYMENT_DEMO_SCENARIOS`           | no       | `true`; `false` in production | Let requests choose a demo payment outcome (demo provider only)                                                   |
| `PAYMENT_WINDOW_MINUTES`           | no       | `30`                          | 5–1440. How long a booking waits for its payment before it expires                                                |
| `PAYMENT_DEMO_PENDING_SECONDS`     | no       | `8`                           | 1–300. How long demo `pending` payments stay pending                                                              |
| `PAYMENT_RATE_LIMIT_MAX`           | no       | `10`                          | Payment starts and cancellations per signed-in user per minute                                                    |
| `SEARCH_SESSION_STORE`             | no       | `redis` if `REDIS_URL` set    | `redis` or `memory`; **production requires `redis`** ([search.md](search.md#search-sessions))                     |
| `SEARCH_SESSION_TTL_SECONDS`       | no       | `600`                         | 60–1800. Search session lifetime (old name `SEARCH_CACHE_TTL_SECONDS` accepted)                                   |
| `SEARCH_DEADLINE_MS`               | no       | `8000`                        | Budget per search / offer check, retries included                                                                 |
| `SEARCH_PROVIDER_MAX_ATTEMPTS`     | no       | `2`                           | Attempts per provider call (transient failures only)                                                              |
| `SEARCH_PROVIDER_RETRY_BASE_MS`    | no       | `200`                         | Backoff base (full jitter, cap 8×)                                                                                |
| `SEARCH_BREAKER_FAILURE_THRESHOLD` | no       | `5`                           | Consecutive failures that open a provider's circuit breaker                                                       |
| `SEARCH_BREAKER_COOLDOWN_SECONDS`  | no       | `30`                          | Open time before one trial call                                                                                   |

**Redis and search.** Search sessions live in Redis whenever `REDIS_URL` is
set (and must in production): they survive API restarts and are shared by
every instance. Without Redis in local development the API keeps them in
memory and logs a warning; if a configured Redis goes down, search answers
503 rather than falling back. Expired sessions are removed by Redis itself
(key TTLs); no cleanup job is needed.

### `apps/worker/.env`

| Variable                              | Required | Default | Notes                                                                                                                         |
| ------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                           | **yes**  |         | The worker cannot run without Redis                                                                                           |
| `WORKER_CONCURRENCY`                  | no       | `5`     |                                                                                                                               |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `15000` | Time allowed for in-flight jobs                                                                                               |
| `DATABASE_URL`                        | no       |         | Needed for notification delivery (the email outbox); without it that job is off ([notifications.md](notifications.md#worker)) |
| `WEB_ORIGIN`                          | no       |         | Public web origin for links in emails                                                                                         |
| `NOTIFICATION_DISPATCH_INTERVAL_MS`   | no       | `15000` | How often the outbox is checked (1 s–10 min)                                                                                  |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT` | no       |         | As for the API                                                                                                                |

### `apps/web/.env`

| Variable            | Default                 | Notes                                                                                |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `VITE_API_BASE_URL` | `http://localhost:4000` | **Public.** Every `VITE_*` value ships in the browser bundle; never put secrets here |

### `database/.env`

| Variable       | Notes                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL` | Used by the Prisma CLI (migrate, seed, studio). Keep in sync with `apps/api/.env` |

If a required variable is missing the app exits immediately, for example:

```text
Invalid environment configuration for @wayora/api:
  - DATABASE_URL: is required but not set
  - CORS_ORIGIN: is required but not set

Fix: copy apps/api/.env.example to apps/api/.env (or run `npm run setup`) and set the values above.
```

## Database workflow

```bash
npm run db:migrate          # apply pending migrations; after editing schema.prisma, creates a new one
npm run db:migrate:status   # what is applied
npm run db:seed             # idempotent dev seed
npm run db:reset            # DESTRUCTIVE: drop, re-migrate, re-seed (dev only)
npm run db:studio           # browse data
```

Schema: `database/schema.prisma`. Migrations: `database/migrations/`. Read
[architecture.md#database](architecture.md#database) before changing either.

The Phase 12 migration (`20261022000000_demo_bookings`) stops without changing
anything if the `bookings` table already has rows (it had no writer before);
see [bookings.md#migration](bookings.md#migration) for what to do and for the
rollback SQL. `npm run db:migrate` applies it to an up-to-date dev database.
The Phase 13 migration (`20261023000000_payments`) is additive: existing
bookings get payment mode `NONE` ([payments.md#database](payments.md#database)).

## Docker

```bash
npm run infra:up      # start + wait for healthchecks
npm run infra:ps      # status
npm run infra:logs    # follow logs
npm run infra:down    # stop (data kept in volumes)
npm run infra:reset   # stop and DELETE volumes (fresh database)
```

## Verifying everything

```bash
npm run check    # lint, format check, typecheck, all tests
npm run build    # production builds
```

Tests mock PostgreSQL, Redis and the network; they need no running services or credentials.
The exception is the account integration suite, which runs against a separate
`*_test` PostgreSQL database only when `TEST_DATABASE_URL` is set and is reported
as skipped otherwise. See [auth.md](auth.md#running-the-tests).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request,
on Ubuntu with Node 22 and a PostgreSQL 16 service container:

1. `npm ci` (npm cache via `actions/setup-node`; Prisma engines cached in
   `~/.cache/prisma`, keyed by `package-lock.json`).
2. `prisma --version`: fails early and clearly if the Prisma engine is missing.
3. `npm run db:migrate:deploy` into the `wayora_test` database, then
   `npm run db:migrate:check` (exit code 2 if the migrated schema and
   `schema.prisma` differ).
4. `npm run lint`, `npm run format:check`, `npm run typecheck`.
5. `npm test` with `TEST_DATABASE_URL` and `TEST_REDIS_URL` set, so the
   account integration suite runs against PostgreSQL and the search-session
   suite against Redis (a Redis 7 service container). With `CI` set, a missing
   `TEST_DATABASE_URL` or `TEST_REDIS_URL` fails those suites instead of
   skipping them.
6. `npm audit --omit=dev --audit-level=high`: fails on high or critical
   advisories in what ships.
7. `npm run build` with `VITE_API_BASE_URL=http://localhost:4000` (production web
   builds refuse to run without an explicit API URL). The web build also checks
   that no source maps or development-only routes end up in `apps/web/dist`.

The workflow uses read-only repository permissions, throwaway service
containers and CI-only credentials, and never touches a real database.
Releases are a separate, manual process: [deployment.md](deployment.md).

### Running the CI steps locally

With Docker running (`npm run infra:up`) and the test database created once
(see [auth.md](auth.md#running-the-tests)):

```bash
export CI=true
export TEST_DATABASE_URL=postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora_test
export TEST_REDIS_URL=redis://localhost:6379/15  # tests use a unique key prefix and delete only their keys
export DATABASE_URL=$TEST_DATABASE_URL     # Prisma CLI target for the next two steps
npm ci
npm run db:migrate:deploy
npm run db:migrate:check
npm run lint && npm run format:check && npm run typecheck && npm test
npm audit --omit=dev --audit-level=high
npm run build   # VITE_API_BASE_URL comes from apps/web/.env (npm run setup)
unset DATABASE_URL                         # back to apps' .env files for dev
```

To run the workflow file itself, [`act`](https://github.com/nektos/act)
(`act pull_request`) executes it in Docker with the same service container.

### Prisma engines and restricted networks

Every Prisma CLI command, including `prisma generate` (run by `npm ci` and by
`build:packages` before typecheck, tests and builds), first makes sure the
**schema-engine** binary for the installed Prisma version is present. On a
normal network `npm ci` downloads it once from `binaries.prisma.sh` into
`~/.cache/prisma` and `node_modules/@prisma/engines`; nothing is fetched after
that. Where that host is blocked, every Prisma command fails with
`Failed to fetch sha256 checksum … 403`. Supported fixes, in order of
preference:

1. Allow `binaries.prisma.sh`, or restore `~/.cache/prisma` from a cache (as CI
   does).
2. `PRISMA_ENGINES_MIRROR=https://<internal mirror>` serving the same files.
3. Pre-provision the binary and point at it with
   `PRISMA_SCHEMA_ENGINE_BINARY=/path/to/schema-engine`. Add
   `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` only if the mirror has no
   `.sha256` files.

Don't point `PRISMA_SCHEMA_ENGINE_BINARY` at a stub (e.g. `/bin/true`): it lets
`generate` pass but makes every migrate command silently do nothing. The
binary is never committed.

## Troubleshooting

| Symptom                                                                    | Fix                                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration` on start                               | Run `npm run setup`, then check the listed variables                                                                                |
| Readiness shows `unready`, PostgreSQL down                                 | `npm run infra:up`; check `DATABASE_URL` matches `.env` credentials                                                                 |
| Readiness shows `degraded`, `worker` down                                  | Start the worker (`npm run dev:worker`); it writes a heartbeat to Redis every 15 s                                                  |
| Readiness shows `degraded`, Redis down                                     | `npm run infra:up`. The API keeps serving; rate limiting falls back to per-process memory                                           |
| Web shows "Showing the built-in service list"                              | The API isn't running or `VITE_API_BASE_URL` is wrong; start `npm run dev:api`                                                      |
| Port 5432/6379 already in use                                              | Set `POSTGRES_PORT` / `REDIS_PORT` in root `.env` and update the URLs in the app `.env` files                                       |
| `prisma generate` fails fetching `binaries.prisma.sh` during `npm install` | Your network blocks Prisma's engine download. See [Prisma engines and restricted networks](#prisma-engines-and-restricted-networks) |
| `npm run job:example` times out                                            | Start the worker (`npm run dev:worker`) and check Redis is up                                                                       |
| CORS error in the browser                                                  | Add the web origin to `CORS_ORIGIN` in `apps/api/.env`                                                                              |
