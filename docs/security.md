# Security considerations

Authentication (email + password, server-side sessions) shipped in Phase 8; see
[auth.md](auth.md) for its full design. Payments and provider integrations are not
built yet. This document records the controls in place now and the approach decided
for later phases, so they are built the same way from day one.

## In place now

### Configuration and secrets

- Every app validates its environment at startup with Zod and exits with a clear
  list of problems. Misconfiguration never reaches runtime.
- `.env` files are git-ignored. Only `.env.example` files with obviously
  local-only placeholders are committed.
- **Browser bundle boundary:** only `VITE_*` variables reach the web app, and the
  only one is the public API URL. Provider keys, PSP keys, database and Redis URLs
  exist only in `apps/api` / `apps/worker` env.
- Docker Compose binds PostgreSQL and Redis to `127.0.0.1` only.

### HTTP

- `helmet` security headers (CSP for API responses, `nosniff`, HSTS, frame-ancestors,
  referrer policy). `X-Powered-By` disabled.
- CORS allow-list from `CORS_ORIGIN`; `*` is rejected by env validation because
  credentials are enabled.
- JSON bodies limited to 100 kB. Malformed JSON returns `INVALID_JSON`, not a stack trace.
- Rate limiting per client IP, shared through Redis, falling back to in-memory
  limits (not to no limits) when Redis is down. `TRUST_PROXY` must be set correctly
  behind a load balancer so clients cannot spoof IPs via `X-Forwarded-For`.
- Strict query schemas reject unknown parameters.
- Inbound `X-Request-Id` values are accepted only if they match a short safe pattern
  (prevents log injection).
- Unexpected errors return a generic message plus request ID; internals are logged,
  not exposed (except in local development).

### Logging

- Structured JSON logs with request IDs.
- Redaction of `authorization`, `cookie`, `set-cookie`, `x-api-key` and any
  `password`, `confirmPassword`, `currentPassword`, `passwordHash`, `token`,
  `sessionToken`, `tokenHash`, `accessToken`, `refreshToken`, `secret`,
  `cardNumber`, `cvv` fields. Request bodies are never logged.
- Request bodies and job payloads are not logged.

### Data

- Money as integers in minor units with DB-level CHECK constraints.
- `audit_logs` is append-only, enforced by a database trigger.
- Webhook events are unique per `(provider, external_id)`, so replays are no-ops.
- No card data columns exist, by design.
- Seed script refuses to run with `NODE_ENV=production` and uses fictional data.

### Background jobs

- Job payload schemas are strict and carry IDs only. PII is loaded by the worker
  from the database at execution time.

### Dependencies

- Exact version pins and a committed lockfile. `npm audit` reports 0 known
  vulnerabilities at the time of Phase 1.
- Fonts self-hosted; the web app makes no third-party requests.

### Authentication (Phase 8)

Details, rationale and limitations: [auth.md](auth.md).

- Passwords hashed with **Argon2id**; generic sign-in errors and a dummy hash
  verification for unknown emails (no account enumeration by message or timing).
- **Server-side sessions in PostgreSQL** (the essential dependency, so Redis stays
  optional), referenced by an opaque 256-bit token in an
  `HttpOnly; SameSite=Lax` cookie (`Secure` and `__Host-` prefixed in
  production). Only the token's SHA-256 is stored. No JWTs, and nothing about the
  session in browser storage. No signing secret is needed, so the reserved
  `SESSION_SECRET` was dropped.
- Rotation on sign-in, revocation on sign-out, "sign out everywhere", 7-day idle
  and 30-day absolute expiry, hourly cleanup.
- CSRF: `SameSite=Lax` plus an `Origin` allow-list check on every state-changing
  request, plus JSON-only bodies.
- Per-IP limits on sign-in and registration, plus a per-email limit on failed
  sign-ins.
- Authorization in services: every account query is scoped to the session's
  `userId`; another user's records return 404.

### Search (Phase 9)

Details: [search.md](search.md).

- Public, user-independent search: no session, nothing personal stored or cached.
- Offer pages (Phase 10) read the offer from the server's stored search by
  search id and result id; prices or provider references in a URL are never
  trusted. The results-page context carried in offer links (`from`) is only
  used as query parameters on a fixed path, so it can't cause open redirects.
- Strict per-category validation before any provider runs; per-IP search rate
  limit; 100 kB bodies; the `Origin` check applies to `POST /search`.
- Providers run with bounded concurrency and hard time limits; every result is
  re-validated against the contract and the provider's identity; one failing
  provider can't fail or hang the search. No retries inside a search.
- No outbound URLs from requests; adapters call only their configured endpoint.
  Credentials stay in API env (never `VITE_*`); `GET /providers` exposes no
  configuration values.
- Logs carry category, status, counts and durations only: no request bodies,
  traveller details or supplier payloads.
- Demo providers are off in production unless `SEARCH_DEMO_PROVIDERS=true`, so
  fixtures can't pass for live inventory by accident; fault simulation exists
  only in test code.

## Planned approach for later phases

### Authentication extensions

- Email verification and password reset with single-use, hashed, short-lived
  tokens; a reset revokes all sessions.
- Password change requiring the current password; re-authentication before
  sensitive changes (email, payment methods).
- OTP or passkeys may be added alongside passwords; they get the same
  per-account rate limits.

### Payments

- PCI scope stays with the PSP: hosted fields or a redirect/checkout page. Card data
  never touches Wayora servers, logs or the database.
- Order totals are computed server-side in `bigint` minor units. The client never
  sends a price we trust.
- `Idempotency-Key` required on payment and order creation, stored in
  `idempotency_keys` with a request hash. Same key with a different body returns
  `409 CONFLICT`.
- PSP webhooks: verify the signature over the raw body, check timestamp tolerance,
  store in `webhook_events` before processing, process in the worker, and treat the
  webhook (not the browser redirect) as the source of truth.
- Refunds and status changes are written to `audit_logs`.

### Travel provider integrations

- Credentials only in API/worker env (later, a secrets manager), never in the
  repository, never in `VITE_*`.
- Each provider sits behind an adapter interface with timeouts, retries with
  backoff, and circuit breaking, so a slow supplier cannot exhaust API workers.
- Provider responses are validated with Zod at the boundary before use.
- Outbound calls are restricted to known provider hosts (egress allow-list in production).
- Sensitive traveller data (passport numbers, DOB) sent to providers is minimised,
  encrypted at rest with field-level encryption, and subject to a retention policy.

### Operations

- TLS everywhere; HSTS on the web origin.
- Separate database roles: migrations role (DDL) vs application role (DML only).
- Centralised error reporting with PII scrubbing.
- Dependency updates and `npm audit` in CI; `npm run check` as the merge gate.
- Backups with point-in-time recovery for PostgreSQL; AOF persistence for Redis queues.

## Reporting

Until a security contact is published, report issues privately to the repository
owners. Do not open public issues for vulnerabilities.
