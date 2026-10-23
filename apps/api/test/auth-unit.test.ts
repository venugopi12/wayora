import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { requireTrustedOrigin } from '../src/middleware/csrf.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { readCookie, sessionCookieName } from '../src/modules/auth/cookies.js';
import { hashPassword, needsRehash, verifyPassword } from '../src/modules/auth/password.js';
import { toSafeUser } from '../src/modules/auth/safe-user.js';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
} from '../src/modules/auth/session-token.js';
import { REDACT_PATHS } from '../src/utils/logger.js';
import type { PrismaClient } from '@wayora/database';
import { buildTestApp, validEnvSource } from './helpers.js';

describe('password hashing', () => {
  it('uses Argon2id with the configured parameters and verifies correctly', async () => {
    const hash = await hashPassword('blue river morning');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('blue river morning');
    expect(await verifyPassword(hash, 'blue river morning')).toBe(true);
    expect(await verifyPassword(hash, 'Blue river morning')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash and never throws on garbage', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('flags hashes made with older parameters for upgrade', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
  });
});

describe('session tokens', () => {
  it('are 256-bit random base64url values stored only as SHA-256 hex', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(isWellFormedToken(a)).toBe(true);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).toBe(hashSessionToken(a));
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${a.slice(0, 42)}=`)).toBe(false);
  });
});

describe('session cookie', () => {
  it('uses the __Host- prefix only when Secure', () => {
    expect(sessionCookieName(true)).toBe('__Host-wayora_session');
    expect(sessionCookieName(false)).toBe('wayora_session');
  });

  it('reads one cookie from the header and ignores malformed values', () => {
    const req = { headers: { cookie: 'a=1; wayora_session=abc%20def; b=2' } };
    expect(readCookie(req as never, 'wayora_session')).toBe('abc def');
    expect(readCookie({ headers: {} } as never, 'wayora_session')).toBeUndefined();
    expect(
      readCookie({ headers: { cookie: 'wayora_session=%E0%A4' } } as never, 'wayora_session'),
    ).toBeUndefined();
  });
});

describe('CSRF origin check', () => {
  const app = express();
  app.use(requireTrustedOrigin(['http://localhost:5173']));
  app.all('/x', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler(pino({ level: 'silent' }), { exposeInternals: false }));

  it('allows safe methods from anywhere', async () => {
    expect((await request(app).get('/x').set('Origin', 'https://evil.example')).status).toBe(200);
  });

  it('allows state-changing requests from allowed origins only', async () => {
    expect((await request(app).post('/x').set('Origin', 'http://localhost:5173')).status).toBe(200);
    const blocked = await request(app).post('/x').set('Origin', 'https://evil.example');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');
    expect((await request(app).delete('/x').set('Origin', 'null')).status).toBe(403);
  });

  it('uses Sec-Fetch-Site when Origin is missing, and allows non-browser clients', async () => {
    expect((await request(app).post('/x').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).post('/x').set('Sec-Fetch-Site', 'same-site')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(200);
  });
});

describe('auth configuration', () => {
  it('defaults to a 7-day idle and 30-day absolute session', () => {
    const env = parseEnv(validEnvSource);
    expect(env.SESSION_IDLE_TIMEOUT_HOURS).toBe(168);
    expect(env.SESSION_ABSOLUTE_TIMEOUT_HOURS).toBe(720);
  });

  it('rejects an idle timeout longer than the absolute lifetime', () => {
    expect(() => parseEnv({ ...validEnvSource, SESSION_IDLE_TIMEOUT_HOURS: '800' })).toThrow(
      /SESSION_IDLE_TIMEOUT_HOURS/,
    );
  });

  it('requires HTTPS origins in production (session cookies are Secure there)', () => {
    expect(() => parseEnv({ ...validEnvSource, NODE_ENV: 'production' })).toThrow(
      /CORS_ORIGIN: http:\/\/localhost:5173 must use https/,
    );
    expect(
      parseEnv({
        ...validEnvSource,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://wayora.example',
        WEB_ORIGIN: 'https://wayora.example',
        API_BASE_URL: 'https://api.wayora.example',
        DATABASE_URL: 'postgresql://wayora:prod-secret@db.internal:5432/wayora',
      }).NODE_ENV,
    ).toBe('production');
  });
});

describe('what leaves the server', () => {
  it('toSafeUser exposes an allow-list of fields only', () => {
    const safe = toSafeUser({
      id: '01890000-0000-7000-8000-000000000000',
      email: 'a@b.co',
      emailVerifiedAt: null,
      displayName: 'Asha',
      phoneE164: '+919876543210',
      passwordHash: '$argon2id$secret',
      status: 'ACTIVE',
      role: 'USER',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(Object.keys(safe).sort()).toEqual([
      'createdAt',
      'email',
      'emailVerified',
      'id',
      'name',
      'role',
    ]);
    expect(JSON.stringify(safe)).not.toContain('argon2');
  });

  it('redacts credentials and cookies from logs', () => {
    for (const path of [
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.sessionToken',
      '*.tokenHash',
    ])
      expect(REDACT_PATHS).toContain(path);
  });
});

describe('GET /auth/session failures', () => {
  // A stand-in database whose session lookup fails, as when PostgreSQL is down.
  const brokenPrisma = {
    session: {
      findUnique: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
    },
  } as unknown as PrismaClient;

  it('reports a real failure as 500, not as "signed out"', async () => {
    const res = await request(buildTestApp({ prisma: brokenPrisma }))
      .get('/api/v1/auth/session')
      .set('Cookie', `wayora_session=${generateSessionToken()}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('answers a visitor without a cookie without touching the database', async () => {
    const res = await request(buildTestApp({ prisma: brokenPrisma })).get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ user: null });
  });
});
