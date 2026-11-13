import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRuntime } from './bootstrap.js';
import { EnvValidationError, parseEnv, productionWarnings, type Env } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { unexpectedErrorForLog } from './utils/log-safety.js';
import { createLogger } from './utils/logger.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(): Env {
  loadEnvFile(appRoot);
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const logger = createLogger(env);
  for (const warning of productionWarnings(env)) logger.warn({ config: true }, warning);

  const { app, tasks, closeStreams, close } = await createApiRuntime(env, logger);

  // Maintenance (bootstrap.ts): each task on its own interval, not overlapping itself.
  const timers = tasks.map((task) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await task.run();
      } finally {
        running = false;
      }
    };
    if (task.runAtStart) void tick();
    const timer = setInterval(() => void tick(), task.intervalMs);
    timer.unref();
    return timer;
  });

  // Not app.listen(port, host, callback): Express 5 also calls that callback
  // when listening fails, which logged "listening" for a server that wasn't.
  const server: Server = app.listen(env.PORT, env.HOST);
  server.once('listening', () => {
    logger.info({ url: `http://localhost:${env.PORT}`, host: env.HOST }, 'Wayora API listening');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { port: env.PORT, host: env.HOST },
        `Port ${env.PORT} is already in use, probably by another copy of the API that is still running. ` +
          `Stop it (macOS/Linux: \`lsof -nP -iTCP:${env.PORT} -sTCP:LISTEN\` shows the process) or set PORT in apps/api/.env.`,
      );
    } else {
      logger.fatal({ err: unexpectedErrorForLog(err) }, 'HTTP server failed');
    }
    process.exit(1);
  });
  // Keep-alive slightly above typical load-balancer idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    for (const timer of timers) clearInterval(timer);
    // Live-update streams never finish on their own: end them (browsers reconnect).
    await closeStreams();
    // 1. Stop accepting connections and let in-flight requests finish.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    // 2. Release dependencies.
    await close();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: unexpectedErrorForLog(reason) }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: unexpectedErrorForLog(err) }, 'Uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

void main();
