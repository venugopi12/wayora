import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';
import { validEnvSource } from './helpers.js';

function expectEnvError(source: Record<string, string | undefined>): EnvValidationError {
  try {
    parseEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return error as EnvValidationError;
  }
  throw new Error('Expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('parses a valid environment with typed values and defaults', () => {
    const env = parseEnv(validEnvSource);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173']);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.RATE_LIMIT_MAX).toBe(120);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('splits comma-separated CORS origins', () => {
    const env = parseEnv({
      ...validEnvSource,
      CORS_ORIGIN: 'http://localhost:5173, https://app.wayora.com',
    });
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173', 'https://app.wayora.com']);
  });

  it('treats an empty REDIS_URL as disabled', () => {
    expect(parseEnv({ ...validEnvSource, REDIS_URL: '' }).REDIS_URL).toBeUndefined();
  });

  it('parses TRUST_PROXY hop counts', () => {
    expect(parseEnv({ ...validEnvSource, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(parseEnv({ ...validEnvSource, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('names every missing essential variable with an actionable fix', () => {
    const error = expectEnvError({ NODE_ENV: 'development' });
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'DATABASE_URL: is required but not set',
        'CORS_ORIGIN: is required but not set',
        'WEB_ORIGIN: is required but not set',
        'API_BASE_URL: is required but not set',
      ]),
    );
    expect(error.message).toContain('apps/api/.env.example');
  });

  it('rejects a wildcard CORS origin', () => {
    const error = expectEnvError({ ...validEnvSource, CORS_ORIGIN: '*' });
    expect(error.message).toMatch(/CORS_ORIGIN.*wildcard/);
  });

  it('rejects malformed URLs and ports', () => {
    const error = expectEnvError({
      ...validEnvSource,
      DATABASE_URL: 'mysql://localhost/db',
      REDIS_URL: 'http://localhost:6379',
      PORT: '99999',
    });
    const keys = error.issues.map((issue) => issue.split(':')[0]);
    expect(keys).toEqual(expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'PORT']));
  });
});
