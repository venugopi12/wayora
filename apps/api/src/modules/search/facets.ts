import {
  TRAIN_CLASS_NAMES,
  fromMinorUnits,
  type FacetKey,
  type FacetOption,
  type SearchFacets,
  type SearchRequest,
  type SearchResult,
  type SearchResultFor,
} from '@wayora/contracts';
import {
  flightCarriers,
  flightDuration,
  flightStops,
  hasCheckedBaggage,
  hasFreeCancellation,
  nightlyPrice,
  priceAmount,
  type ComparablePrice,
} from './refine.js';

/*
 * Facets: the filter choices and ranges present in a search's results
 * (docs/search.md#facets). Built from the whole provider round, before
 * filters, so a UI only offers filters that match something real and the
 * choices stay put while filters are applied.
 */

/** Counts values in order of first appearance, then sorts by `order`. */
class Tally {
  private readonly entries = new Map<string, { label: string; count: number }>();

  add(value: string, label: string = value): void {
    const entry = this.entries.get(value);
    if (entry) entry.count += 1;
    else this.entries.set(value, { label, count: 1 });
  }

  options(order: 'label' | 'value-number' = 'label'): FacetOption[] {
    const list = [...this.entries].map(([value, { label, count }]) => ({ value, label, count }));
    return order === 'value-number'
      ? list.sort((a, b) => Number(a.value) - Number(b.value))
      : list.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  }
}

const BUS_TYPE_LABELS: Record<SearchResultFor<'buses'>['busType'], string> = {
  'ac-sleeper': 'AC sleeper',
  'ac-seater': 'AC seater',
  'non-ac-sleeper': 'Non-AC sleeper',
  'non-ac-seater': 'Non-AC seater',
};

const titleCase = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).replace(/-/g, ' ');

function rangeOf(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function priceRange(
  prices: readonly (ComparablePrice | null)[],
  currency: string,
  basis: 'total' | 'night',
): SearchFacets['price'] {
  const amounts = prices.filter((p): p is ComparablePrice => !!p && p.currency === currency);
  if (amounts.length === 0) return null;
  let min = amounts[0]!.amount;
  let max = min;
  for (const { amount } of amounts) {
    if (amount < min) min = amount;
    if (amount > max) max = amount;
  }
  return { min: fromMinorUnits(min, currency), max: fromMinorUnits(max, currency), basis };
}

type Options = Partial<Record<FacetKey, FacetOption[]>>;

/** Drops empty option lists so the response only names facets that exist. */
function compact(options: Options): Options {
  return Object.fromEntries(Object.entries(options).filter(([, list]) => list && list.length > 0));
}

const of = <S extends SearchResult['serviceType']>(results: readonly SearchResult[], type: S) =>
  results.filter((r): r is SearchResultFor<S> => r.serviceType === type);

export function computeFacets(
  request: SearchRequest,
  results: readonly SearchResult[],
): SearchFacets {
  const prices = results.map((r) => priceAmount(r.price));
  const currency = request.currency;

  switch (request.serviceType) {
    case 'flights': {
      const flights = of(results, 'flights');
      const stops = new Tally();
      const carriers = new Tally();
      const baggage = new Tally();
      for (const r of flights) {
        if (hasCheckedBaggage(r)) baggage.add('included', 'Checked bag included');
        const n = flightStops(r);
        stops.add(String(n), n === 0 ? 'Nonstop' : `${n} stop${n === 1 ? '' : 's'}`);
        const names = new Map(
          r.itineraries.flatMap((i) => i.segments.map((s) => [s.carrier.code, s.carrier.name])),
        );
        for (const code of flightCarriers(r)) carriers.add(code, names.get(code) ?? code);
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: rangeOf(flights.map(flightDuration)),
        options: compact({
          stops: stops.options('value-number'),
          carriers: carriers.options(),
          checkedBaggage: baggage.options(),
        }),
      };
    }
    case 'hotels': {
      const hotels = of(results, 'hotels');
      const types = new Tally();
      const amenities = new Tally();
      const areas = new Tally();
      const cancellation = new Tally();
      for (const r of hotels) {
        if (hasFreeCancellation(r)) cancellation.add('free-cancellation', 'Free cancellation');
        types.add(r.property.propertyType, titleCase(r.property.propertyType));
        for (const a of r.amenities) amenities.add(a, a === 'wifi' ? 'Wi-Fi' : titleCase(a));
        if (r.property.area) areas.add(r.property.area);
      }
      return {
        price: priceRange(hotels.map(nightlyPrice), currency, 'night'),
        durationMinutes: null,
        options: compact({
          propertyTypes: types.options(),
          amenities: amenities.options(),
          areas: areas.options(),
          cancellation: cancellation.options(),
        }),
      };
    }
    case 'trains': {
      const trains = of(results, 'trains');
      const classes = new Tally();
      const numbers = new Tally();
      for (const r of trains) {
        classes.add(
          r.travelClass.code,
          `${TRAIN_CLASS_NAMES[r.travelClass.code]} (${r.travelClass.code})`,
        );
        numbers.add(r.trainNumber, `${r.trainName} (${r.trainNumber})`);
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: rangeOf(trains.map((r) => r.durationMinutes)),
        options: compact({ classes: classes.options(), trains: numbers.options() }),
      };
    }
    case 'buses': {
      const buses = of(results, 'buses');
      const operators = new Tally();
      const types = new Tally();
      const amenities = new Tally();
      for (const r of buses) {
        operators.add(r.operatorName);
        types.add(r.busType, BUS_TYPE_LABELS[r.busType]);
        for (const a of r.amenities) amenities.add(a);
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: rangeOf(buses.map((r) => r.durationMinutes)),
        options: compact({
          operators: operators.options(),
          busTypes: types.options(),
          busAmenities: amenities.options(),
        }),
      };
    }
    case 'metro': {
      const journeys = of(results, 'metro');
      const lines = new Tally();
      const transfers = new Tally();
      for (const r of journeys) {
        transfers.add(
          String(r.transfers),
          r.transfers === 0 ? 'No changes' : `${r.transfers} change${r.transfers === 1 ? '' : 's'}`,
        );
        for (const id of new Set(r.legs.map((l) => l.line.id))) {
          lines.add(id, r.legs.find((l) => l.line.id === id)!.line.name);
        }
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: rangeOf(journeys.map((r) => r.durationMinutes)),
        options: compact({
          lines: lines.options(),
          transfers: transfers.options('value-number'),
        }),
      };
    }
    case 'cabs': {
      const cabs = of(results, 'cabs');
      const vehicles = new Tally();
      const capacities = new Tally();
      for (const r of cabs) {
        vehicles.add(r.vehicleType, titleCase(r.vehicleType).replace('Suv', 'SUV'));
        capacities.add(String(r.capacity), `${r.capacity}+ seats`);
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: rangeOf(cabs.map((r) => r.durationMinutes)),
        options: compact({
          vehicleTypes: vehicles.options(),
          capacities: capacities.options('value-number'),
        }),
      };
    }
    case 'holidays': {
      const packages = of(results, 'holidays');
      const interests = new Tally();
      const nights = new Tally();
      for (const r of packages) {
        for (const i of r.interests) interests.add(i, titleCase(i));
        nights.add(String(r.nights), `${r.nights} nights`);
      }
      return {
        price: priceRange(prices, currency, 'total'),
        durationMinutes: null,
        options: compact({
          interests: interests.options(),
          nights: nights.options('value-number'),
        }),
      };
    }
  }
}
