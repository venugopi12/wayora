import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { connectionErrorMessage, endpointForLog } from '../src/utils/log-safety.js';

/*
 * Local start-up problems are reported clearly: a refused connection says
 * why (Node's AggregateError has an empty message), connection URLs never
 * reach the logs with credentials, and a busy port is not logged as
 * "listening".
 */

describe('connectionErrorMessage', () => {
  it('explains an AggregateError from a refused localhost connection', () => {
    const err = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:6379'),
          new Error('connect ECONNREFUSED 127.0.0.1:6379'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    expect(connectionErrorMessage(err)).toBe(
      'connect ECONNREFUSED ::1:6379; connect ECONNREFUSED 127.0.0.1:6379',
    );
  });

  it('falls back to the code, and keeps a normal message', () => {
    expect(connectionErrorMessage(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe(
      'ETIMEDOUT',
    );
    expect(connectionErrorMessage(new Error('boom redis://:pw@cache:6379'))).toBe(
      'boom redis://cache:6379',
    );
  });

  it('endpointForLog keeps host and port only', () => {
    expect(endpointForLog('redis://:secret@cache.internal:6380/0')).toBe('cache.internal:6380');
    expect(endpointForLog('redis://localhost')).toBe('localhost:6379');
    expect(endpointForLog('not a url')).toBeUndefined();
  });
});

describe('API start-up on a busy port', () => {
  it('exits with a clear message and never logs "listening"', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'development',
          LOG_FORMAT: 'json',
          LOG_LEVEL: 'info',
          PORT: String(port),
          HOST: '127.0.0.1',
          // apps/api/.env is loaded when present but never overrides these,
          // so the run doesn't depend on local services.
          SEARCH_SESSION_STORE: 'memory',
          REDIS_URL: '',
          DATABASE_URL: 'postgresql://wayora:unused@127.0.0.1:1/unused_test',
        },
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code).toBe(1);
      expect(out).toContain(`Port ${port} is already in use`);
      expect(out).not.toContain('Wayora API listening');
    } finally {
      blocker.close();
    }
  }, 30_000);
});
