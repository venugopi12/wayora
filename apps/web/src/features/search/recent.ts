import { z } from 'zod';
import type { SearchServiceType } from '@wayora/contracts';
import { SEARCH_CONFIG } from './config';
import { readSearchParams, type FormValues } from './params';

/*
 * Recent searches (Phase 24, docs/search.md#recent-searches).
 *
 * Kept in this browser only (localStorage), never sent to the API or tied
 * to an account. An entry holds just the search form's fields — the same
 * place ids, dates, party counts and cabin that are already in the search
 * URL — and when it was saved. No filters, prices, results, names or
 * contact details. Entries that no longer make a valid search (a date now in
 * the past) are not offered. Storage can be missing or blocked (private
 * windows, disabled site data); every read and write tolerates that.
 */

export const RECENT_SEARCHES_KEY = 'wayora:recent-searches:v1';
/** Per category. */
export const MAX_RECENT_SEARCHES = 5;

/** The browser storage used (replaceable in tests). */
export interface RecentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStore(): RecentStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const entrySchema = z.object({
  values: z.record(z.string().max(40), z.string().max(40)),
  savedAt: z.number().int().nonnegative(),
});
const storedSchema = z.partialRecord(
  z.enum(['flights', 'hotels', 'trains', 'buses', 'metro', 'cabs', 'holidays']),
  z.array(entrySchema).max(MAX_RECENT_SEARCHES),
);
type Stored = z.infer<typeof storedSchema>;
type Entry = z.infer<typeof entrySchema>;

function load(store: RecentStore | null): Stored {
  if (!store) return {};
  try {
    const raw = store.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return {};
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function save(store: RecentStore | null, data: Stored): void {
  if (!store) return;
  try {
    if (Object.values(data).every((list) => !list?.length)) store.removeItem(RECENT_SEARCHES_KEY);
    else store.setItem(RECENT_SEARCHES_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked: recent searches are a convenience only.
  }
}

/** Only the category's form fields, non-empty, in config order. */
function formFields(type: SearchServiceType, values: FormValues): FormValues {
  const kept: FormValues = {};
  for (const field of SEARCH_CONFIG[type].fields) {
    const value = values[field.param];
    if (value) kept[field.param] = value;
  }
  return kept;
}

const sameValues = (a: FormValues, b: FormValues) => JSON.stringify(a) === JSON.stringify(b);

/** Remembers a search that ran (newest first, without duplicates). */
export function rememberSearch(
  type: SearchServiceType,
  values: FormValues,
  { store = browserStore(), now = Date.now() }: { store?: RecentStore | null; now?: number } = {},
): void {
  const fields = formFields(type, values);
  if (Object.keys(fields).length === 0) return;
  const data = load(store);
  const others = (data[type] ?? []).filter((e) => !sameValues(e.values, fields));
  data[type] = [{ values: fields, savedAt: now }, ...others].slice(0, MAX_RECENT_SEARCHES);
  save(store, data);
}

export interface RecentSearch {
  values: FormValues;
  /** The search's URL query, without filters, sort or page. */
  query: string;
  savedAt: number;
}

/** Recent searches of a category that still make a valid search, newest first. */
export function recentSearches(
  type: SearchServiceType,
  { store = browserStore() }: { store?: RecentStore | null } = {},
): RecentSearch[] {
  return (load(store)[type] ?? []).flatMap((entry: Entry) => {
    const values = formFields(type, entry.values);
    const params = new URLSearchParams(values);
    return readSearchParams(type, params).status === 'ready'
      ? [{ values, query: params.toString(), savedAt: entry.savedAt }]
      : [];
  });
}

/** Forgets the category's recent searches. */
export function clearRecentSearches(
  type: SearchServiceType,
  { store = browserStore() }: { store?: RecentStore | null } = {},
): void {
  const data = load(store);
  delete data[type];
  save(store, data);
}
