# Testing

How Wayora is tested, what each layer covers, and how to run it. Every
command here was run for the Phase 32 release check; results are in
[launch-readiness.md](launch-readiness.md#test-results).

| Layer                | Where                                       | Needs                               | Command                                                     |
| -------------------- | ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| Format, lint, types  | whole repo                                  | nothing                             | `npm run format:check && npm run lint && npm run typecheck` |
| Unit                 | `*/test/*.test.ts(x)` (Vitest)              | nothing                             | `npm test`                                                  |
| Integration (API)    | `apps/api/test/integration/`                | PostgreSQL `*_test` database, Redis | `TEST_DATABASE_URL=… TEST_REDIS_URL=… npm test`             |
| Integration (worker) | `apps/worker/test/` (outbox, push, purge)   | PostgreSQL `*_test` database        | same                                                        |
| Web components       | `apps/web/test/` (Vitest + Testing Library) | nothing (fake API in the tests)     | `npm test -w @wayora/web`                                   |
| End-to-end           | `apps/web/e2e/journey.mjs` (Playwright)     | running API + web build, Chromium   | `npm run test:e2e -w @wayora/web`                           |
| Dependencies         | lockfile                                    | network                             | `npm audit --omit=dev --audit-level=high`                   |

Without `TEST_DATABASE_URL` / `TEST_REDIS_URL` the integration suites are
reported as **skipped**, not passed. With `CI` set they fail instead of
skipping, so CI can't go green without them. The database name must end in
`_test`: the suites empty tables and refuse anything else.

## Integration tests

They run the real API (`createApp`) against PostgreSQL with every migration
applied, and cover the money and booking rules at the database level:
idempotent and concurrent booking creation, one payment success per booking,
refunds never exceeding the payment, coupon limits under concurrent
checkouts, points and travel credit that can't be spent twice
(`rewards.test.ts`, including concurrent travel-credit use), append-only
ledgers, ownership (another customer's booking is a 404), role checks on
every admin route, and the analytics triggers.

Prepare the test database once (Docker: `npm run infra:up`):

```bash
createdb wayora_test   # or via psql
DATABASE_URL=postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora_test npm run db:migrate:deploy
export TEST_DATABASE_URL=postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora_test
export TEST_REDIS_URL=redis://localhost:6379/15
npm test
```

## End-to-end

`apps/web/e2e/journey.mjs` drives Chromium through one journey on a
production build:

1. Home page (axe: no serious or critical WCAG 2.1 AA problems, no sideways scroll).
2. Hotel search with demo results; sorting re-orders and updates the URL.
3. Booking while signed out asks to sign in; registering returns to checkout.
4. Traveller details, review, one demo booking.
5. A double click on Pay makes exactly one demo payment.
6. My trips and the booking page show it paid; nothing claims "nothing was paid".
7. Cancelling it records a refund owed (demo), never "refunded".
8. A customer gets "no access" in the admin area.
9. Signing out ends the session server-side.
10. An administrator (granted with the audited `admin:role` CLI) sees the
    booking in Analytics, with demo money labelled.
11. No uncaught page errors.

Run it locally against throwaway data, never production (it creates
accounts; it refuses obvious production URLs):

```bash
npm run build                                   # VITE_API_BASE_URL / VITE_SITE_URL from apps/web/.env
npm run start:api &                             # or npm run dev:api
(cd apps/web && npx vite preview --port 4173) &
npx -w @wayora/web playwright install chromium  # once
DATABASE_URL=<the API's database> npm run test:e2e -w @wayora/web
```

`E2E_BASE_URL` and `E2E_API_URL` default to `http://localhost:4173` and
`http://localhost:4000`; `CHROMIUM_PATH` points at an existing Chromium. A
failed step saves a screenshot in `apps/web/e2e-results/`. CI runs it in the
`e2e` job with fresh PostgreSQL and Redis containers.

Only Chromium is automated. Firefox and Safari aren't (see
[launch-readiness.md](launch-readiness.md#browsers)): check them by hand
before a public launch.

## Release audits (manual, not in CI)

The Phase 32 audits used throwaway scripts outside the repository, with the
same Playwright and axe-core versions:

- **Accessibility and layout**: axe (WCAG 2.0/2.1/2.2 A and AA and best
  practices), horizontal overflow, one `h1`, console errors and 5xx
  responses on 42 public, customer and admin pages at desktop (1366×900),
  tablet (820×1180), Android (Pixel 7) and iPhone-sized (390×844) viewports.
- **Performance**: lab LCP, CLS and INP on a production build
  ([performance.md](performance.md)).
- **Security probe**: headers, CORS, CSRF, validation, request size,
  ownership, price authority, forged provider events, admin access, session
  invalidation and login throttling against a running API.

Repeat them before a public launch; the results of the last run are in
[launch-readiness.md](launch-readiness.md).
