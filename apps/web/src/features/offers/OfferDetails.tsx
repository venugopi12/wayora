import type {
  BusResult,
  CabResult,
  FlightResult,
  HolidayResult,
  HotelResult,
  MetroResult,
  SearchResult,
  TrainResult,
} from '@wayora/contracts';
import { formatDuration } from '@wayora/ui';
import { BUS_TYPE_LABELS } from '../search/cards/BusResultCard';
import { cabinLabel, carrierNames } from '../search/cards/FlightResultCard';
import { AMENITY_LABELS, propertyTypeLabel } from '../search/cards/HotelResultCard';
import { interestLabel } from '../search/cards/HolidayResultCard';
import { LineSequence, changesLabel } from '../search/cards/MetroResultCard';
import { localDate, localTime } from '../search/cards/shared';
import { formatDay } from '../search/summary';
import { DetailList, DetailSection } from './DetailList';

/*
 * Category-specific offer details. Only fields present in the normalized
 * result are shown; anything a traveller would expect but the source didn't
 * supply (baggage, cancellation policy, seat availability…) is listed as
 * "Not provided in this offer", never filled in.
 */

/** "Tue, 10 Nov, 09:10" in the place's local time. */
const when = (dateTime: string) => `${formatDay(localDate(dateTime))}, ${localTime(dateTime)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

function FlightDetails({ result }: { result: FlightResult }) {
  return (
    <>
      {result.itineraries.map((itinerary) => (
        <DetailSection
          key={itinerary.direction}
          title={`${itinerary.direction === 'return' ? 'Return' : 'Outbound'}: ${formatDay(localDate(itinerary.departAt))}`}
        >
          <p className="text-body-sm text-ink-secondary">
            {formatDuration(itinerary.durationMinutes)} in total ·{' '}
            {itinerary.stops === 0 ? 'nonstop' : plural(itinerary.stops, 'stop')}
          </p>
          <ol className="flex flex-col gap-4">
            {itinerary.segments.map((segment, i) => {
              const previous = itinerary.segments[i - 1];
              return (
                <li
                  key={`${segment.flightNumber}-${segment.departAt}`}
                  className="flex flex-col gap-3"
                >
                  {previous ? (
                    <p className="rounded-md bg-sunken px-3 py-2 text-body-sm text-ink-secondary">
                      Change planes in {segment.origin.cityName} ({segment.origin.code}):{' '}
                      {formatDuration(minutesBetween(previous.arriveAt, segment.departAt))}{' '}
                      connection
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-1">
                    <p className="text-label text-ink">
                      {segment.carrier.name} {segment.flightNumber}
                    </p>
                    <DetailList
                      rows={[
                        {
                          label: 'Departs',
                          value: `${when(segment.departAt)} · ${segment.origin.name} (${segment.origin.code})`,
                        },
                        {
                          label: 'Arrives',
                          value: `${when(segment.arriveAt)} · ${segment.destination.name} (${segment.destination.code})`,
                        },
                        { label: 'Flight time', value: formatDuration(segment.durationMinutes) },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        </DetailSection>
      ))}
      <DetailSection title="Fare">
        <DetailList
          rows={[
            { label: 'Cabin', value: cabinLabel(result.cabinClass) },
            { label: 'Airlines', value: carrierNames(result).join(', ') },
            { label: 'Baggage allowance', value: null },
            { label: 'Change and refund rules', value: null },
          ]}
        />
      </DetailSection>
    </>
  );
}

function HotelDetails({ result }: { result: HotelResult }) {
  const { property } = result;
  return (
    <>
      <DetailSection title="Property">
        <DetailList
          rows={[
            { label: 'Name', value: property.name },
            { label: 'Type', value: propertyTypeLabel(property.propertyType) },
            {
              label: 'Location',
              value: [property.area, property.cityName].filter(Boolean).join(', '),
            },
            {
              label: 'Amenities',
              value: result.amenities.length
                ? result.amenities.map((a) => AMENITY_LABELS[a]).join(', ')
                : null,
            },
          ]}
        />
      </DetailSection>
      <DetailSection title="Your stay">
        <DetailList
          rows={[
            { label: 'Check-in', value: formatDay(result.checkIn) },
            { label: 'Check-out', value: formatDay(result.checkOut) },
            { label: 'Length', value: plural(result.nights, 'night') },
            { label: 'Room', value: `${result.roomType} × ${result.rooms}` },
            { label: 'Guests', value: String(result.guests) },
            { label: 'Breakfast', value: result.breakfastIncluded ? 'Included' : 'Not included' },
            { label: 'Cancellation policy', value: null },
            { label: 'Room availability', value: null },
          ]}
        />
      </DetailSection>
    </>
  );
}

function TrainDetails({ result }: { result: TrainResult }) {
  return (
    <DetailSection title="Journey">
      <DetailList
        rows={[
          { label: 'Train', value: `${result.trainName} (${result.trainNumber})` },
          { label: 'From', value: `${result.origin.name} (${result.origin.code})` },
          { label: 'To', value: `${result.destination.name} (${result.destination.code})` },
          { label: 'Departs', value: when(result.departAt) },
          { label: 'Arrives', value: when(result.arriveAt) },
          { label: 'Journey time', value: formatDuration(result.durationMinutes) },
          { label: 'Class', value: `${result.travelClass.name} (${result.travelClass.code})` },
          { label: 'Passengers', value: String(result.passengers) },
          { label: 'Intermediate stops', value: null },
          { label: 'Seat availability', value: null },
        ]}
      />
    </DetailSection>
  );
}

function BusDetails({ result }: { result: BusResult }) {
  return (
    <DetailSection title="Journey">
      <DetailList
        rows={[
          { label: 'Operator', value: result.operatorName },
          { label: 'Bus type', value: BUS_TYPE_LABELS[result.busType] },
          { label: 'Boarding point', value: `${result.origin.name}, ${result.origin.cityName}` },
          {
            label: 'Drop-off point',
            value: `${result.destination.name}, ${result.destination.cityName}`,
          },
          { label: 'Departs', value: when(result.departAt) },
          { label: 'Arrives', value: when(result.arriveAt) },
          { label: 'Journey time', value: formatDuration(result.durationMinutes) },
          {
            label: 'On board',
            value: result.amenities.length ? result.amenities.join(', ') : null,
          },
          { label: 'Passengers', value: String(result.passengers) },
          { label: 'Seat availability', value: null },
        ]}
      />
    </DetailSection>
  );
}

function MetroDetails({ result }: { result: MetroResult }) {
  return (
    <>
      <DetailSection title="Route">
        <LineSequence legs={result.legs} />
        <ol className="flex flex-col gap-3">
          {result.legs.map((leg, i) => (
            <li key={`${leg.line.id}-${i}`} className="flex items-start gap-3 text-body-sm">
              <span
                aria-hidden="true"
                className="mt-1 size-3 shrink-0 rounded-full"
                style={{ backgroundColor: leg.line.colour }}
              />
              <span>
                <span className="text-label text-ink">
                  {i + 1}. {leg.line.name}
                </span>
                <span className="block text-ink-secondary">
                  {leg.from.name} to {leg.to.name} · {plural(leg.stops, 'stop')} · about{' '}
                  {formatDuration(leg.durationMinutes)}
                </span>
                {i < result.legs.length - 1 ? (
                  <span className="block text-ink-secondary">Change at {leg.to.name}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </DetailSection>
      <DetailSection title="Journey">
        <DetailList
          rows={[
            { label: 'City', value: result.cityName },
            { label: 'Changes', value: changesLabel(result.transfers) },
            {
              label: 'Journey time',
              value: `About ${formatDuration(result.durationMinutes)} (estimate, including changes)`,
            },
            { label: 'Passengers', value: String(result.passengers) },
            { label: 'Timetable', value: null },
            { label: 'Step-free access', value: null },
          ]}
        />
      </DetailSection>
    </>
  );
}

function CabDetails({ result }: { result: CabResult }) {
  return (
    <DetailSection title="Trip">
      <DetailList
        rows={[
          { label: 'Pick-up', value: `${result.pickup.name}, ${result.pickup.cityName}` },
          { label: 'Drop-off', value: `${result.dropoff.name}, ${result.dropoff.cityName}` },
          { label: 'Pick-up time', value: when(result.pickupAt) },
          { label: 'Vehicle', value: result.vehicleLabel },
          { label: 'Seats', value: `Up to ${result.capacity} passengers` },
          { label: 'Distance', value: `About ${result.distanceKm} km` },
          {
            label: 'Drive time',
            value: `About ${formatDuration(result.durationMinutes)} in normal traffic`,
          },
          { label: 'Luggage space', value: null },
          { label: 'Driver and vehicle', value: null },
        ]}
      />
      <p className="text-body-sm text-ink-secondary">
        This is an estimate, not a quote: real fares depend on traffic, demand and the operator.
      </p>
    </DetailSection>
  );
}

function HolidayDetails({ result }: { result: HolidayResult }) {
  return (
    <>
      <DetailSection title="Package">
        <DetailList
          rows={[
            { label: 'Destination', value: result.destination.name },
            {
              label: 'Dates',
              value: `${formatDay(result.startDate)} – ${formatDay(result.endDate)}`,
            },
            { label: 'Length', value: plural(result.nights, 'night') },
            { label: 'Travellers', value: String(result.travellers) },
            { label: 'Themes', value: result.interests.map(interestLabel).join(', ') || null },
            { label: 'Highlights', value: result.highlights.join(', ') || null },
          ]}
        />
      </DetailSection>
      <DetailSection title="What's included">
        {result.inclusions.length ? (
          <ul className="list-disc pl-5 text-body-sm text-ink">
            {result.inclusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-ink-secondary italic">Not provided in this offer</p>
        )}
        <DetailList
          rows={[
            { label: 'Not included', value: null },
            { label: 'Day-by-day itinerary', value: null },
          ]}
        />
      </DetailSection>
    </>
  );
}

export function OfferDetails({ result }: { result: SearchResult }) {
  switch (result.serviceType) {
    case 'flights':
      return <FlightDetails result={result} />;
    case 'hotels':
      return <HotelDetails result={result} />;
    case 'trains':
      return <TrainDetails result={result} />;
    case 'buses':
      return <BusDetails result={result} />;
    case 'metro':
      return <MetroDetails result={result} />;
    case 'cabs':
      return <CabDetails result={result} />;
    case 'holidays':
      return <HolidayDetails result={result} />;
  }
}

/** Heading and one-line description of an offer, for the page header and title. */
export function offerHeading(result: SearchResult): { title: string; subtitle: string } {
  switch (result.serviceType) {
    case 'flights': {
      const out = result.itineraries[0]!;
      const first = out.segments[0]!;
      const last = out.segments.at(-1)!;
      return {
        title: `${first.origin.cityName} to ${last.destination.cityName}`,
        subtitle: `${carrierNames(result).join(' + ')} · ${result.itineraries.length > 1 ? 'Return' : 'One way'} · ${cabinLabel(result.cabinClass)}`,
      };
    }
    case 'hotels':
      return {
        title: result.property.name,
        subtitle: [result.property.area, result.property.cityName].filter(Boolean).join(', '),
      };
    case 'trains':
      return {
        title: `${result.trainName} (${result.trainNumber})`,
        subtitle: `${result.origin.name} to ${result.destination.name} · ${result.travelClass.name}`,
      };
    case 'buses':
      return {
        title: result.operatorName,
        subtitle: `${result.origin.cityName} to ${result.destination.cityName} · ${BUS_TYPE_LABELS[result.busType]}`,
      };
    case 'metro':
      return {
        title: `${result.origin.name} to ${result.destination.name}`,
        subtitle: `${result.cityName} metro · ${changesLabel(result.transfers)}`,
      };
    case 'cabs':
      return {
        title: result.vehicleLabel,
        subtitle: `${result.pickup.name} to ${result.dropoff.name}`,
      };
    case 'holidays':
      return {
        title: result.packageName,
        subtitle: `${result.destination.name} · ${plural(result.nights, 'night')}`,
      };
  }
}
