import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORIES,
  EMPTY_PLANNER_PREFERENCES,
  createPlannedTripSchema,
  hasUnsafeTextCharacters,
  suggestionIdSchema,
  updatePlannedTripSchema,
} from '@wayora/contracts';
import {
  PLANNER_CATALOG,
  catalogActivity,
  catalogDestination,
} from '../src/modules/planner/catalog.js';
import { datesBetween, dateOnly, toDbDate } from '../src/modules/planner/presenter.js';
import { suggest, type PlannedSummary } from '../src/modules/planner/recommend.js';
import {
  formatDuration,
  formatMinute,
  parseLocalTime,
  scheduleWarnings,
  type ScheduleItem,
} from '../src/modules/planner/schedule.js';

/* Pure planner logic (docs/planner.md): dates, schedule warnings, the curated catalog and the suggestion rules. */

const NOTHING_PLANNED: PlannedSummary = {
  suggestionIds: new Set(),
  titles: new Set(),
  categories: new Set(),
  count: 0,
};

const item = (over: Partial<ScheduleItem> & { id: string }): ScheduleItem => ({
  day: '2026-11-12',
  position: 0,
  title: over.id,
  startMinute: null,
  durationMinutes: null,
  ...over,
});
const TRIP = { startDate: '2026-11-12', endDate: '2026-11-14' };

