import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utcDateFromToday, type ProviderStatus } from '@wayora/contracts';
import { SERVICE_NAV } from '../src/features/navigation/config';
import { installFakeSearchApi, searchResponse } from './fake-search-api';
import { renderRoute } from './render';
import {
  DATE,
  bus,
  cab,
  connectingFlight,
  flight,
  holiday,
  hotel,
  metro,
  train,
} from './search-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const FLIGHT_URL = `/flights?from=airport%3ABLR&to=airport%3ADEL&depart=${DATE}`;
const choose = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });

const flights = () => [
  flight('CDA 101', 6 * 60 + 10, 5420),
  flight('KDA 401', 9 * 60 + 45, 6180, { carrier: ['KDA', 'Kestrel Demo Airways'] }),
  connectingFlight(9100),
];
const flightResponse = () => searchResponse(flights());

const sidebar = () => screen.getByRole('region', { name: 'Filters' });
const resultsList = () => screen.findByRole('list', { name: 'Search results' });

describe('service search pages', () => {
  it.each(SERVICE_NAV.map((s) => [s.path, s.name]))(
    '%s shows a labelled demo search form and searches nothing until asked',
    async (path, name) => {
      const api = installFakeSearchApi();
      renderRoute(path);
      expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
      expect(screen.getByText('Demo search')).toBeInTheDocument();
      expect(screen.getByText('Demo data only')).toBeInTheDocument();
      expect(screen.getByRole('form', { name: /^(Search|Plan|Get)/ })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /book/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /book/i })).toBeNull();
      expect(api.calls).toHaveLength(0);
    },
  );
});

