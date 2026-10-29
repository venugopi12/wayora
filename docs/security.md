# Security considerations

Authentication (email + password, server-side sessions) shipped in Phase 8; see
[auth.md](auth.md) for its full design. Payments exist only with a simulated demo
provider (Phase 13, [payments.md](payments.md)); real gateways and live travel
providers are not built yet. This document records the controls in place now and the approach decided
for later phases, so they are built the same way from day one.

## In place now

### Configuration and secrets

- Every app validates its environment at startup with Zod and exits with a clear
  list of problems (variable names and reasons, never values). Misconfiguration
  never reaches runtime.
- **Production refuses development defaults** (Phase 16): with `NODE_ENV=production`
  the API won't start if `DATABASE_URL`/`REDIS_URL` contain the local development
  password, if `CORS_ORIGIN`, `WEB_ORIGIN` or `API_BASE_URL` aren't HTTPS, or
  without Redis; the worker won't start without `DATABASE_URL`, with the
  development password, or with a non-HTTPS `WEB_ORIGIN`. Demo inventory and demo
  payments are off unless enabled explicitly. Valid but risky choices
  (`TRUST_PROXY=false`, demo providers or payments on) are logged as warnings at
  start-up.
- **The web build refuses an implicit API URL**: a production `npm run build`
  needs `VITE_API_BASE_URL` set, HTTPS (plain http only for localhost), with no
  credentials or query (`apps/web/config/security-headers.ts`).
- `.env` files are git-ignored. Only `.env.example` files with obviously
  local-only placeholders are committed.
- **Browser bundle boundary:** only `VITE_*` variables reach the web app, and the
  only one is the public API URL. Provider keys, PSP keys, database and Redis URLs
  exist only in `apps/api` / `apps/worker` env.
- Docker Compose binds PostgreSQL and Redis to `127.0.0.1` only.

### HTTP

- **API headers** (`apiSecurityHeaders` in `apps/api/src/app.ts`): the API serves
  JSON only, so its CSP is `default-src 'none'; frame-ancestors 'none'; base-uri
'none'; form-action 'none'`, plus `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`.
  HSTS (1 year, subdomains) only in production, where every origin is HTTPS.
  `X-Powered-By` disabled.
