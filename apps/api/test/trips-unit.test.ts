import { describe, expect, it } from 'vitest';
import { tripEventKind, TRIP_EVENT_TYPES } from '@wayora/contracts';
import {
  DemoTravelStatusProvider,
  demoScenarioFor,
  type DemoScenario,
} from '../src/modules/trips/providers/demo.js';
import { providerReportSchema, type ScheduledLeg } from '../src/modules/trips/providers/types.js';
import { presentEvent } from '../src/modules/trips/presenter.js';
import { LocalTripEventHub } from '../src/modules/trips/stream.js';

const leg = (index: number, departAt: string, arriveAt: string): ScheduledLeg => ({
  index,
  label: index === 0 ? 'Outbound' : 'Return',
  origin: { name: 'Kempegowda', code: 'BLR', cityName: 'Bengaluru' },
  destination: { name: 'Indira Gandhi', code: 'DEL', cityName: 'Delhi' },
  departAt,
  arriveAt,
  serviceRef: 'XX101',
});

const run = (scenario: DemoScenario, now: string, legs: ScheduledLeg[]) =>
  new DemoTravelStatusProvider({
    now: () => new Date(now),
    scenarioFor: () => scenario,
  }).fetchStatus(
    { reference: 'WYD-TEST-0001', serviceType: 'flights', legs },
    new AbortController().signal,
  );

const outbound = leg(0, '2026-11-10T06:00:00+05:30', '2026-11-10T08:45:00+05:30');

describe('demo travel-status provider', () => {
  it('chooses a scenario deterministically from the reference, mostly on time', () => {
    expect(demoScenarioFor('WYD-AAAA-AAAA')).toBe(demoScenarioFor('WYD-AAAA-AAAA'));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i += 1) {
      const s = demoScenarioFor(`WYD-${i}`);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    expect(counts.on_time).toBeGreaterThan(500);
    expect(Object.keys(counts).sort()).toEqual([
      'cancelled',
      'delayed',
      'on_time',
      'schedule_change',
    ]);
  });

  it('answers in the normalized shape, which validates', async () => {
    for (const s of ['on_time', 'delayed', 'schedule_change', 'cancelled'] as const) {
      const report = await run(s, '2026-11-09T12:00:00Z', [outbound]);
      expect(providerReportSchema.safeParse(report).success, s).toBe(true);
    }
  });

  it('follows the clock: delayed, then departed, then arrived and the delay is over', async () => {
    const before = await run('delayed', '2026-11-10T00:00:00Z', [outbound]);
    expect(before.legs[0]).toMatchObject({ state: 'delayed', delayMinutes: 45 });
    expect(before.disruptions[0]).toMatchObject({ type: 'departure_delay', state: 'active' });
    const during = await run('delayed', '2026-11-10T01:30:00Z', [outbound]);
    expect(during.legs[0]!.state).toBe('departed');
    const after = await run('delayed', '2026-11-10T05:00:00Z', [outbound]);
    expect(after.legs[0]!.state).toBe('arrived');
    expect(after.disruptions[0]!.state).toBe('resolved');
  });

  it('disrupts only the first leg; later legs run as booked', async () => {
    const back = leg(1, '2026-11-14T18:00:00+05:30', '2026-11-14T20:45:00+05:30');
    const r = await run('cancelled', '2026-11-09T12:00:00Z', [outbound, back]);
    expect(r.legs.map((l) => l.state)).toEqual(['cancelled', 'scheduled']);
    expect(r.disruptions).toHaveLength(1);
    expect(r.disruptions[0]).toMatchObject({
      type: 'cancellation',
      severity: 'severe',
      legIndex: 0,
    });
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new DemoTravelStatusProvider().fetchStatus(
        { reference: 'WYD-X', serviceType: 'flights', legs: [outbound] },
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });
});

describe('provider answers are validated before use', () => {
  it('rejects unusable shapes and out-of-range values', () => {
    for (const bad of [
      {},
      { observedAt: 'yesterday', legs: [], disruptions: [] },
      {
        observedAt: '2026-11-09T12:00:00Z',
        legs: [{ index: 0, state: 'teleported' }],
        disruptions: [],
      },
      {
        observedAt: '2026-11-09T12:00:00Z',
        legs: [{ index: 0, state: 'delayed', delayMinutes: 99_999 }],
        disruptions: [],
      },
      {
        observedAt: '2026-11-09T12:00:00Z',
        legs: [],
        disruptions: [{ key: '', type: 'departure_delay', severity: 'minor', state: 'active' }],
      },
    ]) {
      expect(providerReportSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('timeline wording', () => {
  const at = new Date('2026-11-09T12:00:00Z');
  const booking = { serviceType: 'flights' as const, demo: true };

  it('labels simulated provider information and never repeats provider text', () => {
    const e = presentEvent(
      {
        id: '01890000-0000-7000-8000-000000000001',
        type: 'DISRUPTION_REPORTED',
        source: 'DEMO_PROVIDER',
        occurredAt: at,
        observedAt: at,
        data: { disruptionType: 'departure_delay', delayMinutes: 45, providerText: 'GATE 22 <b>' },
      },
      booking,
    );
    expect(e).toMatchObject({
      source: 'demo',
      kind: 'disruption',
      title: 'Departure delayed by about 45 minutes',
    });
    expect(e.description).toMatch(/Simulated/);
    expect(JSON.stringify(e)).not.toMatch(/GATE|<b>/);
  });

  it('has wording and a kind for every entry type', () => {
    for (const type of TRIP_EVENT_TYPES) {
      const e = presentEvent(
        {
          id: '01890000-0000-7000-8000-000000000002',
          type: type.toUpperCase(),
          source: 'WAYORA',
          occurredAt: at,
          observedAt: null,
          data: {},
        },
        booking,
      );
      expect(e.title.length, type).toBeGreaterThan(0);
      expect(e.kind).toBe(tripEventKind(type));
    }
  });
});

describe('live-update fan-out', () => {
  it('delivers to the booking’s subscribers only, and ends streams on close', async () => {
    const hub = new LocalTripEventHub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = hub.subscribe('booking-a', (s) => a.push(s));
    hub.subscribe('booking-b', (s) => b.push(s));
    hub.deliver('booking-a', '7');
    expect(a).toEqual([{ seq: '7' }]);
    expect(b).toEqual([]);
    offA();
    hub.deliver('booking-a', '8');
    expect(a).toHaveLength(1);
    expect(hub.subscriberCount).toBe(1);
    await hub.close();
    expect(b).toEqual([{ closing: true }]);
    expect(hub.subscriberCount).toBe(0);
  });
});
