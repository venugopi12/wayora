import { z } from 'zod';

const publicEnvSchema = z.object({
  VITE_API_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'VITE_API_BASE_URL must be an http(s) URL' })
    .default('http://localhost:4000')
    .transform((url) => url.replace(/\/+$/, '')),
});

/**
 * Public (browser-visible) configuration. Everything here ships in the bundle,
 * so it must never contain secrets.
 */
function readPublicEnv() {
  const result = publicEnvSchema.safeParse(import.meta.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid web configuration (${issues}). Check apps/web/.env.`);
  }
  return { apiBaseUrl: result.data.VITE_API_BASE_URL };
}

export const publicEnv = readPublicEnv();
