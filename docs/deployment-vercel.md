# Deploying to Vercel

Wayora deploys to Vercel as one project with two
[services](https://vercel.com/docs/services) on one domain (`vercel.json`):

| Path     | Service                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `/api/*` | `api`: the Express API as a Vercel Function (`apps/api/src/vercel.ts`)                                      |
| `/*`     | `web`: the static build of `apps/web` with the [hosting rules](deployment.md#web-hosting-rules) and headers |

Everything is still **demo**: demo search inventory, demo payments (no
money moves), no supplier reservations. See
[launch-readiness.md](launch-readiness.md).

## What runs where

- **PostgreSQL**: Neon, added from the Vercel Marketplace (Storage →
  Neon). It sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`; the API and the
  migrations use the unpooled URL, because live updates need `LISTEN`.
- **Redis**: Upstash, from the Marketplace (Storage → Upstash Redis). Its
  `REDIS_URL` (or `KV_URL`) is used for search sessions, rate limits and the
  analytics cache.
- **Migrations**: production builds run `prisma migrate deploy`
  (`scripts/vercel/build-api.sh`) before the new version goes live. It only
  applies pending migrations; it never resets or drops anything. Preview
  builds don't migrate.
- **Maintenance** (payment expiry, refunds, rewards, promotions, support
  auto-close, purges, reminders): a Vercel Cron Job calls
  `/api/internal/cron` once a day (the Hobby plan's limit). It only runs
  when `CRON_SECRET` is set in the project, and checks it on every call.
  Payments and refunds are also reconciled whenever someone opens them.
- **Not on Vercel: the background worker** (`apps/worker`). Email and push
  delivery and the analytics retention purge don't run, and readiness
  reports the worker as **down** (status `degraded`), as it should. No email
  or push provider is configured anyway. To run it, host it anywhere that
  runs a long-lived Node process with the same `DATABASE_URL` and
  `REDIS_URL`.

## Environment variables

Set automatically: `DATABASE_URL*` and `REDIS_URL`/`KV_URL` (integrations),
and Vercel's own `VERCEL_*`. From those, the API defaults `WEB_ORIGIN`,
`API_BASE_URL` and `CORS_ORIGIN` to the deployment's domain, and the web
build defaults `VITE_SITE_URL` and `VITE_API_BASE_URL` to it
(`apps/api/src/config/vercel-env.ts`, `scripts/vercel/build-web.sh`).
Anything you set yourself wins, e.g. for a custom domain.

Set in the project (Settings → Environment Variables, Production):

| Variable                | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `SEARCH_DEMO_PROVIDERS` | `true` (production shows no inventory unless this is set)          |
| `PAYMENT_PROVIDER`      | `demo` (production defaults to `none`: no payments at all)         |
| `CRON_SECRET`           | a long random value (optional; without it maintenance doesn't run) |

Production still refuses to start with HTTP origins or the local development
passwords, and the error names the variable (never its value).

## First deployment

1. Import the repository in Vercel; it reads `vercel.json`.
2. Add Neon and Upstash Redis from the project's **Storage** tab and connect
   them to the project (all environments).
3. Set the variables above, then redeploy. The build log shows the
   migrations being applied.
4. Check `https://<domain>/api/v1/health/ready`: PostgreSQL and Redis
   `up`, worker `down`, status `degraded`.
5. Create the first administrator from your computer, against the
   production database (Neon's unpooled URL, from the Storage tab):
   `DATABASE_URL='<unpooled url>' npm run admin:role -- --email you@example.com --role admin --reason "First administrator"`.

## Rollback

Vercel keeps every deployment: **Instant Rollback** in the dashboard
(Deployments → … → Promote) switches the domain back. Migrations so far are
additive, so an older deployment runs against the migrated database. Take a
Neon branch or backup before deploying a migration you might need to undo.
