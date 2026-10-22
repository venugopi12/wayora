import {
  findPlace,
  fromMinorUnits,
  type Money,
  type ResultPoint,
  type SearchPrice,
} from '@wayora/contracts';

/*
 * Helpers shared by the demo (fixture) adapters. Everything is deterministic:
 * the same request always produces the same results, so tests and screenshots
 * are reproducible. Nothing here is random and nothing reads the network.
 */

// 2026-10-22.1: flight and cab offers carry the party they are priced for (Phase 12).
export const DEMO_VERSION = '2026-10-22.1';
/** Demo answers are instant; the limit still applies so the plumbing is exercised. */
export const DEMO_TIMEOUT_MS = 2_000;
/** How long a demo price is labelled indicative. */
const VALID_FOR_MS = 20 * 60 * 1000;

export const IST_OFFSET = 330;

/** Whole rupees → Money in paise (exact, no floats). */
export function inr(rupees: bigint | number): Money {
  return fromMinorUnits(BigInt(rupees) * 100n, 'INR');
}

/** Rounds a rupee amount computed as `base × numerator / denominator` to whole rupees. */
export function scaleRupees(base: number, numerator: number, denominator: number): bigint {
  const n = BigInt(base) * BigInt(numerator);
  const d = BigInt(denominator);
  return (n + d / 2n) / d;
}

export function totalPrice(
  totalRupees: bigint,
  perUnit: { rupees: bigint; unit: 'traveller' | 'adult' | 'night' | 'passenger' } | null,
): SearchPrice {
  return {
    kind: 'total',
    total: inr(totalRupees),
    perUnit: perUnit ? { amount: inr(perUnit.rupees), unit: perUnit.unit } : null,
  };
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Local date-time with offset: `date` (YYYY-MM-DD) plus `minutes` after local
 * midnight (may exceed a day), in a zone `offsetMinutes` from UTC.
 * zoned('2026-11-12', 23 * 60 + 30 + 120, 330) → '2026-11-13T01:30:00+05:30'
 */
export function zoned(date: string, minutes: number, offsetMinutes = IST_OFFSET): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const localAsUtc = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  return `${localAsUtc.toISOString().slice(0, 19)}${formatOffset(offsetMinutes)}`;
}

/** "HH:MM" → minutes after midnight. */
export function hm(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function validUntil(now: Date): string {
  return new Date(now.getTime() + VALID_FOR_MS).toISOString();
}

/** A result end-point from the place directory. */
export function point(placeId: string): ResultPoint {
  const place = findPlace(placeId);
  if (!place) throw new Error(`Demo fixture refers to unknown place ${placeId}`);
  return { placeId: place.id, code: place.code, name: place.name, cityName: place.cityName };
}

/** A named point that isn't in the directory (a bus boarding point, a hotel area). */
export function namedPoint(name: string, cityName: string): ResultPoint {
  return { placeId: null, code: null, name, cityName };
}

/** Days of the week a service runs; `daily` for every day. */
export type RunsOn = 'daily' | readonly number[];

export function runsOn(days: RunsOn, date: string): boolean {
  return days === 'daily' || days.includes(weekday(date));
}
