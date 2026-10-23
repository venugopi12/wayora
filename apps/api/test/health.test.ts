import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiSuccessEnvelopeSchema, livenessSchema, readinessSchema } from '@wayora/contracts';
import { buildTestApp, down, up } from './helpers.js';

describe('GET /api/v1/health (liveness)', () => {
  it('returns 200 with the standard envelope and a request ID', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = apiSuccessEnvelopeSchema(livenessSchema).parse(res.body);
    expect(body.data.status).toBe('ok');
    expect(body.meta.requestId).toBe(res.headers['x-request-id']);
  });

  it('stays live even when every dependency is down', async () => {
    const app = buildTestApp({ healthChecks: [down('postgres', true), down('redis', false)] });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('echoes a well-formed inbound request ID and replaces a malformed one', async () => {
    const app = buildTestApp();
    const kept = await request(app).get('/api/v1/health').set('X-Request-Id', 'lb-trace-12345678');
    expect(kept.headers['x-request-id']).toBe('lb-trace-12345678');

    const replaced = await request(app)
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id <script>');
    expect(replaced.headers['x-request-id']).not.toContain('bad');
  });

  it('sets security headers', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /api/v1/health/ready (readiness)', () => {
  const readinessBody = apiSuccessEnvelopeSchema(readinessSchema);

  it('is ready (200) when all dependencies are up', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(readinessBody.parse(res.body).data.status).toBe('ready');
  });

  it('is degraded (200) when only optional Redis is down', async () => {
    const app = buildTestApp({ healthChecks: [up('postgres', true), down('redis', false)] });
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    const { data } = readinessBody.parse(res.body);
    expect(data.status).toBe('degraded');
    expect(data.dependencies.find((d) => d.name === 'redis')).toMatchObject({
      state: 'down',
      essential: false,
      // The driver's message (hosts, ports) stays in the server logs.
      error: 'Not responding',
    });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('is unready (503) when essential PostgreSQL is down', async () => {
    const app = buildTestApp({ healthChecks: [down('postgres', true), up('redis', false)] });
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(readinessBody.parse(res.body).data.status).toBe('unready');
  });

  it('reports a disabled dependency without degrading', async () => {
    const app = buildTestApp({
      healthChecks: [
        up('postgres', true),
        { name: 'redis', essential: false, check: async () => 'disabled' },
      ],
    });
    const res = await request(app).get('/api/v1/health/ready');
    const { data } = readinessBody.parse(res.body);
    expect(data.status).toBe('ready');
    expect(data.dependencies[1]?.state).toBe('disabled');
  });

  it('times out a hanging dependency instead of hanging the probe', async () => {
    const app = buildTestApp({
      env: { HEALTH_CHECK_TIMEOUT_MS: 50 },
      healthChecks: [{ name: 'postgres', essential: true, check: () => new Promise(() => {}) }],
    });
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.dependencies[0].error).toMatch(/Timed out after 50ms/);
  });
});
