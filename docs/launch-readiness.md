# Launch readiness (Phase 32)

An honest account of what Wayora can do in production today, what only
works as a demo, what is missing, and what must happen before each kind of
release. Written from the repository and from tests that were actually run
(see [Test results](#test-results)), not from earlier phase plans.

**Summary:** Wayora is ready for a **controlled demo release** (a private or
invited audience, clearly labelled as a demo) once the [P0](#p0-before-any-production-release)
items are done. It is **not** ready to sell real travel: no real supplier,
payment gateway, ticketing or email provider is integrated, and the
customer account features that depend on email (password reset,
verification) don't exist.

- [Classification](#classification)
- [Prioritized issues](#prioritized-issues)
- [Release checklist](#release-checklist)
- [Rollback](#rollback)
- [Recommended release plan](#recommended-release-plan)
- [Browsers](#browsers)
- [Test results](#test-results)

## Classification

Categories: **Ready** (implemented, tested, needs nothing external),
**Ready with configuration** (implemented; needs credentials or
infrastructure that weren't available to verify it), **Demo only**
(works end to end on simulated data), **Partial**, **Not implemented**.

| Area                                   | Status                   | Evidence and notes                                                                                                                                                                                                |
| -------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration, sign-in, sessions        | Ready                    | Argon2id hashes; random session tokens stored as SHA-256; HttpOnly SameSite=Lax cookie (`__Host-` in production); idle and absolute expiry; sign-out revokes server-side (security probe, E2E, integration tests) |
| Password reset, email verification     | Not implemented          | Needs an email provider (docs/auth.md#limitations-and-future-work)                                                                                                                                                |
| Password change, account deletion, MFA | Not implemented          | Same                                                                                                                                                                                                              |
| Roles and staff access                 | Ready                    | user / support / admin, enforced per route on the server, denials audited; first admin by CLI only                                                                                                                |
| Travel search (7 categories)           | Demo only                | Built-in demo providers; `createLiveProviders` returns none. Filters, sorting, pagination, search sessions in Redis, resilience and breakers are real code                                                        |
| Live supplier inventory                | Not implemented          | No supplier contract, credentials or sandbox (apps/api/src/modules/providers/live/index.ts)                                                                                                                       |
| Booking lifecycle                      | Demo only                | Server pricing, idempotency, concurrency, ownership, expiry and cancellation are real and tested; bookings are demo bookings                                                                                      |
| Supplier reservations                  | Ready with configuration | State machine, recovery and ambiguity handling tested against a fixture supplier; off by default (`SUPPLIER_RESERVATIONS_ENABLED`); no real adapter                                                               |
| Ticket / voucher issuance              | Not implemented          | Needs a supplier                                                                                                                                                                                                  |
| Payments                               | Demo only                | Demo provider (no money). Provider interface, signed webhooks, reconciliation and one-success-per-booking are tested with a signed test gateway; no real gateway adapter exists                                   |
| Refunds                                | Partial                  | Lifecycle tested with the test gateway; the demo provider can't refund, so refunds are recorded as owed                                                                                                           |
| In-app notifications                   | Ready                    | Created inside the booking/payment transactions; deduplicated                                                                                                                                                     |
| Email delivery                         | Not implemented          | Outbox and worker exist; no provider, deliveries recorded as "not configured"                                                                                                                                     |
| Browser push                           | Ready with configuration | Web Push with VAPID (worker), encryption verified in tests; needs `VAPID_*` keys; delivery through real push services not verified here                                                                           |
| AI travel assistant                    | Ready with configuration | Rule-based demo assistant works (labelled "not AI"); Anthropic adapter tested with fakes only; needs `AI_PROVIDER=anthropic` and a key                                                                            |
| Trip planner, collaboration            | Ready                    | Integration and browser tests                                                                                                                                                                                     |
| Budget and expense splitting           | Ready                    | Exact minor-unit splits, database invariants, concurrency tests                                                                                                                                                   |
| Travel status and disruptions          | Demo only                | Simulated provider when enabled; none in production by default                                                                                                                                                    |
| Loyalty points and travel credit       | Ready (demo mode)        | Ledger is append-only, balances can't go negative, concurrent spending refused; live rewards switched off until real payments exist                                                                               |
| Coupons and promotions                 | Ready                    | Limits hold under concurrent checkouts; the payable never goes below ₹1                                                                                                                                           |
| Customer support                       | Ready                    | Tickets, staff workspace, SLAs, escalation; AI suggestions only with an AI provider                                                                                                                               |
| Reviews and moderation                 | Ready                    | Verified-booking reviews, moderation, reports                                                                                                                                                                     |
| SEO and CMS                            | Ready                    | Prerendered pages with titles, descriptions, canonical URLs, Open Graph, JSON-LD (except /about and /promotions), sitemap, robots; indexing not verified (needs a public deployment)                              |
| PWA and offline                        | Ready (Chromium)         | Installable, versioned caches, offline fallback, private data never cached, offline writes refused (browser run 20/20)                                                                                            |
| Analytics                              | Ready                    | Internal only; no external analytics service                                                                                                                                                                      |
| Admin dashboard                        | Ready                    | Read views plus audited staff actions (reservations, rewards, promotions, support, reviews, content)                                                                                                              |
| Worker and queues                      | Ready                    | BullMQ on Redis, heartbeat, outbox leasing, retention purge, graceful shutdown (verified)                                                                                                                         |
| Health and readiness                   | Ready                    | `/health` (liveness) and `/health/ready` (readiness) are separate; unknown or missing dependencies are reported as such, never "up"                                                                               |
| Error tracking and alerting            | Not implemented          | Structured JSON logs with request ids only                                                                                                                                                                        |
| Database backups                       | Ready with configuration | Manual `pg_dump` step in docs/deployment.md; automated backups/PITR depend on the hosting                                                                                                                         |
| Deployment automation                  | Not implemented          | Documented manual release; no Dockerfiles or infrastructure code; CI deploys nothing                                                                                                                              |
| Legal pages                            | Partial                  | Privacy policy and terms are marked as drafts                                                                                                                                                                     |

## Prioritized issues

Each with evidence, impact and the recommended fix.

### P0: before any production release

1. **Migrations have never been applied with the Prisma CLI in a verified
   environment.** _Evidence:_ in the build environment the Prisma schema
   engine couldn't be downloaded (`binaries.prisma.sh` returns 403), so every
   migration was applied with `psql` and checked with a schema comparison
   script; `npm run db:migrate:deploy`, `db:migrate:status` and
   `db:migrate:check` weren't run here, and the CI workflow hasn't been run
   on GitHub. Prisma doesn't model partial indexes, triggers or check
   constraints (all used here), so `db:migrate:check` may report them.
   _Impact:_ a failed or unexpected migration at release time.
   _Fix:_ run CI on GitHub once, and on a staging copy run `db:migrate:deploy`
   then `db:migrate:status`; if `db:migrate:check` only reports the
   documented partial indexes, triggers and check constraints, record that
   and make the CI step tolerate exactly those.
2. **Backups.** _Evidence:_ only a manual `pg_dump` step is documented.
   _Impact:_ data loss with no restore point. _Fix:_ turn on automated
   backups or point-in-time recovery on the managed database, and test a
   restore to a scratch database before the first release.
3. **Production configuration.** _Evidence:_ the API and worker refuse to
   start with HTTP origins or development passwords (verified). _Impact:_ none
   if done; an outage if not. _Fix:_ provision the production environment
   (HTTPS origins, database and Redis credentials in the secret store,
   `PAYMENT_PROVIDER=demo` or `none`, `SEARCH_DEMO_PROVIDERS=true`, which
   start-up warns about), then follow the [release checklist](#release-checklist).
4. **The release must say it is a demo.** _Evidence:_ every booking, payment
   and search result is simulated (labelled as such in the UI). _Impact:_
   anyone expecting real travel would be misled. _Fix:_ release only to an
   invited audience with that expectation set, until the P1 integrations
   exist.

### P1: before a public launch

1. **No real supplier, payment gateway or ticketing.** Integrate at least
   one supplier (search, revalidation, reservation, cancellation) and one
   payment gateway (payments, refunds, signed webhooks) against their
   sandboxes, using the existing adapter interfaces; then switch on supplier
   reservations and live rewards.
2. **No email provider, so no password reset or email verification.**
   Customers who forget their password lose their account. Add an email
   provider to the worker's outbox, then verification and reset tokens
   (docs/auth.md).
3. **No account deletion or data export.** Needed for privacy law; add with
   the email work.
4. **Draft legal pages.** Replace the privacy policy and terms with reviewed
   ones.
5. **No error tracking or alerting.** Add an error tracker for the API, the
   worker and the web app (with personal data scrubbed), and alerts on
   readiness failures, worker heartbeat loss, the outbox backlog and
   reservations needing attention.
6. **Firefox and Safari untested.** Only Chromium was automated. Test the
   main journeys by hand on Safari (iOS and macOS) and Firefox; consider
   adding them to the end-to-end job.
7. **Mobile load time.** On the phone lab profile the home and search pages
   reach LCP in about 3.1 s (target 2.5 s; [performance.md](performance.md)).
   Trim the start-up bundle (header menus and toasts on demand) and measure
   real users.
8. **Push notifications.** Configure VAPID keys and verify delivery on real
   Android, desktop and iOS (installed) browsers before announcing it.

### P2: important improvements

1. Server-side rendering or hydration of the prerendered pages (the larger
   fix for mobile LCP).
2. Container images or infrastructure code for the API, worker and web
   hosting rules, so releases are repeatable.
3. Multi-factor authentication for staff accounts.
4. Unknown paths outside the prerendered sections return the app shell with
   status 200 (`noindex`, the app shows "not found"); a real 404 needs the
   host to know the app's routes.
5. Development-only dependency advisories (moderate/low: ESLint and
   typescript-eslint via `minimatch`; `vite-plugin-pwa` via
   `workbox-build`): upgrade when upstream releases fixes.
6. JSON-LD for /about and /promotions.

### P3: future enhancements

1. An external product-analytics or real-user-monitoring service (with
   consent).
2. Scheduled analytics reports (after email delivery exists).
3. Automated accessibility and visual regression checks across browsers.

## Release checklist

The full procedure is [deployment.md](deployment.md); in order:

1. P0 items done; CI green on the release commit (both jobs).
2. `npm audit --omit=dev --audit-level=high` clean.
3. Production secrets in the secret store; `.env` files never committed.
4. Back up the database (or confirm a restore point), then
   `db:migrate:status` → `db:migrate:deploy` → `db:migrate:status`.
5. Build once (`npm run build` with the production `VITE_API_BASE_URL`,
   `VITE_SITE_URL` and `PRERENDER_CONTENT_URL`); deploy the same artefacts.
6. Start the worker, then the API; check `/api/v1/health/ready` and the
   admin Platform health page (worker heartbeat, queue, outbox).
7. Upload `apps/web/dist` with the hosting rules and security headers.
8. Smoke tests (deployment.md#7-smoke-tests), then the end-to-end journey
   against staging (never production: it creates accounts).
9. Create the first administrator with the audited CLI.

## Rollback

From [deployment.md](deployment.md#8-rollback): redeploy the previous
build of the API, worker and web (every migration so far is additive, so the
previous release runs against the migrated database). If the service worker
misbehaves, build with `VITE_PWA=off` (a worker that removes itself and its
caches). Restore the backup taken before migrating only if data integrity is
in doubt. Phase 31 and 32 add no destructive schema changes; the Phase 31
analytics migration can be left in place on rollback.

## Recommended release plan

1. **Staging:** a production-like environment with its own database and
   Redis; complete the P0 items there, run the end-to-end journey and the
   smoke tests.
2. **Controlled demo release:** invited users, demo labels kept, analytics
   and logs watched daily; fix anything found before widening.
3. **Integrations:** supplier and payment gateway sandboxes, email provider,
   password reset, error tracking (P1 1–5), each behind its existing
   configuration switch.
4. **Public launch** only after P1 is closed, with real payments switched
   on gradually and refunds rehearsed end to end.

## Browsers

Automated: **Chromium 141** only (Playwright 1.56.1), at desktop, tablet,
Android-sized and iPhone-sized viewports (the iPhone size is emulated in
Chromium, not Safari). **Not tested:** Firefox, Safari (macOS or iOS) and
Edge; Edge shares Chromium's engine but wasn't run. PWA installation was
checked with Chromium's own installability checks only.

## Test results

Run on the Phase 32 release commit in the build environment (Linux, Node 22,
PostgreSQL 16, Redis 7):

| Check                                             | Result                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, TypeScript (every workspace)        | pass                                                                                                                                                                                                              |
| Contracts / UI / API / worker / web tests         | 106 / 126 / 697 / 33 / 551 passed (API and worker with PostgreSQL and Redis)                                                                                                                                      |
| Migrations on an empty database                   | all 19 applied in order (with `psql`; see P0 1)                                                                                                                                                                   |
| Production builds (web, API, worker)              | pass                                                                                                                                                                                                              |
| `npm audit --omit=dev --audit-level=high`         | 0 vulnerabilities                                                                                                                                                                                                 |
| End-to-end journey                                | 12/12 steps (also with the API from its production build on a fresh database)                                                                                                                                     |
| Security probe against a running API              | 37/37                                                                                                                                                                                                             |
| Accessibility and layout (42 pages × 4 viewports) | 168 checks: 0 axe violations, no sideways scroll, one `h1`, no console errors or 5xx                                                                                                                              |
| PWA browser run                                   | 20/20                                                                                                                                                                                                             |
| Earlier browser journeys re-run on this build     | planner 38/38, collaboration 25/25, budget and assistant all pass, rewards 48/48, promotions 42/42, support 52/52 (reviews needs a moved clock and wasn't re-run; covered by its integration and component tests) |
| Graceful shutdown (API and worker, `SIGTERM`)     | both exit 0 after finishing work                                                                                                                                                                                  |
