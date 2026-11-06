import { authKeys } from '../auth/AuthProvider';

/**
 * Promotions (Phase 26). Offer lists depend on who is signed in (personal
 * offers), so they live under `account` and are dropped on sign-out.
 */
export const promotionKeys = {
  offers: (category: string) => [...authKeys.account, 'promotions', 'offers', category] as const,
  pricing: (reference: string) =>
    [...authKeys.account, 'promotions', 'pricing', reference] as const,
};
