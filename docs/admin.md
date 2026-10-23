# Admin dashboard and platform operations (Phase 15)

An internal, staff-only dashboard at `/admin` for understanding platform
activity, helping customers and checking that background work is healthy.
It is **read-only**: no page or endpoint changes a booking, payment or
account. Everything it shows comes from the database (or Redis, for worker
and queue health); anything the system doesn't know is shown as unavailable,
never filled in.

- [Scope](#scope)
- [Roles and permissions](#roles-and-permissions)
- [Provisioning staff](#provisioning)
- [API](#api)
- [Metrics: definitions](#metrics)
- [Search activity](#search-activity)
- [Platform health](#platform-health)
- [Audit log](#audit-log)
- [Web](#web)
- [Database](#database) and [rollback](#rollback)
- [Security checklist](#security)
- [Known limitations](#limitations)

## Scope

| Area            | What staff can do                                                                                                      | What deliberately doesn't exist                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Overview        | Counts for a 24h / 7d / 30d UTC window, recent activity                                                                | Revenue from demo payments                                          |
| Users           | List, filter (name/email/id, role, status), page, view one account                                                     | Editing, suspending, deleting, impersonating, role changes          |
| Bookings        | List, filter (reference, category, status, dates, user), view one booking with history, payments and notifications     | Cancelling, confirming or changing a booking; contacting a supplier |
| Payments        | List, filter (payment id or booking reference, status, mode, dates), view one attempt with history and provider events | "Mark as paid", refunds, retries                                    |
| Search activity | Volume by category/outcome, hourly/daily series, provider call stats                                                   | Routes, dates, travellers or who searched                           |
| Notifications   | Created notifications by type, email deliveries by status                                                              | Re-sending, editing                                                 |
| Audit log       | Filter and page the audit trail (administrators only)                                                                  | Editing or deleting entries                                         |
| Platform health | API, database, Redis, worker heartbeat, queue, email outbox, payments in progress                                      | Connection strings, hosts, versions, environment values             |

Write actions are out of scope for this phase on purpose: each one (refund,
cancellation, suspension) needs its own rules, confirmation, audit and tests,
and none of them can be honest yet for demo bookings and payments.

## Roles and permissions

`users.role` is `USER` (default for every account), `SUPPORT` or `ADMIN`.
The mapping lives in one place, `packages/contracts/src/admin.ts`
(`ROLE_PERMISSIONS`), shared by the API (which enforces it) and the web app
(which only hides what a role can't use).

| Permission                 | user | support | admin |
| -------------------------- | ---- | ------- | ----- |
| `admin.overview.read`      | –    | ✓       | ✓     |
| `admin.users.read`         | –    | ✓       | ✓     |
| `admin.bookings.read`      | –    | ✓       | ✓     |
| `admin.payments.read`      | –    | ✓       | ✓     |
| `admin.search.read`        | –    | ✓       | ✓     |
| `admin.notifications.read` | –    | ✓       | ✓     |
| `admin.health.read`        | –    | ✓       | ✓     |
| `admin.audit.read`         | –    | –       | ✓     |

Enforcement (`apps/api/src/modules/admin/access.ts`):

- Every admin route has `requirePermission(…)` in front of it, before
  validation, so a refused request learns nothing about the endpoint.
- The role is read from the **user row loaded from the database on this
  request** by the session middleware (session valid, unrevoked, unexpired,
  user `ACTIVE`). Nothing from the request — body, query, headers, cookies
  other than the session, client state — can name a role, user id or
  permission. A role change or suspension takes effect on the very next
  request (tested).
- No session: `401 UNAUTHENTICATED`. Signed in without the permission:
  `403 FORBIDDEN`, and the denial is audited (`admin.access_denied`, with the
  route pattern, never the query string).
- `PATCH /users/me` and registration accept only their listed fields (strict
  schemas): sending `role`, `permissions` or `isAdmin` is a `400`, so no one
  can promote themselves (tested).

## Provisioning

There is no role-management UI or API. Roles are changed by an operator with
database access, using a server-side script:

```bash
# The person signs up normally first; then:
npm run admin:role -- --email ops@example.com --role admin --reason "On-call lead"
npm run admin:role -- --email helper@example.com --role support --reason "Support rota"
npm run admin:role -- --email helper@example.com --role user --reason "Left the team"
npm run admin:role -- --list
```

It uses `DATABASE_URL` from `apps/api/.env` or the environment.

- `--reason` is required and recorded; `--actor` defaults to `cli:<os user>`.
- **The last active administrator can't be demoted** (or demoted by two
  concurrent runs: active admin rows are locked first). Make another account
  an administrator first.
- Only `ACTIVE` accounts can be given a staff role.
- Every change is audited **by the database itself**: trigger
  `users_role_change_audited` writes `user.role_changed` with
  `{from, to, reason}` and the actor, whatever made the change (the script
  sets `wayora.actor_id` / `wayora.reason` for its transaction; a change made
  by hand in SQL is still recorded, with no actor).
- The first administrator of a fresh deployment is created the same way.

## API

All `GET`, under `/api/v1/admin`, `Cache-Control: no-store`, strict query
validation (unknown parameters are `400`), pages of at most 100 rows.

| Path                                            | Permission    | Query                                                                                                          |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `/admin/me`                                     | overview      | –                                                                                                              |
| `/admin/overview`                               | overview      | `range=24h\|7d\|30d` (default `7d`)                                                                            |
| `/admin/users`, `/admin/users/:userId`          | users         | `q`, `role`, `status`, `page`, `pageSize`                                                                      |
| `/admin/bookings`, `/admin/bookings/:reference` | bookings      | `reference` (prefix), `serviceType`, `status`, `userId`, `from`, `to` (UTC days, ≤ 1 year), `page`, `pageSize` |
| `/admin/payments`, `/admin/payments/:paymentId` | payments      | `q` (payment id or booking-reference prefix), `status`, `mode`, `from`, `to`, `page`, `pageSize`               |
| `/admin/search-analytics`                       | search        | `range`                                                                                                        |
| `/admin/notifications`                          | notifications | `range`                                                                                                        |
| `/admin/audit-logs`                             | audit         | `action` (prefix), `actorId`, `entityType`, `entityId`, `from`, `to`, `page`, `pageSize`                       |
| `/admin/health`                                 | health        | –                                                                                                              |

Response schemas: `packages/contracts/src/admin.ts`. Detail views write an
audit entry (`admin.user_viewed`, `admin.booking_viewed`,
`admin.payment_viewed`).

What detail views never include: password hashes, session tokens or their
hashes, idempotency keys, raw provider payloads or signatures, phone numbers
(bookings show the last four digits), traveller dates of birth or
nationalities, saved-traveller details. Travellers on a booking are shown by
name only.

## Metrics

All windows are rolling and in **UTC** (`from`, `to` and `timezone` are in
every response). Counts are `COUNT`/`GROUP BY` in PostgreSQL over indexed
columns; nothing loads whole tables.

| Metric            | Definition                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users             | All accounts; "new" = created in the window                                                                                                                                                                                                                    |
| Bookings in range | Created in the window, grouped by their **current** status; "demo" vs "real" from `bookings.is_demo`                                                                                                                                                           |
| Payment attempts  | Attempts created in the window, by status and mode (`demo`/`live`); declined attempts count                                                                                                                                                                    |
| Real revenue      | Sum of `LIVE` payments `SUCCEEDED` or `REFUND_PENDING`, completed in the window, per currency. **Demo payments are never counted.** With no live provider this is empty, and the overview says why                                                             |
| Searches          | Rows in `search_events` in the window (see below)                                                                                                                                                                                                              |
| Conversion        | Distinct search sessions recorded in the window from which at least one booking (any status) was created (`bookings.search_id`) ÷ distinct recorded search sessions. `null` with no searches. All bookings are demo bookings today, and the definition says so |

## Search activity

Search sessions live in Redis and expire, so they can't be used for history.
Since Phase 15 each search request writes one row to `search_events` after
it answers: category, outcome (`SUCCESS`, `PARTIAL` some providers failed,
`EMPTY` no matching results, `FAILED` with the error code), result count,
duration, the search session id, and the provider calls made
(`[{id, status, durationMs}]`; empty when an earlier session was reused).

Deliberately **not** recorded: who searched, IP, user agent, routes,
destinations, dates, traveller counts or names, request bodies. Invalid
requests (`400`) aren't searches; a visitor who left mid-search isn't a
failure. The write is fire-and-forget: if it fails it is logged and the
search answers normally (tested).

History starts empty when Phase 15 is deployed. Views show "recorded since
…", omit periods before tracking began, and never invent earlier searches.
A provider listed under search activity has only been _called_; current
availability is shown per search and on the health page, never inferred from
configuration.

## Platform health

`GET /admin/health` (and `/admin/health` in the web app) reports states and
counts only; failures are logged server-side, not returned. Each check has a
time limit (`HEALTH_CHECK_TIMEOUT_MS`), and the report is cached in memory
for 10 seconds (it is identical for every staff member, so caching can't leak
anything user-specific).

| Check        | How                                                                     | States                                                    |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| API          | The process answering                                                   | up                                                        |
| Database     | `SELECT 1`                                                              | up / down                                                 |
| Redis        | `PING`                                                                  | up / down / not-configured                                |
| Worker       | The worker's own heartbeat (below)                                      | up / down / unknown                                       |
| Queue        | BullMQ key sizes for `wayora-system` (waiting, active, delayed, failed) | up / degraded (> 1000 waiting) / unknown / not-configured |
| Email outbox | `notification_deliveries` by status, oldest pending                     | up / degraded (oldest > 15 min) / unknown                 |
| Payments     | Attempts `CREATED`/`PENDING`, oldest                                    | up / degraded (oldest > 15 min) / unknown                 |

**Worker heartbeat.** Redis being reachable says nothing about the worker.
While its job loop is running (`worker.isRunning()` and not paused) the
worker writes `{"at": "<ISO time>"}` to `wayora:worker:heartbeat` every 15
seconds with a 60-second expiry (`apps/worker/src/liveness/beacon.ts`). No
key or a timestamp older than 60 seconds = **down**; Redis unreadable =
**unknown** (never "up"). The value holds a timestamp only.

The public `/health` (liveness) and `/health/ready` (readiness) endpoints are
unchanged; this page is the protected, operator view.

## Audit log

`audit_logs` is append-only (database trigger since the initial migration: no `UPDATE` or
`DELETE`); there is no endpoint that writes or edits it, and reading it needs
`admin.audit.read` (administrators only). Phase 15 added these writers to the
existing table (no second audit system):

| Action                                                              | When                                          | Metadata                               |
| ------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `admin.sign_in`                                                     | A support or admin account signs in           | `{role}`                               |
| `admin.access_denied`                                               | A signed-in user is refused an admin endpoint | `{method, path (route pattern), role}` |
| `admin.user_viewed`, `admin.booking_viewed`, `admin.payment_viewed` | A staff member opens a detail view            | `{role}`                               |
| `user.role_changed`                                                 | Any change of `users.role` (database trigger) | `{from, to, reason}`                   |

Existing writers (bookings, payments, provider events) are unchanged. No
entry contains passwords, cookies, tokens, card data or secrets; IP addresses
and user agents aren't recorded.

## Web

- `/admin…` is a focused layout (sibling of the marketing layout), behind
  sign-in, in its own code-split chunks (customers never download it).
- Ordinary users see "You don't have access" and the app never calls the
  admin API for them. Staff get the sections `GET /admin/me` grants; a page
  the role can't use shows "no access" without requesting data; if the
  server refuses a request (role revoked meanwhile), the page shows "no
  access" too.
- An "Admin dashboard" link appears in the account menu and mobile drawer for
  staff only.
- Lists keep filters and page in the URL (shareable, back/forward work).
  Loading, empty, not-found, error-with-retry and invalid-filter states
  everywhere. Times are shown in UTC, labelled.
- Responsive: side navigation from `lg`, a menu sheet below it; tables
  scroll sideways inside a focusable region, never the page. Checked with
  axe (WCAG 2.1 AA + best practices) at 1280 px and 390 px.
- Cached admin responses live under the `account` query key, so signing out
  drops them; no admin data is stored in browser storage.

## Database

Migration `20261025000000_admin` (additive):

- `user_role` enum and `users.role` (`NOT NULL DEFAULT 'USER'`): every
  existing account becomes an ordinary user.
- `search_outcome` enum and `search_events` (CHECKs: non-negative counts,
  `providers` is a JSON array, `error_code` present exactly when the outcome
  is `FAILED`).
- Indexes for the admin lists and windows: `users(role)`,
  `users(created_at)`, `bookings(created_at DESC)`, `bookings(search_id)`,
  `payments(created_at DESC)`, `audit_logs(action, created_at)`,
  `search_events(created_at)`, `(category, created_at)`, `(search_id)`.
- Trigger `users_role_change_audited` (above).

Apply with `npm run db:migrate:deploy`, then provision the first
administrator with `npm run admin:role`.

### Rollback

```sql
BEGIN;
DROP TRIGGER IF EXISTS "users_role_change_audited" ON "users";
DROP FUNCTION IF EXISTS "users_audit_role_change"();
DROP TABLE IF EXISTS "search_events";
DROP INDEX IF EXISTS "users_role_idx", "users_created_at_idx", "bookings_created_at_idx",
  "bookings_search_id_idx", "payments_created_at_idx", "audit_logs_action_created_at_idx";
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
DROP TYPE IF EXISTS "user_role";
DROP TYPE IF EXISTS "search_outcome";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025000000_admin';
COMMIT;
```

Then deploy the Phase 14 code (API, web and worker). Audit entries written
by Phase 15 stay (the table is append-only); search history is lost. Tested:
rollback leaves exactly the Phase 14 schema, and re-applying the migration
works, with existing accounts as `USER`.

## Security

- [x] Server-side permission check on every admin endpoint; role from the
      database per request; client-sent roles ignored or rejected.
- [x] No self-promotion (strict profile/registration schemas); provisioning
      only by the audited script; last administrator protected.
- [x] Read-only: no admin writes exist (any `POST`/`PUT`/`PATCH`/`DELETE` is
      `404`; cross-origin writes are refused by the CSRF check first).
- [x] No secrets or unnecessary personal data in responses (tested against
      password hashes, token hashes, idempotency keys, phone numbers,
      connection strings).
- [x] `no-store` on every admin response; brief server-side cache only for
      the user-independent health report.
- [x] Bounded, validated queries; counts in the database; pagination
      everywhere.
- [x] Audit log append-only and restricted to administrators.
- [x] General API rate limit applies to admin endpoints.

## Limitations

- No write actions (refunds, cancellations, suspensions, role UI): deliberate
  for this phase.
- Search history starts at deployment; there is no backfill.
- Conversion counts any booking from a search session, demo included; with
  real suppliers it should be split by demo/real and status.
- Health thresholds (15 minutes, 1000 waiting jobs) are fixed constants.
- The heartbeat proves the worker's loop is running, not that every job type
  succeeds; failed jobs are counted but not listed.
- Staff sign-ins are audited, but there is no separate staff session policy
  (shorter timeouts, MFA) yet.
