import {
  Activity,
  ChartLine,
  BellRing,
  CreditCard,
  FileText,
  Gift,
  LifeBuoy,
  LayoutDashboard,
  Luggage,
  MessageSquareText,
  ScrollText,
  Search,
  Tag,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { AdminPermission } from '@wayora/contracts';

import { ADMIN_PATHS } from './paths';

export interface AdminNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the server grants this permission (the API enforces it regardless). */
  permission: AdminPermission;
  end: boolean;
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    to: ADMIN_PATHS.overview,
    label: 'Overview',
    icon: LayoutDashboard,
    permission: 'admin.overview.read',
    end: true,
  },
  {
    to: ADMIN_PATHS.analytics,
    label: 'Analytics',
    icon: ChartLine,
    permission: 'admin.analytics.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.users,
    label: 'Users',
    icon: Users,
    permission: 'admin.users.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.bookings,
    label: 'Bookings',
    icon: Luggage,
    permission: 'admin.bookings.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.payments,
    label: 'Payments',
    icon: CreditCard,
    permission: 'admin.payments.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.rewards,
    label: 'Rewards',
    icon: Gift,
    permission: 'admin.rewards.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.support,
    label: 'Support',
    icon: LifeBuoy,
    permission: 'admin.support.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.reviews,
    label: 'Reviews',
    icon: MessageSquareText,
    permission: 'admin.reviews.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.content,
    label: 'Content',
    icon: FileText,
    permission: 'admin.content.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.promotions,
    label: 'Promotions',
    icon: Tag,
    permission: 'admin.promotions.read',
    end: false,
  },
  {
    to: ADMIN_PATHS.search,
    label: 'Search activity',
    icon: Search,
    permission: 'admin.search.read',
    end: true,
  },
  {
    to: ADMIN_PATHS.notifications,
    label: 'Notifications',
    icon: BellRing,
    permission: 'admin.notifications.read',
    end: true,
  },
  {
    to: ADMIN_PATHS.audit,
    label: 'Audit log',
    icon: ScrollText,
    permission: 'admin.audit.read',
    end: true,
  },
  {
    to: ADMIN_PATHS.health,
    label: 'Platform health',
    icon: Activity,
    permission: 'admin.health.read',
    end: true,
  },
];
