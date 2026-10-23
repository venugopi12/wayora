import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validateWorkerEnv } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const BASE = { REDIS_URL: 'redis://localhost:6379' };
const PROD = {
  NODE_ENV: 'production',
  REDIS_URL: 'rediss://:prod@cache.internal:6380',
  DATABASE_URL: 'postgresql://wayora:prod-secret@db.internal:5432/wayora',
  WEB_ORIGIN: 'https://wayora.example',
};
const issues = (source: Record<string, string>) => {
  const result = validateWorkerEnv(source);
  return result.ok ? [] : result.issues;
};

describe('worker configuration', () => {
  it('development runs without a database (notifications wait in the outbox)', () => {
    expect(issues(BASE)).toEqual([]);
  });

  it('production needs the database, real credentials and an https web origin', () => {
    expect(issues(PROD)).toEqual([]);
    const { DATABASE_URL: _d, ...noDb } = PROD;
    expect(issues(noDb)).toEqual([
      expect.stringMatching(/^DATABASE_URL: is required in production/),
    ]);
    const bad = issues({
      ...PROD,
      DATABASE_URL: 'postgresql://wayora:wayora_local_dev_only@db:5432/wayora',
      WEB_ORIGIN: 'http://wayora.example',
    });
    expect(bad).toHaveLength(2);
    expect(bad.join('\n')).not.toContain('wayora_local_dev_only');
  });

  it('names a missing REDIS_URL', () => {
    expect(issues({})).toEqual(['REDIS_URL: is required but not set']);
  });
});

describe('worker logs', () => {
  it('redact credentials and personal fields', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _e, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = createLogger(
      { LOG_LEVEL: 'info', LOG_FORMAT: 'json', NODE_ENV: 'test' },
      stream,
    );
    logger.info(
      {
        delivery: {
          email: 'asha@example.com',
          password: 'hunter2',
          token: 't0k',
          firstName: 'Asha',
        },
      },
      'Email delivery failed',
    );
    const line = lines.join('');
    expect(line).toContain('Email delivery failed');
    expect(line).not.toMatch(/asha@example|hunter2|t0k|"Asha"/);
    expect(line).toContain('[REDACTED]');
  });
});