- **Web headers** (`apps/web/config/security-headers.ts`): a CSP with
  `script-src 'self'` (no inline scripts, no eval — Zod's compiled parsers are
  switched off for it, `apps/web/src/lib/zod.ts`), `connect-src` limited to the API
  origin, `object-src 'none'`, `frame-ancestors 'none'`; `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy`, `Permissions-Policy`. `style-src` allows inline
  styles because Radix dialogs inject a scroll-lock `<style>` at runtime. The
  build embeds the CSP as a `<meta>` tag (so it holds on any host); the server in
  front of `dist/` must send the full set ([deployment.md](deployment.md#web-server-headers)).
  Verified in a browser: no CSP violations across every journey, and framing by
  another origin is refused.
- CORS allow-list from `CORS_ORIGIN`; `*` is rejected by env validation because
  credentials are enabled.
- JSON bodies limited to 100 kB. Malformed JSON returns `INVALID_JSON`, not a stack trace.
- Rate limiting per client IP, shared through Redis. **Redis failure policy:**
  limits fall back to per-process in-memory counters (still enforced, but per
  instance), never to "no limits"; the switch is logged once a minute.
  `TRUST_PROXY` must be set correctly behind a load balancer so clients cannot
  spoof IPs via `X-Forwarded-For` (production warns when it's off).
- Stricter limits on sensitive endpoints: sign-in/registration per IP and failed
  sign-ins per email (15 min), searches per IP, and per signed-in user: booking
  writes, payment writes, (Phase 16) notification writes
  (`NOTIFICATION_RATE_LIMIT_MAX`) and (Phase 18) trip-planner writes
  (`PLANNER_RATE_LIMIT_MAX`). Profile and saved-traveller writes rely on the
  API-wide limit (and travellers are capped at 20 per account).
- Strict query schemas reject unknown parameters.
- Inbound `X-Request-Id` values are accepted only if they match a short safe pattern
  (prevents log injection).
- Unexpected errors return a generic message plus request ID; internals are logged,
  not exposed (except in local development).
- Public readiness (`/health/ready`) says _that_ a dependency failed ("Not
  responding" or "Timed out after … ms"), never the driver's message (hosts, IPs,
  ports); the scrubbed reason goes to the logs, at most once a minute per
  dependency.

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

- Structured JSON logs (timestamp, level, service, version, environment) with
  request IDs.
- Redaction of `authorization`, `cookie`, `set-cookie`, `x-api-key` and any
  `password`, `confirmPassword`, `currentPassword`, `passwordHash`, `token`,
  `sessionToken`, `tokenHash`, `accessToken`, `refreshToken`, `secret`,
  `cardNumber`, `cvv` fields. Request bodies are never logged.
- Request bodies and job payloads are not logged. Access logs keep the path and
  the _names_ of query parameters, never their values (admin searches by email).
- Error text is scrubbed before logging (`apps/api/src/utils/log-safety.ts`):
  credentials in any URL (`postgresql://user:pass@…`), bearer tokens and
  secret-looking pairs are masked; ORM errors keep their first and last lines
  (the failed query's values in between are dropped), stack frames and the
  model/constraint names.
- The worker's logs redact credentials and personal fields (`email`, names,
  phone), and scheduled-job successes are debug-level, so production logs stay
  quiet.

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

### Admin dashboard (Phase 15)

Details: [admin.md](admin.md#security).

- Roles `USER` / `SUPPORT` / `ADMIN` with one permission map; every admin
  endpoint checks its permission on the server, using the role of the user
  row loaded from the database for this request. Client-sent roles are
  ignored (headers, query) or rejected (`400` from strict profile and
  registration schemas); hiding links in the web app is presentation only.
- Roles change only through the provisioning script (no UI or API); the
  last active administrator can't be demoted; a database trigger audits
  every role change with actor and reason.
- Read-only: no admin write endpoints. Responses are `no-store`, exclude
  credentials, tokens, idempotency keys, raw provider payloads and phone
  numbers (masked), and are paginated and bounded.
- Audited: staff sign-ins, denied admin requests, detail views, role changes.
  The audit log stays append-only and is readable by administrators only.
- The health page reports states and counts, never connection strings,
  hosts, versions or error text; the worker is "up" only from its own
  heartbeat.
- Search analytics store no user, IP, route, dates or traveller data.

### Trip tracking (Phase 17)

Details: [trips.md](trips.md).

- Every trip endpoint, including the live-update stream, needs a session and
  checks booking ownership; another user's booking is 404. The stream
  re-checks the session every minute, ends on sign-out, and is capped per
  user.
- Users can't write travel status or disruptions (no endpoints); only
  validated provider observations create them. Refreshes need a trusted
  `Origin`, are rate-limited per user and throttled per booking.
- Provider answers are validated before use; provider text is never stored
  or shown (normalized error codes only; logs scrubbed). Simulated data is
  labelled everywhere, and Wayora never cancels, rebooks or refunds because
  of a disruption.
- Live-update messages carry ids only; browsers re-read through the
  authorized endpoints. Timeline rows are append-only.

### Trip planner (Phase 18)

Details: [planner.md](planner.md).

- Every planner endpoint needs a session and looks plans up by (id, owner):
  another user's plan or activity is a 404 with the same message as a
  missing one, for reads and for every write (edit, move, reorder, duplicate,
  delete), including attempts routed through the attacker's own plan.
- Strict request schemas: ownership, ids, versions and timestamps can't be
  mass-assigned. Free text is length-limited, refuses control characters and
  bidirectional overrides, and is rendered as text only.
- Writes need a trusted `Origin`, are rate-limited per user
  (`PLANNER_RATE_LIMIT_MAX`), run in transactions that lock the plan, and
  creating POSTs are idempotent. A reorder must match the day exactly.
- A linked booking must be the user's own and confirmed; a database trigger
  enforces same-owner links too. Linking never changes the booking.
- Plan contents (titles, notes, places) are never logged.

### Plan collaboration (Phase 19)

Details: [planner.md](planner.md#collaboration).

- Access (owner, editor, viewer) is resolved from the database on every
  request, after locking the plan row for writes. Non-members get the same
  404 as for a missing plan; a role that doesn't allow an action gets 403.
  Removal takes effect on the next request, including open live streams
  (re-checked before each message, failing closed).
- One owner per plan, enforced by database triggers (the owner can't be a
  member or invitee; `planned_trips.user_id` can't change). `owner` is never
  an accepted role value; only the owner changes roles.
- Invitations are bound to one existing account and usable only by it,
  signed in: no bearer tokens, no public links. One open invitation per
  person and plan (unique index); accepting is atomic; closed invitations
  can't be reused. Invitations are rate limited per user per hour
  (`PLANNER_INVITE_RATE_LIMIT_MAX`).
- Members see display names only; the owner sees invitees' emails masked.
  History stores ids, roles, field names and activity titles — no emails or
  notes — and is append-only.
- Known exposure: inviting by email tells the owner whether an address has
  an active account (as registration already does), bounded by the invite
  rate limit.

### Plan budget and expenses (Phase 20)

Details: [planner.md](planner.md#budget-and-expenses).

- Same access check as collaboration on every request (non-members 404,
  wrong role 403); editors change only expenses they added, viewers only
  record payments they're part of. Everyone on an expense or payment must be
  a member; ids from another plan are refused.
- Strict bodies: no `tripId`, `createdById`, `parts`, `version` (except as
  the edit's base) or other server-owned fields are accepted.
- Money is integer minor units end to end; totals are checked by the API and
  again by deferred database triggers. Balances are computed server-side from
  saved rows.
- **No money movement**: no payment provider is called; suggestions and
  recorded payments are never presented as transfers Wayora made. No
  exchange rates are used.
- Notes are visible to plan members but never logged or copied into the
  history. Members see display names only.

### Travel assistant (Phase 21)

Details: [assistant.md](assistant.md).

- Provider credentials (`AI_API_KEY`) exist only in the API process: a true
  private field in the adapter, redacted from logs, never in responses,
  errors or `VITE_*` variables. Configuration errors name variables only.
- Conversations belong to one user (404 for anyone else); a conversation
  about a plan needs current view access on every request, and removal
  takes effect at once.
- Context sent to a provider is minimal and built server-side after the
  access check: no names, emails, ids, notes, expense details, booking
  references, payment data or tokens.
- Prompt injection: user-written content is sent as escaped JSON data,
  separate from the rules; the model can only return contract block types,
  refers to activities by opaque references, and cannot change anything.
- Model output is validated block by block and rendered as text, never HTML.
- Changes require a separate request with `confirm: true`, an
  Idempotency-Key and the user's normal role (viewers can't), through the
  planner/budget services with their version checks. No booking, payment,
  refund, settlement or provider action is reachable from the assistant.
- Abuse and cost: per-user per-minute and 24-hour limits, one reply at a
  time per conversation, bounded input/output, one overall timeout, bounded
  transient-only retries. Prompts and outputs are never logged or stored.

### Travel supplier readiness (Phase 22)

Details: [providers.md](providers.md). No live supplier is integrated.

- Supplier settings are read from the API environment only (`readProviderConfig`);
  `.env.example` has placeholders, never values. Secrets are `ProviderSecret`
  objects that print `[redacted]` in JSON, strings and inspection; only the
  adapter's header code calls `reveal()`.
- URL settings must be absolute http(s) with no embedded credentials (https
  required in production); adapters call only their configured base URL, never
  a URL from a request, and redirects are refused.
- Supplier error bodies are never read; error messages hold provider id,
  method, path and status only (no query string, headers or payload) and are
  scrubbed before logging. Users see fixed wording per error code.
- Payloads are schema-validated before mapping and every result again against
  the contracts; money is converted exactly or the offer is dropped.
- Supplier offers can't be booked (`SERVICE_UNAVAILABLE` before any write); no
  supplier booking, ticketing or payment call exists. Retries apply to read
  operations only.
- Admin health shows provider ids, kinds and counts only: no settings or
  supplier text; a provider with no recent calls is "unknown".

### Booking lifecycle and supplier reservations (Phase 23)

Details: [bookings.md](bookings.md#supplier-reservations-phase-23),
[payments.md](payments.md#refunds), [admin.md](admin.md#supplier-reservations-phase-23).
No real supplier implements reservations.

- **Ownership.** Every booking read, cancel and payment route resolves the
  booking by `(reference, session user)`. Another user's booking is
  "not found" (tested for supplier bookings too).
- **Staff.**
  - Staff reads need `admin.bookings.read`; the two reservation actions need
    `admin.reservations.manage` (admins only), checked on the server and
    audited.
  - Support staff see supplier references masked to their last four
    characters.
- **Never from the client.** Price, currency, supplier status, supplier
  reference, tickets and refund status or amount are never taken from a
  request (strict schemas).
- **From server records only.** A reservation request is built only from the
  booking's immutable snapshot and records. A refund amount is always the
  payment's (trigger).
- **Supplier answers are untrusted input.**
  - Validated by schema (references printable and bounded, document types
    closed, integer money).
  - Anything unusable makes the outcome unknown, never a success.
  - Supplier text is never shown or stored; only normalized error categories
    are.
- **Database guards.**
  - One reservation per booking; unique idempotency and cancellation keys.
  - A supplier reference is unique per provider and set once.
  - A supplier booking can't be confirmed, cancelled or failed unless its
    reservation is.
  - Documents only for confirmed reservations, and immutable.
  - One open refund per payment; refund amount and currency equal the
    payment's.
  - Append-only history.
- **Transactions and races.**
  - Every status change is a conditional update in a transaction with its
    history, notification and audit entry.
  - Supplier calls happen outside transactions, after a committed claim.
  - Recovery leases rows with conditional updates. No in-memory locks.
- **Timeouts.** Each supplier call has `SUPPLIER_RESERVATION_TIMEOUT_MS`. A
  timeout is an unknown outcome, never a failure, and never triggers a blind
  resend.
- **Logs.** They carry booking references, provider ids, operations, outcome
  categories, durations and correlation ids. Never traveller names, phone
  numbers, payloads or credentials. The staff-only resolution reason is kept
  in the audit log only.

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
- Automated dependency updates (CI already runs lint, format, typecheck, tests
  with PostgreSQL and Redis, `npm audit --omit=dev --audit-level=high` and the
  build on every push and pull request).
- Backups with point-in-time recovery for PostgreSQL; AOF persistence for Redis queues.

## Reporting

Until a security contact is published, report issues privately to the repository
owners. Do not open public issues for vulnerabilities.
