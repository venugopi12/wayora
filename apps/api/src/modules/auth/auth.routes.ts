import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import { loginRequestSchema, registerRequestSchema } from '@wayora/contracts';
import { authAttemptLimiter, loginFailuresPerEmailLimiter } from '../../middleware/rate-limit.js';
import { currentUser, noStore, requireAuth, type AuthLocals } from '../../middleware/session.js';
import { sendData } from '../../utils/respond.js';
import { validateRequest } from '../../utils/validate.js';
import type { AuthService } from './auth.service.js';
import { clearSessionCookie, setSessionCookie, type SessionCookieConfig } from './cookies.js';
import { toSafeUser } from './safe-user.js';
import type { SessionService } from './session.service.js';

export interface AuthRouterOptions {
  auth: AuthService;
  sessions: SessionService;
  cookie: SessionCookieConfig;
  limits: { attemptsPerIp: number; failuresPerEmail: number };
  /** Separate store per limiter (Redis-backed in production). */
  createStore?: (name: string) => Store;
}

const emailKey = (email: string) =>
  `login:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;

/**
 * POST /auth/register   create account + session            201 { user }
 * POST /auth/login      verify credentials + new session     200 { user }
 * POST /auth/logout     revoke this session, clear cookie    200 { signedOut: true }
 * POST /auth/logout-all revoke every session of the user     200 { signedOut: true, sessionsRevoked }
 * GET  /auth/me         the signed-in user, or 401           200 { user }
 */
export function authRouter(options: AuthRouterOptions): Router {
  const { auth, sessions, cookie } = options;
  const router = Router();
  router.use(noStore);

  const perIp = authAttemptLimiter({
    max: options.limits.attemptsPerIp,
    store: options.createStore?.('auth-ip'),
  });
  const perEmail = loginFailuresPerEmailLimiter({
    max: options.limits.failuresPerEmail,
    store: options.createStore?.('auth-email'),
    keyFor: emailKey,
  });

  /** Ends the session this browser currently holds (rotation on sign-in). */
  const revokeCurrent = async (locals: AuthLocals) => {
    if (locals.sessionToken) await sessions.revokeToken(locals.sessionToken);
  };

  router.post('/register', perIp, (async (req, res) => {
    const { body } = validateRequest(req, { body: registerRequestSchema });
    const signedIn = await auth.register(body);
    await revokeCurrent(res.locals as AuthLocals);
    setSessionCookie(res, signedIn.token, cookie);
    sendData(res, { user: signedIn.user }, 201);
  }) satisfies RequestHandler);

  router.post('/login', perIp, perEmail, (async (req, res) => {
    const { body } = validateRequest(req, { body: loginRequestSchema });
    const signedIn = await auth.login(body);
    await revokeCurrent(res.locals as AuthLocals);
    setSessionCookie(res, signedIn.token, cookie);
    sendData(res, { user: signedIn.user });
  }) satisfies RequestHandler);

  // Idempotent: works (and clears the cookie) with or without a valid session.
  router.post('/logout', (async (_req, res) => {
    await revokeCurrent(res.locals as AuthLocals);
    clearSessionCookie(res, cookie);
    sendData(res, { signedOut: true });
  }) satisfies RequestHandler);

  router.post('/logout-all', requireAuth, (async (_req, res) => {
    const sessionsRevoked = await sessions.revokeAllForUser(currentUser(res).id);
    clearSessionCookie(res, cookie);
    sendData(res, { signedOut: true, sessionsRevoked });
  }) satisfies RequestHandler);

  router.get('/me', requireAuth, (_req, res) => {
    sendData(res, { user: toSafeUser(currentUser(res)) });
  });

  return router;
}
