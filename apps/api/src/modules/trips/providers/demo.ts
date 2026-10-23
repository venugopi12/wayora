import { createHash } from 'node:crypto';
import type { SearchServiceType } from '@wayora/contracts';
import type { ProviderReport, StatusQuery, TravelStatusProvider } from './types.js';

/*
 * The demo travel-status provider (docs/trips.md#demo-provider).
 *
 * There is no real flight, train or bus status source configured. This
 * adapter SIMULATES one so the timeline, status, disruption and notification
 * paths can be developed and tested end to end. Everything it produces is
 * stored with source DEMO_PROVIDER and shown as "simulated"; it is never
 * presented as verified travel information.
 *
 * It is deterministic: the scenario follows from the booking reference
 * (so the same booking always tells the same story), and leg states follow
 * from the booked times and the clock:
 *
 *   hash(reference) % 10   0–5 on time · 6–7 delayed 45 min ·
 *                          8 schedule change (+2 h) · 9 cancelled by the operator
 */

export type DemoScenario = 'on_time' | 'delayed' | 'schedule_change' | 'cancelled';

export const DEMO_STATUS_PROVIDER_ID = 'demo-status';
const DELAY_MINUTES = 45;
const SCHEDULE_SHIFT_MINUTES = 120;

export function demoScenarioFor(reference: string): DemoScenario {
  const n = createHash('sha256').update(reference).digest()[0]! % 10;
  if (n <= 5) return 'on_time';
  if (n <= 7) return 'delayed';
  return n === 8 ? 'schedule_change' : 'cancelled';
}

const addMinutes = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export class DemoTravelStatusProvider implements TravelStatusProvider {
  readonly id = DEMO_STATUS_PROVIDER_ID;
  readonly name = 'Wayora demo status (simulated)';
  readonly kind = 'demo' as const;

  constructor(
    private readonly options: {
      now?: () => Date;
      /** Overrides the reference-based choice (tests). */
      scenarioFor?: (reference: string) => DemoScenario;
    } = {},
  ) {}

  supports(serviceType: SearchServiceType): boolean {
    return serviceType === 'flights' || serviceType === 'trains' || serviceType === 'buses';
  }

  async fetchStatus(query: StatusQuery, signal: AbortSignal): Promise<ProviderReport> {
    signal.throwIfAborted();
    const now = (this.options.now ?? (() => new Date()))();
    const scenario = (this.options.scenarioFor ?? demoScenarioFor)(query.reference);
    const report: ProviderReport = { observedAt: now.toISOString(), legs: [], disruptions: [] };

    for (const leg of query.legs) {
      // Only the first leg is disrupted; later legs run as booked.
      const affected = leg.index === 0 ? scenario : 'on_time';
      if (affected === 'cancelled') {
        report.legs.push({ index: leg.index, state: 'cancelled' });
        report.disruptions.push({
          key: `${query.reference}:${leg.index}:cancelled`,
          type: 'cancellation',
          severity: 'severe',
          state: 'active',
          legIndex: leg.index,
        });
        continue;
      }
      const shift =
        affected === 'delayed'
          ? DELAY_MINUTES
          : affected === 'schedule_change'
            ? SCHEDULE_SHIFT_MINUTES
            : 0;
      const departure = addMinutes(leg.departAt, shift);
      const arrival = addMinutes(leg.arriveAt, shift);
      const t = now.getTime();
      const state =
        t >= Date.parse(arrival)
          ? 'arrived'
          : t >= Date.parse(departure)
            ? 'departed'
            : affected === 'delayed'
              ? 'delayed'
              : 'scheduled';
      report.legs.push({
        index: leg.index,
        state,
        estimatedDeparture: departure,
        estimatedArrival: arrival,
        delayMinutes: shift,
      });
      if (affected === 'delayed' || affected === 'schedule_change') {
        report.disruptions.push({
          key: `${query.reference}:${leg.index}:${affected}`,
          type: affected === 'delayed' ? 'departure_delay' : 'schedule_change',
          severity: affected === 'delayed' ? 'minor' : 'major',
          // Over once the journey is done.
          state: state === 'arrived' ? 'resolved' : 'active',
          legIndex: leg.index,
          newDeparture: departure,
          newArrival: arrival,
          delayMinutes: shift,
        });
      }
    }
    return report;
  }
}
