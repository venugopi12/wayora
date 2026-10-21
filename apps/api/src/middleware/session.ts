import type { RequestHandler, Response } from 'express';
import type { UserModel as User } from '@wayora/database';
import { readCookie, sessionCookieName } from '../modules/auth/cookies.js';
import type { ResolvedSession, SessionService } from '../modules/auth/session.service.js';
import { AppError } from '../utils/errors.js';

export interface AuthLocals {
  /** Present when the request carries a valid session cookie. */
  auth?: ResolvedSession;
  /** The raw cookie token, for logout/rotation. Never logged. */
  sessionToken?: string;
}

/**
 * Loads the session named by the cookie (if any) into `res.locals.auth`.
 * Never trusts a user id from the request: identity comes only from a valid,
 * server-side session.
 */
export function loadSession(sessions: SessionService, secureCookie: boolean): RequestHandler {
  const name = sessionCookieName(secureCookie);
  return async (req, res, next) => {
    try {
      const token = readCookie(req, name);
      const locals = res.locals as AuthLocals;
      locals.sessionToken = token;
      const resolved = await sessions.resolve(token);
      if (resolved) locals.auth = resolved;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  if (!(res.locals as AuthLocals).auth) {
    next(new AppError('UNAUTHENTICATED', 'Sign in to continue.'));
    return;
  }
  next();
};

/** The signed-in user. Only call after `requireAuth`. */
export function currentUser(res: Response): User {
  const auth = (res.locals as AuthLocals).auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return auth.user;
}

/** Personal data must not be stored by browsers or shared caches. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
