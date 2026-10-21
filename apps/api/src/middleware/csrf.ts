import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

/**
 * CSRF defence for cookie-authenticated requests (docs/auth.md#cookie-and-csrf-strategy).
 *
 * Layered with SameSite=Lax cookies and JSON-only bodies, every state-changing
 * request must come from an allowed browser origin:
 * - `Origin` present → it must be one of CORS_ORIGIN, exactly.
 * - `Origin` absent but `Sec-Fetch-Site` present → it must not be cross-site.
 * - Neither header (curl, server-to-server) → allowed; such clients don't carry
 *   a victim's ambient cookies, so there is nothing to forge.
 */
export function requireTrustedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      if (allowed.has(origin)) {
        next();
        return;
      }
    } else {
      const site = req.get('sec-fetch-site');
      if (site === undefined || TRUSTED_FETCH_SITES.has(site)) {
        next();
        return;
      }
    }
    next(new AppError('FORBIDDEN', 'This request came from a site that is not allowed.'));
  };
}
