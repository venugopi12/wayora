import type { FlightResult } from '@wayora/contracts';
import { Badge, JourneySummary } from '@wayora/ui';
import { formatDay } from '../summary';
import { ResultCardShell, dayOffset, localDate, localTime } from './shared';

export const cabinLabel = (cabin: FlightResult['cabinClass']) => {
  const text = cabin.replace('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Carriers (by name) across all segments, in order of appearance. */
export const carrierNames = (result: FlightResult) => [
  ...new Set(result.itineraries.flatMap((i) => i.segments.map((s) => s.carrier.name))),
];

export function FlightResultCard({ result, href }: { result: FlightResult; href: string }) {
  const roundTrip = result.itineraries.length > 1;
  return (
    <ResultCardShell
      result={result}
      href={href}
      heading={carrierNames(result).join(' + ')}
      subheading={result.itineraries
        .map((i) => i.segments.map((s) => s.flightNumber).join(', '))
        .join(' · return ')}
      meta={
        <Badge size="sm" tone="neutral">
          {cabinLabel(result.cabinClass)}
        </Badge>
      }
      body={
        <div className="flex flex-col gap-4">
          {result.itineraries.map((itinerary) => {
            const first = itinerary.segments[0]!;
            const last = itinerary.segments.at(-1)!;
            return (
              <div key={itinerary.direction} className="flex flex-col gap-1.5">
                <p className="text-caption text-ink-secondary">
                  {roundTrip
                    ? `${itinerary.direction === 'return' ? 'Return' : 'Outbound'} · `
                    : ''}
                  {formatDay(localDate(itinerary.departAt))}
                </p>
                <JourneySummary
                  mode="flight"
                  origin={{
                    name: first.origin.cityName,
                    code: first.origin.code ?? undefined,
                    time: localTime(itinerary.departAt),
                    dateTime: itinerary.departAt,
                  }}
                  destination={{
                    name: last.destination.cityName,
                    code: last.destination.code ?? undefined,
                    time: localTime(itinerary.arriveAt),
                    dateTime: itinerary.arriveAt,
                  }}
                  durationMinutes={itinerary.durationMinutes}
                  stops={itinerary.stops}
                  dayOffset={dayOffset(itinerary.departAt, itinerary.arriveAt) || undefined}
                />
              </div>
            );
          })}
        </div>
      }
    />
  );
}
