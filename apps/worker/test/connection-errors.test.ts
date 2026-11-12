import { describe, expect, it } from 'vitest';
import { connectionErrorMessage, endpointForLog, errorCode } from '../src/connection-errors.js';

describe('worker connection errors in the logs', () => {
  it('explains a refused localhost connection (AggregateError with an empty message)', () => {
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
    expect(errorCode(err)).toBe('ECONNREFUSED');
  });

  it('never logs credentials', () => {
    expect(connectionErrorMessage(new Error('failed rediss://:secret@cache:6380'))).toBe(
      'failed rediss://cache:6380',
    );
    expect(endpointForLog('rediss://:secret@cache.internal:6380')).toBe('cache.internal:6380');
    expect(endpointForLog('redis://localhost')).toBe('localhost:6379');
  });
});
