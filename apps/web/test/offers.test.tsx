import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utcDateFromToday, type SearchResult } from '@wayora/contracts';
import { offerPath, resultsPathFor } from '../src/features/offers/paths';
import { installFakeSearchApi, searchResponse } from './fake-search-api';
import { renderRoute } from './render';
import { DATE, cab, connectingFlight, flight, holiday, hotel, metro } from './search-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEARCH = `from=airport%3ABLR&to=airport%3ADEL&depart=${DATE}`;

/** Installs the fake with one answered search, and returns an offer URL into it. */
function withSession(results: SearchResult[], from = SEARCH) {
  const response = searchResponse(results);
  const api = installFakeSearchApi({ kind: 'ok', response });
  api.sessions.set(response.searchId, response);
  const url = (result: SearchResult) =>
    offerPath(result.serviceType, result.id, response.searchId, from);
  return { api, response, url };
}

describe('opening an offer', () => {
  it('goes from a result card to its offer page and back, keeping the search, filters and sort', async () => {
    const results = [flight('CDA 101', 370, 5420), connectingFlight(9100)];
    const api = installFakeSearchApi({ kind: 'ok', response: searchResponse(results) });
    const { router } = renderRoute(`/flights?${SEARCH}&sort=price-asc&airlines=KDA`);
    const list = await screen.findByRole('list', { name: 'Search results' });

    fireEvent.click(within(list).getByRole('link', { name: 'View details: Kestrel Demo Airways' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bengaluru to Delhi' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/offers/flights/${encodeURIComponent(results[1]!.id)}`,
    );
    // Read from the server's stored search, by its id.
    const [searchId] = [...api.sessions.keys()];
    expect(api.offerCalls).toEqual([`flights|${searchId}|${results[1]!.id}`]);

    // Breadcrumbs and the back link return to the same results.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Flights results',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Back to flights results' }));
    await screen.findByRole('list', { name: 'Search results' });
    expect(router.state.location.pathname).toBe('/flights');
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toMatchObject({
      from: 'airport:BLR',
      to: 'airport:DEL',
      sort: 'price-asc',
      airlines: 'KDA',
    });
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('price-asc');
    // The restored results come from the client cache: no second search.
    expect(api.calls).toHaveLength(1);
  });

  it("shows the server's price, never one from the URL", async () => {
    const { url } = withSession([hotel]);
    renderRoute(`${url(hotel)}&price=1`);
    const price = await screen.findByRole('complementary', { name: 'Price' });
    expect(price).toHaveTextContent('₹23,400');
    expect(price).toHaveTextContent('₹7,800 per night');
    expect(price).not.toHaveTextContent('₹1');
    expect(price).toHaveTextContent('Booking isn’t available on Wayora yet.'.replace('’', "'"));
    expect(screen.queryByRole('button', { name: /book|reserve|pay/i })).toBeNull();
  });
});

describe('how current an offer is', () => {
  it('demo offers say they are not rechecked and valid for this search only', async () => {
    const { url } = withSession([hotel]);
    renderRoute(url(hotel));
    const price = await screen.findByRole('complementary', { name: 'Price' });
    expect(price).toHaveTextContent(
      /Demo price: illustrative, not bookable\. Not rechecked with any supplier; shown for this search until/,
    );
  });

  it('a changed price: the new price, the old one, and a clear notice', async () => {
    const { api, url } = withSession([hotel]);
    const newPrice = {
      kind: 'total' as const,
      total: { amountMinor: '1450000', currency: 'INR' },
      perUnit: null,
    };
    api.nextOffer({
      kind: 'transform',
      transform: (offer) => ({
        ...offer,
        result: { ...offer.result, price: newPrice },
        validation: {
          status: 'price-changed',
          checkedAt: '2026-10-22T10:32:00+05:30',
          previousPrice: offer.result.price,
        },
      }),
    });
    renderRoute(url(hotel));
    const title = await screen.findByText('The price has changed');
    const alert = title.closest('[role="alert"]');
    expect(alert).toHaveTextContent(
      /When you searched it was ₹[\d,]+\. The provider now quotes ₹14,500\./,
    );
    expect(screen.getByRole('complementary', { name: 'Price' })).toHaveTextContent('₹14,500');
    expect(screen.getByRole('complementary', { name: 'Price' })).toHaveTextContent(
      /Checked with the provider at/,
    );
  });

  it('a confirmed offer says when it was checked', async () => {
    const { api, url } = withSession([hotel]);
    api.nextOffer({
      kind: 'transform',
      transform: (offer) => ({
        ...offer,
        validation: {
          status: 'confirmed',
          checkedAt: '2026-10-22T10:32:00+05:30',
          previousPrice: null,
        },
      }),
    });
    renderRoute(url(hotel));
    const price = await screen.findByRole('complementary', { name: 'Price' });
    expect(price).toHaveTextContent(/Checked with the provider at \d{2}:\d{2}/);
    expect(screen.queryByText('The price has changed')).toBeNull();
  });
});

describe('offer details by category', () => {
  it('flights: segments, the connection, and fare details the source does not provide', async () => {
    const result = connectingFlight(9100);
    const { url } = withSession([result]);
    renderRoute(url(result));
    expect(await screen.findByRole('heading', { name: /^Outbound/ })).toBeInTheDocument();
    expect(screen.getByText('Kestrel Demo Airways KDA 431')).toBeInTheDocument();
    expect(screen.getByText('Kestrel Demo Airways KDA 462')).toBeInTheDocument();
    expect(
      screen.getByText(/Change planes in Hyderabad \(HYD\): 1h 45m connection/),
    ).toBeInTheDocument();
    const fare = screen.getByRole('region', { name: 'Fare' });
    expect(within(fare).getByText('Baggage allowance').nextSibling).toHaveTextContent(
      'Not provided in this offer',
    );
    expect(screen.getByText('Demo offer')).toBeInTheDocument();
  });

  it('hotels: property, stay, and a cancellation policy marked as not provided', async () => {
    const { url } = withSession([hotel]);
    renderRoute(url(hotel));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' }),
    ).toBeInTheDocument();
    const stay = screen.getByRole('region', { name: 'Your stay' });
    expect(within(stay).getByText('Included')).toBeInTheDocument();
    expect(within(stay).getByText('Cancellation policy').nextSibling).toHaveTextContent(
      'Not provided in this offer',
    );
    expect(screen.getByRole('region', { name: 'Property' })).toHaveTextContent(
      'Wi-Fi, Pool, Breakfast',
    );
  });

  it('metro: route steps with the change; cabs: an estimate, not a quote; holidays: inclusions', async () => {
    const { url } = withSession([metro]);
    const first = renderRoute(url(metro));
    const route = await screen.findByRole('region', { name: 'Route' });
    expect(route).toHaveTextContent('1. Purple Line');
    expect(route).toHaveTextContent('Change at Majestic');
    first.unmount();

    const cabSession = withSession([cab], `from=airport%3ABLR&to=locality%3Ablr-koramangala`);
    const second = renderRoute(cabSession.url(cab));
    expect(await screen.findByText(/This is an estimate, not a quote/)).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Price' })).toHaveTextContent('₹840 – ₹1,020');
    second.unmount();

    const holidaySession = withSession([holiday]);
    renderRoute(holidaySession.url(holiday));
    const included = await screen.findByRole('region', { name: "What's included" });
    expect(within(included).getByText('Houseboat stay (1 night)')).toBeInTheDocument();
    expect(within(included).getByText('Day-by-day itinerary').nextSibling).toHaveTextContent(
      'Not provided in this offer',
    );
  });
});

describe('offers that cannot be shown', () => {
  it('rejects invalid service types and offer ids', async () => {
    const api = installFakeSearchApi();
    const first = renderRoute('/offers/rockets/demo-rockets%3Ax');
    // The state is the whole page, so it is the page's one level-1 heading.
    expect(
      await screen.findByRole('heading', { level: 1, name: "This offer link isn't valid" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    first.unmount();
    renderRoute('/offers/flights/has%20a%20space');
    expect(await screen.findByText("This offer link isn't valid")).toBeInTheDocument();
    expect(api.offerCalls).toEqual([]);
  });

  it('reports an expired search, refreshes it, and finds the same offer in the new results', async () => {
    const result = flight('CDA 101', 370, 5420);
    const api = installFakeSearchApi({ kind: 'ok', response: searchResponse([result]) });
    const expiredId = '01890000-0000-7000-8000-00000000dead';
    const { router } = renderRoute(offerPath('flights', result.id, expiredId, SEARCH));
    expect(await screen.findByText('This offer has expired')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh this offer' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bengaluru to Delhi' }),
    ).toBeInTheDocument();
    expect(api.calls).toHaveLength(1); // the original search ran again
    expect(api.calls[0]!.body).toMatchObject({ origin: 'airport:BLR', destination: 'airport:DEL' });
    const sid = new URLSearchParams(router.state.location.search).get('sid');
    expect(sid).not.toBe(expiredId);
    expect(api.sessions.has(sid!)).toBe(true);
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('says so when a refreshed search no longer contains the offer', async () => {
    const gone = flight('CDA 101', 370, 5420);
    installFakeSearchApi({ kind: 'ok', response: searchResponse([flight('KDA 999', 600, 7000)]) });
    renderRoute(offerPath('flights', gone.id, '01890000-0000-7000-8000-00000000dead', SEARCH));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh this offer' }));
    expect(await screen.findByText('This offer is no longer in the results')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh this offer' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /Back to( flights)? results/ })[0]).toHaveAttribute(
      'href',
      `/flights?${new URLSearchParams(decodeURIComponent(SEARCH)).toString()}`,
    );
  });

  it('without a search id, explains the expiry and offers no refresh if the search is unknown', async () => {
    const api = installFakeSearchApi();
    renderRoute(`/offers/flights/${encodeURIComponent('demo-flights:x')}`);
    expect(await screen.findByText('This offer has expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh this offer' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /Back to( flights)? results/ })[0]).toHaveAttribute(
      'href',
      '/flights',
    );
    expect(api.offerCalls).toEqual([]);
  });

  it('reports a network failure with a working retry', async () => {
    const { url } = withSession([hotel]);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const real = fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let offline = true;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      offline && String(input).includes('/offer?')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : real(input, init),
    );
    renderRoute(url(hotel));
    expect(await screen.findByText("We couldn't load this offer")).toBeInTheDocument();
    offline = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' }),
    ).toBeInTheDocument();
  });

  it('an offer that is not part of the named search: says so and offers a refresh', async () => {
    const hotelsSearch = `to=city%3Agoa&checkin=${DATE}&checkout=${utcDateFromToday(23)}&rooms=1&adults=2`;
    const { url } = withSession([hotel], hotelsSearch);
    const stranger = { ...hotel, id: 'demo-hotels:elsewhere', offerRef: 'elsewhere' };
    renderRoute(url(stranger));
    expect(await screen.findByText("This offer isn't part of that search")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh this offer' })).toBeInTheDocument();
  });

  it.each([
    ['OFFER_NOT_FOUND', 404, "This offer link doesn't work"],
    ['CATEGORY_MISMATCH', 409, 'This link mixes up travel types'],
  ])('%s: a link that cannot work leads to a new search', async (code, status, title) => {
    const { api, url } = withSession([hotel]);
    api.nextOffer({ kind: 'error', status, code, message: 'x' });
    renderRoute(url(hotel));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search hotels' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/hotels/),
    );
    expect(screen.queryByRole('button', { name: 'Refresh this offer' })).toBeNull();
  });

  it('OFFER_UNAVAILABLE: the provider says the offer is gone', async () => {
    const { api, url } = withSession([hotel]);
    api.nextOffer({
      kind: 'error',
      status: 410,
      code: 'OFFER_UNAVAILABLE',
      message: 'This offer is no longer available.',
    });
    renderRoute(url(hotel));
    expect(await screen.findByText('This offer is no longer available')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: /Back to( hotels)? results/ }).length,
    ).toBeGreaterThan(0);
  });

  it('a temporary provider failure shows its message and retries only when asked', async () => {
    const { api, url } = withSession([hotel]);
    api.nextOffer({
      kind: 'error',
      status: 504,
      code: 'PROVIDER_TIMEOUT',
      message: "The provider didn't confirm this offer in time. Please try again.",
    });
    renderRoute(url(hotel));
    expect(await screen.findByText("We couldn't check this offer right now")).toBeInTheDocument();
    expect(
      screen.getByText("The provider didn't confirm this offer in time. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByText(/req-offer-1/)).toBeInTheDocument(); // reference for support
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(api.offerCalls).toHaveLength(1); // no automatic retries
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Casa Lagoa (demo)' }),
    ).toBeInTheDocument();
    expect(api.offerCalls).toHaveLength(2);
  });

  it('a refresh that hits a provider failure says so, and can be tried again', async () => {
    const result = flight('CDA 101', 370, 5420);
    const api = installFakeSearchApi({ kind: 'ok', response: searchResponse([result]) });
    api.next({
      kind: 'error',
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Flights providers are unavailable right now. Please try again in a few minutes.',
    });
    renderRoute(offerPath('flights', result.id, '01890000-0000-7000-8000-00000000dead', SEARCH));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh this offer' }));
    expect(await screen.findByText("We couldn't refresh this offer")).toBeInTheDocument();
    expect(screen.getByText(/providers are unavailable right now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh this offer' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bengaluru to Delhi' }),
    ).toBeInTheDocument();
  });

  it('uses "from" only as query parameters on the category path, never as a URL', () => {
    const path = offerPath(
      'hotels',
      hotel.id,
      '01890000-0000-7000-8000-000000000001',
      '?to=city:goa',
    );
    expect(new URL(path, 'https://wayora.test').searchParams.get('from')).toBe('to=city:goa');
    expect(resultsPathFor('hotels', 'to=city:goa&rooms=2')).toBe('/hotels?to=city%3Agoa&rooms=2');
    for (const hostile of [
      'https://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
    ]) {
      expect(resultsPathFor('hotels', hostile)).toMatch(/^\/hotels\?/);
    }
    expect(resultsPathFor('hotels', null)).toBe('/hotels');
  });
});

describe('return navigation', () => {
  it('Back in the browser returns to the results', async () => {
    const results = [flight('CDA 101', 370, 5420)];
    installFakeSearchApi({ kind: 'ok', response: searchResponse(results) });
    const { router } = renderRoute(`/flights?${SEARCH}`);
    const list = await screen.findByRole('list', { name: 'Search results' });
    fireEvent.click(within(list).getByRole('link', { name: /^View details/ }));
    await screen.findByRole('heading', { level: 1, name: 'Bengaluru to Delhi' });
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/flights'));
    expect(await screen.findByRole('list', { name: 'Search results' })).toBeInTheDocument();
  });
});
