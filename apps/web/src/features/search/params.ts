import {
  findPlace,
  searchCurrencySchema,
  searchRequestSchemas,
  type SearchRequestInput,
  type SearchServiceType,
} from '@wayora/contracts';
import { SEARCH_CONFIG, type FieldConfig } from './config';
import { PAGE_PARAM, SORT_PARAM, readFilters, readPage, readSort } from './filters';

/*
 * Search state lives in the URL, so a search can be shared, refreshed and
 * revisited with Back. Parameters are short and readable
 * (`/flights?from=airport:BLR&to=airport:GOI&depart=2026-11-12&adults=2`) and
 * contain no personal data. Everything read from the URL is validated with
 * the same contract the API uses before a request is made.
 */

/** Form values, keyed by URL parameter name. */
export type FormValues = Record<string, string>;

export interface ParamIssue {
  /** URL parameter (form field) the problem belongs to, if any. */
  param: string | null;
  message: string;
}

export type SearchParamsState =
  | { status: 'idle'; values: FormValues }
  | { status: 'invalid'; values: FormValues; issues: ParamIssue[] }
  | {
      status: 'ready';
      values: FormValues;
      request: SearchRequestInput;
      /** Filter, sort, page or currency parameters that were invalid and ignored. */
      dropped: string[];
    };

const CURRENCY_PARAM = 'currency';

