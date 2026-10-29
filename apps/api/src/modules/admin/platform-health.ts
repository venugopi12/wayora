import {
  QUEUE_NAMES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_STALE_MS,
  type AdminCheckStatus,
  type AdminHealth,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import type { Logger } from '../../utils/logger.js';

/**
 * The part of the Redis client platform health reads (ioredis-compatible).
 * Read-only commands only.
 */
export interface HealthRedis {
  get(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
  ping(): Promise<string>;
}

export interface PlatformHealthOptions {
  prisma: PrismaClient;
  /** Absent when REDIS_URL isn't set: Redis, worker and queue are "not configured"/"unknown". */
  redis?: HealthRedis;
  logger: Logger;
  timeoutMs: number;
  now?: () => Date;
  /** Seconds since the process started. */
  uptime?: () => number;
  /** How long a report is reused, so the page can't hammer dependencies. */
  cacheMs?: number;
  /** The travel-status provider, if one is configured (docs/trips.md#providers). */
  travelStatus?: {
    providerName: string;
    simulated: boolean;
    recentFailures: () => Promise<number>;
  } | null;
  /** The travel assistant's provider, if one is configured (docs/assistant.md). */
  assistant?: {
    providerName: string;
    simulated: boolean;
    /** Failed provider calls in the last hour (from assistant_requests). */
    recentFailures: () => Promise<number>;
  } | null;
}

/** Outbox or payment work older than this is a backlog worth looking at. */
const BACKLOG_AGE_MS = 15 * 60 * 1000;
const QUEUE_BACKLOG = 1000;

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Platform health for operators (docs/admin.md#platform-health). Unlike the
 * public /health endpoints, this looks at background work: whether the
 * worker is actually running (its own heartbeat, not just Redis being up),
 * queue and outbox backlogs, and payments stuck in progress.
 *
 * Reports states and counts only. No connection strings, hosts, versions,
 * environment values or error text: failures are logged server-side and the
 * report says "down" or "unknown". The report is the same for every staff
 * member, so caching it briefly can't leak anything user-specific.
 */
export class PlatformHealth {
  private cached: { at: number; report: AdminHealth } | undefined;
  private inflight: Promise<AdminHealth> | undefined;
  private readonly now: () => Date;
  private readonly cacheMs: number;

  constructor(private readonly options: PlatformHealthOptions) {
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? 10_000;
  }

  async report(): Promise<AdminHealth> {
    const t = this.now().getTime();
    if (this.cached && t - this.cached.at < this.cacheMs) return this.cached.report;
    this.inflight ??= this.build().finally(() => (this.inflight = undefined));
    const report = await this.inflight;
    this.cached = { at: t, report };
    return report;
  }

  private async probe<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number }> {
    const started = performance.now();
    try {
      const value = await withTimeout(fn(), this.options.timeoutMs);
      return { ok: true, value, ms: Math.round(performance.now() - started) };
    } catch (err) {
      this.options.logger.warn(
        { check: name, err: { message: (err as Error).message } },
        'Admin health check failed',
      );
      return { ok: false, ms: Math.round(performance.now() - started) };
    }
  }

  private async build(): Promise<AdminHealth> {
    const { prisma, redis } = this.options;
    const now = this.now();
    const prefix = `bull:${QUEUE_NAMES.system}`;

    const travel = this.options.travelStatus ?? null;
    const assistant = this.options.assistant ?? null;
    const [db, outbox, payments, ping, beacon, queue, tripFailures, assistantFailures] =
      await Promise.all([
        this.probe('database', () => prisma.$queryRaw`SELECT 1`),
        this.probe('outbox', async () => {
          const [byStatus, oldest] = await Promise.all([
            prisma.notificationDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
            prisma.notificationDelivery.findFirst({
              where: { status: 'PENDING' },
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            }),
          ]);
          const n = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
          return {
            pending: n('PENDING'),
            failed: n('FAILED'),
            notConfigured: n('NOT_CONFIGURED'),
            oldest: oldest?.createdAt ?? null,
          };
        }),
        this.probe('payments', async () => {
          const where = { status: { in: ['CREATED' as const, 'PENDING' as const] } };
          const [count, oldest] = await Promise.all([
            prisma.payment.count({ where }),
            prisma.payment.findFirst({
              where,
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            }),
          ]);
          return { count, oldest: oldest?.createdAt ?? null };
        }),
        redis ? this.probe('redis', () => redis.ping()) : undefined,
        redis ? this.probe('worker', () => redis.get(WORKER_HEARTBEAT_KEY)) : undefined,
        redis
          ? this.probe('queue', async () => {
              const [wait, prioritized, active, delayed, failed] = await Promise.all([
                redis.llen(`${prefix}:wait`),
                redis.zcard(`${prefix}:prioritized`),
                redis.llen(`${prefix}:active`),
                redis.zcard(`${prefix}:delayed`),
                redis.zcard(`${prefix}:failed`),
              ]);
              return { waiting: wait + prioritized, active, delayed, failed };
            })
          : undefined,
        travel ? this.probe('travel-status', () => travel.recentFailures()) : undefined,
        assistant ? this.probe('assistant', () => assistant.recentFailures()) : undefined,
      ]);

    const age = (d: Date | null) => (d ? now.getTime() - d.getTime() : 0);

    // Worker: alive only if it wrote its own heartbeat recently.
    let worker: AdminHealth['worker'];
    if (!redis) {
      worker = {
        status: 'unknown',
        lastHeartbeatAt: null,
        note: 'Redis isn’t configured, so the worker can’t run or report a heartbeat.',
      };
    } else if (!beacon?.ok) {
      worker = {
        status: 'unknown',
        lastHeartbeatAt: null,
        note: 'Redis couldn’t be read, so the worker’s heartbeat is unknown.',
      };
    } else {
      const at = parseBeacon(beacon.value);
      if (!at) {
        worker = {
          status: 'down',
          lastHeartbeatAt: null,
          note: `No worker heartbeat in the last ${WORKER_HEARTBEAT_STALE_MS / 1000} seconds: the worker isn’t running, or can’t reach Redis.`,
        };
      } else if (age(at) > WORKER_HEARTBEAT_STALE_MS) {
        worker = {
          status: 'down',
          lastHeartbeatAt: at.toISOString(),
          note: 'The last worker heartbeat is too old: the worker has stopped or is stuck.',
        };
      } else {
        worker = {
          status: 'up',
          lastHeartbeatAt: at.toISOString(),
          note: 'The worker reported itself running.',
        };
      }
    }

    const queueStatus: AdminCheckStatus = !redis
      ? 'not-configured'
      : !queue?.ok
        ? 'unknown'
        : queue.value.waiting > QUEUE_BACKLOG
          ? 'degraded'
          : 'up';

    return {
      checkedAt: now.toISOString(),
      maxAgeSeconds: Math.round(this.cacheMs / 1000),
      api: { status: 'up', uptimeSeconds: Math.round((this.options.uptime ?? process.uptime)()) },
      database: { status: db.ok ? 'up' : 'down', latencyMs: db.ms },
      redis: !redis
        ? { status: 'not-configured', latencyMs: null }
        : { status: ping?.ok ? 'up' : 'down', latencyMs: ping?.ms ?? null },
      worker,
      queue: {
        status: queueStatus,
        waiting: queue?.ok ? queue.value.waiting : null,
        active: queue?.ok ? queue.value.active : null,
        delayed: queue?.ok ? queue.value.delayed : null,
        failed: queue?.ok ? queue.value.failed : null,
      },
      outbox: outbox.ok
        ? {
            status: age(outbox.value.oldest) > BACKLOG_AGE_MS ? 'degraded' : 'up',
            pending: outbox.value.pending,
            failed: outbox.value.failed,
            notConfigured: outbox.value.notConfigured,
            oldestPendingAt: outbox.value.oldest?.toISOString() ?? null,
          }
        : {
            status: 'unknown',
            pending: null,
            failed: null,
            notConfigured: null,
            oldestPendingAt: null,
          },
      payments: payments.ok
        ? {
            status: age(payments.value.oldest) > BACKLOG_AGE_MS ? 'degraded' : 'up',
            inProgress: payments.value.count,
            oldestInProgressAt: payments.value.oldest?.toISOString() ?? null,
          }
        : { status: 'unknown', inProgress: null, oldestInProgressAt: null },
      travelStatus: !travel
        ? {
            status: 'not-configured',
            providerName: null,
            simulated: false,
            failedChecksLastHour: null,
          }
        : !tripFailures?.ok
          ? {
              status: 'unknown',
              providerName: travel.providerName,
              simulated: travel.simulated,
              failedChecksLastHour: null,
            }
          : {
              status: tripFailures.value > 0 ? 'degraded' : 'up',
              providerName: travel.providerName,
              simulated: travel.simulated,
              failedChecksLastHour: tripFailures.value,
            },
      assistant: !assistant
        ? {
            status: 'not-configured',
            providerName: null,
            simulated: false,
            failedRequestsLastHour: null,
          }
        : !assistantFailures?.ok
          ? {
              status: 'unknown',
              providerName: assistant.providerName,
              simulated: assistant.simulated,
              failedRequestsLastHour: null,
            }
          : {
              status: assistantFailures.value > 0 ? 'degraded' : 'up',
              providerName: assistant.providerName,
              simulated: assistant.simulated,
              failedRequestsLastHour: assistantFailures.value,
            },
    };
  }
}

function parseBeacon(value: string | null): Date | null {
  if (!value) return null;
  try {
    const at = (JSON.parse(value) as { at?: unknown }).at;
    if (typeof at !== 'string') return null;
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
