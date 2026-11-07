import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  ROLE_PERMISSIONS,
  WORKER_HEARTBEAT_KEY,
  hasPermission,
  isStaff,
  type ProviderStatus,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { PlatformHealth, type HealthRedis } from '../src/modules/admin/platform-health.js';
import {
  outcomeFor,
  prismaSearchEventRecorder,
  type SearchEventRecord,
} from '../src/modules/search/analytics.js';
import {
  hotelResult,
  hotelsRequest,
  serviceWith,
  stubProvider,
  unavailable,
} from './search-support.js';

const silent = pino({ level: 'silent' });

describe('roles and permissions (one map, enforced by the API)', () => {
  it('ordinary users have no admin permission at all', () => {
    expect(ROLE_PERMISSIONS.user).toEqual([]);
    expect(isStaff('user')).toBe(false);
    for (const p of ADMIN_PERMISSIONS) expect(hasPermission('user', p)).toBe(false);
  });

  it('support can read operations but not the audit log; admin has everything', () => {
    expect(isStaff('support')).toBe(true);
    expect(hasPermission('support', 'admin.audit.read')).toBe(false);
    expect(hasPermission('support', 'admin.payments.read')).toBe(true);
    for (const p of ADMIN_PERMISSIONS) expect(hasPermission('admin', p)).toBe(true);
  });

  it('defines read permissions plus writes: supplier reservations (Phase 23), rewards (Phase 25), promotions (Phase 26), support (Phase 27) and reviews (Phase 28)', () => {
    const writes = ADMIN_PERMISSIONS.filter((p) => !p.endsWith('.read'));
    expect(writes).toEqual([
      'admin.reservations.manage',
      'admin.rewards.manage',
      'admin.promotions.manage',
      'admin.support.manage',
      'admin.support.supervise',
      'admin.reviews.moderate',
      'admin.reviews.remove',
    ]);
    // Support staff's writes: working support tickets (Phase 27) and moderating reviews (Phase 28).
    expect(ROLE_PERMISSIONS.support.filter((p) => !p.endsWith('.read'))).toEqual([
      'admin.support.manage',
      'admin.reviews.moderate',
    ]);
    expect(ROLE_PERMISSIONS.support).not.toContain('admin.reviews.remove');
    expect(ROLE_PERMISSIONS.support).not.toContain('admin.support.supervise');
    expect(ROLE_PERMISSIONS.support).not.toContain('admin.promotions.manage');
    expect(ROLE_PERMISSIONS.support).toContain('admin.promotions.read');
    expect(ROLE_PERMISSIONS.support).not.toContain('admin.reservations.manage');
    expect(ROLE_PERMISSIONS.support).not.toContain('admin.rewards.manage');
    expect(ROLE_PERMISSIONS.support).toContain('admin.rewards.read');
    expect(ROLE_PERMISSIONS.user).toEqual([]);
    expect(ROLE_PERMISSIONS.admin).toContain('admin.reservations.manage');
  });
});