/** UTC offset of `timeZone` at the given local date-time, as "+05:30". */
export function utcOffset(localDateTime: string, timeZone: string): string | null {
  const asUtc = new Date(`${localDateTime}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(asUtc)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!name || name === 'GMT') return '+00:00';
    const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
    return match ? `${match[1]}:${match[2] ?? '00'}` : null;
  } catch {
    return null;
  }
}

/** "2026-11-12T09:30" in the place's zone → "2026-11-12T09:30:00+05:30". */
function toOffsetDateTime(local: string, placeId: string | undefined): string {
  const zone = findPlace(placeId)?.timeZone;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !zone) return local;
  const offset = utcOffset(local, zone);
  return offset ? `${local}:00${offset}` : local;
}

function defaultValue(field: FieldConfig): string {
  if (field.kind === 'count') return String(field.defaultValue);
  if (field.kind === 'select') return field.defaultValue;
  return '';
}

/** Form values from the URL, with defaults for anything missing. */
export function formValuesFrom(type: SearchServiceType, params: URLSearchParams): FormValues {
  const values: FormValues = {};
  for (const field of SEARCH_CONFIG[type].fields)
    values[field.param] = params.get(field.param) ?? defaultValue(field);
  return values;
}

/** Turns form values (and the URL's filters, sort, page and currency) into a request input. */
export function requestInputFrom(
  type: SearchServiceType,
  values: FormValues,
  params: URLSearchParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = { serviceType: type };
  for (const field of SEARCH_CONFIG[type].fields) {
    const value = values[field.param] ?? '';
    if (
      value === '' &&
      field.kind !== 'place' &&
      !(field.kind === 'date' && field.required) &&
      field.kind !== 'datetime'
    ) {
      continue; // optional and empty: let the contract apply its default
    }
    switch (field.kind) {
      case 'count':
        input[field.requestKey] = /^\d+$/.test(value) ? Number(value) : value;
        break;
      case 'datetime':
        input[field.requestKey] = toOffsetDateTime(value, values[field.zoneFrom]);
        break;
      default:
        input[field.requestKey] = value;
    }
  }

  return { ...input, ...refinementsFrom(type, params).input };
}

/**
 * Filters, sort, page and currency from the URL. Invalid values are left out
 * (and listed in `dropped`) rather than invalidating the search.
 */
function refinementsFrom(
  type: SearchServiceType,
  params: URLSearchParams,
): { input: Record<string, unknown>; dropped: string[] } {
  const input: Record<string, unknown> = {};
  const { filters, dropped } = readFilters(type, params);
  if (Object.keys(filters).length > 0) input.filters = filters;
  const sort = readSort(type, params);
  if (sort.dropped) dropped.push(SORT_PARAM);
  input.sortBy = sort.sort;
  const page = readPage(params);
  if (page.dropped) dropped.push(PAGE_PARAM);
  if (page.page > 1) input.page = page.page;
  const currency = params.get(CURRENCY_PARAM);
  if (currency !== null) {
    if (searchCurrencySchema.safeParse(currency).success) input.currency = currency;
    else dropped.push(CURRENCY_PARAM);
  }
  return { input, dropped };
}

/** Maps a contract issue path to the URL parameter (form field) it concerns. */
function paramFor(type: SearchServiceType, path: readonly PropertyKey[]): string | null {
  const config = SEARCH_CONFIG[type];
  const [head, sub] = path;
  if (head === 'filters') {
    for (const f of config.filters) {
      if ('requestKeys' in f) {
        const i = f.requestKeys.indexOf(String(sub));
        if (i >= 0) return f.params[i] ?? null;
      } else if (f.requestKey === sub) {
        return f.param;
      }
    }
    return null;
  }
  if (head === 'sortBy') return SORT_PARAM;
  if (head === 'page') return PAGE_PARAM;
  if (head === 'currency') return CURRENCY_PARAM;
  return config.fields.find((f) => f.requestKey === head)?.param ?? null;
}

/** Validates form values against the shared contract. */
export function validate(
  type: SearchServiceType,
  values: FormValues,
  params: URLSearchParams,
): { ok: true; request: SearchRequestInput } | { ok: false; issues: ParamIssue[] } {
  const input = requestInputFrom(type, values, params);
  const result = searchRequestSchemas[type].safeParse(input);
  if (result.success) return { ok: true, request: input as SearchRequestInput };
  const issues: ParamIssue[] = result.error.issues.map((issue) => ({
    param: paramFor(type, issue.path),
    message: issue.message,
  }));
  // Route rules (known place, right kind) only run once every field parses,
  // so flag unknown places here too: a bad link then shows every problem at once.
  for (const field of SEARCH_CONFIG[type].fields) {
    if (field.kind !== 'place') continue;
    const value = values[field.param];
    const place = findPlace(value);
    const known = place !== undefined && field.placeKinds.includes(place.kind);
    if (value && !known && !issues.some((i) => i.param === field.param)) {
      issues.push({ param: field.param, message: 'Choose a place from the list.' });
    }
  }
  return { ok: false, issues };
}

/** Reads the URL: nothing searched yet, an invalid search link, or a search to run. */
export function readSearchParams(
  type: SearchServiceType,
  params: URLSearchParams,
): SearchParamsState {
  const values = formValuesFrom(type, params);
  const required = SEARCH_CONFIG[type].fields.filter(
    (f) => f.kind === 'place' || f.kind === 'datetime' || (f.kind === 'date' && f.required),
  );
  if (!required.some((f) => params.has(f.param))) return { status: 'idle', values };
  const result = validate(type, values, params);
  return result.ok
    ? {
        status: 'ready',
        values,
        request: result.request,
        dropped: refinementsFrom(type, params).dropped,
      }
    : { status: 'invalid', values, issues: result.issues };
}

/**
 * URL parameters for a new search from the form: the form's fields replace
 * the old ones; the filters and sort already chosen, and any unrelated
 * parameters, are kept; the page goes back to 1; the currency follows the
 * display currency.
 */
export function searchParamsFor(
  type: SearchServiceType,
  values: FormValues,
  current: URLSearchParams,
  currency: string,
): URLSearchParams {
  const config = SEARCH_CONFIG[type];
  const next = new URLSearchParams(current);
  next.delete(PAGE_PARAM);
  for (const field of config.fields) {
    const value = values[field.param];
    if (value) next.set(field.param, value);
    else next.delete(field.param);
  }
  if (searchCurrencySchema.safeParse(currency).success && currency !== 'INR') {
    next.set(CURRENCY_PARAM, currency);
  } else {
    next.delete(CURRENCY_PARAM);
  }
  return next;
}

/** A copy of `current` with parameters changed (null removes); back to page 1 unless the page itself changes. */
export function withParams(
  current: URLSearchParams,
  updates: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [param, value] of Object.entries(updates)) {
    if (value === null || value === '') next.delete(param);
    else next.set(param, value);
  }
  if (!(PAGE_PARAM in updates)) next.delete(PAGE_PARAM);
  return next;
}

export const PARAMS = { sort: SORT_PARAM, page: PAGE_PARAM, currency: CURRENCY_PARAM } as const;
