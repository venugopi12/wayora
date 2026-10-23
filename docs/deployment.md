# Deployment and release

How to put a Wayora release into production, check it, and roll it back.
Wayora is three deployables built from one repository:

| Piece  | What it is                                 | Runs as                               |
| ------ | ------------------------------------------ | ------------------------------------- |
| API    | Express server (`apps/api/dist/server.js`) | Long-running Node.js process(es)      |
| Worker | BullMQ worker (`apps/worker/dist/main.js`) | Long-running Node.js process(es)      |
| Web    | Static files (`apps/web/dist/`)            | Any static host, CDN or reverse proxy |

Plus PostgreSQL 16 (essential) and Redis 7 (required in production). Nothing
here assumes Docker, Kubernetes or a particular cloud: the repository ships
Docker Compose for **local development only** (`infra/docker`). Use whatever
process manager your platform has (systemd, a PaaS, IIS with iisnode, PM2, a
container image you build); the commands below are the contract.

- [Before the first release](#before-the-first-release)
- [1. Configuration and secrets](#1-configuration-and-secrets)
- [2. Install](#2-install)
- [3. Build](#3-build)
- [4. Back up, then migrate](#4-back-up-then-migrate)
- [5. Deploy the API, worker and web](#5-deploy)
- [6. Health and readiness](#6-health-and-readiness)
- [7. Smoke tests](#7-smoke-tests)
- [8. Rollback](#8-rollback)
- [9. Logs and troubleshooting](#9-logs-and-troubleshooting)
- [10. Known limitations](#10-known-limitations)
- [Web server headers](#web-server-headers), [HTTPS and HSTS](#https-and-hsts),
  [Dependencies](#dependencies)

## Before the first release

- Node.js **22.12 or newer** and npm 10 (`package.json` `engines`) on the
  build machine and on the API/worker hosts.
- A PostgreSQL 16 database and a Redis 7 instance reachable from the API and
  worker hosts, with their own credentials (not the development ones).
- HTTPS for the web origin and the API origin, on the **same registrable
  domain** (e.g. `wayora.example` and `api.wayora.example`): the session
  cookie is `SameSite=Lax` (docs/auth.md#cookie-and-csrf-strategy).
- An operator who can run commands with `DATABASE_URL` set (migrations and
  staff provisioning are command-line operations).

## 1. Configuration and secrets

Each app reads its environment at start-up, validates it, and **exits with a
list of problems** (variable names and reasons, never values) if anything is
missing or unsafe. Real values come from your platform's secret store or
environment; never commit a `.env` with them. The committed `.env.example`
files hold local development placeholders only.

Each app also loads `apps/<app>/.env` when the file exists, with variables
already in the environment taking precedence. Don't copy a development
`.env` onto a production host: a value missing from the real environment
would silently come from it (development passwords are refused, but URLs
such as `REDIS_URL=redis://localhost:6379` are not).

### API (`apps/api`)

| Variable                 | Production               | Notes                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`               | `production`             | Turns on the production rules below, the `__Host-` secure cookie, HSTS and JSON logs                                                                                                                                                                                                       |
| `DATABASE_URL`           | **required**             | `postgresql://…`; refused if it contains a development password                                                                                                                                                                                                                            |
| `REDIS_URL`              | **required**             | Search sessions, shared rate limits, worker heartbeat; refused with a development password                                                                                                                                                                                                 |
| `CORS_ORIGIN`            | **required**, `https://` | Comma-separated web origins allowed to call the API (also the CSRF allow-list); `*` is refused                                                                                                                                                                                             |
| `WEB_ORIGIN`             | **required**, `https://` | The web app's public origin                                                                                                                                                                                                                                                                |
| `API_BASE_URL`           | **required**, `https://` | This API's public URL                                                                                                                                                                                                                                                                      |
| `TRUST_PROXY`            | number of proxy hops     | Behind a load balancer or reverse proxy set e.g. `1`, or every client shares the proxy's IP for rate limits (warned at start-up)                                                                                                                                                           |
| `HOST`, `PORT`           | as needed                | Defaults `0.0.0.0:4000`                                                                                                                                                                                                                                                                    |
| `LOG_LEVEL`              | `info`                   | `LOG_FORMAT` is always JSON in production                                                                                                                                                                                                                                                  |
| `SEARCH_DEMO_PROVIDERS`  | **`true` for now**       | Off by default in production. There are no live suppliers yet, so without it search answers "unavailable" (warned at start-up when on)                                                                                                                                                     |
| `PAYMENT_PROVIDER`       | `demo` or `none`         | Default `none` in production. `demo` simulates payments; no money moves (warned)                                                                                                                                                                                                           |
| `PAYMENT_DEMO_SCENARIOS` | unset (off)              | Lets requests choose demo outcomes; keep off outside testing                                                                                                                                                                                                                               |
| Rate limits, timeouts    | defaults                 | `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_MAX`, `LOGIN_FAILURES_PER_EMAIL_MAX`, `SEARCH_RATE_LIMIT_MAX`, `BOOKING_RATE_LIMIT_MAX`, `PAYMENT_RATE_LIMIT_MAX`, `NOTIFICATION_RATE_LIMIT_MAX`, `HEALTH_CHECK_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`, `SESSION_*`, `SEARCH_*` — see `apps/api/.env.example` |

There are no signing secrets to provision: session tokens are random values
stored as SHA-256 hashes, and no payment, email or supplier credentials exist
yet. When a real integration is added, its credentials go here (API/worker
environment), never into `VITE_*` variables.

### Worker (`apps/worker`)

| Variable                                                                                      | Production   | Notes                                                    |
| --------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| `NODE_ENV`                                                                                    | `production` |                                                          |
| `REDIS_URL`                                                                                   | **required** | Same Redis as the API                                    |
| `DATABASE_URL`                                                                                | **required** | Notification outbox; refused with a development password |
| `WEB_ORIGIN`                                                                                  | `https://`   | Links in emails                                          |
| `WORKER_CONCURRENCY`, `NOTIFICATION_DISPATCH_INTERVAL_MS`, `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL` | defaults     | See `apps/worker/.env.example`                           |

### Web (`apps/web`, build time only)

| Variable            | Production               | Notes                                                                                                                       |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | **required**, `https://` | Baked into the bundle and the CSP `connect-src`. The build refuses to run without it, or with plain http (except localhost) |

Everything `VITE_*` is public: it ends up in JavaScript anyone can read.

## 2. Install

On the build machine, from a clean checkout of the release commit:

```bash
npm ci
```

`npm ci` installs exactly the committed lockfile and runs `prisma generate`,
which downloads Prisma's engine binary for the platform once (cached in
`~/.cache/prisma`). On a network that blocks `binaries.prisma.sh`, use a
mirror (`PRISMA_ENGINES_MIRROR`) or a pre-provisioned engine
(docs/SETUP.md#prisma-engines-and-restricted-networks); don't stub the engine
on a machine that will run migrations.

## 3. Build

```bash
VITE_API_BASE_URL=https://api.wayora.example npm run build
```

This builds `@wayora/contracts`, `@wayora/database` (Prisma client), the API,
the worker and the web app. The web build also:

- refuses to run without a safe `VITE_API_BASE_URL`,
- embeds the Content-Security-Policy in `index.html` as a `<meta>` tag,
- moves source maps out of `dist/` into `apps/web/sourcemaps/` (never
  served; keep them privately if you add error monitoring),
- fails if development-only routes ended up in the bundle.

Run the checks CI runs before shipping a build (docs/SETUP.md#continuous-integration):

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
npm audit --omit=dev --audit-level=high
```

Artifacts: the repository directory with `node_modules`, `packages/*/dist`,
`database/dist`, `apps/api/dist`, `apps/worker/dist` (the API and worker
import the built workspace packages), and `apps/web/dist/` for the static host.

## 4. Back up, then migrate

The API and worker **never change the schema at start-up**, and the seed
script refuses to run when `NODE_ENV=production`. Migrations are a separate,
explicit step, run once per release by an operator or the release pipeline,
**before** the new code starts:

```bash
# 1. Back up (or confirm a point-in-time-recovery restore point exists).
pg_dump --format=custom --file=wayora-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"

# 2. See what will run.
DATABASE_URL=… npm run db:migrate:status

# 3. Apply committed migrations (never `db:migrate`/`migrate dev` or `db:reset` in production).
DATABASE_URL=… npm run db:migrate:deploy

# 4. Confirm the database matches the schema the code was built for.
DATABASE_URL=… npm run db:migrate:check
```

Every migration so far is additive (new tables, columns with defaults,
indexes, triggers), so the previous release keeps working against the
migrated database. That is the rule for future migrations too: expand first,
contract in a later release (docs/architecture.md#changing-the-schema). Each
phase document has the migration's rollback SQL.

First release only: create the first administrator after the API is up and
the person has registered (docs/admin.md#provisioning):

```bash
DATABASE_URL=… npm run admin:role -- --email ops@example.com --role admin --reason "First administrator"
```

## 5. Deploy

**API** — on each host, with the production environment:

```bash
npm run start:api        # node apps/api/dist/server.js
```

Several instances can run behind a load balancer: sessions are in
PostgreSQL, search sessions and rate limits in Redis, and the background jobs
it runs (session purge, payment reconciliation and booking expiry, travel
reminders) are idempotent and row-locked. On `SIGTERM` it stops accepting
connections, finishes in-flight requests, closes PostgreSQL and Redis, and
exits (forced after `SHUTDOWN_TIMEOUT_MS`). Point the load balancer's
**liveness** probe at `/api/v1/health` and its **readiness** probe at
`/api/v1/health/ready`.

**Worker** — one or more processes:

```bash
npm run start:worker     # node apps/worker/dist/main.js
```

On `SIGTERM` it stops taking jobs, waits for active ones, closes the queue and
the database, and exits. Running several workers is safe: the dispatch
schedule lives once in Redis and outbox rows are leased with
`FOR UPDATE SKIP LOCKED`.

**Web** — upload `apps/web/dist/` to the static host or CDN. Configure:

- SPA fallback: unknown paths serve `index.html` (client-side routes such as
  `/trips/WYD-…` or `/admin/users`),
- long-lived caching for `/assets/*` (file names are content-hashed) and
  `no-cache` for `index.html`,
- the [security headers](#web-server-headers) on every response.

Order for a release: migrate → API → worker → web. The web bundle only needs
API endpoints that already exist, so deploying it last avoids a window where
the browser calls something the API doesn't have yet.

## 6. Health and readiness

| Endpoint                     | Meaning                                                                              | Use                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `GET /api/v1/health`         | Liveness: the process serves HTTP. Never touches dependencies                        | Restart the process if it fails               |
| `GET /api/v1/health/ready`   | Readiness: `ready` (200), `degraded` (200), `unready` (503)                          | Take the instance out of rotation on 503      |
| `/admin/health` (staff only) | Database, Redis, worker heartbeat, queue backlog, email outbox, payments in progress | Operator view (docs/admin.md#platform-health) |

Readiness dependencies: `postgres` is essential (down → 503); `redis` and
`worker` are optional (down → `degraded`, still 200). The worker counts as up
only while its own heartbeat in Redis is fresh (written every 15 s, 60 s
expiry), not because Redis answers. A stopped worker doesn't take the API out
of rotation: every request still works, notification emails wait in the
outbox. Public readiness says only "Not responding" or "Timed out after … ms";
the real reasons are in the API logs.

After deploying, expect `ready` within a few seconds of the worker starting:

```bash
curl -s https://api.wayora.example/api/v1/health/ready
```

## 7. Smoke tests

Run against the new release, in a browser, with a fresh test account.
Demo data is clearly labelled everywhere; nothing below moves money or
contacts a supplier.

1. **Headers:** `curl -sI https://wayora.example/` shows
   `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`; the API (`curl -sI …/api/v1/health`) shows
   `Strict-Transport-Security`. The browser console shows no CSP violations.
2. **Auth:** register, sign out, sign in. The session cookie is
   `__Host-wayora_session`, `Secure`, `HttpOnly`, `SameSite=Lax`. "Sign out
   everywhere" ends other sessions.
3. **Search:** a hotel search returns demo results with the demo disclaimer;
   an offer page opens.
4. **Booking:** book the offer; the confirmation says it is a demo booking with
   no supplier reservation, ticket or PNR.
5. **Payment** (if `PAYMENT_PROVIDER=demo`): pay; it says no real money was
   charged; the booking becomes a demo confirmation.
6. **Notifications:** the bell shows the booking and payment notifications.
7. **Admin authorization:** as the test customer, `/admin` says "no access" and
   `GET /api/v1/admin/overview` answers 403. As an administrator, `/admin`
   opens, the overview shows real revenue as unavailable, and `/admin/health`
   shows the worker healthy.
8. **Readiness:** `ready`.

Afterwards, demote or leave the test accounts; they hold only demo data.

## 8. Rollback

**Application:** redeploy the previous release's build (API, worker, web) the
same way. Because migrations are additive, the previous code runs against the
migrated database; no database change is needed to roll back code. Roll
back the web together with the API if the release added endpoints the old
API lacks.

**Database:** only when a migration itself is the problem, and only after the
code that needs it has been rolled back:

1. Restore from the backup taken in step 4 if data integrity is in doubt, or
2. run the migration's documented rollback SQL (for example
   docs/admin.md#rollback, docs/notifications.md#rollback), which also
   removes its row from `_prisma_migrations`.

Rollback SQL drops what the migration added (data in new tables is lost;
audit entries already written stay). Never edit an applied migration file;
fix forward with a new migration instead.

## 9. Logs and troubleshooting

Both processes write one JSON object per line to stdout: `time` (ISO 8601),
`level`, `service` (`wayora-api` / `wayora-worker`), `env`, `msg`, and for
API requests `requestId` (also returned to clients as `X-Request-Id` and in
every error body as `requestId`). Collect stdout with your platform's log
shipping.

- Find one request: search for its `requestId` (a customer can read it from an
  error message).
- Never in logs: passwords, cookies, tokens, authorization headers, card
  data, request bodies, query-string values, traveller names or contact
  details. Error messages are scrubbed of credentials (any URL's user info,
  bearer tokens, secret-looking pairs), and database errors keep only their
  first and last lines.
- Expected warnings at start-up in a demo deployment: "SEARCH_DEMO_PROVIDERS
  is on", "PAYMENT_PROVIDER is demo".

| Symptom                                                         | Likely cause                                                       | Check                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Process exits at start with `Invalid environment configuration` | Missing or unsafe variable                                         | The listed names; section 1                                                             |
| Readiness 503, `postgres` down                                  | Database unreachable or wrong credentials                          | API log line "Readiness check failed" (scrubbed reason)                                 |
| Readiness `degraded`, `redis` down                              | Redis unreachable                                                  | Rate limits fall back to per-instance memory (logged once a minute); search answers 503 |
| Readiness `degraded`, `worker` down                             | No worker running, or it can't reach Redis                         | Worker logs; `/admin/health`                                                            |
| Everyone hits 429 at once                                       | `TRUST_PROXY` not set behind a proxy                               | Start-up warning                                                                        |
| Browser "Failed to fetch", CSP error in console                 | `VITE_API_BASE_URL` wrong for this deployment                      | Rebuild with the right URL                                                              |
| Sign-in works but the next request is signed out                | API on a different site than the web app, or not HTTPS             | Section "Before the first release"                                                      |
| Email outbox growing                                            | No email provider exists; deliveries are recorded "not configured" | Expected (docs/notifications.md)                                                        |

## 10. Known limitations

- **Demo inventory only.** All search results come from built-in demo
  providers; no live supplier is integrated. Bookings are demo bookings: no
  reservation, ticket or PNR exists.
- **Demo payments only.** No payment gateway is integrated; demo payments move
  no money, and refunds are not available.
- **No email delivery.** Notifications are in-app; email deliveries are
  recorded as not configured.
- No email verification or password reset yet (docs/auth.md#limitations-and-future-work).
- The admin dashboard is read-only (docs/admin.md#limitations).
- Release steps are manual; CI checks every commit but deploys nothing.

## Web server headers

Whatever serves `apps/web/dist/` (CDN, nginx, IIS, …) must add these to every
response. They come from `apps/web/config/security-headers.ts`, which is
tested, and `vite preview` sends exactly this set, so the production build is
exercised with them:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'self' https://api.wayora.example; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

Replace the `connect-src` API origin with yours. The `<meta>` CSP in
`index.html` covers everything except `frame-ancestors` (browsers ignore it
in a meta tag), so the `frame-ancestors`/`X-Frame-Options` headers must come
from the server. On IIS, set them under `<httpProtocol><customHeaders>` in
`web.config`, together with a URL Rewrite rule for the SPA fallback.

The API sets its own headers (helmet, `apiSecurityHeaders` in
`apps/api/src/app.ts`); a proxy in front of it doesn't need to add any, and
must not strip them.

## HTTPS and HSTS

- Terminate TLS at your load balancer or reverse proxy, and set the API's
  `TRUST_PROXY` to the number of hops so client IPs (rate limits) and
  `Secure` cookies work.
- The API sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  in production (every production origin must be HTTPS).
- The web origin's HSTS header is **not** in the static headers on purpose:
  send it from the TLS-terminating proxy once HTTPS is guaranteed for that
  host and all its subdomains. Add `preload` only after deciding to submit
  the domain to browser preload lists, which is hard to undo.

## Dependencies

- Exact version pins and a committed lockfile; installs use `npm ci`.
- CI runs `npm audit --omit=dev --audit-level=high` on every push and pull
  request: a high or critical advisory in a shipped dependency fails the
  build. Run it before each release too; fix by upgrading the pinned version
  (then the full checks), not by suppressing the advisory.
