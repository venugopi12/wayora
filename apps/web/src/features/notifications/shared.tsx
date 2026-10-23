import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, Luggage, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import type { Notification, NotificationCategory } from '@wayora/contracts';
import { Badge, Button, cn } from '@wayora/ui';
import {
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../services/notifications';
import { useAuth } from '../auth/AuthProvider';
import { paymentPath, tripPath } from '../bookings/paths';
import { notificationKeys } from './keys';

/*
 * Notification building blocks shared by the header panel and the
 * /notifications page (docs/notifications.md#web). Text is rendered as plain
 * React text (escaped), never as HTML.
 */

/** Unread count: on start, every minute while the tab is visible, and on focus. */
export function useUnreadCount() {
  const { status } = useAuth();
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) => getUnreadCount(signal),
    enabled: status === 'authenticated',
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Paused while the tab is hidden (the TanStack default).
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

/** Mark one / all as read; the count and lists refresh from the server afterwards. */
export function useNotificationMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSettled: refresh,
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSettled: refresh,
  });
  return { markRead, markAll };
}

/** "99+" above 99. */
export const badgeCount = (count: number) => (count > 99 ? '99+' : String(count));

export function linkFor(notification: Notification): { to: string; label: string } | null {
  const link = notification.link;
  if (!link) return null;
  return link.kind === 'payment'
    ? { to: paymentPath(link.bookingReference, link.paymentId), label: 'View payment' }
    : { to: tripPath(link.bookingReference), label: 'View booking' };
}

const ICON: Record<NotificationCategory, typeof Luggage> = {
  booking: Luggage,
  payment: Wallet,
  reminder: BellRing,
};

const relative = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "just now", "5 minutes ago", "yesterday", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return absolute.format(new Date(iso));
}

export function NotificationItem({
  notification,
  onOpen,
  onMarkRead,
  marking,
}: {
  notification: Notification;
  /** Called when its link is followed (the panel closes; it is marked read). */
  onOpen?: () => void;
  onMarkRead: () => void;
  marking: boolean;
}) {
  const Icon = ICON[notification.category];
  const link = linkFor(notification);
  const titleId = `notification-${notification.id}`;
  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex gap-3 rounded-lg px-3 py-3',
        notification.read ? 'bg-transparent' : 'bg-brand-soft/60',
      )}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-card text-brand-ink shadow-xs [&_svg]:size-4"
      >
        <Icon strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {!notification.read ? (
            <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
          ) : null}
          <h3
            id={titleId}
            className={cn('text-body-sm', notification.read ? 'font-medium' : 'font-semibold')}
          >
            {notification.title}
            {!notification.read ? <span className="sr-only"> (unread)</span> : null}
          </h3>
          {notification.demo ? (
            <Badge size="sm" tone="warning">
              Demo
            </Badge>
          ) : null}
        </div>
        <p className="text-body-sm text-ink-secondary">{notification.message}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <time dateTime={notification.createdAt} className="text-caption text-ink-secondary">
            {timeAgo(notification.createdAt)}
          </time>
          {link ? (
            <Link
              to={link.to}
              aria-label={`${link.label}: ${notification.title}`}
              onClick={() => {
                if (!notification.read) onMarkRead();
                onOpen?.();
              }}
              className="text-caption font-semibold text-brand-ink underline"
            >
              {link.label}
            </Link>
          ) : null}
          {!notification.read ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-1.5 py-0.5 text-caption"
              onClick={onMarkRead}
              disabled={marking}
              aria-label={`Mark as read: ${notification.title}`}
            >
              <Check aria-hidden="true" />
              Mark as read
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