describe('date-only handling', () => {
  it('never shifts calendar dates, whatever the process time zone', () => {
    const before = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
        process.env.TZ = tz;
        expect(dateOnly(toDbDate('2026-12-31'))).toBe('2026-12-31');
        expect(datesBetween('2026-12-30', '2027-01-02')).toEqual([
          '2026-12-30',
          '2026-12-31',
          '2027-01-01',
          '2027-01-02',
        ]);
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it('handles leap days and month ends', () => {
    expect(datesBetween('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
    expect(datesBetween('2026-11-12', '2026-11-12')).toEqual(['2026-11-12']);
  });

  it('validates trip date ranges in the contract', () => {
    const base = {
      title: 'T',
      destinationId: 'goa',
      startDate: '2026-11-12',
      endDate: '2026-11-12',
    };
    expect(createPlannedTripSchema.safeParse(base).success).toBe(true);
    expect(createPlannedTripSchema.safeParse({ ...base, endDate: '2026-11-11' }).success).toBe(
      false,
    );
    expect(createPlannedTripSchema.safeParse({ ...base, endDate: '2026-12-11' }).success).toBe(
      true,
    ); // 30 days
    expect(createPlannedTripSchema.safeParse({ ...base, endDate: '2026-12-12' }).success).toBe(
      false,
    ); // 31
    expect(createPlannedTripSchema.safeParse({ ...base, startDate: '2027-02-29' }).success).toBe(
      false,
    );
    expect(updatePlannedTripSchema.safeParse({ version: 1, startDate: '2026-11-12' }).success).toBe(
      false,
    );
  });
});

describe('text safety', () => {
  it('refuses control characters and bidirectional overrides, keeps newlines in notes', () => {
    expect(hasUnsafeTextCharacters('Café ☕ near the fort')).toBe(false);
    expect(hasUnsafeTextCharacters('a\u0000b')).toBe(true);
    expect(hasUnsafeTextCharacters('abc‮gpj.exe')).toBe(true);
    expect(hasUnsafeTextCharacters('line\nline')).toBe(true);
    expect(hasUnsafeTextCharacters('line\nline\ttab', true)).toBe(false);
    expect(hasUnsafeTextCharacters('a⁦b', true)).toBe(true);
  });
});

describe('time helpers', () => {
  it('formats and parses local wall-clock times', () => {
    expect(formatMinute(0)).toBe('00:00');
    expect(formatMinute(9 * 60 + 5)).toBe('09:05');
    expect(formatMinute(24 * 60 + 30)).toBe('00:30');
    expect(parseLocalTime('23:59')).toBe(1439);
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(135)).toBe('2 h 15 min');
  });
});

describe('schedule warnings', () => {
  it('is empty for an untimed or well-ordered day', () => {
    expect(scheduleWarnings([], TRIP)).toEqual([]);
    expect(scheduleWarnings([item({ id: 'a' }), item({ id: 'b', position: 1 })], TRIP)).toEqual([]);
    expect(
      scheduleWarnings(
        [
          item({ id: 'a', startMinute: 540, durationMinutes: 60 }),
          item({ id: 'b', position: 1, startMinute: 600, durationMinutes: 60 }),
        ],
        TRIP,
      ),
    ).toEqual([]); // back to back is not an overlap
  });

  it('flags overlaps only where times and durations show one', () => {
    const w = scheduleWarnings(
      [
        item({ id: 'a', startMinute: 540, durationMinutes: 120 }),
        item({ id: 'b', position: 1, startMinute: 600 }), // no duration, starts inside a
        item({ id: 'c', position: 2, startMinute: 900 }),
        item({ id: 'd', position: 3, startMinute: 900 }), // same start as c
      ],
      TRIP,
    );
    expect(w.map((x) => [x.code, x.itemIds])).toEqual([
      ['overlap', ['a', 'b']],
      ['overlap', ['c', 'd']],
    ]);
    expect(w[1]!.message).toContain('start at the same time (15:00)');
  });

  it('flags untimed activities only when the day also has timed ones', () => {
    const w = scheduleWarnings(
      [
        item({ id: 'a', startMinute: 540 }),
        item({ id: 'b', position: 1 }),
        item({ id: 'c', position: 2 }),
      ],
      TRIP,
    );
    expect(w).toEqual([
      expect.objectContaining({ code: 'missing_start_time', itemIds: ['b', 'c'] }),
    ]);
    expect(w[0]!.message).toContain('2 activities have no start time');
  });

  it('flags out-of-order times, past-midnight endings and long days', () => {
    const w = scheduleWarnings(
      [
        item({ id: 'late', startMinute: 1380, durationMinutes: 90 }),
        item({ id: 'early', position: 1, startMinute: 420, durationMinutes: 700 }),
      ],
      TRIP,
    );
    expect(w.map((x) => x.code)).toEqual(['out_of_order', 'ends_next_day', 'long_day']);
    expect(w[0]!.itemIds).toEqual(['early']);
    expect(w[1]!.itemIds).toEqual(['late']);
    expect(w[2]!.message).toBe(
      'Activities on this day add up to 13 h 10 min, before any travel between them.',
    );
  });

  it('reports activities outside the trip dates, and only that for those days', () => {
    const w = scheduleWarnings(
      [
        item({ id: 'x', day: '2026-11-20', startMinute: 600 }),
        item({ id: 'y', day: '2026-11-20', position: 1 }),
      ],
      TRIP,
    );
    expect(w).toEqual([
      {
        code: 'outside_trip_dates',
        day: '2026-11-20',
        itemIds: ['x', 'y'],
        message:
          '2 activities are on a day outside the trip dates. Move them to a trip day or delete them.',
      },
    ]);
  });

  it('never mentions travel time or distance', () => {
    const w = scheduleWarnings(
      [
        item({ id: 'a', startMinute: 540, durationMinutes: 60 }),
        item({ id: 'b', position: 1, startMinute: 600, durationMinutes: 60 }),
      ],
      TRIP,
    );
    expect(w.map((x) => x.message).join(' ')).not.toMatch(/travel time|km|reach|drive/i);
  });
});

describe('curated catalog', () => {
  it('covers the twelve discover destinations with unique, valid ids and no live-data fields', () => {
    expect(PLANNER_CATALOG.map((d) => d.id)).toEqual([
      'goa',
      'jaipur',
      'kerala',
      'manali',
      'bengaluru',
      'hyderabad',
      'mumbai',
      'delhi',
      'bali',
      'kyoto',
      'singapore',
      'dubai',
    ]);
    const ids = PLANNER_CATALOG.flatMap((d) => d.activities.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of PLANNER_CATALOG) {
      expect(d.activities.length).toBeGreaterThanOrEqual(7);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: d.timeZone })).not.toThrow();
      for (const a of d.activities) {
        expect(suggestionIdSchema.safeParse(a.id).success, a.id).toBe(true);
        expect(a.id.startsWith(`${d.id}:`)).toBe(true);
        expect(ACTIVITY_CATEGORIES).toContain(a.category);
        expect(a.typicalMinutes).toBeGreaterThanOrEqual(15);
        expect(a.typicalMinutes).toBeLessThanOrEqual(720);
        expect(a.groups.length).toBeGreaterThan(0);
        expect(a.summary).not.toMatch(
          /₹|\$|AED|SGD|open(s|ing)? (daily|from|at)|\d{1,2}(:\d\d)? ?(am|pm)|rated|stars?\b/i,
        );
        expect(Object.keys(a)).not.toEqual(expect.arrayContaining(['price', 'rating', 'hours']));
      }
    }
    expect(catalogDestination('goa')?.name).toBe('Goa');
    expect(catalogDestination(null)).toBeNull();
    expect(catalogActivity('goa:fort-aguada')?.title).toBe('Fort Aguada');
    expect(catalogActivity('goa:nope')).toBeNull();
  });
});

