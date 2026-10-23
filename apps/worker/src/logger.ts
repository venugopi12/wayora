import { pino, type DestinationStream, type Logger } from 'pino';
import type { WorkerEnv } from './config.js';

export type { Logger };

/** Never in worker logs (mirrors the API's list for the fields jobs can touch). */
export const REDACT_PATHS = [
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.email',
  '*.recipient',
  '*.to',
  '*.firstName',
  '*.lastName',
  '*.phone',
  '*.contactPhone',
];

export function createLogger(
  env: Pick<WorkerEnv, 'LOG_LEVEL' | 'LOG_FORMAT' | 'NODE_ENV'>,
  /** Where JSON lines go (tests); stdout by default. */
  destination?: DestinationStream,
): Logger {
  const options = {
    level: env.LOG_LEVEL,
    base: { service: 'wayora-worker', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
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
  return destination ? pino(options, destination) : pino(options);
}
