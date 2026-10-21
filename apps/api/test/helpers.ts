import { pino } from 'pino';
import { createApp, type AppDependencies } from '../src/app.js';
import { parseEnv, type Env } from '../src/config/env.js';
import type { DependencyCheck } from '../src/services/health.js';

export const validEnvSource = {
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/wayora_test',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGIN: 'http://localhost:5173',
  WEB_ORIGIN: 'http://localhost:5173',
  API_BASE_URL: 'http://localhost:4000',
  LOG_LEVEL: 'silent',
} satisfies Record<string, string>;

export const up = (name: string, essential: boolean): DependencyCheck => ({
  name,
  essential,
  check: async () => undefined,
});

export const down = (
  name: string,
  essential: boolean,
  message = 'connect ECONNREFUSED',
): DependencyCheck => ({
  name,
  essential,
  check: async () => {
    throw new Error(message);
  },
});

type TestOverrides = Omit<Partial<AppDependencies>, 'env'> & { env?: Partial<Env> };

export function buildTestApp({ env: envOverrides, ...overrides }: TestOverrides = {}) {
  const env: Env = { ...parseEnv(validEnvSource), ...envOverrides };
  return createApp({
    logger: pino({ level: 'silent' }),
    healthChecks: [up('postgres', true), up('redis', false)],
    ...overrides,
    env,
  });
}