describe('search analytics', () => {
  const status = (s: ProviderStatus['status']): ProviderStatus => ({
    providerId: 'p',
    providerName: 'P',
    kind: 'demo',
    status: s,
    resultCount: 0,
    durationMs: 1,
    message: null,
  });

  it('classifies outcomes', () => {
    expect(outcomeFor([status('success')], 3)).toBe('SUCCESS');
    expect(outcomeFor([status('success'), status('timeout')], 3)).toBe('PARTIAL');
    expect(outcomeFor([status('empty')], 0)).toBe('EMPTY');
  });

  it('records one event per search: outcome, timing and provider calls, nothing about the traveller', async () => {
    const events: SearchEventRecord[] = [];
    const service = serviceWith(
      [stubProvider('p1', { kind: 'results', results: [hotelResult('p1', 'a', 5000)] })],
      {
        recordEvent: (e) => events.push(e),
      },
    );
    const response = await service.search(hotelsRequest());
    await service.search(hotelsRequest()); // reused session: no provider calls
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      serviceType: 'hotels',
      outcome: 'SUCCESS',
      searchId: response.searchId,
      resultCount: 1,
      errorCode: null,
      providers: [{ id: 'p1', status: 'success', durationMs: expect.any(Number) }],
    });
    expect(events[1]!.providers).toEqual([]);
    expect(Object.keys(events[0]!).sort()).toEqual(
      [
        'durationMs',
        'errorCode',
        'outcome',
        'providers',
        'resultCount',
        'searchId',
        'serviceType',
      ].sort(),
    );
  });

  it('records failed searches with their error code and still throws', async () => {
    const events: SearchEventRecord[] = [];
    const service = serviceWith([stubProvider('p1', { kind: 'throw', error: unavailable })], {
      recordEvent: (e) => events.push(e),
    });
    await expect(service.search(hotelsRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(events).toEqual([
      expect.objectContaining({
        outcome: 'FAILED',
        searchId: null,
        errorCode: 'PROVIDER_UNAVAILABLE',
        providers: [expect.objectContaining({ id: 'p1', status: 'unavailable' })],
      }),
    ]);
  });

  it('a failing analytics write never fails the search', async () => {
    const prisma = {
      searchEvent: { create: () => Promise.reject(new Error('database is down')) },
    } as unknown as PrismaClient;
    const record = prismaSearchEventRecorder(prisma, silent);
    const service = serviceWith(
      [stubProvider('p1', { kind: 'results', results: [hotelResult('p1', 'a', 5000)] })],
      { recordEvent: record },
    );
    await expect(service.search(hotelsRequest())).resolves.toMatchObject({ serviceType: 'hotels' });
  });
});

describe('platform health', () => {
  const prisma = (ok = true) =>
    ({
      $queryRaw: () =>
        ok ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('down')),
      notificationDelivery: {
        groupBy: () => Promise.resolve([]),
        findFirst: () => Promise.resolve(null),
      },
      payment: { count: () => Promise.resolve(0), findFirst: () => Promise.resolve(null) },
    }) as unknown as PrismaClient;

  const hangingRedis: HealthRedis = {
    get: () => new Promise(() => {}),
    llen: () => new Promise(() => {}),
    zcard: () => new Promise(() => {}),
    ping: () => new Promise(() => {}),
  };

  it('a hung Redis makes the report "unknown" within the timeout, never "up"', async () => {
    const health = new PlatformHealth({
      prisma: prisma(),
      redis: hangingRedis,
      logger: silent,
      timeoutMs: 50,
    });
    const started = Date.now();
    const report = await health.report();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(report.redis.status).toBe('down');
    expect(report.worker.status).toBe('unknown');
    expect(report.queue.status).toBe('unknown');
  });

  it('a database outage is reported as down/unknown, not as zero work', async () => {
    const health = new PlatformHealth({ prisma: prisma(false), logger: silent, timeoutMs: 50 });
    const report = await health.report();
    expect(report.database.status).toBe('down');
    expect(report.redis.status).toBe('not-configured');
  });

  it('caches the report briefly (dependencies are not hit per page view)', async () => {
    let gets = 0;
    const redis: HealthRedis = {
      get: (key) => {
        gets += 1;
        return Promise.resolve(
          key === WORKER_HEARTBEAT_KEY ? JSON.stringify({ at: new Date().toISOString() }) : null,
        );
      },
      llen: () => Promise.resolve(0),
      zcard: () => Promise.resolve(0),
      ping: () => Promise.resolve('PONG'),
    };
    let t = Date.now();
    const health = new PlatformHealth({
      prisma: prisma(),
      redis,
      logger: silent,
      timeoutMs: 50,
      now: () => new Date(t),
    });
    expect((await health.report()).worker.status).toBe('up');
    await health.report();
    expect(gets).toBe(1);
    t += 11_000;
    await health.report();
    expect(gets).toBe(2);
  });
});
