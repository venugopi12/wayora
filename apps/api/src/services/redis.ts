import { Redis } from 'ioredis';
import { connectionErrorMessage, endpointForLog } from '../utils/log-safety.js';
import type { Logger } from '../utils/logger.js';

export interface RedisConnection {
  readonly client: Redis;
  /** Starts connecting in the background. Never throws: Redis is optional for the API. */
  connect(): Promise<void>;
  /** Throws when Redis does not answer PING. Used by readiness checks. */
  ping(): Promise<void>;
  /** Graceful QUIT, falling back to a hard disconnect. */
  close(): Promise<void>;
}

const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Creates a Redis client tuned for request-path use:
 * - commands fail fast while disconnected (no unbounded offline queue),
 * - reconnects automatically with capped backoff,
 * - connection errors are logged, but throttled so an outage does not flood logs.
 *
 * BullMQ workers need different settings (`maxRetriesPerRequest: null`) and
 * create their own connections — see apps/worker.
 */
export function createRedisConnection(url: string, logger: Logger): RedisConnection {
  const log = logger.child({ component: 'redis', redis: endpointForLog(url) });
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    // A hung Redis must not hold requests (rate limits, search sessions) open.
    commandTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  });

  let lastErrorLogAt = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorLogAt = now;
    const code = (err as { code?: string }).code;
    log.warn(
      {
        err: { message: connectionErrorMessage(err), code },
        ...(code === 'ECONNREFUSED' && process.env.NODE_ENV !== 'production'
          ? {
              hint: 'Redis is not running. Start it with `npm run infra:up` (Docker) or your local Redis service.',
            }
          : {}),
      },
      'Redis connection error',
    );
  });
  client.on('ready', () => {
    lastErrorLogAt = 0;
    log.info('Redis connection ready');
  });
  client.on('reconnecting', (delay: number) => log.debug({ delay }, 'Redis reconnecting'));

  return {
    client,
    async connect() {
      try {
        await client.connect();
      } catch {
        // Logged by the 'error' listener; retryStrategy keeps reconnecting.
      }
    },
    async ping() {
      const reply = await client.ping();
      if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
    },
    async close() {
      if (client.status === 'end') return;
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
