import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../config/service.js';

export type { Logger };

/** Paths that must never reach log output. Extend as new sensitive fields appear. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.confirmPassword',
  '*.currentPassword',
  '*.sessionToken',
  '*.tokenHash',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  // Assistant provider credentials (docs/assistant.md): never logged, even by accident.
  '*.apiKey',
  '*.AI_API_KEY',
  'AI_API_KEY',
  '*.cardNumber',
  '*.cvv',
  // Traveller details (bookings): never logged, even by accident.
  '*.travellers',
  '*.firstName',
  '*.lastName',
  '*.contactPhone',
  '*.phone',
  '*.dateOfBirth',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'LOG_FORMAT' | 'NODE_ENV'>): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: SERVICE_NAME, version: SERVICE_VERSION, env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
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
