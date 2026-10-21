import type { CookieOptions, Request, Response } from 'express';

/**
 * Session cookie (docs/auth.md#cookie-and-csrf-strategy).
 *
 * - HttpOnly: unreadable by JavaScript.
 * - Secure + `__Host-` prefix in production: HTTPS only, host-only (no Domain),
 *   Path=/ (the browser enforces all three for `__Host-` cookies).
 * - SameSite=Lax: not sent on cross-site subrequests (fetch/XHR/forms POSTed
 *   from other sites); the web app and API must therefore be same-site.
 * - Max-Age = the absolute session lifetime; the server enforces the idle
 *   timeout and revocation independently of the cookie.
 */
export interface SessionCookieConfig {
  secure: boolean;
  maxAgeMs: number;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-wayora_session' : 'wayora_session';
}

function baseOptions(config: SessionCookieConfig): CookieOptions {
  return { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/' };
}

export function setSessionCookie(res: Response, token: string, config: SessionCookieConfig): void {
  res.cookie(sessionCookieName(config.secure), token, {
    ...baseOptions(config),
    maxAge: config.maxAgeMs,
  });
}

/** Clears with the same attributes it was set with, so browsers actually drop it. */
export function clearSessionCookie(res: Response, config: SessionCookieConfig): void {
  res.clearCookie(sessionCookieName(config.secure), baseOptions(config));
}

/** Reads one cookie from the Cookie header (no cookie-parser dependency needed). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