describe('searching', () => {
  it('validates the form with the shared contract before searching', async () => {
    const api = installFakeSearchApi();
    renderRoute('/flights');
    fireEvent.click(await screen.findByRole('button', { name: 'Search flights' }));
    expect(await screen.findAllByText('Choose a place.')).toHaveLength(2);
    choose('From', 'airport:BLR');
    choose('To', 'airport:BLR');
    fireEvent.change(screen.getByLabelText(/^Departure/), { target: { value: DATE } });
    fireEvent.click(screen.getByRole('button', { name: 'Search flights' }));
    expect(await screen.findByText('Choose a different place from the start.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('submits, puts the search in the URL, shows a summary, and moves focus to the results', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    const { router } = renderRoute('/flights');
    await screen.findByRole('combobox', { name: 'From' });
    choose('From', 'airport:BLR');
    choose('To', 'airport:DEL');
    fireEvent.change(screen.getByLabelText(/^Departure/), { target: { value: DATE } });
    fireEvent.click(screen.getByRole('button', { name: 'More adults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search flights' }));

    const list = await resultsList();
    expect(within(list).getAllByRole('article')).toHaveLength(3);
    expect(within(list).getAllByText('Demo data')).toHaveLength(3);
    expect(screen.getByText('3 flight options')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Results' })).toHaveFocus());

    // The form makes way for a one-line summary with an edit action.
    expect(screen.queryByRole('form', { name: 'Search flights' })).toBeNull();
    expect(screen.getByText('Bengaluru (BLR) to Delhi (DEL)')).toBeInTheDocument();
    expect(screen.getByText(/2 adults · Economy/)).toBeInTheDocument();

    expect(router.state.historyAction).toBe('PUSH');
    const params = Object.fromEntries(new URLSearchParams(router.state.location.search));
    expect(params).toMatchObject({
      from: 'airport:BLR',
      to: 'airport:DEL',
      depart: DATE,
      adults: '2',
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.body).toMatchObject({
      origin: 'airport:BLR',
      destination: 'airport:DEL',
      departureDate: DATE,
      adults: 2,
      sortBy: 'recommended',
    });
    expect(api.calls[0]!.body).not.toHaveProperty('serviceType');
  });

  it('edits the search from the summary: focus goes to the form, and Cancel returns it', async () => {
    installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    await resultsList();
    fireEvent.click(screen.getByRole('button', { name: /^Edit search/ }));
    const from = screen.getByRole('combobox', { name: 'From' });
    await waitFor(() => expect(from).toHaveFocus());
    expect(from).toHaveValue('airport:BLR');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Edit search/ })).toHaveFocus());
  });

  it('restores a search, its filters and sort from the URL, and runs it once', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(`${FLIGHT_URL}&adults=2&cabin=business&sort=price-desc&airlines=KDA&maxPrice=7000`);
    await resultsList();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('price-desc');
    expect(within(sidebar()).getByRole('checkbox', { name: /Kestrel Demo Airways/ })).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Remove filter: Airline: Kestrel Demo Airways' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove filter: Price: up to ₹7,000' }),
    ).toBeInTheDocument();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.body).toMatchObject({
      adults: 2,
      cabinClass: 'business',
      sortBy: 'price-desc',
      filters: { carriers: ['KDA'], maxPriceMinor: '700000' },
    });
  });

  it('shows the problems in an invalid search link instead of searching', async () => {
    const api = installFakeSearchApi();
    renderRoute('/flights?from=airport%3AXXX&to=airport%3ADEL&depart=2020-01-01&adults=lots');
    expect(await screen.findByText("This search link isn't valid")).toBeInTheDocument();
    expect(screen.getByText('Choose a place from the list.')).toBeInTheDocument();
    expect(screen.getByText('That date has already passed.')).toBeInTheDocument();
    expect(screen.getByText('Enter the number of adults.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('ignores invalid filters, sort and page in a link, tidies the URL and says so', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    const { router } = renderRoute(
      `${FLIGHT_URL}&stops=many&sort=cheapest&page=0&maxPrice=-5&airlines=CDA&depart-times=midnight`,
    );
    await resultsList();
    expect(api.calls[0]!.body).toMatchObject({ sortBy: 'recommended' });
    expect(api.calls[0]!.body.filters).toEqual({ carriers: ['CDA'] });
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        from: 'airport:BLR',
        to: 'airport:DEL',
        depart: DATE,
        airlines: 'CDA',
      }),
    );
    expect(router.state.historyAction).toBe('REPLACE');
    expect(await screen.findByText(/weren't valid, so they were removed/)).toBeInTheDocument();
  });

  it('swaps origin and destination', async () => {
    installFakeSearchApi();
    renderRoute('/flights');
    await screen.findByRole('combobox', { name: 'From' });
    choose('From', 'airport:BLR');
    choose('To', 'airport:DEL');
    fireEvent.click(screen.getByRole('button', { name: 'Swap from and to' }));
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('airport:DEL');
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('airport:BLR');
  });
});

