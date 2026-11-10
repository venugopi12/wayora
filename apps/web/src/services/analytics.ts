import {
  ANALYTICS_REPORT_SCHEMAS,
  API_V1_PREFIX,
  apiErrorEnvelopeSchema,
  type AnalyticsQuery,
  type AnalyticsReport,
  type AnalyticsReports,
} from '@wayora/contracts';
import { ApiClientError } from '../lib/api-client';
import { publicEnv } from '../lib/env';
import { queryString } from './admin';
import { api, credentialsFor } from './api';

/*
 * Analytics (Phase 31, docs/analytics.md). Staff reports and CSV exports
 * (authorized on the server by the session's role). The one behavioural
 * event the web app sends is in analytics-events.ts (kept apart so offer
 * pages don't load the report schemas).
 */

const reportQuery = (q: AnalyticsQuery) =>
  queryString({ preset: q.preset, from: q.from, to: q.to, granularity: q.granularity });

export function getReport<R extends AnalyticsReport>(
  report: R,
  query: AnalyticsQuery,
  signal?: AbortSignal,
): Promise<AnalyticsReports[R]> {
  return api.request(`/admin/analytics/${report}${reportQuery(query)}`, {
    schema: ANALYTICS_REPORT_SCHEMAS[report],
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  }) as Promise<AnalyticsReports[R]>;
}

/**
 * Downloads a report as CSV. The server checks the export permission, audits
 * the export and names the file; this saves what it sent.
 */
export async function downloadReport(
  report: AnalyticsReport,
  query: AnalyticsQuery,
): Promise<void> {
  const base = publicEnv.apiBaseUrl;
  const response = await fetch(
    `${base}${API_V1_PREFIX}/admin/analytics/${report}/export${reportQuery(query)}`,
    {
      credentials: credentialsFor(base, window.location.origin),
      headers: { Accept: 'text/csv' },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
      const { code, message, requestId } = parsed.data.error;
      throw new ApiClientError(code, message, response.status, requestId);
    }
    throw new ApiClientError('INVALID_RESPONSE', 'The export failed.', response.status);
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
    `wayora-${report}.csv`;
  const url = URL.createObjectURL(await response.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
