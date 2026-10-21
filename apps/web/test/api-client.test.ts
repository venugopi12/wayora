import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClientError, createApiClient } from '../src/lib/api-client';

const schema = z.object({ ok: z.boolean() });

function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    }),
  );
}

describe('createApiClient', () => {
  it('prefixes /api/v1 and unwraps the success envelope', async () => {
    const fetchMock = respond({ data: { ok: true }, meta: { requestId: 'r' } });
    const client = createApiClient('http://api.test', fetchMock);

    await expect(client.request('/things', { schema })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/things', expect.any(Object));
  });

  it('turns error envelopes into ApiClientError with code, requestId and details', async () => {
    const client = createApiClient(
      'http://api.test',
      respond(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request is invalid.',
            requestId: 'req-42',
            details: [{ path: 'query.x', message: 'bad', code: 'invalid_value' }],
          },
        },
        400,
      ),
    );
    const error = await client.request('/things', { schema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, requestId: 'req-42' });
    expect((error as ApiClientError).details).toHaveLength(1);
  });

  it('rejects responses that do not match the contract', async () => {
    const client = createApiClient(
      'http://api.test',
      respond({ data: { ok: 'yes' }, meta: { requestId: 'r' } }),
    );
    await expect(client.request('/things', { schema })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('accepts listed non-2xx statuses that carry a success envelope', async () => {
    const client = createApiClient(
      'http://api.test',
      respond({ data: { ok: false }, meta: { requestId: 'r' } }, 503),
    );
    await expect(client.request('/ready', { schema, acceptStatuses: [503] })).resolves.toEqual({
      ok: false,
    });
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    const client = createApiClient(
      'http://api.test',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(client.request('/things', { schema })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: null,
    });
  });
});
