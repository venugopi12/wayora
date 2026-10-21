import { pino, type Logger } from 'pino';
import type { WorkerEnv } from './config.js';

export type { Logger };

export function createLogger(
  env: Pick<WorkerEnv, 'LOG_LEVEL' | 'LOG_FORMAT' | 'NODE_ENV'>,
): Logger {
  const options = {
    level: env.LOG_LEVEL,
    base: { service: 'wayora-worker', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };
  if (env.LOG_FORMAT === 'pretty' && env.NODE_ENV !== 'production') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(options);
}
