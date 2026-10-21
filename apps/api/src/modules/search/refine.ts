import {
  DEPARTURE_WINDOW_HOURS,
  type DepartureWindow,
  type SearchPrice,
  type SearchRequest,
  type SearchResult,
  type SearchResultFor,
  type SearchServiceType,
} from '@wayora/contracts';

/*
 * Filters and sorting, applied by the search service to every provider's
 * normalized results, so they behave the same whichever supplier answered.
 * One table per category; no per-category orchestration. Every rule reads
 * only fields that the result contract guarantees (docs/search.md#filters).
 */

export interface ComparablePrice {
  amount: bigint;
  currency: string;
}

/** The comparable amount of a price: the total, or the low end of a range. */
export function priceAmount(price: SearchPrice | null): ComparablePrice | null {
  if (!price) return null;
  const money = price.kind === 'total' ? price.total : price.min;
  return { amount: BigInt(money.amountMinor), currency: money.currency };
}

/** The high end of a range price (cab estimates); the total otherwise. */
function priceHigh(price: SearchPrice | null): ComparablePrice | null {
  if (!price) return null;
  const money = price.kind === 'total' ? price.total : price.max;
  return { amount: BigInt(money.amountMinor), currency: money.currency };
}

/** Per-night price of a hotel result (its `perUnit` night figure), if it has one. */
export function nightlyPrice(result: SearchResultFor<'hotels'>): ComparablePrice | null {
  const { price } = result;
  if (price?.kind !== 'total' || price.perUnit?.unit !== 'night') return null;
  return {
    amount: BigInt(price.perUnit.amount.amountMinor),
    currency: price.perUnit.amount.currency,
  };
}

/** Local hour of an offset date-time such as `2026-11-12T06:15:00+05:30`. */
function localHour(dateTime: string): number {
  return Number(dateTime.slice(11, 13));
}

function inWindows(dateTime: string, windows: readonly DepartureWindow[] | undefined): boolean {
  if (!windows || windows.length === 0) return true;
  const hour = localHour(dateTime);
  return windows.some((w) => {
    const [start, end] = DEPARTURE_WINDOW_HOURS[w];
    return hour >= start && hour < end;
  });
}

const anyOf = <T>(selected: readonly T[] | undefined, value: T) =>
  !selected?.length || selected.includes(value);
const allOf = <T>(required: readonly T[] | undefined, present: readonly T[]) =>
  (required ?? []).every((r) => present.includes(r));
const atMost = (limit: number | undefined, value: number) => limit === undefined || value <= limit;

/** Stops of a flight result: the most stops of any direction. */
export const flightStops = (r: SearchResultFor<'flights'>) =>
  Math.max(...r.itineraries.map((i) => i.stops));
/** Longest direction of a flight, in minutes. */
export const flightDuration = (r: SearchResultFor<'flights'>) =>
  Math.max(...r.itineraries.map((i) => i.durationMinutes));
/** Carrier codes appearing in any segment. */
export const flightCarriers = (r: SearchResultFor<'flights'>) => [
  ...new Set(r.itineraries.flatMap((i) => i.segments.map((s) => s.carrier.code))),
];

type Predicate<S extends SearchServiceType> = (result: SearchResultFor<S>) => boolean;

