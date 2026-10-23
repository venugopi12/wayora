# Security considerations

Authentication (email + password, server-side sessions) shipped in Phase 8; see
[auth.md](auth.md) for its full design. Payments exist only with a simulated demo
provider (Phase 13, [payments.md](payments.md)); real gateways and live travel
providers are not built yet. This document records the controls in place now and the approach decided
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

### Web build

- Production source maps are `hidden` (no `sourceMappingURL` in the bundle) and
  moved out of `apps/web/dist` into the git-ignored `apps/web/sourcemaps/` by
  `apps/web/scripts/extract-sourcemaps.mjs`. The build fails if a map file or a
  map reference is left in `dist/`, so deploying `dist/` never publishes the
  original source. Keep the maps for debugging or an error tracker's private
  upload; the dev server always has full source maps.
- The build also fails if development-only routes (the design-system showcase)
  leak into the bundle.

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
- Providers run with bounded concurrency, per-call time limits inside one
  deadline, retries only for transient failures of read-only calls (backoff
  with jitter) and a circuit breaker per provider; every result is
  re-validated against the contract, the provider's identity and integrity
  rules (offer id = provider + reference, one currency per price); one
  failing provider can't fail or hang the search.
- Search sessions (Phase 11) live in Redis with a TTL and hold only offers and
  provider statuses: no request data, nothing about the visitor, no secrets.
  Every read is schema-validated; tampered or corrupted entries are deleted,
  never served. Production refuses in-memory sessions; a Redis outage is a
  503, not a silent fallback.
- Offer lookups accept only a search id and an offer id (strict query: a
  price, currency or provider reference in the URL is a 400) and check the
  session, category and membership before returning the server's copy; see
  [search.md](search.md#offer-validation).
- Clients get stable codes and Wayora's own wording for provider and storage
  failures; supplier messages, bodies, URLs, credentials, stacks and Redis or
  database details never reach a response. Logs get a scrubbed class and
  message with `requestId` and `providerId` (URLs lose credentials and query
  strings; tokens, keys and passwords are masked).
- No outbound URLs from requests; adapters call only their configured endpoint.
  Credentials stay in API env (never `VITE_*`); `GET /providers` exposes no
  configuration values.
- Logs carry category, status, counts, durations, retries and breaker
  decisions only: no request bodies, traveller details or supplier payloads.
- Demo providers are off in production unless `SEARCH_DEMO_PROVIDERS=true`, so
  fixtures can't pass for live inventory by accident; fault simulation exists
  only in test code.

### Demo bookings (Phase 12)

Details: [bookings.md](bookings.md).

- Demo only: no supplier call, ticket, payment form or card field exists. The
  database refuses a supplier reference on a demo booking (no fake PNRs).
- Every route needs a session; writes also need a trusted `Origin` (CSRF).
  The user is the session's user; no request field names a user (strict
  schemas reject `userId` and any other unknown field).
- Ownership on every read and write (`WHERE reference = ? AND user_id = ?`);
  another user's booking answers 404 exactly like a missing one, so
  references can't be probed (no IDOR). References are random (CSPRNG,
  31-character alphabet, 8 characters) and are not database ids.
- The price is the server's: the offer is read again from the stored search,
  and the browser's `acceptedPrice` is only compared (mismatch: 409, nothing
  booked). Only demo-source, priced offers are bookable. Nothing is booked by
  opening a page; creation needs `acceptDemoTerms: true` and a POST.
- `Idempotency-Key` required, scoped per user, with a body hash; concurrent
  duplicates get 409 and create nothing; the key completes inside the booking
  transaction. Per-user write rate limit (`BOOKING_RATE_LIMIT_MAX`).
- Transitions are server-side and conditional on the current status; booked
  facts, travellers and status history are immutable in the database
  (triggers); every change is in `audit_logs`.
- Personal data (names, phone) appears only in booking bodies and responses
  (`Cache-Control: no-store`), never in URLs, logs or analytics. The API
  logger redacts `travellers`, `firstName`, `lastName`, `contactPhone`,
  `phone` and `dateOfBirth`; booking logs carry the reference, category,
  provider and party size only. Idempotency records store only the reference.
- The web app keeps traveller details in memory only (not in the URL or
  browser storage).

### Payments (Phase 13)

Details: [payments.md](payments.md).

- Demo provider only: a simulator in the API process, no network calls, no
  money, no card/bank/token fields anywhere (contracts, database or UI).
  Every demo payment carries "Demo payment — no real money was charged.";
  real-mode payments would carry none.
- The amount and currency come from the booking's record; the client's amount
  is only compared (`409 PAYMENT_AMOUNT_MISMATCH`). The client can't send a
  status (strict schema), and only the provider's events move an attempt to
  succeeded/failed/cancelled.
- Demo scenarios (decline, pending…) are accepted only when the server enables
  them (`PAYMENT_DEMO_SCENARIOS`, off in production by default, impossible with
  any other provider).
- No public callback can mark a payment successful: the demo provider has no
  webhook route (`/payment-events/demo` is a 404), and webhook routes exist only
  for providers that verify signatures over the raw body with timestamp
  tolerance; unverified or malformed events are refused before storage.
- Provider events are de-duplicated in `webhook_events`, applied only along
  allowed transitions (no regression from final states), and stored without
  raw bodies, signatures or personal data.
- Ownership on every query (`user_id` on payments); others' payments answer 404. Session, CSRF, per-user write limits (`PAYMENT_RATE_LIMIT_MAX`) and
  `Cache-Control: no-store` as for bookings.
- `Idempotency-Key` per user + booking + operation; partial unique indexes
  allow at most one in-progress and one successful payment per booking.
- Payment rows can't be deleted and their amount, booking, provider and
  reference can't change (triggers); status history is append-only.
- Logs carry payment ids, statuses and scrubbed provider errors, never keys,
  names or secrets (tested).

### Notifications (Phase 14)

Details: [notifications.md](notifications.md).

- Created only inside the transaction of the change they report, once per
  event (unique dedupe key); text written by Wayora, no traveller names,
  contact details or provider text; rendered as text (escaped in emails).
  Demo notifications never claim a reservation, ticket, real payment or refund.
- Every route needs a session; the recipient is the session's user; others'
  notifications are 404; writes need a trusted `Origin`; inputs are strict
  (`userId` in a query is a 400). Links lead only to the owner's own
  booking/payment pages, which check ownership again.
- Notification content can't be changed in the database (trigger), only its
  read time.
- The email outbox stores no addresses or bodies: the worker reads the address
  at send time; `last_error` holds a short code. No email provider or
  credentials exist; deliveries are recorded `NOT_CONFIGURED`, never `SENT`.

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
  `idempotency_keys` with a request hash, as demo bookings and payments already do (same key
  with a different body: `422 IDEMPOTENCY_KEY_REUSED`; still running: `409
IDEMPOTENCY_IN_PROGRESS`).
- PSP webhooks: verify the signature over the raw body, check timestamp tolerance,
  store in `webhook_events` before processing, and treat the webhook (not the
  browser redirect) as the source of truth. The boundary for this exists
  (`PaymentProvider.verifyEvent`, `PaymentEventProcessor`, payments.md#events);
  processing is in the API today, not the worker.
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
- Dependency updates and `npm audit` in CI (CI itself runs today: lint, format,
  typecheck, tests with PostgreSQL, build; `npm audit` is not a CI step yet).
- Backups with point-in-time recovery for PostgreSQL; AOF persistence for Redis queues.

## Reporting

Until a security contact is published, report issues privately to the repository
owners. Do not open public issues for vulnerabilities.
