import { daysBetween, findPlace, type SearchServiceType } from '@wayora/contracts';
import type { FormValues } from './params';

const dayFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "Tue, 10 Nov" for a YYYY-MM-DD date. */
export function formatDay(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Short name of a place: its code where it has one, else its name. */
const short = (id: string | undefined) => {
  const place = findPlace(id);
  return place ? (place.code ?? place.name) : '';
};
const city = (id: string | undefined) => findPlace(id)?.cityName ?? '';
const name = (id: string | undefined) => findPlace(id)?.name ?? '';

function party(values: FormValues, keys: readonly [string, string][]): string {
  return keys
    .map(([key, noun]) => [Number(values[key] ?? 0), noun] as const)
    .filter(([n]) => n > 0)
    .map(([n, noun]) => plural(n, noun, noun === 'child' ? 'children' : undefined))
    .join(', ');
}

export interface SearchSummaryText {
  /** "Bengaluru to Goa" */
  title: string;
  /** "Tue, 10 Nov", "2 adults", "Economy"… */
  details: string[];
}

/**
 * A one-line description of a search, from its (validated) URL values, for
 * the results summary bar. Only states what the search asked for.
 */
export function summarizeSearch(type: SearchServiceType, values: FormValues): SearchSummaryText {
  switch (type) {
    case 'flights': {
      const cabin = (values.cabin ?? 'economy').replace('-', ' ');
      return {
        title: `${city(values.from)} (${short(values.from)}) to ${city(values.to)} (${short(values.to)})`,
        details: [
          values.return
            ? `${formatDay(values.depart!)} – ${formatDay(values.return)}, return`
            : `${formatDay(values.depart!)}, one way`,
          party(values, [
            ['adults', 'adult'],
            ['children', 'child'],
            ['infants', 'infant'],
          ]),
          cabin.charAt(0).toUpperCase() + cabin.slice(1),
        ],
      };
    }
    case 'hotels': {
      const nights = daysBetween(values.checkin!, values.checkout!);
      return {
        title: `Stays in ${name(values.to)}`,
        details: [
          `${formatDay(values.checkin!)} – ${formatDay(values.checkout!)}, ${plural(nights, 'night')}`,
          plural(Number(values.rooms ?? 1), 'room'),
          party(values, [
            ['adults', 'adult'],
            ['children', 'child'],
          ]),
        ],
      };
    }
    case 'trains':
    case 'buses':
      return {
        title:
          type === 'trains'
            ? `${name(values.from)} (${short(values.from)}) to ${name(values.to)} (${short(values.to)})`
            : `${name(values.from)} to ${name(values.to)}`,
        details: [
          formatDay(values.date!),
          party(values, [
            ['adults', 'adult'],
            ['children', 'child'],
          ]),
        ],
      };
    case 'metro':
      return {
        title: `${name(values.from)} to ${name(values.to)}`,
        details: [city(values.from), plural(Number(values.passengers ?? 1), 'passenger')],
      };
    case 'cabs': {
      const at = values.at ?? '';
      return {
        title: `${name(values.from)} to ${name(values.to)}`,
        details: [
          `${formatDay(at.slice(0, 10))}, ${at.slice(11, 16)}`,
          city(values.from),
          plural(Number(values.passengers ?? 1), 'passenger'),
        ],
      };
    }
    case 'holidays':
      return {
        title: `Packages in ${name(values.to)}`,
        details: [
          `Starting ${formatDay(values.depart!)}`,
          party(values, [
            ['adults', 'adult'],
            ['children', 'child'],
          ]),
        ],
      };
  }
}
