import { readinessSchema, type Readiness } from '@wayora/contracts';
import { api } from './api';

/** Readiness returns 503 with a valid body when an essential dependency is down. */
export function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  return api.request('/health/ready', {
    schema: readinessSchema,
    signal,
    timeoutMs: 5_000,
    acceptStatuses: [503],
  });
}
