import { Router, type RequestHandler } from 'express';
import { authRouter, type AuthRouterOptions } from '../modules/auth/auth.routes.js';
import { catalogRouter } from '../modules/catalog/catalog.routes.js';
import { providersRouter } from '../modules/providers/providers.routes.js';
import type { ProviderRegistry } from '../modules/providers/registry.js';
import { searchRouter } from '../modules/search/search.routes.js';
import type { SearchService } from '../modules/search/search.service.js';
import { healthRouter, type HealthRouterOptions } from '../modules/system/health.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
import type { UsersService } from '../modules/users/users.service.js';

export interface AccountsRouterOptions {
  /** Resolves the session cookie for the account routes. */
  loadSession: RequestHandler;
  auth: AuthRouterOptions;
  users: UsersService;
}

export interface V1RouterOptions {
  health: HealthRouterOptions;
  /** Auth, profile and travellers; mounted only when a database is configured. */
  accounts?: AccountsRouterOptions;
  search: { service: SearchService; registry: ProviderRegistry; limiter?: RequestHandler };
}

/**
 * Mounts every module under /api/v1. A breaking change to any endpoint means
 * a new /api/v2 router — never an in-place change here.
 */
export function v1Router(options: V1RouterOptions): Router {
  const router = Router();
  router.use('/health', healthRouter(options.health));
  router.use('/catalog', catalogRouter());
  router.use('/search', searchRouter(options.search.service, options.search.limiter));
  router.use('/providers', providersRouter(options.search.registry));
  if (options.accounts) {
    const { loadSession, auth, users } = options.accounts;
    router.use('/auth', loadSession, authRouter(auth));
    router.use('/users', loadSession, usersRouter(users));
  }
  return router;
}
