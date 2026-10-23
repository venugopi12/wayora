import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  tripDisruptionSchema,
  tripEventSchema,
  tripStatusSchema,
  type TripStatus,
} from '@wayora/contracts';
import { demoBooking, installFakeBookingApi } from './fake-booking-api';
import { renderRoute } from './render';
import { hotel, train } from './search-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const JOURNEY = { timeout: 20_000 };

/** A minimal EventSource the tests drive by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const trainBooking = demoBooking(train, { reference: 'WYD-TRAN-2222' });
const legOf = (overrides: Partial<TripStatus['legs'][number]> = {}) => ({
  label: 'Bengaluru to Chennai',
  origin: { name: 'KSR Bengaluru City Junction', code: 'SBC', cityName: 'Bengaluru' },
  destination: { name: 'Chennai Central', code: 'MAS', cityName: 'Chennai' },
  scheduledDeparture: train.departAt,
  scheduledArrival: train.arriveAt,
  estimatedDeparture: null,
  estimatedArrival: null,
  delayMinutes: null,
  state: 'scheduled' as const,
  ...overrides,
});
const shift = (iso: string, minutes: number) => {
  const offset = iso.slice(-6);
  const local = new Date(Date.parse(iso) + minutes * 60_000 + 330 * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${offset}`;
};
const statusOf = (overrides: Partial<TripStatus> = {}): TripStatus =>
  tripStatusSchema.parse({
    reference: trainBooking.reference,
    freshness: 'current',
    explanation: 'Simulated by the demo status provider: not real travel information.',
    source: 'demo',
    providerName: 'Wayora demo status (simulated)',
    simulated: true,
    observedAt: '2026-10-22T09:30:00.000Z',
    checkedAt: '2026-10-22T09:30:00.000Z',
    legs: [
      legOf({
        state: 'delayed',
        estimatedDeparture: shift(train.departAt, 45),
        estimatedArrival: shift(train.arriveAt, 45),
        delayMinutes: 45,
      }),
    ],
    refresh: { available: true, nextAllowedAt: null },
    ...overrides,
  });

function setup(
  options: { status?: TripStatus; refreshed?: TripStatus; eventSource?: boolean } = {},
) {
  if (options.eventSource) {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  }
  const api = installFakeBookingApi({ results: [train, hotel], bookings: [trainBooking] });
  const t = api.trip(trainBooking.reference);
  if (options.status) t.status = options.status;
  if (options.refreshed) t.refreshed = options.refreshed;
  return api;
}

const statusPanel = () => screen.findByRole('region', { name: 'Travel status' });

describe('trip details: travel status', JOURNEY, () => {
  it('a stay has no travel status, says so, and offers no check', async () => {
    const stay = demoBooking(hotel, { reference: 'WYD-STAY-2222' });
    installFakeBookingApi({ results: [hotel], bookings: [stay] });
    renderRoute(`/trips/${stay.reference}`);
    const panel = await statusPanel();
    expect(await within(panel).findByText('Not available for this booking')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('shows a simulated delay with booked and expected times, labelled and never as live tracking', async () => {
    setup({ status: statusOf() });
    renderRoute(`/trips/${trainBooking.reference}`);
    const panel = await statusPanel();
    await within(panel).findByText('Up to date');
    expect(within(panel).getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Delayed')).toBeInTheDocument();
    expect(within(panel).getByText('About 45 min late.')).toBeInTheDocument();
    // Booked 06:00, now expected 06:45 (station time).
    const departs = within(panel)
      .getByText(/Departs Bengaluru/)
      .closest('div')!;
    expect(departs).toHaveTextContent(/06:00 booked; now expected 06:45/);
    expect(panel).toHaveTextContent(/Source: Wayora demo status \(simulated\)/);
    expect(panel).not.toHaveTextContent(/live tracking|gate|terminal|platform|seat|PNR/i);
  });

  it('old information is shown as possibly out of date, never as up to date', async () => {
    setup({
      status: statusOf({
        freshness: 'stale',
        explanation: 'This is the last status the provider reported; it may have changed since.',
      }),
    });
    renderRoute(`/trips/${trainBooking.reference}`);
    const panel = await statusPanel();
    expect(await within(panel).findByText('May be out of date')).toBeInTheDocument();
    expect(within(panel).queryByText('Up to date')).toBeNull();
    expect(panel).toHaveTextContent(/may have changed since/);
  });

  it('"Check now" asks the server and shows the result; the page announces it', async () => {
    const api = setup({
      status: statusOf({
        freshness: 'pending',
        explanation: 'Not checked yet. The times shown are the booked ones.',
        source: null,
        providerName: null,
        simulated: false,
        observedAt: null,
        checkedAt: null,
        legs: [legOf()],
      }),
      refreshed: statusOf({ freshness: 'current' }),
    });
    renderRoute(`/trips/${trainBooking.reference}`);
    const panel = await statusPanel();
    await within(panel).findByText('Not checked yet');
    fireEvent.click(within(panel).getByRole('button', { name: 'Check now' }));
    expect(await within(panel).findByText('Up to date')).toBeInTheDocument();
    expect(api.tripRequests).toContain('POST status/refresh');
    expect(within(panel).getByRole('status')).toHaveTextContent('Travel status: Up to date.');
  });

  it('a status error leaves the booking usable and can be retried', async () => {
    const api = setup({ status: statusOf() });
    api.trip(trainBooking.reference).failing = /^status$/;
    renderRoute(`/trips/${trainBooking.reference}`);
    expect(await screen.findByText('We couldn’t load the travel status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    api.trip(trainBooking.reference).failing = undefined;
    const panel = await statusPanel();
    fireEvent.click(within(panel).getByRole('button', { name: /Try again/ }));
    expect(await within(panel).findByText('Up to date')).toBeInTheDocument();
  });
});

describe('trip details: disruptions and timeline', JOURNEY, () => {
  it('shows what changed, where it came from, and that nothing was changed automatically', async () => {
    const api = setup({ status: statusOf() });
    api.trip(trainBooking.reference).disruptions = [
      tripDisruptionSchema.parse({
        id: '01890000-0000-7000-8000-000000000501',
        type: 'departure_delay',
        severity: 'minor',
        state: 'active',
        source: 'demo',
        simulated: true,
        providerName: 'Wayora demo status (simulated)',
        title: 'Departure delayed by about 45 minutes',
        description: 'Simulated.',
        legLabel: null,
        changes: {
          scheduledDeparture: train.departAt,
          newDeparture: shift(train.departAt, 45),
          scheduledArrival: train.arriveAt,
          newArrival: shift(train.arriveAt, 45),
          delayMinutes: 45,
        },
        firstDetectedAt: '2026-10-22T09:30:00.000Z',
        lastObservedAt: '2026-10-22T09:30:00.000Z',
        resolvedAt: null,
      }),
    ];
    renderRoute(`/trips/${trainBooking.reference}`);
    const region = await screen.findByRole('region', { name: 'Travel disruption' });
    expect(region).toHaveTextContent('Departure delayed by about 45 minutes');
    expect(region).toHaveTextContent('Departure: 06:00 → 06:45 (local time)');
    expect(region).toHaveTextContent(/Reported by Wayora demo status \(simulated\)/);
    expect(region).toHaveTextContent(/nothing is cancelled, rebooked, refunded or compensated/);
    expect(within(region).getByText('Simulated')).toBeInTheDocument();
    expect(within(region).getByText('Minor')).toBeInTheDocument();
  });

  it('lists the timeline oldest first, with simulated entries labelled', async () => {
    const api = setup({ status: statusOf() });
    api.trip(trainBooking.reference).timeline = [
      ['booking_created', 'Booking requested', 'wayora', '2026-10-22T09:00:00.000Z'],
      ['booking_confirmed', 'Demo booking confirmed', 'wayora', '2026-10-22T09:01:00.000Z'],
      [
        'disruption_reported',
        'Departure delayed by about 45 minutes',
        'demo',
        '2026-10-22T09:30:00.000Z',
      ],
    ].map(([type, title, source, at], i) =>
      tripEventSchema.parse({
        id: `01890000-0000-7000-8000-00000000060${i}`,
        type,
        kind: type!.startsWith('booking') ? 'booking' : 'disruption',
        source,
        title,
        description: null,
        occurredAt: at,
        observedAt: source === 'demo' ? at : null,
        amount: null,
        paymentId: null,
      }),
    );
    renderRoute(`/trips/${trainBooking.reference}`);
    const list = await screen.findByRole('list', { name: 'Booking timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.font-semibold')!.textContent)).toEqual([
      'Booking requested',
      'Demo booking confirmed',
      'Departure delayed by about 45 minutes',
    ]);
    expect(within(items[2]!).getByText('Simulated')).toBeInTheDocument();
    expect(within(items[0]!).queryByText('Simulated')).toBeNull();
    expect(items[0]!.querySelector('time')).toHaveAttribute('dateTime', '2026-10-22T09:00:00.000Z');
  });
});

describe('trip details: updates', JOURNEY, () => {
  it('follows the booking’s stream with credentials, re-reads on an announcement, and closes on leave', async () => {
    const api = setup({ status: statusOf(), eventSource: true });
    const { unmount } = renderRoute(`/trips/${trainBooking.reference}`);
    await statusPanel();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toMatch(new RegExp(`/api/v1/bookings/${trainBooking.reference}/events$`));
    expect(source.init).toEqual({ withCredentials: true });
    act(() => source.emit('ready', { live: true }));
    expect(
      await screen.findByText('This page updates automatically when anything changes.'),
    ).toBeInTheDocument();

    const before = api.tripRequests.filter((r) => r === 'GET timeline').length;
    act(() => source.emit('trip-event', { seq: '42', reference: trainBooking.reference }));
    await waitFor(() =>
      expect(api.tripRequests.filter((r) => r === 'GET timeline').length).toBeGreaterThan(before),
    );
    unmount();
    expect(source.closed).toBe(true);
  });

  it('falls back to checking every minute when the stream keeps failing', async () => {
    setup({ status: statusOf(), eventSource: true });
    renderRoute(`/trips/${trainBooking.reference}`);
    await statusPanel();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.onerror?.();
      source.onerror?.();
      source.onerror?.();
    });
    expect(
      await screen.findByText('This page checks for changes every minute while it’s open.'),
    ).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });

  it('without EventSource support it polls; finished bookings don’t follow updates at all', async () => {
    setup({ status: statusOf() });
    vi.stubGlobal('EventSource', undefined);
    const { unmount } = renderRoute(`/trips/${trainBooking.reference}`);
    expect(
      await screen.findByText('This page checks for changes every minute while it’s open.'),
    ).toBeInTheDocument();
    unmount();

    const cancelled = demoBooking(train, { reference: 'WYD-CANC-2222', status: 'cancelled' });
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    installFakeBookingApi({ results: [train], bookings: [cancelled] });
    renderRoute(`/trips/${cancelled.reference}`);
    await statusPanel();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByText(/updates automatically|every minute/)).toBeNull();
  });
});
