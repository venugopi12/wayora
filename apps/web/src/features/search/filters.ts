import type { z } from 'zod';
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  searchRequestSchemas,
  type SearchFacets,
  type SearchServiceType,
} from '@wayora/contracts';
import { formatMoney } from '@wayora/ui';
import { SEARCH_CONFIG, filterParams, type FilterConfig } from './config';

/*
 * Filters, sort and page in the URL (docs/search.md#url-state).
 *
 * The search itself (route, dates, party) must be valid or nothing is
 * searched. Filters, sort and page are refinements: an invalid value is
 * dropped (and reported, so the page can tidy the URL) instead of
 * invalidating the search. Every value is checked with the same contract the
 * API uses, field by field.
 */

export const SORT_PARAM = 'sort';
export const PAGE_PARAM = 'page';

/** Whole currency units ↔ minor units. All supported search currencies have 2 decimals. */
const MINOR_PER_UNIT = 100n;
const WHOLE_UNITS = /^[1-9]\d{0,10}$/;

/** Contract schema for one filter field of a category. */
function filterFieldSchema(type: SearchServiceType, requestKey: string): z.ZodType | undefined {
  const filters = searchRequestSchemas[type].shape.filters.unwrap();
  return (filters.shape as Record<string, z.ZodType>)[requestKey];
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface ReadFilters {
  /** Valid filters, as the request's `filters` object. */
  filters: Record<string, unknown>;
  /** URL parameters whose values were dropped as invalid. */
  dropped: string[];
}

/** Reads one filter's raw URL value(s) into request fields, or null if invalid. */
function readOne(
  type: SearchServiceType,
  filter: FilterConfig,
  params: URLSearchParams,
): { fields: Record<string, unknown>; invalid: string[] } {
  const fields: Record<string, unknown> = {};
  const invalid: string[] = [];
  const accept = (param: string, requestKey: string, value: unknown) => {
    const schema = filterFieldSchema(type, requestKey);
    if (schema?.safeParse(value).success) fields[requestKey] = value;
    else invalid.push(param);
  };

  switch (filter.kind) {
    case 'options': {
      const raw = params.get(filter.param);
      if (raw !== null) accept(filter.param, filter.requestKey, [...new Set(parseList(raw))]);
      break;
    }
    case 'at-most':
    case 'at-least':
    case 'max-duration': {
      const raw = params.get(filter.param);
      if (raw !== null) {
        if (/^\d{1,5}$/.test(raw)) accept(filter.param, filter.requestKey, Number(raw));
        else invalid.push(filter.param);
      }
      break;
    }
    case 'toggle': {
      const raw = params.get(filter.param);
      if (raw !== null) {
        if (raw === '1') accept(filter.param, filter.requestKey, true);
        else invalid.push(filter.param);
      }
      break;
    }
    case 'price-range':
    case 'nights-range': {
      filter.params.forEach((param, i) => {
        const raw = params.get(param);
        if (raw === null) return;
        const key = filter.requestKeys[i]!;
        if (!WHOLE_UNITS.test(raw)) {
          invalid.push(param);
        } else if (filter.kind === 'price-range') {
          accept(param, key, (BigInt(raw) * MINOR_PER_UNIT).toString());
        } else {
          accept(param, key, Number(raw));
        }
      });
      // An inverted range can't match anything: drop both ends.
      const [lowKey, highKey] = filter.requestKeys;
      const low = fields[lowKey];
      const high = fields[highKey];
      if (low !== undefined && high !== undefined && BigInt(String(low)) > BigInt(String(high))) {
        delete fields[lowKey];
        delete fields[highKey];
        invalid.push(...filter.params);
      }
      break;
    }
  }
  return { fields, invalid };
}

export function readFilters(type: SearchServiceType, params: URLSearchParams): ReadFilters {
  const filters: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const filter of SEARCH_CONFIG[type].filters) {
    const { fields, invalid } = readOne(type, filter, params);
    Object.assign(filters, fields);
    dropped.push(...invalid);
  }
  return { filters, dropped };
}

