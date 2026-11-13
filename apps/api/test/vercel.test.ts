import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { vercelEnvDefaults } from '../src/config/vercel-env.js';

/* Vercel deployment entry (docs/deployment-vercel.md). */

describe('vercelEnvDefaults', () => {
  it('does nothing outside Vercel', () => {
    expect(vercelEnvDefaults({ VERCEL_URL: 'x.vercel.app' })).toEqual({});
  });

  it('uses the production domain for production deployments, and allows the deployment URLs', () => {
    const out = vercelEnvDefaults({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'wayora.vercel.app',
      VERCEL_URL: 'wayora-abc123.vercel.app',
      VERCEL_BRANCH_URL: 'wayora-git-main.vercel.app',
      DATABASE_URL: 'postgresql://pooled',
      DATABASE_URL_UNPOOLED: 'postgresql://direct',
      KV_URL: 'rediss://default:t@x.upstash.io:6379',
    });
    expect(out).toMatchObject({
      WEB_ORIGIN: 'https://wayora.vercel.app',
      API_BASE_URL: 'https://wayora.vercel.app',
      CORS_ORIGIN:
        'https://wayora.vercel.app,https://wayora-git-main.vercel.app,https://wayora-abc123.vercel.app',
      DATABASE_URL: 'postgresql://direct',
      REDIS_URL: 'rediss://default:t@x.upstash.io:6379',
      TRUST_PROXY: '1',
    });
  });

  it('uses the branch URL for previews and never overrides values that are set', () => {
    const out = vercelEnvDefaults({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_PRODUCTION_URL: 'wayora.vercel.app',
      VERCEL_URL: 'wayora-abc123.vercel.app',
      VERCEL_BRANCH_URL: 'wayora-git-feature.vercel.app',
      WEB_ORIGIN: 'https://www.example.com',
      REDIS_URL: 'rediss://set',
      KV_URL: 'rediss://other',
    });
    expect(out.WEB_ORIGIN).toBeUndefined();
    expect(out.REDIS_URL).toBeUndefined();
    expect(out.API_BASE_URL).toBe('https://wayora-git-feature.vercel.app');
    expect(out.CORS_ORIGIN).not.toContain('wayora.vercel.app,');
  });
});

describe('scheduled maintenance endpoint', () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('refuses calls without the cron secret, and runs nothing when no secret is configured', async () => {
    const { default: app } = await import('../src/vercel.js');
    delete process.env.CRON_SECRET;
    await request(app).get('/api/internal/cron').expect(401);
    await request(app).get('/api/internal/cron').set('Authorization', 'Bearer ').expect(401);
    process.env.CRON_SECRET = 'right';
    await request(app).get('/api/internal/cron').set('Authorization', 'Bearer wrong').expect(401);
  });
});
