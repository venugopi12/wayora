/** Admin dashboard paths (kept icon-free: the site header imports this). */
export const ADMIN_BASE = '/admin';

export const ADMIN_PATHS = {
  overview: '/admin',
  users: '/admin/users',
  user: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
  bookings: '/admin/bookings',
  booking: (reference: string) => `/admin/bookings/${encodeURIComponent(reference)}`,
  payments: '/admin/payments',
  payment: (id: string) => `/admin/payments/${encodeURIComponent(id)}`,
  search: '/admin/search',
  notifications: '/admin/notifications',
  audit: '/admin/audit',
  health: '/admin/health',
  /** Loyalty (Phase 25). */
  rewards: '/admin/rewards',
  rewardsRules: '/admin/rewards/rules',
  rewardsUser: (id: string) => `/admin/rewards/users/${encodeURIComponent(id)}`,
} as const;
