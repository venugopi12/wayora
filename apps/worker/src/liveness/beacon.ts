import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_STALE_MS } from '@wayora/contracts';
import type { Logger } from '../logger.js';

/** The part of BullMQ's Redis client the beacon needs. */
export interface BeaconRedis {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
}

export const BEACON_INTERVAL_MS = 15_000;

/**
 * Liveness beacon (docs/admin.md#platform-health). While the worker's job
 * loop is running it writes `{at}` to Redis every 15s with a 60s expiry, so
 * the admin health page can tell "worker running" from "Redis reachable":
 * a stopped or hung worker stops writing and the key expires. The value holds
 * a timestamp only: no host names, ids or configuration.
 */
export function writeBeacon(redis: BeaconRedis, now: Date): Promise<unknown> {
  return redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: now.toISOString() }), {
    PX: WORKER_HEARTBEAT_STALE_MS,
  });
}

export interface Beacon {
  stop(): void;
}

/**
 * Starts the beacon. `isRunning` gates each write (the worker's own state),
 * so a paused or closing worker stops reporting itself as alive.
 */
export function startBeacon(options: {
  redis: () => Promise<BeaconRedis>;
  isRunning: () => boolean;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
}): Beacon {
  const now = options.now ?? (() => new Date());
  let lastErrorLogAt = 0;
  const beat = async () => {
    if (!options.isRunning()) return;
    try {
      await writeBeacon(await options.redis(), now());
    } catch (err) {
      const t = Date.now();
      if (t - lastErrorLogAt < 60_000) return;
      lastErrorLogAt = t;
      options.logger.warn(
        { err: { message: (err as Error).message } },
        'Could not write the worker liveness beacon (retrying)',
      );
    }
  };
  const timer = setInterval(() => void beat(), options.intervalMs ?? BEACON_INTERVAL_MS);
  timer.unref();
  void beat();
  return { stop: () => clearInterval(timer) };
}
