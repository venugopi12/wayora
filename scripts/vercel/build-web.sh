#!/usr/bin/env bash
# Vercel build step for the web service (docs/deployment-vercel.md).
# The web app and the API share the deployment's domain, so both public URLs
# default to it: the production domain for production deployments, the
# deployment's own URL for previews. Set VITE_SITE_URL / VITE_API_BASE_URL
# in the project to override (e.g. a custom domain).
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "${VERCEL_ENV:-}" = "production" ] && [ -n "${VERCEL_PROJECT_PRODUCTION_URL:-}" ]; then
  SITE="https://${VERCEL_PROJECT_PRODUCTION_URL}"
else
  SITE="https://${VERCEL_BRANCH_URL:-${VERCEL_URL:?VERCEL_URL is not set: run this on Vercel}}"
fi
export VITE_SITE_URL="${VITE_SITE_URL:-$SITE}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$SITE}"
echo "Building the web app for ${VITE_SITE_URL} (API ${VITE_API_BASE_URL})"

npm run build -w @wayora/contracts
npm run build -w @wayora/web
