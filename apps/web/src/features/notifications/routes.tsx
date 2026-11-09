import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { UpdateNotificationPreferences } from '@wayora/contracts';
import { Alert, Button, Checkbox, EmptyState, ErrorState, Skeleton } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  getNotificationPreferences,
  listNotifications,
  updateNotificationPreferences,
} from '../../services/notifications';
import { AccountShell, Panel } from '../account/AccountShell';
import { notificationKeys } from './keys';
import { NotificationItem, useNotificationMutations } from './shared';
import { currentPushSubscription, disablePush, enablePush, pushAvailability } from '../../pwa/push';

/*
 * /notifications (signed in): every notification, paged, and the email
 * preferences (docs/notifications.md#web).
 */

const PAGE_SIZE = 20;

export function NotificationsRoute() {
  useDocumentTitle('Notifications');
  const [params, setParams] = useSearchParams();
  const pageParam = Number(params.get('page') ?? '1');
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 1000 ? pageParam : 1;
  const list = useQuery({
    queryKey: notificationKeys.list(page, PAGE_SIZE),
    queryFn: ({ signal }) => listNotifications({ page, pageSize: PAGE_SIZE }, signal),
    placeholderData: (previous) => previous,
  });
  const { markRead, markAll } = useNotificationMutations();
  const [announcement, setAnnouncement] = useState('');
  const setPage = (next: number) => setParams(next === 1 ? {} : { page: String(next) });
  const unread = list.data?.unreadCount ?? 0;

  return (
    <AccountShell
      title="Notifications"
      description="Updates about your demo bookings and payments. Demo updates never mean a supplier reservation, ticket or real payment exists."
      actions={
        <Button
          variant="secondary"
          disabled={unread === 0 || markAll.isPending}
          loading={markAll.isPending}
          onClick={() =>
            markAll.mutate(undefined, {
              onSuccess: () => setAnnouncement('All notifications marked as read.'),
            })
          }
        >
          Mark all as read
        </Button>
      }
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {list.isPending ? (
        <div role="status" aria-label="Loading notifications" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState
          title="We couldn't load your notifications"
          description="Check your connection, then try again."
          reference={
            list.error instanceof ApiClientError ? (list.error.requestId ?? undefined) : undefined
          }
          action={
            <Button
              variant="secondary"
              onClick={() => void list.refetch()}
              loading={list.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : list.data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            size="page"
            icon={<BellOff />}
            title="No notifications yet"
            description="Updates about your demo bookings and payments will appear here."
          />
        </div>
      ) : (
        <section aria-labelledby="all-notifications" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="all-notifications" className="text-title">
              All notifications
            </h2>
            <p className="text-body-sm text-ink-secondary">
              {unread === 0 ? 'All read.' : `${unread} unread.`}
            </p>
          </div>
          <ul
            aria-label="Notifications"
            className="flex flex-col gap-1 rounded-xl border border-line bg-card p-2 shadow-xs"
          >
            {list.data.items.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  notification={n}
                  marking={markRead.isPending && markRead.variables === n.id}
                  onMarkRead={() =>
                    markRead.mutate(n.id, {
                      onSuccess: () => setAnnouncement(`Marked “${n.title}” as read.`),
                    })
                  }
                />
              </li>
            ))}
          </ul>
          {list.data.pagination.totalPages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <p className="text-body-sm text-ink-secondary" aria-live="polite">
                Page {page} of {list.data.pagination.totalPages}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= list.data.pagination.totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </section>
      )}
      <PushPreferences />
      <EmailPreferences />
    </AccountShell>
  );
}

/** The saved preferences, with each checkbox changing at once and the server's answer replacing it. */
function usePreferenceToggles() {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: ({ signal }) => getNotificationPreferences(signal),
  });
  // The box changes at once (local draft); the server's answer replaces it,
  // and a refusal puts the saved value back.
  const [draft, setDraft] = useState<UpdateNotificationPreferences>({});
  const save = useMutation({
    mutationFn: (body: UpdateNotificationPreferences) => updateNotificationPreferences(body),
    onSuccess: (updated) => queryClient.setQueryData(notificationKeys.preferences, updated),
    onSettled: (_data, _error, body) =>
      setDraft((current) => {
        const next = { ...current };
        for (const key of Object.keys(body) as PreferenceKey[]) delete next[key];
        return next;
      }),
  });
  return {
    prefs,
    value: (key: PreferenceKey) => draft[key] ?? prefs.data?.[key] ?? true,
    set: (key: PreferenceKey, checked: boolean) => {
      const change = { [key]: checked };
      setDraft((current) => ({ ...current, ...change }));
      save.mutate(change);
    },
    saveFailed: save.isError,
  };
}

type PreferenceKey = keyof UpdateNotificationPreferences;
interface PreferenceOption {
  key: PreferenceKey;
  label: string;
  description: string;
}

function PreferenceChoices({
  legend,
  options,
  toggles,
}: {
  legend: string;
  options: PreferenceOption[];
  toggles: ReturnType<typeof usePreferenceToggles>;
}) {
  return (
    <>
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{legend}</legend>
        {options.map((o) => (
          <Checkbox
            key={o.key}
            label={o.label}
            description={o.description}
            checked={toggles.value(o.key)}
            onChange={(e) => toggles.set(o.key, e.target.checked)}
          />
        ))}
      </fieldset>
      {toggles.saveFailed ? (
        <Alert tone="danger" title="We couldn’t save that">
          Check your connection and try again.
        </Alert>
      ) : null}
    </>
  );
}

