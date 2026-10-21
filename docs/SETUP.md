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

| Variable                         | Required | Default                     | Notes                                                                          |
| -------------------------------- | -------- | --------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                       | no       | `development`               | `development` \| `test` \| `production`                                        |
| `HOST` / `PORT`                  | no       | `0.0.0.0` / `4000`          |                                                                                |
| `LOG_LEVEL`                      | no       | `info`                      | pino levels or `silent`                                                        |
| `LOG_FORMAT`                     | no       | `json`                      | `pretty` for local dev (ignored in production)                                 |
| `DATABASE_URL`                   | **yes**  |                             | `postgresql://…`. Essential dependency                                         |
| `REDIS_URL`                      | no       | (disabled)                  | `redis://` or `rediss://`. Optional dependency                                 |
| `CORS_ORIGIN`                    | **yes**  |                             | Comma-separated origins; `*` is rejected                                       |
| `WEB_ORIGIN`                     | **yes**  |                             | Canonical web URL (future email links/redirects)                               |
| `API_BASE_URL`                   | **yes**  |                             | Public API URL (future webhook callbacks)                                      |
| `TRUST_PROXY`                    | no       | `false`                     | `true`, `false` or hop count behind a load balancer                            |
| `RATE_LIMIT_WINDOW_MS`           | no       | `60000`                     |                                                                                |
| `RATE_LIMIT_MAX`                 | no       | `120`                       | Requests per window per client IP                                              |
| `HEALTH_CHECK_TIMEOUT_MS`        | no       | `1500`                      | Per-dependency probe timeout                                                   |
| `SHUTDOWN_TIMEOUT_MS`            | no       | `10000`                     | Forced exit after this during shutdown                                         |
| `SESSION_IDLE_TIMEOUT_HOURS`     | no       | `168`                       | Sign-out after this long without activity ([auth.md](auth.md))                 |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | no       | `720`                       | Maximum session length                                                         |
| `AUTH_RATE_LIMIT_MAX`            | no       | `20`                        | Sign-in + registration attempts per IP per 15 min                              |
| `LOGIN_FAILURES_PER_EMAIL_MAX`   | no       | `10`                        | Failed sign-ins per email per 15 min                                           |
| `SEARCH_DEMO_PROVIDERS`          | no       | dev/test on, production off | Demo search fixtures ([search.md](search.md))                                  |
| `SEARCH_DISABLED_PROVIDERS`      | no       | empty                       | Comma-separated provider ids to switch off                                     |
| `SEARCH_RATE_LIMIT_MAX`          | no       | `30`                        | Searches per IP per minute                                                     |
| `SEARCH_CACHE_TTL_SECONDS`       | no       | `600`                       | Search session lifetime (reuse while refining; offer pages); `0` disables both |

### `apps/worker/.env`

| Variable                              | Required | Default | Notes                               |
| ------------------------------------- | -------- | ------- | ----------------------------------- |
| `REDIS_URL`                           | **yes**  |         | The worker cannot run without Redis |
| `WORKER_CONCURRENCY`                  | no       | `5`     |                                     |
| `SHUTDOWN_TIMEOUT_MS`                 | no       | `15000` | Time allowed for in-flight jobs     |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT` | no       |         | As for the API                      |

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

## Troubleshooting

| Symptom                                                                    | Fix                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration` on start                               | Run `npm run setup`, then check the listed variables                                                                |
| Readiness shows `unready`, PostgreSQL down                                 | `npm run infra:up`; check `DATABASE_URL` matches `.env` credentials                                                 |
| Readiness shows `degraded`, Redis down                                     | `npm run infra:up`. The API keeps serving; rate limiting falls back to per-process memory                           |
| Web shows "Showing the built-in service list"                              | The API isn't running or `VITE_API_BASE_URL` is wrong; start `npm run dev:api`                                      |
| Port 5432/6379 already in use                                              | Set `POSTGRES_PORT` / `REDIS_PORT` in root `.env` and update the URLs in the app `.env` files                       |
| `prisma generate` fails fetching `binaries.prisma.sh` during `npm install` | Your network blocks Prisma's engine download. Allow that host, or set `PRISMA_ENGINES_MIRROR` to an internal mirror |
| `npm run job:example` times out                                            | Start the worker (`npm run dev:worker`) and check Redis is up                                                       |
| CORS error in the browser                                                  | Add the web origin to `CORS_ORIGIN` in `apps/api/.env`                                                              |
