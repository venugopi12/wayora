import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_STALE_MS } from '@wayora/contracts';
import { startBeacon, writeBeacon, type BeaconRedis } from '../src/liveness/beacon.js';

const logger = pino({ level: 'silent' });

function fakeRedis() {
  const calls: unknown[][] = [];
  const redis: BeaconRedis = {
    set: (...args) => {
      calls.push(args);
      return Promise.resolve('OK');
    },
  };
  return { redis, calls };
}

describe('worker liveness beacon', () => {
  it('writes only a timestamp, with an expiry equal to the staleness limit', async () => {
    const { redis, calls } = fakeRedis();
    await writeBeacon(redis, new Date('2026-10-25T10:00:00.000Z'));
    expect(calls).toEqual([
      [
        WORKER_HEARTBEAT_KEY,
        JSON.stringify({ at: '2026-10-25T10:00:00.000Z' }),
        { PX: WORKER_HEARTBEAT_STALE_MS },
      ],
    ]);
  });

  it('does not report itself alive while the worker is not running', async () => {
    const { redis, calls } = fakeRedis();
    const beacon = startBeacon({
      redis: () => Promise.resolve(redis),
      isRunning: () => false,
      logger,
      intervalMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    beacon.stop();
    expect(calls).toHaveLength(0);
  });

  it('keeps beating while running and survives Redis errors', async () => {
    let fail = true;
    const set = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve('OK')));
    const beacon = startBeacon({
      redis: () => Promise.resolve({ set }),
      isRunning: () => true,
      logger,
      intervalMs: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    fail = false;
    await new Promise((r) => setTimeout(r, 20));
    beacon.stop();
    const count = set.mock.calls.length;
    expect(count).toBeGreaterThan(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(set.mock.calls.length).toBe(count);
  });
});
