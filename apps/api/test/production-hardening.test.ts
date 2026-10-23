import { Writable } from 'node:stream';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WORKER_HEARTBEAT_KEY } from '@wayora/contracts';
import { EnvValidationError, parseEnv, productionWarnings } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { splitUrl } from '../src/middleware/http-logger.js';
import { checkReadiness } from '../src/services/health.js';
import { workerHeartbeatCheck } from '../src/services/worker-heartbeat.js';
import { scrub, unexpectedErrorForLog } from '../src/utils/log-safety.js';
import { buildTestApp, validEnvSource } from './helpers.js';

/*
 * Phase 16 production hardening (docs/security.md, docs/deployment.md):
 * configuration that fails fast, headers, safe errors and logs, and
 * readiness that neither leaks nor lies.
 */

const PROD = {
  ...validEnvSource,
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://wayora.example',
  WEB_ORIGIN: 'https://wayora.example',
  API_BASE_URL: 'https://api.wayora.example',
  DATABASE_URL: 'postgresql://wayora:s3cr3t-prod@db.internal:5432/wayora',
  REDIS_URL: 'rediss://:r3dis-prod@cache.internal:6380',
};

function issuesOf(source: Record<string, string>): string[] {
  try {
    parseEnv(source);
    return [];
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
}

/** A logger whose output the test can read. */
function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: 'debug' }, stream), lines };
}

describe('production configuration fails fast', () => {
  it('accepts a complete production configuration', () => {
    expect(issuesOf(PROD)).toEqual([]);
  });

  it('refuses http public URLs and the local development passwords, without echoing values', () => {
    const issues = issuesOf({
      ...PROD,
      API_BASE_URL: 'http://api.wayora.example',
      DATABASE_URL: 'postgresql://wayora:wayora_local_dev_only@db:5432/wayora',
      REDIS_URL: 'redis://:wayora_ci_only@cache:6379',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'API_BASE_URL: must use https:// in production',
        expect.stringMatching(/^DATABASE_URL: uses the local development password/),
        expect.stringMatching(/^REDIS_URL: uses a local development password/),
      ]),
    );
    expect(issues.join('\n')).not.toMatch(/wayora_local_dev_only|wayora_ci_only/);
  });

  it('names missing required settings', () => {
    const { DATABASE_URL: _d, CORS_ORIGIN: _c, ...rest } = PROD;
    expect(issuesOf(rest)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL: is required but not set',
        'CORS_ORIGIN: is required but not set',
      ]),
    );
  });

  it('development keeps its local defaults', () => {
    expect(
      issuesOf({
        ...validEnvSource,
        DATABASE_URL: 'postgresql://wayora:wayora_local_dev_only@localhost:5432/wayora',
      }),
    ).toEqual([]);
  });

  it('warns (without refusing) about risky but valid production choices', () => {
    const warnings = productionWarnings(
      parseEnv({ ...PROD, SEARCH_DEMO_PROVIDERS: 'true', PAYMENT_PROVIDER: 'demo' }),
    );
    expect(warnings.join('\n')).toMatch(/TRUST_PROXY is false/);
    expect(warnings.join('\n')).toMatch(/demo inventory/);
    expect(warnings.join('\n')).toMatch(/payments are simulated/);
    expect(productionWarnings(parseEnv({ ...PROD, TRUST_PROXY: '1' }))).toEqual([]);
    expect(productionWarnings(parseEnv(validEnvSource))).toEqual([]);
  });
});

