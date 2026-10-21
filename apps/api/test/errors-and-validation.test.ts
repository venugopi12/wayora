import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiErrorEnvelopeSchema } from '@wayora/contracts';
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler.js';
import { requestId } from '../src/middleware/request-id.js';
import { sendData } from '../src/utils/respond.js';
import { validateRequest } from '../src/utils/validate.js';
import { buildTestApp } from './helpers.js';

const silent = pino({ level: 'silent' });

/** A minimal app exercising body validation through the real middleware chain. */
function bodyValidationApp(exposeInternals = false) {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  app.post('/echo', (req, res) => {
    const { body } = validateRequest(req, {
      body: z.object({ email: z.email(), travellers: z.number().int().min(1).max(9) }),
    });
    sendData(res, body, 201);
  });
  app.get('/boom', () => {
    throw new Error('database password is hunter2');
  });
  app.use(notFoundHandler);
  app.use(errorHandler(silent, { exposeInternals }));
  return app;
}

describe('catalog example module', () => {
  it('lists the seven categories', async () => {
    const res = await request(buildTestApp()).get('/api/v1/catalog/categories');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
  });

  it('filters by a valid query parameter', async () => {
    const res = await request(buildTestApp()).get('/api/v1/catalog/categories?availability=live');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('rejects an invalid query value with VALIDATION_FAILED details', async () => {
    const res = await request(buildTestApp()).get('/api/v1/catalog/categories?availability=soon');
    expect(res.status).toBe(400);
    const { error } = apiErrorEnvelopeSchema.parse(res.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.[0]?.path).toBe('query.availability');
    expect(error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects unknown query parameters', async () => {
    const res = await request(buildTestApp()).get('/api/v1/catalog/categories?debug=true');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('validates path params', async () => {
    const ok = await request(buildTestApp()).get('/api/v1/catalog/categories/flights');
    expect(ok.status).toBe(200);
    expect(ok.body.data.slug).toBe('flights');

    const bad = await request(buildTestApp()).get('/api/v1/catalog/categories/spaceships');
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('params.slug');
  });
});

describe('error handling', () => {
  it('returns a NOT_FOUND envelope for unknown routes', async () => {
    const res = await request(buildTestApp()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_JSON for a malformed body', async () => {
    const res = await request(bodyValidationApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns PAYLOAD_TOO_LARGE when the body exceeds the limit', async () => {
    const res = await request(bodyValidationApp())
      .post('/echo')
      .send({ email: 'a@b.co', travellers: 1, padding: 'x'.repeat(2048) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('reports every invalid body field', async () => {
    const res = await request(bodyValidationApp())
      .post('/echo')
      .send({ email: 'nope', travellers: 0 });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(['body.email', 'body.travellers']);
  });

  it('accepts a valid body', async () => {
    const res = await request(bodyValidationApp())
      .post('/echo')
      .send({ email: 'a@b.co', travellers: 2 });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ email: 'a@b.co', travellers: 2 });
  });

  it('hides internal error messages unless explicitly exposed', async () => {
    const hidden = await request(bodyValidationApp(false)).get('/boom');
    expect(hidden.status).toBe(500);
    expect(hidden.body.error.code).toBe('INTERNAL_ERROR');
    expect(hidden.body.error.message).not.toContain('hunter2');

    const exposed = await request(bodyValidationApp(true)).get('/boom');
    expect(exposed.body.error.message).toContain('hunter2');
  });
});

describe('CORS and rate limiting', () => {
  it('allows configured origins only', async () => {
    const app = buildTestApp();
    const allowed = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const blocked = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns RATE_LIMITED after the limit, but never limits health probes', async () => {
    const app = buildTestApp({ env: { RATE_LIMIT_MAX: 2 } });
    await request(app).get('/api/v1/catalog/categories').expect(200);
    await request(app).get('/api/v1/catalog/categories').expect(200);
    const limited = await request(app).get('/api/v1/catalog/categories');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    for (let i = 0; i < 4; i += 1) {
      await request(app).get('/api/v1/health').expect(200);
    }
  });
});
