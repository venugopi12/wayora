import type { SearchResult } from '@wayora/contracts';
import type { ScheduledLeg } from './providers/types.js';

/*
 * The scheduled legs of a booking, from its offer snapshot (the trusted
 * record of what was booked). Only categories with a timetable have legs:
 * flights (each itinerary), trains and buses. Hotels, holidays, metro (no
 * timetable) and cabs (a pickup time, but no operator status) have none.
 */

const place = (p: { name: string; code: string | null; cityName: string }) => ({
  name: p.name,
  code: p.code,
  cityName: p.cityName,
});

export function scheduledLegs(offer: SearchResult): ScheduledLeg[] {
  switch (offer.serviceType) {
    case 'flights':
      return offer.itineraries.map((it, index) => {
        const first = it.segments[0]!;
        const last = it.segments[it.segments.length - 1]!;
        return {
          index,
          label: it.direction === 'outbound' ? 'Outbound' : 'Return',
          origin: place(first.origin),
          destination: place(last.destination),
          departAt: it.departAt,
          arriveAt: it.arriveAt,
          serviceRef: it.segments.map((s) => `${s.carrier.code}${s.flightNumber}`).join(' '),
        };
      });
    case 'trains':
      return [
        {
          index: 0,
          label: `${offer.origin.cityName} to ${offer.destination.cityName}`,
          origin: place(offer.origin),
          destination: place(offer.destination),
          departAt: offer.departAt,
          arriveAt: offer.arriveAt,
          serviceRef: offer.trainNumber,
        },
      ];
    case 'buses':
      return [
        {
          index: 0,
          label: `${offer.origin.cityName} to ${offer.destination.cityName}`,
          origin: place(offer.origin),
          destination: place(offer.destination),
          departAt: offer.departAt,
          arriveAt: offer.arriveAt,
          serviceRef: offer.operatorName,
        },
      ];
    default:
      return [];
  }
}

/** Tracking stops this long after the last scheduled arrival. */
export const TRACKING_ENDS_AFTER_ARRIVAL_MS = 12 * 60 * 60 * 1000;

/** The end of the tracking window, or null when the booking has no legs. */
export function trackingEndsAt(legs: ScheduledLeg[]): Date | null {
  if (legs.length === 0) return null;
  const last = Math.max(...legs.map((l) => Date.parse(l.arriveAt)));
  return new Date(last + TRACKING_ENDS_AFTER_ARRIVAL_MS);
}
