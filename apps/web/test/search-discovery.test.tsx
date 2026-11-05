import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utcDateFromToday } from '@wayora/contracts';
import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  clearRecentSearches,
  recentSearches,
  rememberSearch,
  type RecentStore,
} from '../src/features/search/recent';
import { installFakeSearchApi, searchResponse } from './fake-search-api';
import { renderRoute } from './render';
import { DATE, DATE_PLUS_3, flight, flightFacets, hotel, train } from './search-fixtures';

/*
 * Phase 24: trip type, recent searches, data-backed filters and the
 * "Latest departure" sort. Deterministic fixtures; the API's side of the
 * new filters and sort is covered by apps/api/test/search-refine.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const FLIGHT_URL = `/flights?from=airport%3ABLR&to=airport%3ADEL&depart=${DATE}`;
const choose = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
const resultsList = () => screen.findByRole('list', { name: 'Search results' });
const sidebar = () => screen.getByRole('region', { name: 'Filters' });

/** An in-memory store, for testing storage edge cases without the browser's. */
function memoryStore(
  initial: Record<string, string> = {},
): RecentStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('flight trip type', () => {
  it('starts one way with no return field; Round trip shows it and requires a date', async () => {
    const api = installFakeSearchApi();
    renderRoute('/flights');
    const tripType = await screen.findByRole('group', { name: 'Trip type' });
    expect(within(tripType).getByRole('radio', { name: 'One way' })).toBeChecked();
    expect(screen.queryByLabelText(/^Return/)).toBeNull();

    fireEvent.click(within(tripType).getByRole('radio', { name: 'Round trip' }));
    expect(screen.getByLabelText(/^Return/)).toBeInTheDocument();
    choose('From', 'airport:BLR');
    choose('To', 'airport:DEL');
    fireEvent.change(screen.getByLabelText(/^Departure/), { target: { value: DATE } });
    fireEvent.click(screen.getByRole('button', { name: 'Search flights' }));
    expect(
      await screen.findByText('Choose a return date, or switch to one way.'),
    ).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('sends a return date for a round trip, and none after switching back to one way', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: searchResponse([]) });
    const { router } = renderRoute('/flights');
    fireEvent.click(await screen.findByRole('radio', { name: 'Round trip' }));
    choose('From', 'airport:BLR');
    choose('To', 'airport:DEL');
    fireEvent.change(screen.getByLabelText(/^Departure/), { target: { value: DATE } });
    fireEvent.change(screen.getByLabelText(/^Return/), { target: { value: DATE_PLUS_3 } });
    // Back to one way clears the hidden return date.
    fireEvent.click(screen.getByRole('radio', { name: 'One way' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Round trip' }));
    expect(screen.getByLabelText(/^Return/)).toHaveValue('');
    fireEvent.change(screen.getByLabelText(/^Return/), { target: { value: DATE_PLUS_3 } });
    fireEvent.click(screen.getByRole('button', { name: 'Search flights' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]!.body).toMatchObject({ returnDate: DATE_PLUS_3 });
    expect(new URLSearchParams(router.state.location.search).get('return')).toBe(DATE_PLUS_3);
  });

  it('opens a return-trip link as a round trip in the edit form', async () => {
    installFakeSearchApi({ kind: 'ok', response: searchResponse([flight('CDA 101', 400, 5000)]) });
    renderRoute(`${FLIGHT_URL}&return=${DATE_PLUS_3}`);
    await resultsList();
    fireEvent.click(screen.getByRole('button', { name: /Edit search/ }));
    expect(await screen.findByRole('radio', { name: 'Round trip' })).toBeChecked();
    expect(screen.getByLabelText(/^Return/)).toHaveValue(DATE_PLUS_3);
  });
});

describe('recent searches', () => {
  it('remembers a search that ran and offers it again on the empty search page', async () => {
    const api = installFakeSearchApi({
      kind: 'ok',
      response: searchResponse([flight('CDA 101', 400, 5000)]),
    });
    const { router } = renderRoute(`${FLIGHT_URL}&airlines=CDA&sort=price-asc`);
    await resultsList();

    // Only the form's fields are kept: no filters, sort, prices or results.
    const stored = JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY)!);
    expect(stored.flights).toHaveLength(1);
    expect(stored.flights[0].values).toEqual({
      from: 'airport:BLR',
      to: 'airport:DEL',
      depart: DATE,
      adults: '1',
      children: '0',
      infants: '0',
      cabin: 'economy',
    });

    await act(() => router.navigate('/flights'));
    const section = await screen.findByRole('region', { name: 'Recent searches' });
    expect(within(section).getByText(/Saved in this browser only/)).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: /Bengaluru \(BLR\) to Delhi \(DEL\)/ });
    fireEvent.click(link);
    await resultsList();
    expect(router.state.location.search).not.toContain('airlines');
    expect(api.calls.at(-1)!.body).toMatchObject({
      origin: 'airport:BLR',
      destination: 'airport:DEL',
    });
  });

  it('clears the category’s recent searches', async () => {
    rememberSearch('hotels', { to: 'city:goa', checkin: DATE, checkout: DATE_PLUS_3, adults: '2' });
    rememberSearch('flights', { from: 'airport:BLR', to: 'airport:DEL', depart: DATE });
    installFakeSearchApi();
    renderRoute('/hotels');
    const section = await screen.findByRole('region', { name: 'Recent searches' });
    expect(within(section).getAllByRole('link')).toHaveLength(1);
    fireEvent.click(within(section).getByRole('button', { name: 'Clear recent searches' }));
    expect(screen.queryByRole('region', { name: 'Recent searches' })).toBeNull();
    expect(recentSearches('hotels')).toEqual([]);
    expect(recentSearches('flights')).toHaveLength(1);
  });

  it('keeps at most five per category, newest first, without duplicates', () => {
    const store = memoryStore();
    for (let i = 0; i < 7; i += 1) {
      rememberSearch(
        'trains',
        { from: 'station:SBC', to: 'station:MAS', date: utcDateFromToday(10 + i) },
        { store, now: i },
      );
    }
    rememberSearch(
      'trains',
      { from: 'station:SBC', to: 'station:MAS', date: utcDateFromToday(12) },
      { store, now: 99 },
    );
    const list = recentSearches('trains', { store });
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]!.values.date).toBe(utcDateFromToday(12));
    expect(new Set(list.map((e) => e.query)).size).toBe(list.length);
  });

  it('hides searches that are no longer valid and survives bad or missing storage', () => {
    const past = memoryStore({
      [RECENT_SEARCHES_KEY]: JSON.stringify({
        flights: [
          {
            values: { from: 'airport:BLR', to: 'airport:DEL', depart: '2020-01-01' },
            savedAt: 1,
          },
        ],
      }),
    });
    expect(recentSearches('flights', { store: past })).toEqual([]);

    const corrupt = memoryStore({ [RECENT_SEARCHES_KEY]: '{not json' });
    expect(recentSearches('flights', { store: corrupt })).toEqual([]);
    rememberSearch(
      'flights',
      { from: 'airport:BLR', to: 'airport:DEL', depart: DATE },
      { store: corrupt },
    );
    expect(recentSearches('flights', { store: corrupt })).toHaveLength(1);

    const blocked: RecentStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() =>
      rememberSearch(
        'flights',
        { from: 'airport:BLR', to: 'airport:DEL', depart: DATE },
        { store: blocked },
      ),
    ).not.toThrow();
    expect(recentSearches('flights', { store: blocked })).toEqual([]);
    expect(() => clearRecentSearches('flights', { store: blocked })).not.toThrow();
    expect(recentSearches('flights', { store: null })).toEqual([]);
  });

  it('ignores unknown fields stored for a category', () => {
    const store = memoryStore();
    rememberSearch(
      'flights',
      { from: 'airport:BLR', to: 'airport:DEL', depart: DATE, firstName: 'Asha', airlines: 'CDA' },
      { store },
    );
    const [entry] = recentSearches('flights', { store });
    expect(entry!.values).not.toHaveProperty('firstName');
    expect(entry!.values).not.toHaveProperty('airlines');
    expect(store.data.get(RECENT_SEARCHES_KEY)).not.toContain('Asha');
  });
});

