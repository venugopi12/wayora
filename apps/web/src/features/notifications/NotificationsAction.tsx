import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  cn,
} from '@wayora/ui';
import { listNotifications } from '../../services/notifications';
import { useAuth } from '../auth/AuthProvider';
import { ACCOUNT_PATHS, type HeaderTone } from '../navigation/config';
import { notificationKeys } from './keys';
import { NotificationItem, badgeCount, useNotificationMutations, useUnreadCount } from './shared';

/*
 * Header notification control (docs/notifications.md#web): a bell with the
 * unread count, opening a panel with the latest notifications. Signed-in
 * only. The count is shown only when the server answered; a failed request
 * shows no badge (never a stale or made-up number).
 */

const PANEL_SIZE = 8;

export function NotificationsAction({ tone }: { tone: HeaderTone }) {
  const { status } = useAuth();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  if (status !== 'authenticated') return null;

  const count = unread.isSuccess ? unread.data : null;
  const label =
    count === null
      ? unread.isError
        ? 'Notifications (unread count unavailable)'
        : 'Notifications'
      : count === 0
        ? 'Notifications, none unread'
        : `Notifications, ${count} unread`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Refresh the count whenever the panel opens.
        if (next) void unread.refetch();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={tone === 'inverse' ? 'ghost-inverse' : 'ghost'}
          size="sm"
          className="relative size-11 px-0"
          aria-label={label}
        >
          <Bell aria-hidden="true" />
          {count !== null && count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute top-1.5 right-1 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-danger px-1 text-[0.6875rem] leading-none font-semibold text-ink-inverse"
            >
              {badgeCount(count)}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Notifications" className="p-0">
        <NotificationsPanel
          onClose={() => setOpen(false)}
          onAnnounce={setAnnouncement}
          unreadCount={count}
        />
      </PopoverContent>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Popover>
  );
}

function NotificationsPanel({
  onClose,
  onAnnounce,
  unreadCount,
}: {
  onClose: () => void;
  onAnnounce: (text: string) => void;
  unreadCount: number | null;
}) {
  const list = useQuery({
    queryKey: notificationKeys.list(1, PANEL_SIZE),
    queryFn: ({ signal }) => listNotifications({ page: 1, pageSize: PANEL_SIZE }, signal),
    // Fresh every time the panel opens.
    staleTime: 0,
    retry: 1,
  });
  const { markRead, markAll } = useNotificationMutations();
  const unread = list.data?.unreadCount ?? unreadCount ?? 0;

  return (
    <div className="flex max-h-[min(36rem,calc(100dvh-6rem))] flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-title">Notifications</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={unread === 0 || markAll.isPending}
          loading={markAll.isPending}
          onClick={() =>
            markAll.mutate(undefined, {
              onSuccess: () => onAnnounce('All notifications marked as read.'),
            })
          }
        >
          Mark all as read
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.isPending ? (
          <div role="status" aria-label="Loading notifications" className="flex flex-col gap-2 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
            <p className="text-body-sm text-ink-secondary">We couldn’t load your notifications.</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void list.refetch()}
              loading={list.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : list.data.items.length === 0 ? (
          <EmptyState
            icon={<BellOff />}
            title="No notifications yet"
            description="Updates about your demo bookings and payments will appear here."
          />
        ) : (
          <ul aria-label="Latest notifications" className="flex flex-col gap-1">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  notification={n}
                  onOpen={onClose}
                  marking={markRead.isPending && markRead.variables === n.id}
                  onMarkRead={() =>
                    markRead.mutate(n.id, {
                      onSuccess: () => onAnnounce(`Marked “${n.title}” as read.`),
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={cn('border-t border-line px-4 py-3')}>
        <Link
          to={ACCOUNT_PATHS.notifications}
          onClick={onClose}
          className="text-body-sm font-semibold text-brand-ink underline"
        >
          See all notifications and email settings
        </Link>
      </div>
    </div>
  );
}