/** Category filters other than price (price needs currency handling, below). */
function categoryPredicate(request: SearchRequest): (result: SearchResult) => boolean {
  const keep =
    <S extends SearchServiceType>(type: S, predicate: Predicate<S>) =>
    (result: SearchResult) =>
      result.serviceType === type && predicate(result as SearchResultFor<S>);

  switch (request.serviceType) {
    case 'flights': {
      const f = request.filters;
      return keep('flights', (r) => {
        const out = r.itineraries[0]!;
        return (
          atMost(f.maxStops, flightStops(r)) &&
          inWindows(out.departAt, f.departureWindows) &&
          inWindows(out.arriveAt, f.arrivalWindows) &&
          (!f.carriers?.length || flightCarriers(r).some((c) => f.carriers!.includes(c))) &&
          atMost(f.maxDurationMinutes, flightDuration(r))
        );
      });
    }
    case 'hotels': {
      const f = request.filters;
      return keep(
        'hotels',
        (r) =>
          anyOf(f.propertyTypes, r.property.propertyType) &&
          allOf(f.amenities, r.amenities) &&
          (!f.areas?.length || (r.property.area !== null && f.areas.includes(r.property.area))) &&
          (f.breakfastIncluded !== true || r.breakfastIncluded),
      );
    }
    case 'trains': {
      const f = request.filters;
      return keep(
        'trains',
        (r) =>
          anyOf(f.classes, r.travelClass.code) &&
          anyOf(f.trains, r.trainNumber) &&
          inWindows(r.departAt, f.departureWindows) &&
          inWindows(r.arriveAt, f.arrivalWindows) &&
          atMost(f.maxDurationMinutes, r.durationMinutes),
      );
    }
    case 'buses': {
      const f = request.filters;
      return keep(
        'buses',
        (r) =>
          anyOf(f.busTypes, r.busType) &&
          anyOf(f.operators, r.operatorName) &&
          allOf(f.amenities, r.amenities) &&
          inWindows(r.departAt, f.departureWindows) &&
          inWindows(r.arriveAt, f.arrivalWindows) &&
          atMost(f.maxDurationMinutes, r.durationMinutes),
      );
    }
    case 'metro': {
      const f = request.filters;
      return keep(
        'metro',
        (r) =>
          atMost(f.maxTransfers, r.transfers) &&
          (!f.lines?.length || r.legs.some((l) => f.lines!.includes(l.line.id))) &&
          atMost(f.maxDurationMinutes, r.durationMinutes),
      );
    }
    case 'cabs': {
      const f = request.filters;
      return keep(
        'cabs',
        (r) =>
          anyOf(f.vehicleTypes, r.vehicleType) &&
          (f.minCapacity === undefined || r.capacity >= f.minCapacity),
      );
    }
    case 'holidays': {
      const f = request.filters;
      return keep(
        'holidays',
        (r) =>
          (f.minNights === undefined || r.nights >= f.minNights) &&
          atMost(f.maxNights, r.nights) &&
          (!f.interests?.length || f.interests.some((i) => r.interests.includes(i))),
      );
    }
  }
}

interface PriceLimits {
  min: bigint | undefined;
  max: bigint | undefined;
  /** The figures of a result the limits apply to (equal unless it is a range). */
  read: (result: SearchResult) => { low: ComparablePrice | null; high: ComparablePrice | null };
}

const big = (v: string | undefined) => (v === undefined ? undefined : BigInt(v));

function priceLimits(request: SearchRequest): PriceLimits | null {
  switch (request.serviceType) {
    case 'hotels': {
      const { minNightlyPriceMinor: min, maxNightlyPriceMinor: max } = request.filters;
      if (min === undefined && max === undefined) return null;
      return {
        min: big(min),
        max: big(max),
        read: (r) => {
          const night = r.serviceType === 'hotels' ? nightlyPrice(r) : null;
          return { low: night, high: night };
        },
      };
    }
    case 'flights':
    case 'buses':
    case 'cabs':
    case 'holidays': {
      const { minPriceMinor: min, maxPriceMinor: max } = request.filters;
      if (min === undefined && max === undefined) return null;
      return {
        min: big(min),
        max: big(max),
        read: (r) => ({ low: priceAmount(r.price), high: priceHigh(r.price) }),
      };
    }
    default:
      return null;
  }
}

export interface FilterOutcome {
  results: SearchResult[];
  /** Results dropped by a price limit only because they are priced in another currency. */
  hiddenForCurrency: number;
}

/**
 * Applies the request's filters. Price limits are in the request currency;
 * results priced in another currency can't be compared without conversion,
 * so they are left out and counted (never silently converted). A result
 * with no price never matches a price limit. Range prices (cab estimates)
 * match when the range overlaps the limits.
 */
