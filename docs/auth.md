# Authentication and accounts (Phase 8)

Email-and-password accounts with server-side sessions, a profile, and saved
travellers. This document covers how it works, the security decisions, setup,
tests and what is deliberately not built yet.

## At a glance

| Concern            | Decision                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Passwords          | Argon2id (`@node-rs/argon2`), m = 19 MiB, t = 2, p = 1; re-hashed on login if parameters rise |
| Sessions           | Opaque 256-bit random token in an `HttpOnly` cookie; only its SHA-256 is stored (PostgreSQL)  |
| Session lifetime   | 7 days idle, 30 days absolute; revoked on sign-out; "sign out everywhere" revokes all         |
| CSRF               | `SameSite=Lax` cookie + `Origin` allow-list on every state-changing request + JSON-only APIs  |
| CORS               | Credentialed CORS only for origins in `CORS_ORIGIN` (never `*`)                               |
| Abuse              | Per-IP limit on sign-in/registration, per-email limit on failed sign-ins, generic errors      |
| Browser storage    | None for auth. No tokens or JWTs in `localStorage`/`sessionStorage`; JS can't read the cookie |
| Extra dependencies | One: `@node-rs/argon2` (prebuilt binaries, no compiler). No Redis requirement, no JWT library |

## Architecture

```text
apps/web                                   apps/api
────────                                   ────────
AuthProvider ── GET /auth/me (once) ─────▶ loadSession (cookie → SessionService.resolve)
  │  status: loading | authenticated |       │   res.locals.auth = { session, user } | absent
  │          unauthenticated                 ▼
RequireAuth / RedirectIfSignedIn         requireTrustedOrigin (Origin allow-list, unsafe methods)
LoginRoute / RegisterRoute ── POST ────▶ authRouter    /api/v1/auth/*      → AuthService
ProfileRoute / TravellersRoute ────────▶ usersRouter   /api/v1/users/me/*  → UsersService
services/account.ts (fetch, credentials)            SessionService ── Prisma ── sessions table
```

Backend (`apps/api/src/modules/`):

| File                       | Responsibility                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `auth/password.ts`         | Argon2id hash/verify (never throws), re-hash check, dummy verify for unknown users |
| `auth/session-token.ts`    | Token generation (32 random bytes, base64url) and SHA-256 hashing                  |
| `auth/session.service.ts`  | Create, resolve (+ sliding expiry), revoke one/all, purge expired                  |
| `auth/cookies.ts`          | Cookie name and attributes; set and clear with identical attributes                |
| `auth/auth.service.ts`     | Register, sign in (timing-equalized), generic failures                             |
| `auth/auth.routes.ts`      | Thin HTTP layer: validate (shared Zod contracts) → service → cookie → response     |
| `auth/safe-user.ts`        | The only user/traveller serializers: an allow-list of fields                       |
| `users/users.service.ts`   | Profile update and traveller CRUD, every query scoped by the session's `userId`    |
| `users/users.routes.ts`    | Thin HTTP layer for `/users/me`                                                    |
| `middleware/session.ts`    | `loadSession`, `requireAuth`, `noStore`                                            |
| `middleware/csrf.ts`       | `requireTrustedOrigin`                                                             |
| `middleware/rate-limit.ts` | `authAttemptLimiter`, `loginFailuresPerEmailLimiter`                               |

Shared contracts: `packages/contracts/src/auth.ts` (request/response schemas,
email normalization, password policy). The API validates with them; the web
forms use the same schemas through React Hook Form, so rules can't drift.

Frontend (`apps/web/src/`): `features/auth/` (provider, guards, redirect
validation, forms), `features/account/` (profile, travellers),
`features/navigation/AccountAction.tsx` (header menu and drawer states),
`components/layout/AuthLayout.tsx`, `services/account.ts`.

## Endpoints

All under `/api/v1`. Responses use the standard envelope
(`docs/api-conventions.md`). Every auth and account response sends
`Cache-Control: no-store`.

