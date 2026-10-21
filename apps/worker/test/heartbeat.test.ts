import { UnrecoverableError, type Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { JOB_NAMES } from '@wayora/contracts';
import { bullConnection } from '../src/config.js';
import { processHeartbeat } from '../src/jobs/heartbeat.js';
import { createProcessor } from '../src/processor.js';

const logger = pino({ level: 'silent' });

/** Minimal stand-in for a BullMQ Job — no Redis needed. */
function fakeJob(name: string, data: unknown): Job {
  return { id: '1', name, data, attemptsMade: 0 } as unknown as Job;
}

describe('processHeartbeat', () => {
  it('computes queue latency from requestedAt', () => {
    const now = new Date('2026-01-01T00:00:01.250Z');
    const result = processHeartbeat(
      { requestedAt: '2026-01-01T00:00:00.000Z', source: 'cli' },
      now,
    );
    expect(result).toEqual({ processedAt: '2026-01-01T00:00:01.250Z', queueLatencyMs: 1250 });
  });

  it('never reports negative latency for clock skew', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = processHeartbeat(
      { requestedAt: '2026-01-01T00:00:05.000Z', source: 'api' },
      now,
    );
    expect(result.queueLatencyMs).toBe(0);
  });
});

describe('job processor', () => {
  const process = createProcessor(logger);

  it('dispatches the heartbeat job', async () => {
    const result = await process(
      fakeJob(JOB_NAMES.systemHeartbeat, { requestedAt: new Date().toISOString(), source: 'cli' }),
    );
    expect(result).toMatchObject({ queueLatencyMs: expect.any(Number) });
  });

  it('fails invalid payloads permanently instead of retrying', async () => {
    await expect(
      process(fakeJob(JOB_NAMES.systemHeartbeat, { source: 'cli', email: 'leak@example.com' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('fails unknown job names permanently', async () => {
    await expect(process(fakeJob('does.not.exist', {}))).rejects.toThrow(/Unknown job/);
  });
});

describe('bullConnection', () => {
  it('parses credentials, db and TLS from REDIS_URL', () => {
    expect(bullConnection('rediss://user:p%40ss@cache.example.com:6380/2')).toEqual({
      host: 'cache.example.com',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('defaults port and db', () => {
    expect(bullConnection('redis://localhost')).toMatchObject({ port: 6379, db: 0 });
  });
});
