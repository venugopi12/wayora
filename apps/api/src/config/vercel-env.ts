/**
 * Defaults for a Vercel deployment, from the variables Vercel and its
 * Marketplace integrations set (docs/deployment-vercel.md). Anything already
 * set wins; nothing here is a secret or invents one.
 *
 * - The web app and the API share the deployment's domain, so the web
 *   origin, the API base URL and the allowed origins are that domain: the
 *   production domain for production deployments, the deployment URL for
 *   previews, plus the deployment's own and branch URLs.
 * - Neon's pooled URL can't LISTEN (live updates use it), so the direct
 *   (unpooled) URL is used when the integration provides one.
 * - Upstash's Redis URL may arrive as KV_URL.
 * - Vercel's edge is one proxy hop in front of the function.
 */
export function vercelEnvDefaults(source: NodeJS.ProcessEnv): Record<string, string> {
  if (!source.VERCEL) return {};
  const https = (host: string | undefined) => (host ? `https://${host}` : undefined);
  const production = source.VERCEL_ENV === 'production';
  const site =
    (production ? https(source.VERCEL_PROJECT_PRODUCTION_URL) : undefined) ??
    https(source.VERCEL_BRANCH_URL) ??
    https(source.VERCEL_URL);

  const defaults: Record<string, string | undefined> = {
    WEB_ORIGIN: site,
    API_BASE_URL: site,
    CORS_ORIGIN: [
      ...new Set(
        [
          site,
          production ? https(source.VERCEL_PROJECT_PRODUCTION_URL) : undefined,
          https(source.VERCEL_BRANCH_URL),
          https(source.VERCEL_URL),
        ].filter((origin): origin is string => Boolean(origin)),
      ),
    ].join(','),
    REDIS_URL: source.KV_URL,
    TRUST_PROXY: '1',
    LOG_FORMAT: 'json',
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value && !source[key]) out[key] = value;
  }
  if (source.DATABASE_URL_UNPOOLED) out.DATABASE_URL = source.DATABASE_URL_UNPOOLED;
  return out;
}