| Method | Path                                | Auth | Success                              | Notes                                       |
| ------ | ----------------------------------- | ---- | ------------------------------------ | ------------------------------------------- |
| POST   | `/auth/register`                    | –    | 201 `{ user }` + session cookie      | 409 on duplicate email; per-IP rate limit   |
| POST   | `/auth/login`                       | –    | 200 `{ user }` + new session cookie  | 401 generic; per-IP and per-email limits    |
| POST   | `/auth/logout`                      | –    | 200 `{ signedOut: true }`            | Idempotent; revokes and clears the cookie   |
| POST   | `/auth/logout-all`                  | yes  | 200 `{ signedOut, sessionsRevoked }` | Revokes every session of the user           |
| GET    | `/auth/me`                          | yes  | 200 `{ user }`                       | 401 when signed out                         |
| GET    | `/users/me`                         | yes  | 200 `SafeUser`                       |                                             |
| PATCH  | `/users/me`                         | yes  | 200 `SafeUser`                       | Only `name`; unknown fields → 400           |
| GET    | `/users/me/travellers`              | yes  | 200 `Traveller[]`                    | Oldest first                                |
| POST   | `/users/me/travellers`              | yes  | 201 `Traveller`                      | At most 20 per account (409 beyond)         |
| PATCH  | `/users/me/travellers/:travellerId` | yes  | 200 `Traveller`                      | 404 if missing **or owned by someone else** |
| DELETE | `/users/me/travellers/:travellerId` | yes  | 200 `{ id, deleted: true }`          | 404 likewise                                |

`SafeUser` = `{ id, name, email, emailVerified, createdAt }`. Password hashes,
token hashes, session ids and account status are never returned.

Identity always comes from the session cookie. No endpoint accepts a user id
from the client; another user's traveller id behaves exactly like a missing
one (404), so ids can't be probed.

## Session lifecycle

