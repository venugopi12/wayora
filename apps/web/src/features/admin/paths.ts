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
  /** Promotions (Phase 26). */
  promotions: '/admin/promotions',
  promotionNew: '/admin/promotions/new',
  promotion: (id: string) => `/admin/promotions/${encodeURIComponent(id)}`,
  /** Support workspace (Phase 27). */
  support: '/admin/support',
  supportQueue: '/admin/support/tickets',
  supportTicket: (reference: string) => `/admin/support/tickets/${encodeURIComponent(reference)}`,
} as const;