describe('suggestion rules', () => {
  const goa = catalogDestination('goa');

  it('is unavailable without curated data, with capacity still reported', () => {
    expect(
      suggest({
        destination: null,
        dayCount: 4,
        preferences: EMPTY_PLANNER_PREFERENCES,
        planned: NOTHING_PLANNED,
      }),
    ).toEqual({
      available: false,
      source: 'curated-sample',
      method: 'rules',
      capacity: { days: 4, perDay: 3, planned: 0 },
      suggestions: [],
    });
  });

  it('keeps catalog order with a default reason when no preferences are set', () => {
    const r = suggest({
      destination: goa,
      dayCount: 3,
      preferences: EMPTY_PLANNER_PREFERENCES,
      planned: NOTHING_PLANNED,
    });
    expect(r.suggestions.map((s) => s.id)).toEqual(goa!.activities.map((a) => a.id));
    expect(new Set(r.suggestions.flatMap((s) => s.reasons))).toEqual(
      new Set(['A sample highlight of Goa']),
    );
  });

  it('ranks by interests, budget, group and pace — and explains each point', () => {
    const r = suggest({
      destination: goa,
      dayCount: 2,
      preferences: { pace: 'packed', budget: 'premium', group: null, interests: ['adventure'] },
      planned: NOTHING_PLANNED,
    });
    expect(r.capacity.perDay).toBe(4);
    expect(r.suggestions[0]).toMatchObject({
      id: 'goa:dudhsagar-falls',
      reasons: ['Matches your interest in adventure', 'An active pick for a packed schedule'],
    });
  });

  it('penalises clashes and never repeats planned activities', () => {
    const r = suggest({
      destination: catalogDestination('bali'),
      dayCount: 5,
      preferences: { pace: 'relaxed', budget: 'shoestring', group: 'family', interests: [] },
      planned: {
        suggestionIds: new Set(['bali:seminyak-beach']),
        titles: new Set(['ubud monkey forest']),
        categories: new Set(['beach']),
        count: 2,
      },
    });
    const ids = r.suggestions.map((s) => s.id);
    expect(ids).not.toContain('bali:seminyak-beach');
    expect(ids).not.toContain('bali:monkey-forest');
    expect(ids).not.toContain('bali:mount-batur'); // not tagged for families
    const top = r.suggestions[0]!;
    expect(top.id).toBe('bali:tegallalang');
    expect(top.reasons).toContain('Usually free or low cost — fits a shoestring budget');
    expect(top.reasons).toContain('Suits family trips');
    expect(top.reasons.some((x) => x.startsWith('Adds variety'))).toBe(true);
  });

  it('filters by category', () => {
    const r = suggest({
      destination: goa,
      dayCount: 2,
      preferences: EMPTY_PLANNER_PREFERENCES,
      planned: NOTHING_PLANNED,
      category: 'food',
    });
    expect(r.suggestions.map((s) => s.id)).toEqual(['goa:goan-seafood']);
  });
});
