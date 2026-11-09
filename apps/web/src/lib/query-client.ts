import { QueryClient } from '@tanstack/react-query';
import { ApiClientError } from './api-client';

/** Do not retry errors that will not fix themselves (4xx, invalid responses). */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError) {
    const transient = error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT';
    // Offline reads pause (and resume on reconnecting) rather than retrying.
    const serverError = error.status !== null && error.status >= 500;
    if (!transient && !serverError) return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
        // React Query would otherwise pause a change made offline and send it
        // when the connection returns. Bookings, payments, cancellations and
        // every other change must never go out later on their own
        // (docs/pwa.md#offline): run now, and fail with OFFLINE if offline.
        networkMode: 'always',
      },
    },
  });
}