1. **Sign-in / registration** generates a token (32 bytes from
   `crypto.randomBytes`, base64url), stores `sha256(token)` in `sessions`, and
   sets the token in the cookie. A database leak therefore exposes no usable
   session. Any session the browser already held is revoked first (rotation:
   a pre-planted cookie can't become an authenticated session).
2. **Each request** with a cookie: the token's hash is looked up. The session is
   valid only if it is not revoked, `expiresAt` is in the future, and the user
   is `ACTIVE` (suspending a user ends their sessions immediately).
3. **Sliding expiry:** at most every 5 minutes, `lastActivityAt` is updated and
   `expiresAt` moves to `min(createdAt + 30 days, now + 7 days)`. The update is
   conditional (`revokedAt IS NULL`), so it can't resurrect a revoked session.
4. **Sign-out** sets `revokedAt` and clears the cookie (same name, path,
   `SameSite`, `Secure` and `HttpOnly` as when set). It is idempotent and works
   without a valid session. **Sign out everywhere** revokes all of the user's
   sessions.
5. **Cleanup:** the API deletes sessions that expired or were revoked more than
   a day ago, hourly (and once at startup), using the `expires_at` index. Run on
   several API instances it is harmless (idempotent `DELETE`).

| Setting                          | Default | Meaning                                         |
| -------------------------------- | ------- | ----------------------------------------------- |
| `SESSION_IDLE_TIMEOUT_HOURS`     | `168`   | Ends a session after this long without requests |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `720`   | Hard limit from sign-in, however active         |

The cookie's `Max-Age` equals the absolute limit; the server-side checks are
what actually decide.

## Cookie and CSRF strategy

| Attribute  | Development / test   | Production                      |
| ---------- | -------------------- | ------------------------------- |
| Name       | `wayora_session`     | `__Host-wayora_session`         |
| `HttpOnly` | yes                  | yes                             |
| `Secure`   | no (plain localhost) | yes                             |
| `SameSite` | `Lax`                | `Lax`                           |
| `Path`     | `/`                  | `/`                             |
| `Domain`   | not set (host-only)  | not set (required by `__Host-`) |

**Why `SameSite=Lax`:** the web app and API are same-site (localhost:5173 →
localhost:4000 in development; e.g. `wayora.example` → `api.wayora.example` in
production), so `Lax` cookies are sent on the app's own `fetch` calls but not on
cross-site `POST`s, images or iframes. `Strict` would add little and break
following a link into the app while signed in.

**CSRF defence, in layers:**

1. `SameSite=Lax`: browsers don't attach the cookie to cross-site
   subrequests or `POST` navigations.
2. `requireTrustedOrigin`: every `POST`/`PUT`/`PATCH`/`DELETE` must carry an
   `Origin` in `CORS_ORIGIN`, else 403 (before any handler runs). If a browser
   omits `Origin`, `Sec-Fetch-Site: cross-site` is rejected too. Requests with
   neither header (curl, server-to-server) carry no ambient browser cookies and
   are allowed.
3. JSON-only bodies: HTML forms can't send `application/json`, and a
   cross-origin `fetch` with JSON triggers a CORS preflight that fails for
   unlisted origins.

**CORS:** `credentials: true` is sent only for allow-listed origins; `*` is
rejected at startup, and in production every origin must be `https`. The web
client uses `credentials: 'include'` when the API is on another origin and
`same-origin` otherwise (`services/api.ts`).

**Deploying on different sites** (e.g. `wayora.app` and `wayora-api.com`)
would need `SameSite=None` and is not supported by this configuration: keep the
API on the same registrable domain, or behind the web origin.

## Abuse protection

- **Per IP:** `AUTH_RATE_LIMIT_MAX` (default 20) sign-in + registration attempts
  per 15 minutes, on top of the general API limit.
- **Per account:** `LOGIN_FAILURES_PER_EMAIL_MAX` (default 10) failed sign-ins
  per email per 15 minutes, keyed by a SHA-256 of the normalized email (no
  plaintext emails in Redis). Successful sign-ins don't count. This slows
  distributed guessing against one account without letting anyone lock a user
  out for longer than 15 minutes.
- Limits are shared through Redis when `REDIS_URL` is set and fall back to
  in-memory counters (per instance) otherwise; Redis is not required.
- **Enumeration:** wrong password, unknown email, an account with no password
  and a suspended account all return the same 401 message, and the unknown-email
  path still runs one Argon2 verification so response times match.
  Registration with an existing email must say _something_; it returns a
  neutral 409 ("We couldn't create an account with that email…"). Fully hiding
  this needs email verification (see Limitations).
- **Validation:** strict Zod schemas (unknown fields → 400), emails trimmed and
  lower-cased, passwords 10–128 characters with a small common-password
  denylist, names normalized. Validation errors never echo values.

## Logging

pino redacts `authorization`, `cookie`, `set-cookie`, and any `password`,
`confirmPassword`, `currentPassword`, `token`, `sessionToken` or `tokenHash`
field. Request bodies are never logged; request logs contain method, path,
status, user-agent and request id only.

## Environment variables

`apps/api/.env` (see `apps/api/.env.example`):

| Variable                         | Default | Notes                                                               |
| -------------------------------- | ------- | ------------------------------------------------------------------- |
| `SESSION_IDLE_TIMEOUT_HOURS`     | `168`   | Must not exceed the absolute timeout (checked at startup)           |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `720`   |                                                                     |
| `AUTH_RATE_LIMIT_MAX`            | `20`    | Sign-in + registration attempts per IP per 15 minutes               |
| `LOGIN_FAILURES_PER_EMAIL_MAX`   | `10`    | Failed sign-ins per email per 15 minutes                            |
| `CORS_ORIGIN`                    | –       | Also the CSRF `Origin` allow-list. `https` only in production       |
| `TRUST_PROXY`                    | `false` | Set to the hop count behind a load balancer, or per-IP limits break |

No session secret is needed: tokens are random and stored hashed, so there is
nothing to sign. (`SESSION_SECRET`, reserved in Phase 1, was removed.)

`apps/web`: no new variables. `VITE_API_BASE_URL` decides the credentials mode.

## Migrations

`database/migrations/20261021000000_auth_sessions/migration.sql` is additive:

- `users.password_hash VARCHAR(255) NULL` (existing users, e.g. the dev seed
  user, keep `NULL` and simply can't sign in with a password),
- the `sessions` table with a unique index on `token_hash` and indexes on
  `user_id` and `expires_at`, cascading on user deletion,
- CHECK constraints: password hashes must be Argon2id PHC strings, emails must be
  trimmed, token hashes must be 64 hex characters, `expires_at > created_at`.

Apply it like any migration:

```bash
npm run db:migrate:deploy   # or npm run db:migrate in development
```

The users-table CHECK `users_email_trimmed_chk` fails if an existing row has an
email with surrounding spaces. Phase 1 already stored emails lower-cased via a
CHECK; if you have hand-inserted data, check first:
`SELECT id FROM users WHERE email <> btrim(email);`

**Rollback** (drops all sessions and password hashes; everyone is signed out
and must re-register):

```sql
BEGIN;
DROP TABLE IF EXISTS "sessions";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_password_hash_chk";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_trimmed_chk";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021000000_auth_sessions';
COMMIT;
```

## Local setup

1. `npm run infra:up` (PostgreSQL; Redis optional), then
   `npm run db:migrate:deploy`.
2. `npm run dev:api` and `npm run dev:web`; open http://localhost:5173/register.
3. The seeded development user has no password. Create an account instead.

## Running the tests

```bash
npm run test                       # everything; account integration tests are SKIPPED
```

The API's account integration tests (`apps/api/test/integration/`) run against
a real PostgreSQL database and only when `TEST_DATABASE_URL` is set. They
**truncate** `users`, `travellers` and `sessions` before each test, so they refuse
to run unless the database name ends in `_test`. Never point them at
development or production data.

```bash
# once: create and migrate a separate test database
docker compose -f infra/docker/docker-compose.yml --project-directory . \
  exec postgres createdb -U wayora wayora_test
DATABASE_URL="postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora_test" \
  npm run db:migrate:deploy

# run
TEST_DATABASE_URL="postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora_test" \
  npm run test --workspace @wayora/api
```

Coverage: registration and normalization, duplicates, Argon2id storage and
re-hashing, generic failures, rotation, idle and absolute expiry (with a test
clock), logout and replay, logout-all scoping, suspended users, purge, CSRF,
both rate limits, profile field restrictions, traveller validation, ownership
(404), the traveller cap, `no-store`. Unit tests (no database) cover hashing,
tokens, cookies, the Origin check, env validation, serializers and log
redaction.

Web tests (`apps/web/test/auth.test.tsx`) drive the real routes against an
in-memory fake of these endpoints: guards and redirects (including open-redirect
attempts), the single `/auth/me` request, no protected-content flash, form
validation, server errors, double-submit protection, show/hide password, no
browser storage, header and drawer states, sign-out, profile editing and
traveller CRUD.

## Limitations and future work

- **No email verification.** `emailVerified` is always `false`; the profile says
  so. Integration point: `users.email_verified_at` exists (Phase 1); add a
  single-use, hashed, short-lived token table and an email provider.
- **No password reset.** It can't be done safely without verified email. The
  sign-in page and Help say so. It will reuse the verification token design and
  must revoke all sessions on reset.
- **No password change, email change or account deletion in the app yet.**
  Password change should require the current password and revoke other sessions.
- **Duplicate registration is distinguishable** (409). Hiding it requires
  "check your email" flows, i.e. email verification.
- **No MFA, passkeys or social sign-in.** None is shown in the UI.
- **Rate limits are per instance without Redis.** With several API instances,
  set `REDIS_URL` so limits are shared.
- **No session list UI** ("signed in on these devices"); only "sign out
  everywhere".
- **Prisma migrate was not run in the build environment** for this phase (the
  Prisma schema engine binary couldn't be downloaded there). The migration was
  written in Prisma's format, applied with `psql` to the development and test
  databases, and verified by the integration tests. Run
  `npm run db:migrate:deploy` (or `db:migrate:status`) locally to record it in
  `_prisma_migrations`.
