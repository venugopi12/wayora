import { API_V1_PREFIX, type AnalyticsInteraction } from '@wayora/contracts';
import { publicEnv } from '../lib/env';
import { trackingDeclined } from './content';

/**
 * "Offer chosen" (docs/analytics.md#client-events): sent when someone
 * continues to book an offer. Nothing is sent when the visitor declined
 * tracking (Do Not Track or Global Privacy Control); no cookie or account
 * is sent; failures are ignored.
 */
export function trackOfferSelected(event: Omit<AnalyticsInteraction, 'type'>): void {
  if (trackingDeclined()) return;
  try {
    void fetch(`${publicEnv.apiBaseUrl}${API_V1_PREFIX}/analytics/interactions`, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'offer.selected', ...event }] }),
    }).catch(() => undefined);
  } catch {
    // Best effort; never break booking.
  }
}
