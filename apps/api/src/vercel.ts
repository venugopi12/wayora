/*
 * Vercel Function entry (docs/deployment-vercel.md).
 *
 * The same API as server.ts, without a port, timers or signal handlers:
 * - the runtime (bootstrap.ts) is built once per function instance, on the
 *   first request, and reused by later requests to that instance;
 * - the maintenance tasks run from a Vercel Cron Job, which calls
 *   GET /api/internal/cron with `Authorization: Bearer $CRON_SECRET`;
 * - URLs default to the deployment's own HTTPS URL (the web app and the API
 *   share one domain), so a deployment works without hand-set origins.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createApiRuntime, type ApiRuntime } from './bootstrap.js';
import { EnvValidationError, parseEnv, productionWarnings } from './config/env.js';
import { vercelEnvDefaults } from './config/vercel-env.js';
import { unexpectedErrorForLog } from './utils/log-safety.js';
import { createLogger, type Logger } from './utils/logger.js';

let runtime: Promise<{ api: ApiRuntime; logger: Logger }> | undefined;

function start(): Promise<{ api: ApiRuntime; logger: Logger }> {
  runtime ??= (async () => {
    Object.assign(process.env, vercelEnvDefaults(process.env));
    const env = parseEnv(process.env);
    const logger = createLogger(env);
    for (const warning of productionWarnings(env)) logger.warn({ config: true }, warning);
    return { api: await createApiRuntime(env, logger), logger };
  })().catch((error: unknown) => {
    // Try again on the next request (a fixed variable doesn't need a redeploy
    // to be read, only a new instance; the failure itself is not cached).
    runtime = undefined;
    throw error;
  });
  return runtime;
}

// Logs start-up failures before the configuration (and so the configured
// logger) exists. JSON, like every production log.
const bootLogger = createLogger({ LOG_LEVEL: 'info', LOG_FORMAT: 'json', NODE_ENV: 'production' });

function startupFailed(error: unknown, res: Response): void {
  // Variable names only, never values (EnvValidationError lists names).
  if (error instanceof EnvValidationError)
    bootLogger.fatal({ issues: error.issues }, 'Invalid environment configuration');
  else bootLogger.fatal({ err: unexpectedErrorForLog(error) }, 'API start-up failed');
  if (!res.headersSent) {
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is starting or misconfigured.' },
    });
  }
}

const app = express();
app.disable('x-powered-by');

app.get('/api/internal/cron', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not allowed.' } });
    return;
  }
  let started;
  try {
    started = await start();
  } catch (error) {
    startupFailed(error, res);
    return;
  }
  // Each task logs and swallows its own failures (retried next run), so this
  // reports that it ran, not that it succeeded: check the logs for failures.
  const results: Record<string, 'ran'> = {};
  // One after another: they share the database pool, and each is idempotent.
  for (const task of started.api.tasks) {
    await task.run();
    results[task.name] = 'ran';
  }
  started.logger.info({ tasks: Object.keys(results) }, 'Scheduled maintenance ran');
  res.json({ data: results });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  start().then(
    ({ api }) => api.app(req, res, next),
    (error: unknown) => startupFailed(error, res),
  );
});

export default app;