export function applyFilters(
  request: SearchRequest,
  results: readonly SearchResult[],
): FilterOutcome {
  const matches = categoryPredicate(request);
  const limits = priceLimits(request);
  let hiddenForCurrency = 0;
  const kept = results.filter((result) => {
    if (!matches(result)) return false;
    if (!limits) return true;
    const { low, high } = limits.read(result);
    if (!low || !high) return false;
    if (low.currency !== request.currency) {
      hiddenForCurrency += 1;
      return false;
    }
    return (
      (limits.max === undefined || low.amount <= limits.max) &&
      (limits.min === undefined || high.amount >= limits.min)
    );
  });
  return { results: kept, hiddenForCurrency };
}

// ─── Sorting ──────────────────────────────────────────────────────────────

type Compare = (a: SearchResult, b: SearchResult) => number;

const compareBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Price order within the request currency. Results without a price, or
 * priced in another currency (not comparable), always go after comparable
 * ones, in both directions; they are never treated as zero.
 */
function byPrice(request: SearchRequest, direction: 1 | -1): Compare {
  return (a, b) => {
    const pa = priceAmount(a.price);
    const pb = priceAmount(b.price);
    const rank = (p: ComparablePrice | null) => (!p ? 2 : p.currency === request.currency ? 0 : 1);
    const ra = rank(pa);
    const rb = rank(pb);
    if (ra !== rb) return ra - rb;
    if (!pa || !pb) return 0;
    if (pa.currency !== pb.currency) return pa.currency.localeCompare(pb.currency);
    return direction * compareBig(pa.amount, pb.amount);
  };
}

/** Departure instant, or null where the category has none. */
function departure(result: SearchResult): number | null {
  switch (result.serviceType) {
    case 'flights':
      return Date.parse(result.itineraries[0]!.departAt);
    case 'trains':
    case 'buses':
      return Date.parse(result.departAt);
    case 'cabs':
      return Date.parse(result.pickupAt);
    default:
      return null;
  }
}

/** Journey length: minutes for transport, nights for stays and packages. */
function duration(result: SearchResult): number {
  switch (result.serviceType) {
    case 'flights':
      return flightDuration(result);
    case 'trains':
    case 'buses':
    case 'metro':
    case 'cabs':
      return result.durationMinutes;
    case 'hotels':
    case 'holidays':
      return result.nights;
  }
}

/** Numeric order; missing values (null) go last in either direction. */
const byNumber =
  (read: (r: SearchResult) => number | null, direction: 1 | -1 = 1): Compare =>
  (a, b) => {
    const x = read(a);
    const y = read(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return direction * (x - y);
  };

const stops = (r: SearchResult) => (r.serviceType === 'flights' ? flightStops(r) : null);
const transfers = (r: SearchResult) => (r.serviceType === 'metro' ? r.transfers : null);
const capacity = (r: SearchResult) => (r.serviceType === 'cabs' ? r.capacity : null);

const chain =
  (...comparators: Compare[]): Compare =>
  (a, b) => {
    for (const compare of comparators) {
      const order = compare(a, b);
      if (order !== 0) return order;
    }
    return 0;
  };

const byId: Compare = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Sorts by the request's `sortBy` (DEFAULT_SORT when the client sent none).
 * Every order ends with the same tie-breaks: lowest price, earliest
 * departure, shortest journey, then result id, so equal results always come
 * back in the same order (docs/search.md#sorting).
 */
export function applySort(
  request: SearchRequest,
  results: readonly SearchResult[],
): SearchResult[] {
  const ties = chain(byPrice(request, 1), byNumber(departure), byNumber(duration), byId);
  let primary: Compare;
  switch (request.sortBy) {
    case 'recommended':
      // Flights: fewest stops, then price, then journey time.
      primary = chain(byNumber(stops), byPrice(request, 1), byNumber(duration));
      break;
    case 'price-asc':
      primary = byPrice(request, 1);
      break;
    case 'price-desc':
      primary = byPrice(request, -1);
      break;
    case 'duration-asc':
      primary = byNumber(duration);
      break;
    case 'duration-desc':
      primary = byNumber(duration, -1);
      break;
    case 'departure-asc':
      primary = byNumber(departure);
      break;
    case 'transfers-asc':
      primary = chain(byNumber(transfers), byNumber(duration));
      break;
    case 'capacity-desc':
      primary = byNumber(capacity, -1);
      break;
  }
  return [...results].sort(chain(primary, ties));
}