describe('result states', () => {
  it('shows card-shaped placeholders while searching, then the results', async () => {
    const api = installFakeSearchApi();
    const release = api.nextHeld({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    expect(await screen.findByRole('status', { name: 'Searching' })).toBeInTheDocument();
    expect(screen.getByText('Searching demo data…')).toBeInTheDocument();
    release();
    expect(await resultsList()).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Searching' })).toBeNull();
  });

  it('distinguishes a search with no results from a failure', async () => {
    installFakeSearchApi({ kind: 'ok', response: searchResponse([]) });
    renderRoute(FLIGHT_URL);
    expect(await screen.findByText('No demo results for this search')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No flight options')).toBeInTheDocument();
  });

  it('says when filters exclude every result, and clears them', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    api.next({ kind: 'ok', response: searchResponse([], { facets: flightResponse().facets }) });
    const { router } = renderRoute(`${FLIGHT_URL}&stops=0&airlines=XYZ`);
    expect(await screen.findByText('No results match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await resultsList();
    expect(router.state.location.search).not.toMatch(/stops|airlines/);
  });

  it('reports an unavailable search with a working retry', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    api.next({
      kind: 'error',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: "We couldn't search flights right now.",
    });
    renderRoute(FLIGHT_URL);
    expect(await screen.findByText('Search is unavailable right now')).toBeInTheDocument();
    expect(screen.getByText("We couldn't search flights right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await resultsList()).toBeInTheDocument();
    expect(api.calls).toHaveLength(2);
  });

  it('reports a network failure in plain words', async () => {
    const api = installFakeSearchApi();
    api.next({ kind: 'network' });
    renderRoute(FLIGHT_URL);
    expect(await screen.findByText("We couldn't reach Wayora")).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
  });

  it('keeps partial results, names the provider that failed, and retries', async () => {
    const failed: ProviderStatus = {
      providerId: 'other',
      providerName: 'Other demo flights',
      kind: 'demo',
      status: 'timeout',
      resultCount: 0,
      durationMs: 2000,
      message: 'This provider took too long to answer.',
    };
    const ok: ProviderStatus = {
      ...failed,
      providerId: 'demo-flights',
      providerName: 'Wayora demo flights',
      status: 'success',
      resultCount: 3,
      message: null,
    };
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    api.next({ kind: 'ok', response: searchResponse(flights(), { statuses: [ok, failed] }) });
    renderRoute(FLIGHT_URL);
    expect(await screen.findByText('Some results may be missing')).toBeInTheDocument();
    expect(
      screen.getByText(/Other demo flights: This provider took too long to answer\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Demo data from Wayora demo flights/)).toBeInTheDocument();
    expect(within(await resultsList()).getAllByRole('article')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.calls).toHaveLength(2));
  });

  it('keeps the current results on screen while a filter or sort change loads', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    await resultsList();
    const release = api.nextHeld({ kind: 'ok', response: searchResponse([flights()[0]!]) });
    choose('Sort by', 'price-desc');
    await waitFor(() => expect(screen.getByText('Updating results…')).toBeInTheDocument());
    const list = screen.getByRole('list', { name: 'Search results' });
    expect(list).toHaveAttribute('aria-busy', 'true');
    expect(within(list).getAllByRole('article')).toHaveLength(3);
    release();
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('article'),
      ).toHaveLength(1),
    );
  });

  it('cancels a replaced search and never shows its late answer', async () => {
    const api = installFakeSearchApi();
    const releaseFirst = api.nextHeld({
      kind: 'ok',
      response: searchResponse([flight('OLD 1', 360, 9999)]),
    });
    api.next({ kind: 'ok', response: searchResponse([flight('NEW 1', 585, 5000)]) });
    renderRoute(FLIGHT_URL);
    await screen.findByRole('status', { name: 'Searching' });
    choose('Sort by', 'price-asc');
    await screen.findByText('NEW 1');
    await waitFor(() => expect(api.calls[0]!.signal?.aborted).toBe(true));
    await act(async () => {
      releaseFirst();
      await Promise.resolve();
    });
    expect(screen.queryByText('OLD 1')).toBeNull();
    expect(screen.getByText('NEW 1')).toBeInTheDocument();
  });
});

describe('filters and sorting', () => {
  it('offers only filter choices found in the results (facets), with counts', async () => {
    installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    await resultsList();
    const panel = sidebar();
    expect(within(panel).getByRole('checkbox', { name: /Coral Demo Air/ })).toBeInTheDocument();
    expect(
      within(panel).getByRole('checkbox', { name: /Kestrel Demo Airways/ }),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Nonstop only' })).toBeInTheDocument();
    expect(within(panel).getByText(/In these results: ₹5,420 – ₹9,100/)).toBeInTheDocument();
    expect(within(panel).queryByText(/rating/i)).toBeNull();
  });

  it(
    'applies filters through the URL without adding history entries, and shows chips',
    { timeout: 20_000 },
    async () => {
      const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
      const { router } = renderRoute(FLIGHT_URL);
      await resultsList();

      fireEvent.click(within(sidebar()).getByRole('checkbox', { name: /Kestrel Demo Airways/ }));
      await waitFor(() => expect(api.calls).toHaveLength(2));
      expect(api.calls[1]!.body).toMatchObject({ filters: { carriers: ['KDA'] } });
      expect(router.state.historyAction).toBe('REPLACE');

      fireEvent.click(within(sidebar()).getByRole('radio', { name: 'Nonstop only' }));
      await waitFor(() => expect(api.calls).toHaveLength(3));
      expect(api.calls[2]!.body).toMatchObject({ filters: { carriers: ['KDA'], maxStops: 0 } });

      const departure = within(sidebar()).getByRole('group', { name: 'Departure time' });
      fireEvent.click(within(departure).getByRole('checkbox', { name: '6 am – 12 pm' }));
      await waitFor(() => expect(api.calls).toHaveLength(4));
      expect(api.calls[3]!.body).toMatchObject({ filters: { departureWindows: ['morning'] } });

      const panel = sidebar();
      fireEvent.change(within(panel).getByRole('textbox', { name: 'Minimum' }), {
        target: { value: '5,000' },
      });
      fireEvent.change(within(panel).getByRole('textbox', { name: 'Maximum' }), {
        target: { value: '8000' },
      });
      fireEvent.click(within(panel).getByRole('button', { name: 'Apply price' }));
      await waitFor(() => expect(api.calls).toHaveLength(5));
      expect(api.calls[4]!.body).toMatchObject({
        filters: { minPriceMinor: '500000', maxPriceMinor: '800000' },
      });
      expect(new URLSearchParams(router.state.location.search).get('maxPrice')).toBe('8000');

      fireEvent.change(
        within(sidebar()).getByRole('combobox', { name: 'Journey time (each way)' }),
        { target: { value: '180' } },
      );
      await waitFor(() => expect(api.calls).toHaveLength(6));
      expect(api.calls[5]!.body).toMatchObject({ filters: { maxDurationMinutes: 180 } });

      const chips = screen.getByRole('list', { name: 'Active filters' });
      expect(
        within(chips)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([
        'Nonstop only',
        'Price: from ₹5,000',
        'Price: up to ₹8,000',
        'Departure time: 6 am – 12 pm',
        'Airline: Kestrel Demo Airways',
        'Journey time (each way): up to 3 h',
      ]);

      // Removing one chip removes just that filter…
      fireEvent.click(within(chips).getByRole('button', { name: 'Remove filter: Nonstop only' }));
      await waitFor(() => expect(api.calls).toHaveLength(7));
      expect(api.calls[6]!.body.filters).not.toHaveProperty('maxStops');
      expect(api.calls[6]!.body).toMatchObject({ filters: { carriers: ['KDA'] } });

      // …and Clear all removes the rest. That is the original search again, so
      // its results come from the client cache without another request.
      fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
      await waitFor(() =>
        expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull(),
      );
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        from: 'airport:BLR',
        to: 'airport:DEL',
        depart: DATE,
      });
      expect(api.calls).toHaveLength(7);
      expect(within(await resultsList()).getAllByRole('article')).toHaveLength(3);
    },
  );

  it('rejects an invalid price range in the form without searching', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    await resultsList();
    const panel = sidebar();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Minimum' }), {
      target: { value: '9000' },
    });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Maximum' }), {
      target: { value: '100' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply price' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The maximum must be at least the minimum.',
    );
    expect(api.calls).toHaveLength(1);
  });

  it('labels the default sort, keeps it out of the URL, and sorts on the server', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    const { router } = renderRoute(FLIGHT_URL);
    await resultsList();
    const sort = screen.getByRole('combobox', { name: 'Sort by' });
    expect(sort).toHaveValue('recommended');
    expect(within(sort).getByRole('option', { name: 'Recommended (default)' })).toBeInTheDocument();
    choose('Sort by', 'duration-asc');
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(api.calls[1]!.body).toMatchObject({ sortBy: 'duration-asc' });
    expect(router.state.location.search).toContain('sort=duration-asc');
    choose('Sort by', 'recommended');
    await waitFor(() => expect(router.state.location.search).not.toContain('sort='));
  });

  it('pages add history entries; Back returns to the previous page', async () => {
    const api = installFakeSearchApi({
      kind: 'ok',
      response: searchResponse(flights(), { pageSize: 3, total: 7 }),
    });
    const { router } = renderRoute(FLIGHT_URL);
    await resultsList();
    expect(screen.getByText('1–3 of 7 flight options')).toBeInTheDocument();
    api.setDefault({
      kind: 'ok',
      response: searchResponse(flights(), { pageSize: 3, total: 7, page: 2 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(router.state.location.search).toContain('page=2'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(api.calls.at(-1)!.body).toMatchObject({ page: 2 });
    await act(() => router.navigate(-1));
    expect(router.state.location.search).not.toContain('page=');
  });

  it('filters on small screens in a sheet that returns focus to its button', async () => {
    const api = installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    await resultsList();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Coral Demo Air/ }));
    await waitFor(() => expect(api.calls).toHaveLength(2));
    const show = await within(sheet).findByRole('button', { name: /Show \d+ results?/ });
    fireEvent.click(show);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filters (1)' })).toHaveFocus());
  });
});

