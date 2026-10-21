import { QueryClient } from '@tanstack/react-query';
import { ApiClientError } from './api-client';

/** Do not retry errors that will not fix themselves (4xx, invalid responses). */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError) {
    const transient = error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT';
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
      },
    },
  });
}