describe('Phase 24 filters and sort', () => {
  it('offers "Latest departure" and sends it to the server', async () => {
    const api = installFakeSearchApi({
      kind: 'ok',
      response: searchResponse([flight('CDA 101', 400, 5000)]),
    });
    const { router } = renderRoute(FLIGHT_URL);
    await resultsList();
    choose('Sort by', 'departure-desc');
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(api.calls[1]!.body).toMatchObject({ sortBy: 'departure-desc' });
    expect(router.state.location.search).toContain('sort=departure-desc');
  });

  it('offers a checked-bag filter only when a fare in the results states one', async () => {
    const results = [flight('CDA 101', 400, 5000), flight('CDA 202', 600, 6000)];
    const api = installFakeSearchApi({ kind: 'ok', response: searchResponse(results) });
    renderRoute(FLIGHT_URL);
    await resultsList();
    expect(within(sidebar()).queryByRole('checkbox', { name: 'Checked bag included' })).toBeNull();

    api.setDefault({
      kind: 'ok',
      response: searchResponse(results, {
        facets: {
          ...flightFacets(results),
          options: {
            ...flightFacets(results).options,
            checkedBaggage: [{ value: 'included', label: 'Checked bag included', count: 1 }],
          },
        },
      }),
    });
    choose('Sort by', 'price-asc');
    const bags = await within(sidebar()).findByRole('checkbox', { name: 'Checked bag included' });
    fireEvent.click(bags);
    await waitFor(() =>
      expect(api.calls.at(-1)!.body).toMatchObject({ filters: { checkedBaggageIncluded: true } }),
    );
    expect(
      within(screen.getByRole('list', { name: 'Active filters' })).getByRole('button', {
        name: 'Remove filter: Checked bag included',
      }),
    ).toBeInTheDocument();
  });

  it('keeps an applied supplier-only filter visible so it can be turned off', async () => {
    installFakeSearchApi({
      kind: 'ok',
      response: searchResponse([hotel], {
        facets: { price: null, durationMinutes: null, options: {} },
      }),
    });
    renderRoute(`/hotels?to=city%3Agoa&checkin=${DATE}&checkout=${DATE_PLUS_3}&free-cancel=1`);
    await resultsList();
    expect(within(sidebar()).getByRole('checkbox', { name: 'Free cancellation' })).toBeChecked();
  });

  it('filters trains by fare', async () => {
    const api = installFakeSearchApi({
      kind: 'ok',
      response: searchResponse([train], {
        facets: {
          price: {
            min: { amountMinor: '50000', currency: 'INR' },
            max: { amountMinor: '250000', currency: 'INR' },
            basis: 'total',
          },
          durationMinutes: null,
          options: {},
        },
      }),
    });
    const { router } = renderRoute(`/trains?from=station%3ASBC&to=station%3AMAS&date=${DATE}`);
    await resultsList();
    const panel = sidebar();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Maximum' }), {
      target: { value: '1500' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply price' }));
    await waitFor(() =>
      expect(api.calls.at(-1)!.body).toMatchObject({ filters: { maxPriceMinor: '150000' } }),
    );
    expect(new URLSearchParams(router.state.location.search).get('maxPrice')).toBe('1500');
  });
});
