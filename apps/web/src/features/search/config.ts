import {
  DEFAULT_SORT,
  placesOfKind,
  type FacetKey,
  type PlaceKind,
  type SearchServiceType,
} from '@wayora/contracts';

/*
 * Search configuration per category: which fields the form shows, how they
 * map to URL parameters and to the shared request contract, and which
 * filters and sort orders apply. The form, URL codec, filter panel and chips
 * read this table; categories differ only in configuration, their summary
 * and their result card.
 */

export type FieldConfig =
  | {
      kind: 'place';
      param: string;
      requestKey: string;
      label: string;
      placeKinds: PlaceKind[];
      required: true;
    }
  | {
      kind: 'date';
      param: string;
      requestKey: string;
      label: string;
      required: boolean;
      hint?: string;
    }
  /** Local date and time; converted to an offset date-time in the time zone of `zoneFrom`'s place. */
  | {
      kind: 'datetime';
      param: string;
      requestKey: string;
      label: string;
      zoneFrom: string;
      required: true;
    }
  | {
      kind: 'count';
      param: string;
      requestKey: string;
      label: string;
      min: number;
      max: number;
      defaultValue: number;
      hint?: string;
    }
  | {
      kind: 'select';
      param: string;
      requestKey: string;
      label: string;
      options: readonly Option[];
      defaultValue: string;
    };

export interface Option {
  value: string;
  label: string;
}

/**
 * Filters (docs/search.md#filters). Options come from the response's facets
 * (only values present in the results) unless a fixed list is given (time
 * windows). URL values are compact: lists are comma-separated, prices are
 * whole currency units (sent to the API as minor units), durations minutes.
 */
export type FilterConfig =
  /** Any of several values. */
  | {
      kind: 'options';
      param: string;
      requestKey: string;
      label: string;
      facet?: FacetKey;
      options?: readonly Option[];
      /** "All of" instead of "any of" (amenities). */
      matchAll?: boolean;
    }
  /** "At most N" over a facet of small integers (stops, changes). */
  | {
      kind: 'at-most';
      param: string;
      requestKey: string;
      label: string;
      facet: FacetKey;
      describe: (n: number) => string;
    }
  /** "At least N" over a facet of small integers (seats). */
  | {
      kind: 'at-least';
      param: string;
      requestKey: string;
      label: string;
      facet: FacetKey;
      describe: (n: number) => string;
    }
  /** Price range in whole units of the search currency. */
  | {
      kind: 'price-range';
      params: readonly [string, string];
      requestKeys: readonly [string, string];
      label: string;
    }
  /** Longest acceptable journey, from the results' duration range. */
  | { kind: 'max-duration'; param: string; requestKey: string; label: string }
  /** Nights range for packages, from the `nights` facet. */
  | {
      kind: 'nights-range';
      params: readonly [string, string];
      requestKeys: readonly [string, string];
      label: string;
    }
  /** A yes/no feature (breakfast included). */
  | { kind: 'toggle'; param: string; requestKey: string; label: string };

export interface CategorySearchConfig {
  serviceType: SearchServiceType;
  /** Name of the place pair, for the swap button ("Swap from and to"). */
  swap: [string, string] | null;
  fields: readonly FieldConfig[];
  filters: readonly FilterConfig[];
  /** Sort options; the category's DEFAULT_SORT comes first. */
  sorts: readonly Option[];
  /** "Search flights" */
  submitLabel: string;
  /** Shown before the first search: what the demo covers. */
  coverage: string;
  /** Noun for one result, for counts ("3 flights"). */
  noun: [singular: string, plural: string];
}

const TIME_WINDOWS: Option[] = [
  { value: 'early-morning', label: 'Before 6 am' },
  { value: 'morning', label: '6 am – 12 pm' },
  { value: 'afternoon', label: '12 pm – 5 pm' },
  { value: 'evening', label: '5 pm – 9 pm' },
  { value: 'night', label: 'After 9 pm' },
];

