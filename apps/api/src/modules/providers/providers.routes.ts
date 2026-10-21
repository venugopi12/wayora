import { Router } from 'express';
import { sendData } from '../../utils/respond.js';
import type { ProviderRegistry } from './registry.js';

/**
 * GET /providers   which providers this API knows, what they support and
 * whether they're enabled. Safe metadata only: no credentials, endpoints or
 * configuration values.
 */
export function providersRouter(registry: ProviderRegistry): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    sendData(res, registry.describe());
  });
  return router;
}
