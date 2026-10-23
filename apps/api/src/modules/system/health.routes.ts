import { Router } from 'express';
import type { Liveness } from '@wayora/contracts';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/service.js';
import { checkReadiness, describeError, type DependencyCheck } from '../../services/health.js';
import { scrub } from '../../utils/log-safety.js';
import type { Logger } from '../../utils/logger.js';
import { sendData } from '../../utils/respond.js';

export interface HealthRouterOptions {
  dependencies: readonly DependencyCheck[];
  timeoutMs: number;
  /** Where the real failure reasons go (probes run often: one line per dependency per minute). */
  logger?: Logger;
}

/**
 * GET /health       – liveness: the process is up and serving. Never touches dependencies.
 * GET /health/ready – readiness: 200 when essential dependencies are up (optional
 *                     ones may be degraded), 503 when an essential one is down.
 */
export function healthRouter({ dependencies, timeoutMs, logger }: HealthRouterOptions): Router {
  const router = Router();
  const lastLogged = new Map<string, number>();
  const onFailure = (name: string, error: unknown) => {
    const now = Date.now();
    if (!logger || now - (lastLogged.get(name) ?? 0) < 60_000) return;
    lastLogged.set(name, now);
    logger.warn(
      { dependency: name, reason: scrub(describeError(error)) },
      'Readiness check failed',
    );
  };

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
    const readiness = await checkReadiness(dependencies, timeoutMs, onFailure);
    sendData(res, readiness, readiness.status === 'unready' ? 503 : 200);
  });

  return router;
}