const departure: FilterConfig = {
  kind: 'options',
  param: 'depart-times',
  requestKey: 'departureWindows',
  label: 'Departure time',
  options: TIME_WINDOWS,
};
const arrival: FilterConfig = {
  kind: 'options',
  param: 'arrive-times',
  requestKey: 'arrivalWindows',
  label: 'Arrival time',
  options: TIME_WINDOWS,
};
const price = (label = 'Price'): FilterConfig => ({
  kind: 'price-range',
  params: ['minPrice', 'maxPrice'],
  requestKeys: ['minPriceMinor', 'maxPriceMinor'],
  label,
});
const maxDuration = (label = 'Journey time'): FilterConfig => ({
  kind: 'max-duration',
  param: 'maxDuration',
  requestKey: 'maxDurationMinutes',
  label,
});

const place = (
  param: string,
  requestKey: string,
  label: string,
  placeKinds: PlaceKind[],
): FieldConfig => ({
  kind: 'place',
  param,
  requestKey,
  label,
  placeKinds,
  required: true,
});
const date = (
  param: string,
  requestKey: string,
  label: string,
  required = true,
  hint?: string,
): FieldConfig => ({
  kind: 'date',
  param,
  requestKey,
  label,
  required,
  ...(hint ? { hint } : {}),
});
const count = (
  param: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  hint?: string,
): FieldConfig => ({
  kind: 'count',
  param,
  requestKey: param,
  label,
  min,
  max,
  defaultValue,
  ...(hint ? { hint } : {}),
});

const SORT_LABELS: Record<string, string> = {
  recommended: 'Recommended',
  'price-asc': 'Price: low to high',
  'price-desc': 'Price: high to low',
  'duration-asc': 'Shortest first',
  'duration-desc': 'Longest first',
  'departure-asc': 'Earliest departure',
  'transfers-asc': 'Fewest changes',
  'capacity-desc': 'Most seats',
};

/** Sort options with the category default first and marked as the default. */
function sorts(type: SearchServiceType, values: readonly string[]): Option[] {
  const fallback = DEFAULT_SORT[type];
  return [fallback, ...values.filter((v) => v !== fallback)].map((value) => ({
    value,
    label: value === fallback ? `${SORT_LABELS[value]} (default)` : SORT_LABELS[value]!,
  }));
}