/** The URL's sort if it is one this category offers, else the category default. */
export function readSort(
  type: SearchServiceType,
  params: URLSearchParams,
): {
  sort: string;
  dropped: boolean;
} {
  const raw = params.get(SORT_PARAM);
  if (raw === null) return { sort: DEFAULT_SORT[type], dropped: false };
  const valid = (SORT_OPTIONS[type] as readonly string[]).includes(raw);
  return { sort: valid ? raw : DEFAULT_SORT[type], dropped: !valid };
}

/** A page number from 1 to 100, else 1. */
export function readPage(params: URLSearchParams): { page: number; dropped: boolean } {
  const raw = params.get(PAGE_PARAM);
  if (raw === null) return { page: 1, dropped: false };
  const valid = /^\d{1,3}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 100;
  return { page: valid ? Number(raw) : 1, dropped: !valid };
}

// ─── Active filter chips ──────────────────────────────────────────────────

export interface FilterChip {
  /** Unique within the page. */
  key: string;
  /** "Airline: Coral Demo Air" */
  label: string;
  /** URL parameter changes that remove this chip (null deletes). */
  remove: Record<string, string | null>;
}

const lookup = (facets: SearchFacets | undefined, filter: FilterConfig, value: string) => {
  if (filter.kind === 'options' && filter.options) {
    return filter.options.find((o) => o.value === value)?.label ?? value;
  }
  const facet = 'facet' in filter && filter.facet ? facets?.options[filter.facet] : undefined;
  return facet?.find((o) => o.value === value)?.label ?? value;
};

/**
 * One chip per active filter value, built from the URL (so chips match what
 * is applied) with labels from the facets where available.
 */
export function activeFilterChips(
  type: SearchServiceType,
  params: URLSearchParams,
  { currency, facets }: { currency: string; facets?: SearchFacets },
): FilterChip[] {
  const { filters } = readFilters(type, params);
  const chips: FilterChip[] = [];
  for (const filter of SEARCH_CONFIG[type].filters) {
    switch (filter.kind) {
      case 'options': {
        const values = filters[filter.requestKey] as string[] | undefined;
        for (const value of values ?? []) {
          const rest = values!.filter((v) => v !== value);
          chips.push({
            key: `${filter.param}:${value}`,
            label: `${filter.label}: ${lookup(facets, filter, value)}`,
            remove: { [filter.param]: rest.length ? rest.join(',') : null },
          });
        }
        break;
      }
      case 'at-most':
      case 'at-least': {
        const n = filters[filter.requestKey] as number | undefined;
        if (n !== undefined) {
          chips.push({
            key: filter.param,
            label: filter.describe(n),
            remove: { [filter.param]: null },
          });
        }
        break;
      }
      case 'max-duration': {
        const minutes = filters[filter.requestKey] as number | undefined;
        if (minutes !== undefined) {
          chips.push({
            key: filter.param,
            label: `${filter.label}: up to ${formatHours(minutes)}`,
            remove: { [filter.param]: null },
          });
        }
        break;
      }
      case 'toggle':
        if (filters[filter.requestKey] === true) {
          chips.push({ key: filter.param, label: filter.label, remove: { [filter.param]: null } });
        }
        break;
      case 'price-range':
      case 'nights-range': {
        const [lowKey, highKey] = filter.requestKeys;
        const [lowParam, highParam] = filter.params;
        const show = (v: unknown) =>
          filter.kind === 'price-range'
            ? formatMoney(String(v), currency)
            : `${String(v)} night${v === 1 ? '' : 's'}`;
        if (filters[lowKey] !== undefined) {
          chips.push({
            key: lowParam,
            label: `${filter.label}: from ${show(filters[lowKey])}`,
            remove: { [lowParam]: null },
          });
        }
        if (filters[highKey] !== undefined) {
          chips.push({
            key: highParam,
            label: `${filter.label}: up to ${show(filters[highKey])}`,
            remove: { [highParam]: null },
          });
        }
        break;
      }
    }
  }
  return chips;
}

/** URL changes that clear every filter of the category. */
export function clearAllFilters(type: SearchServiceType): Record<string, null> {
  return Object.fromEntries(filterParams(type).map((p) => [p, null]));
}

/** "2 h", "2 h 30 min", "45 min". */
export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
