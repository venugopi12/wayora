import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { planEventsUrl } from '../../services/planner';
import { notificationKeys } from '../notifications/keys';
import { plannerKeys } from './keys';

/*
 * Live updates for a shared plan (docs/planner.md#live-updates).
 *
 * Follows the plan's Server-Sent Events stream. Announcements carry only the
 * plan's new revision; on one newer than what is shown, the plan (and its
 * members, history and suggestions) are re-read through the normal,
 * authorized endpoints. A repeated or older announcement is ignored. After a
 * reconnect everything is re-read once, so nothing missed is lost.
 *
 * If the stream can't be used (no EventSource, or it keeps failing), the
 * plan is re-read every 30 seconds while the page is visible. Everything is
 * closed and cleared when the page unmounts or the plan changes.
 */

export type PlanLiveMode = 'connecting' | 'live' | 'polling' | 'off';

/** Polling fallback interval (only while the page is visible). */
export const PLAN_POLL_MS = 30_000;

export function usePlanLiveUpdates(
  tripId: string,
  revision: number,
  enabled: boolean,
): PlanLiveMode {
  const queryClient = useQueryClient();
  const supported = typeof EventSource !== 'undefined';
  const [stream, setStream] = useState<{
    tripId: string;
    state: 'connecting' | 'live' | 'failed' | 'ended';
  }>({ tripId, state: 'connecting' });
  const state = stream.tripId === tripId ? stream.state : 'connecting';
  const mode: PlanLiveMode = !enabled
    ? 'off'
    : !supported || state === 'failed'
      ? 'polling'
      : state === 'ended'
        ? 'off'
        : state;

  // The newest revision this page knows (updated by every read and write).
  const known = useRef(revision);
  useEffect(() => {
    known.current = Math.max(known.current, revision);
  }, [revision]);

  useEffect(() => {
    if (!enabled || !supported) return;
    const refreshAll = () => {
      void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.members(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.activity(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.suggestions(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.budget(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.expenses(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.balances(tripId) });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    };
    const source = new EventSource(planEventsUrl(tripId), { withCredentials: true });
    let failures = 0;
    let readyBefore = false;
    source.addEventListener('ready', () => {
      if (readyBefore) refreshAll();
      readyBefore = true;
      failures = 0;
      setStream({ tripId, state: 'live' });
    });
    source.addEventListener('plan-changed', (event) => {
      const next = (() => {
        try {
          return Number(
            (JSON.parse((event as MessageEvent<string>).data) as { revision?: unknown }).revision,
          );
        } catch {
          return NaN;
        }
      })();
      // Duplicates and our own already-applied changes need no re-read.
      if (Number.isFinite(next) && next <= known.current) return;
      if (Number.isFinite(next)) known.current = next;
      refreshAll();
    });
    source.addEventListener('end', (event) => {
      const reason = (() => {
        try {
          return (JSON.parse((event as MessageEvent<string>).data) as { reason?: string }).reason;
        } catch {
          return undefined;
        }
      })();
      if (reason === 'signed-out' || reason === 'access-ended') {
        source.close();
        setStream({ tripId, state: 'ended' });
        // Re-reading answers 401 (signs this tab out) or 404 (no longer a member).
        refreshAll();
      }
    });
    source.onerror = () => {
      failures += 1;
      if (source.readyState === EventSource.CLOSED || failures >= 3) {
        source.close();
        setStream({ tripId, state: 'failed' });
      }
    };
    return () => source.close();
  }, [enabled, supported, queryClient, tripId]);

  useEffect(() => {
    if (mode !== 'polling') return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.members(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.budget(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.expenses(tripId) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.balances(tripId) });
    }, PLAN_POLL_MS);
    return () => clearInterval(timer);
  }, [mode, queryClient, tripId]);

  return mode;
}