describe('HTTP security headers (JSON API)', () => {
  it('forbids framing and every content type, and sends no HSTS outside production', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS in production, where every origin is HTTPS', async () => {
    const { MemorySearchSessionStore } = await import('../src/modules/search/sessions.js');
    const app = buildTestApp({
      env: parseEnv(PROD),
      searchSessions: new MemorySearchSessionStore(),
    });
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('credentialed CORS only for listed origins', async () => {
    const app = buildTestApp();
    const ok = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('safe errors and logs', () => {
  const PRISMA_LIKE = Object.assign(
    new Error(
      'Invalid `prisma.user.create()` invocation:\n\n{\n  data: {\n    email: "asha@example.com",\n    passwordHash: "$argon2id$v=19$secret"\n  }\n}\n\nUnknown argument `role`.',
    ),
    { name: 'PrismaClientValidationError', meta: { modelName: 'User', query: 'SELECT secret' } },
  );

  it('an unexpected error answers with a generic message and logs no data values', async () => {
    const { logger, lines } = captureLogger();
    const app = express();
    app.use((_req, res, next) => {
      res.locals.requestId = 'req-test-0001';
      next();
    });
    app.get('/boom', () => {
      throw PRISMA_LIKE;
    });
    app.use(errorHandler(logger, { exposeInternals: false }));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Quote the request ID if you contact support.',
      requestId: 'req-test-0001',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|argon2|asha|\/home\/|at /);
    const log = lines.join('');
    expect(log).toContain('Invalid `prisma.user.create()` invocation:');
    expect(log).toContain('"modelName":"User"');
    expect(log).toContain('req-test-0001');
    expect(log).not.toMatch(/argon2|asha@example|SELECT secret/);
  });

  it('unexpected errors keep stack frames for debugging', () => {
    const logged = unexpectedErrorForLog(PRISMA_LIKE);
    expect(logged.name).toBe('PrismaClientValidationError');
    expect(Array.isArray(logged.stack)).toBe(true);
    expect((logged.stack as string[])[0]).toMatch(/^at /);
  });

  it('scrubs credentials from any URL scheme and secret-looking pairs', () => {
    expect(scrub('connect to postgresql://wayora:hunter2@db.internal:5432/wayora failed')).toBe(
      'connect to postgresql://db.internal:5432/wayora failed',
    );
    expect(scrub('redis://:pw@cache:6379/0 down')).toBe('redis://cache:6379/0 down');
    expect(scrub('password=hunter2 token: abc')).toBe('password=[REDACTED] token: [REDACTED]');
  });

  it('access logs keep query parameter names, never values', () => {
    expect(splitUrl('/api/v1/admin/users?q=asha%40example.com&page=2')).toEqual([
      '/api/v1/admin/users',
      ['q', 'page'],
    ]);
    expect(splitUrl('/api/v1/health')).toEqual(['/api/v1/health', []]);
  });

  it('the access log line for a request has no query values', async () => {
    const { logger, lines } = captureLogger();
    const app = buildTestApp({ logger });
    await request(app).get('/api/v1/catalog/categories?availability=beta&email=asha%40example.com');
    const line = lines.find((l) => l.includes('/api/v1/catalog/categories'));
    expect(line).toBeDefined();
    expect(line).toContain('"query":["availability","email"]');
    expect(line).not.toContain('asha');
  });
});

describe('readiness neither leaks nor lies', () => {
  const failing = (message: string) => ({
    name: 'postgres',
    essential: true,
    check: () => Promise.reject(new Error(message)),
  });

  it('reports a failed dependency without the driver message, and logs the scrubbed reason', async () => {
    const { logger, lines } = captureLogger();
    const app = buildTestApp({
      logger,
      healthChecks: [failing('connect ECONNREFUSED 10.1.2.3:5432 postgresql://u:pw@10.1.2.3')],
    });
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.dependencies[0]).toMatchObject({ state: 'down', error: 'Not responding' });
    expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|pw@/);
    const log = lines.find((l) => l.includes('Readiness check failed'));
    expect(log).toContain('ECONNREFUSED');
    expect(log).not.toContain('pw@');
  });

  it('logs each failing dependency at most once a minute (probes are frequent)', async () => {
    const { logger, lines } = captureLogger();
    const app = buildTestApp({ logger, healthChecks: [failing('down')] });
    for (let i = 0; i < 5; i += 1) await request(app).get('/api/v1/health/ready');
    expect(lines.filter((l) => l.includes('Readiness check failed'))).toHaveLength(1);
  });

  it('the worker counts as up only with a fresh heartbeat of its own', async () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    const redisWith = (value: string | null) => ({ get: () => Promise.resolve(value) });
    const state = async (redis?: { get(key: string): Promise<string | null> }) =>
      (await checkReadiness([workerHeartbeatCheck(redis, () => now)], 100)).dependencies[0]!;

    expect((await state(undefined)).state).toBe('disabled');
    expect((await state(redisWith(null))).state).toBe('down');
    expect((await state(redisWith('not json'))).state).toBe('down');
    expect(
      (await state(redisWith(JSON.stringify({ at: new Date(now - 120_000).toISOString() })))).state,
    ).toBe('down');
    const fresh = await state(
      redisWith(JSON.stringify({ at: new Date(now - 5_000).toISOString() })),
    );
    expect(fresh.state).toBe('up');

    // Optional: a stopped worker degrades readiness, it doesn't take the API out of service.
    const r = await checkReadiness(
      [
        { name: 'postgres', essential: true, check: async () => undefined },
        workerHeartbeatCheck(redisWith(null), () => now),
      ],
      100,
    );
    expect(r.status).toBe('degraded');
    expect(WORKER_HEARTBEAT_KEY).toBe('wayora:worker:heartbeat');
  });
});
