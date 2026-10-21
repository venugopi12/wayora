import { Router } from 'express';
import type { Liveness } from '@wayora/contracts';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/service.js';
import { checkReadiness, type DependencyCheck } from '../../services/health.js';
import { sendData } from '../../utils/respond.js';

export interface HealthRouterOptions {
  dependencies: readonly DependencyCheck[];
  timeoutMs: number;
}

/**
 * GET /health       – liveness: the process is up and serving. Never touches dependencies.
 * GET /health/ready – readiness: 200 when essential dependencies are up (optional
 *                     ones may be degraded), 503 when an essential one is down.
 */
export function healthRouter({ dependencies, timeoutMs }: HealthRouterOptions): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body: Liveness = {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    sendData(res, body);
  });

  router.get('/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const readiness = await checkReadiness(dependencies, timeoutMs);
    sendData(res, readiness, readiness.status === 'unready' ? 503 : 200);
  });

  return router;
}
