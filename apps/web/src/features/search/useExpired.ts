import { useEffect, useState } from 'react';

/** setTimeout's ceiling (about 24.8 days); search sessions are minutes long. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Whether the ISO time `at` (a search's `expiresAt`) has passed. Re-renders
 * once, when it passes. Uses this device's clock, so a skewed clock shifts
 * the moment slightly; the server stays the authority (an expired search
 * answers SEARCH_EXPIRED whatever this says).
 */
export function useExpired(at: string | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return undefined;
    const remaining = Date.parse(at) - Date.now();
    // Also fires (at once) when `at` is already past, so a new value is noticed.
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(remaining + 50, 0), MAX_TIMER_MS),
    );
    return () => clearTimeout(timer);
  }, [at]);
  return at !== undefined && Date.parse(at) <= now;
}
