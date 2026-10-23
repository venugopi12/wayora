import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_STALE_MS } from '@wayora/contracts';
import type { DependencyCheck } from './health.js';

/**
 * Readiness entry for the background worker (optional: the API serves
 * requests without it, but notification delivery stops). "Up" only when the
 * worker's own heartbeat is fresh — Redis answering says nothing about the
 * worker (docs/admin.md#platform-health).
 */
export function workerHeartbeatCheck(
  redis: { get(key: string): Promise<string | null> } | undefined,
  now: () => number = Date.now,
): DependencyCheck {
  return {
    name: 'worker',
    essential: false,
    check: async () => {
      if (!redis) return 'disabled';
      const value = await redis.get(WORKER_HEARTBEAT_KEY);
      if (!value) throw new Error('No worker heartbeat');
      let at = Number.NaN;
      try {
        at = Date.parse(String((JSON.parse(value) as { at?: unknown }).at));
      } catch {
        // Unreadable heartbeat: treated as missing.
      }
      if (!Number.isFinite(at) || now() - at > WORKER_HEARTBEAT_STALE_MS) {
        throw new Error('Worker heartbeat is stale');
      }
    },
  };
}