export const SEARCH_CONFIG: Record<SearchServiceType, CategorySearchConfig> = {
  flights: {
    serviceType: 'flights',
    swap: ['from', 'to'],
    fields: [
      place('from', 'origin', 'From', ['airport']),
      place('to', 'destination', 'To', ['airport']),
      date('depart', 'departureDate', 'Departure'),
      date('return', 'returnDate', 'Return', false, 'Optional. Leave empty for one way.'),
      count('adults', 'Adults', 1, 9, 1, '12 years and over'),
      count('children', 'Children', 0, 8, 0, '2 to 11 years'),
      count('infants', 'Infants', 0, 9, 0, 'Under 2, on a lap'),
      {
        kind: 'select',
        param: 'cabin',
        requestKey: 'cabinClass',
        label: 'Cabin',
        defaultValue: 'economy',
        options: [
          { value: 'economy', label: 'Economy' },
          { value: 'premium-economy', label: 'Premium economy' },
          { value: 'business', label: 'Business' },
          { value: 'first', label: 'First' },
        ],
      },
    ],
    filters: [
      {
        kind: 'at-most',
        param: 'stops',
        requestKey: 'maxStops',
        label: 'Stops',
        facet: 'stops',
        describe: (n) => (n === 0 ? 'Nonstop only' : `Up to ${n} stop${n === 1 ? '' : 's'}`),
      },
      price(),
      departure,
      arrival,
      {
        kind: 'options',
        param: 'airlines',
        requestKey: 'carriers',
        label: 'Airline',
        facet: 'carriers',
      },
      maxDuration('Journey time (each way)'),
    ],
    sorts: sorts('flights', [
      'recommended',
      'price-asc',
      'price-desc',
      'duration-asc',
      'departure-asc',
    ]),
    submitLabel: 'Search flights',
    coverage: 'Demo flights cover Bengaluru, Delhi, Mumbai, Hyderabad and Goa.',
    noun: ['flight option', 'flight options'],
  },
  hotels: {
    serviceType: 'hotels',
    swap: null,
    fields: [
      place('to', 'destination', 'Destination', ['city']),
      date('checkin', 'checkIn', 'Check-in'),
      date('checkout', 'checkOut', 'Check-out'),
      count('rooms', 'Rooms', 1, 8, 1),
      count('adults', 'Adults', 1, 32, 2),
      count('children', 'Children', 0, 24, 0),
    ],
    filters: [
      {
        kind: 'price-range',
        params: ['minPrice', 'maxPrice'],
        requestKeys: ['minNightlyPriceMinor', 'maxNightlyPriceMinor'],
        label: 'Price per night',
      },
      {
        kind: 'options',
        param: 'types',
        requestKey: 'propertyTypes',
        label: 'Property type',
        facet: 'propertyTypes',
      },
      { kind: 'options', param: 'areas', requestKey: 'areas', label: 'Area', facet: 'areas' },
      {
        kind: 'options',
        param: 'amenities',
        requestKey: 'amenities',
        label: 'Amenities',
        facet: 'amenities',
        matchAll: true,
      },
      {
        kind: 'toggle',
        param: 'breakfast',
        requestKey: 'breakfastIncluded',
        label: 'Breakfast included',
      },
    ],
    sorts: sorts('hotels', ['price-asc', 'price-desc']),
    submitLabel: 'Search hotels',
    coverage: 'Demo hotels cover Goa, Jaipur, Bengaluru and Kochi (Kerala).',
    noun: ['stay', 'stays'],
  },
  trains: {
    serviceType: 'trains',
    swap: ['from', 'to'],
    fields: [
      place('from', 'origin', 'From station', ['rail-station']),
      place('to', 'destination', 'To station', ['rail-station']),
      date('date', 'departureDate', 'Travel date'),
      count('adults', 'Adults', 1, 6, 1),
      count('children', 'Children', 0, 5, 0),
    ],
    filters: [
      {
        kind: 'options',
        param: 'classes',
        requestKey: 'classes',
        label: 'Class',
        facet: 'classes',
      },
      departure,
      arrival,
      { kind: 'options', param: 'trains', requestKey: 'trains', label: 'Train', facet: 'trains' },
      maxDuration(),
    ],
    sorts: sorts('trains', ['departure-asc', 'duration-asc', 'price-asc', 'price-desc']),
    submitLabel: 'Search trains',
    coverage:
      'Demo trains run between Bengaluru, Chennai, Delhi, Mumbai, Hyderabad (Secunderabad), Pune and Jaipur.',
    noun: ['train fare', 'train fares'],
  },
  buses: {
    serviceType: 'buses',
    swap: ['from', 'to'],
    fields: [
      place('from', 'origin', 'From', ['city']),
      place('to', 'destination', 'To', ['city']),
      date('date', 'departureDate', 'Travel date'),
      count('adults', 'Adults', 1, 6, 1),
      count('children', 'Children', 0, 5, 0),
    ],
    filters: [
      price(),
      departure,
      arrival,
      {
        kind: 'options',
        param: 'operators',
        requestKey: 'operators',
        label: 'Operator',
        facet: 'operators',
      },
      {
        kind: 'options',
        param: 'types',
        requestKey: 'busTypes',
        label: 'Bus type',
        facet: 'busTypes',
      },
      {
        kind: 'options',
        param: 'amenities',
        requestKey: 'amenities',
        label: 'On board',
        facet: 'busAmenities',
        matchAll: true,
      },
      maxDuration(),
    ],
    sorts: sorts('buses', ['departure-asc', 'duration-asc', 'price-asc', 'price-desc']),
    submitLabel: 'Search buses',
    coverage: 'Demo buses run between Bengaluru, Hyderabad, Chennai and Pune.',
    noun: ['bus', 'buses'],
  },
  metro: {
    serviceType: 'metro',
    swap: ['from', 'to'],
    fields: [
      place('from', 'origin', 'From station', ['metro-station']),
      place('to', 'destination', 'To station', ['metro-station']),
      count('passengers', 'Passengers', 1, 6, 1),
    ],
    filters: [
      {
        kind: 'at-most',
        param: 'changes',
        requestKey: 'maxTransfers',
        label: 'Changes',
        facet: 'transfers',
        describe: (n) => (n === 0 ? 'No changes' : `Up to ${n} change${n === 1 ? '' : 's'}`),
      },
      { kind: 'options', param: 'lines', requestKey: 'lines', label: 'Line', facet: 'lines' },
      maxDuration(),
    ],
    sorts: sorts('metro', ['transfers-asc', 'duration-asc']),
    submitLabel: 'Plan journey',
    coverage: 'The demo journey planner covers selected Bengaluru and Delhi metro stations.',
    noun: ['route', 'routes'],
  },
  cabs: {
    serviceType: 'cabs',
    swap: ['from', 'to'],
    fields: [
      place('from', 'pickup', 'Pick-up', ['airport', 'locality']),
      place('to', 'dropoff', 'Drop-off', ['airport', 'locality']),
      {
        kind: 'datetime',
        param: 'at',
        requestKey: 'pickupAt',
        label: 'Pick-up time',
        zoneFrom: 'from',
        required: true,
      },
      count('passengers', 'Passengers', 1, 7, 1),
    ],
    filters: [
      {
        kind: 'options',
        param: 'vehicles',
        requestKey: 'vehicleTypes',
        label: 'Vehicle',
        facet: 'vehicleTypes',
      },
      {
        kind: 'at-least',
        param: 'seats',
        requestKey: 'minCapacity',
        label: 'Seats',
        facet: 'capacities',
        describe: (n) => `At least ${n} seats`,
      },
      price('Estimated fare'),
    ],
    sorts: sorts('cabs', ['price-asc', 'price-desc', 'capacity-desc']),
    submitLabel: 'Get estimates',
    coverage: 'Demo cab estimates cover airport and city trips in Bengaluru, Delhi and Mumbai.',
    noun: ['estimate', 'estimates'],
  },
  holidays: {
    serviceType: 'holidays',
    swap: null,
    fields: [
      place('to', 'destination', 'Destination', ['destination']),
      date('depart', 'departureDate', 'Start date'),
      count('adults', 'Adults', 1, 9, 2),
      count('children', 'Children', 0, 8, 0),
    ],
    filters: [
      price('Budget (whole party)'),
      {
        kind: 'nights-range',
        params: ['minNights', 'maxNights'],
        requestKeys: ['minNights', 'maxNights'],
        label: 'Length',
      },
      {
        kind: 'options',
        param: 'interests',
        requestKey: 'interests',
        label: 'Themes',
        facet: 'interests',
      },
    ],
    sorts: sorts('holidays', ['price-asc', 'price-desc', 'duration-asc', 'duration-desc']),
    submitLabel: 'Search packages',
    coverage: 'Demo packages cover Kerala, Goa, Jaipur and Bali.',
    noun: ['package', 'packages'],
  },
};

/** Place options for a place field, labelled "City · Name (CODE)". */
export function placeOptions(kinds: readonly PlaceKind[]): Option[] {
  return placesOfKind(...kinds).map((p) => ({
    value: p.id,
    label:
      p.kind === 'city' || p.kind === 'destination'
        ? p.name
        : `${p.cityName} · ${p.name}${p.code ? ` (${p.code})` : ''}`,
  }));
}

/** Every URL parameter that belongs to a filter of this category. */
export function filterParams(type: SearchServiceType): string[] {
  return SEARCH_CONFIG[type].filters.flatMap((f) => ('params' in f ? [...f.params] : [f.param]));
}