function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-body-sm text-ink-secondary">We couldn’t load your {what}.</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

const EMAIL_OPTIONS: PreferenceOption[] = [
  {
    key: 'emailBookings',
    label: 'Booking updates',
    description: 'Saved, confirmed, cancelled or expired demo bookings.',
  },
  {
    key: 'emailPayments',
    label: 'Payment updates',
    description: 'Demo payments that succeed, fail or are refunded.',
  },
  { key: 'emailReminders', label: 'Travel reminders', description: 'The day before a trip.' },
];

function EmailPreferences() {
  const toggles = usePreferenceToggles();
  const { prefs } = toggles;
  return (
    <Panel
      title="Email preferences"
      description="In-app notifications are always kept. These choices only decide which emails are sent."
    >
      {prefs.isPending ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : prefs.isError ? (
        <LoadFailed what="email preferences" onRetry={() => void prefs.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {!prefs.data.email.active ? (
            <Alert tone="info" role="none" title="Email isn’t active">
              {prefs.data.email.status}
            </Alert>
          ) : null}
          <PreferenceChoices legend="Email me about" options={EMAIL_OPTIONS} toggles={toggles} />
        </div>
      )}
    </Panel>
  );
}

const PUSH_OPTIONS: PreferenceOption[] = [
  {
    key: 'pushBookings',
    label: 'Booking updates',
    description: 'Bookings saved, confirmed, cancelled or expired, and trip changes.',
  },
  {
    key: 'pushPayments',
    label: 'Payment updates',
    description: 'Payments that succeed, fail or are refunded.',
  },
  { key: 'pushReminders', label: 'Travel reminders', description: 'The day before a trip.' },
  {
    key: 'pushSupport',
    label: 'Support replies',
    description: 'Answers to your support requests.',
  },
  { key: 'pushRewards', label: 'Rewards', description: 'Points and travel credit changes.' },
];

/**
 * Browser push on this device (docs/pwa.md#push). Permission is asked only
 * when "Turn on" is pressed, after saying what will be sent.
 */
function PushPreferences() {
  const toggles = usePreferenceToggles();
  const { prefs } = toggles;
  const [availability] = useState(() => pushAvailability());
  const device = useQuery({
    queryKey: [...notificationKeys.preferences, 'push-device'],
    queryFn: async () => Boolean(await currentPushSubscription()),
    enabled: availability === 'available',
  });
  const [message, setMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: async (on: boolean) => {
      if (!on) {
        await disablePush();
        return 'disabled' as const;
      }
      return enablePush(prefs.data!.push.publicKey!);
    },
    onSuccess: (result) => {
      setMessage(
        result === 'enabled'
          ? 'Push notifications are on for this device.'
          : result === 'disabled'
            ? 'Push notifications are off for this device.'
            : result === 'denied'
              ? 'Notifications are blocked for Wayora in this browser. Allow them in the browser’s site settings, then try again.'
              : result === 'dismissed'
                ? 'Nothing changed: the browser’s question was closed without an answer.'
                : 'This browser can’t receive push notifications.',
      );
      void queryClient.invalidateQueries({
        queryKey: [...notificationKeys.preferences, 'push-device'],
      });
    },
    onError: (error) =>
      setMessage(
        error instanceof ApiClientError
          ? error.message
          : 'We couldn’t turn on push notifications here. Try again.',
      ),
  });

  const on = device.data === true;
  return (
    <Panel
      title="Notifications on this device"
      description="Get booking, payment and trip updates as notifications from your browser or installed app, even when Wayora isn’t open."
    >
      {prefs.isPending ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : prefs.isError ? (
        <LoadFailed what="notification settings" onRetry={() => void prefs.refetch()} />
      ) : !prefs.data.push.active ? (
        <Alert tone="info" role="none" title="Push notifications aren’t active">
          {prefs.data.push.status}
        </Alert>
      ) : availability === 'ios-needs-install' ? (
        <Alert tone="info" role="none" title="Add Wayora to your home screen first">
          On iPhone and iPad, notifications work in the installed app: in Safari, tap Share, then
          Add to Home Screen, and open Wayora from there.
        </Alert>
      ) : availability === 'unsupported' ? (
        <Alert tone="info" role="none" title="Not available in this browser">
          This browser can’t receive push notifications. In-app notifications still work.
        </Alert>
      ) : availability === 'denied' ? (
        <Alert tone="warning" role="none" title="Notifications are blocked">
          Notifications are blocked for Wayora in this browser. Allow them in the browser’s site
          settings to turn them on.
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={on ? 'secondary' : 'primary'}
              loading={change.isPending || device.isPending}
              onClick={() => change.mutate(!on)}
            >
              {on ? 'Turn off on this device' : 'Turn on for this device'}
            </Button>
            <p className="text-body-sm text-ink-secondary">
              {on
                ? 'On for this device. Signing out turns it off.'
                : 'Your browser will ask for permission.'}
            </p>
          </div>
          {message ? (
            <p role="status" className="text-body-sm text-ink">
              {message}
            </p>
          ) : null}
          <PreferenceChoices
            legend="Notify this device about"
            options={PUSH_OPTIONS}
            toggles={toggles}
          />
        </div>
      )}
    </Panel>
  );
}