describe('category result cards', () => {
  const cases = [
    [
      'hotels',
      `/hotels?to=city%3Agoa&checkin=${DATE}&checkout=${utcDateFromToday(23)}`,
      hotel,
      ['Casa Lagoa (demo)', 'Assagao, Goa', /₹7,800 per night/, 'Breakfast included'],
    ],
    [
      'trains',
      `/trains?from=station%3ASBC&to=station%3AMAS&date=${DATE}`,
      train,
      ['Cauvery Demo Express (D2601)', 'AC Chair Car (CC)'],
    ],
    [
      'buses',
      `/buses?from=city%3Abengaluru&to=city%3Ahyderabad&date=${DATE}`,
      bus,
      ['Deccan Demo Travels', 'AC sleeper', 'Charging point'],
    ],
    [
      'metro',
      '/metro?from=metro%3Ablr-whitefield&to=metro%3Ablr-lalbagh',
      metro,
      ['Purple Line', 'Green Line', '1 change'],
    ],
    [
      'cabs',
      `/cabs?from=airport%3ABLR&to=locality%3Ablr-koramangala&at=${utcDateFromToday(5)}T09%3A30`,
      cab,
      ['Sedan (compact saloon)', 'Demo estimate, not a quote', 'Up to 4 passengers'],
    ],
    [
      'holidays',
      `/holidays?to=destination%3Akerala&depart=${DATE}`,
      holiday,
      ['Backwaters and Hills (demo)', '5 nights', 'Nature'],
    ],
  ] as const;

  it.each(cases)(
    '%s: shows its own card with only the fields it has',
    async (_type, url, result, texts) => {
      installFakeSearchApi({ kind: 'ok', response: searchResponse([result]) });
      renderRoute(url);
      const card = within(await resultsList()).getByRole('article');
      for (const text of texts) expect(within(card).getAllByText(text).length).toBeGreaterThan(0);
      expect(within(card).getByText('Demo data')).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: /^View details/ })).toBeInTheDocument();
      expect(within(card).queryByText(/rating|reviews|seats left|available/i)).toBeNull();
    },
  );

  it('flights: carriers, flight numbers, times, stops and the price basis', async () => {
    installFakeSearchApi({ kind: 'ok', response: flightResponse() });
    renderRoute(FLIGHT_URL);
    const [, , connection] = within(await resultsList()).getAllByRole('article');
    expect(
      within(connection!).getByRole('heading', { name: 'Kestrel Demo Airways' }),
    ).toBeInTheDocument();
    expect(within(connection!).getByText('KDA 431, KDA 462')).toBeInTheDocument();
    expect(within(connection!).getAllByText('1 stop').length).toBeGreaterThan(0);
    expect(within(connection!).getByText(/₹9,100 per adult/)).toBeInTheDocument();
  });
});
