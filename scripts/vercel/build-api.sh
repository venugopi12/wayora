#!/usr/bin/env bash
# Vercel build step for the API service (docs/deployment-vercel.md).
# Runs from apps/api. Builds the shared packages the API imports, then, for
# production deployments only, applies pending database migrations
# (`prisma migrate deploy`: additive, never resets or drops).
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run build:packages

if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "Skipping database migrations: VERCEL_ENV=${VERCEL_ENV:-unset} (only production deployments migrate)."
  exit 0
fi

# Neon's pooled URL doesn't support the session features migrations need.
MIGRATE_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
if [ -z "$MIGRATE_URL" ]; then
  echo "WARNING: no DATABASE_URL: migrations not applied. Connect a PostgreSQL database to this project and redeploy." >&2
  exit 0
fi
DATABASE_URL="$MIGRATE_URL" npm run db:migrate:deploy
