import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { notificationKeys } from '../notifications/keys';

/*
 * Live updates for one support ticket (docs/support.md#live-updates).
 *
 * Follows the ticket's Server-Sent Events stream (customer streams hear only
 * customer-visible changes; staff streams everything). An announcement only
 * says "sequence N": anything newer than what is shown is re-read through the
 * normal, authorized endpoints. If the stream can't be used, the ticket is
 * re-read every 30 seconds while the page is visible. Nothing is simulated:
 * without either, the page shows what it last read.
 */

export type TicketLiveMode = 'connecting' | 'live' | 'polling' | 'off';
export const TICKET_POLL_MS = 30_000;

export function useTicketLiveUpdates(
  url: string,
  revision: number,
  enabled: boolean,
  keys: readonly QueryKey[],
): TicketLiveMode {
  const queryClient = useQueryClient();
  const supported = typeof EventSource !== 'undefined';
  const [state, setState] = useState<{
    url: string;
    s: 'connecting' | 'live' | 'failed' | 'ended';
  }>({
    url,
    s: 'connecting',
  });
  const s = state.url === url ? state.s : 'connecting';
  const mode: TicketLiveMode = !enabled
    ? 'off'
    : !supported || s === 'failed'
      ? 'polling'
      : s === 'ended'
        ? 'off'
        : s;
  const known = useRef(revision);
  useEffect(() => {
    known.current = Math.max(known.current, revision);
  }, [revision]);
  const keysRef = useRef(keys);
  useEffect(() => {
    keysRef.current = keys;
  }, [keys]);

  useEffect(() => {
    if (!enabled || !supported) return;
    const refresh = () => {
      for (const key of keysRef.current) void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    };
    const source = new EventSource(url, { withCredentials: true });
    let failures = 0;
    let readyBefore = false;
    source.addEventListener('ready', () => {
      if (readyBefore) refresh();
      readyBefore = true;
      failures = 0;
      setState({ url, s: 'live' });
    });
    source.addEventListener('ticket-changed', (event) => {
      let next = NaN;
      try {
        next = Number((JSON.parse((event as MessageEvent<string>).data) as { seq?: unknown }).seq);
      } catch {
        // Malformed: re-read anyway.
      }
      if (Number.isFinite(next) && next <= known.current) return;
      if (Number.isFinite(next)) known.current = next;
      refresh();
    });
    source.addEventListener('end', () => {
      source.close();
      setState({ url, s: 'ended' });
      refresh();
    });
    source.onerror = () => {
      failures += 1;
      if (source.readyState === EventSource.CLOSED || failures >= 3) {
        source.close();
        setState({ url, s: 'failed' });
      }
    };
    return () => source.close();
  }, [enabled, supported, queryClient, url]);

  useEffect(() => {
    if (mode !== 'polling') return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const key of keysRef.current) void queryClient.invalidateQueries({ queryKey: key });
    }, TICKET_POLL_MS);
    return () => clearInterval(timer);
  }, [mode, queryClient]);

  return mode;
}
