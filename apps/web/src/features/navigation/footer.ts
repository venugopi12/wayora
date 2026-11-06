import type { LucideIcon } from 'lucide-react';
import { DISCOVER, INFO_PATHS, serviceBySlug, type AppPath } from './config';

/**
 * Footer navigation: the single source of truth for the footer's link groups
 * (desktop columns and mobile accordions render from the same data).
 *
 * Every `to` is a routed page (or an anchor on one). Add a link only when its
 * page exists; never invent contact details, addresses or social URLs.
 */

export type FooterHref = AppPath | `${AppPath}#${string}`;

export interface FooterLink {
  label: string;
  to: FooterHref;
}

export interface FooterGroup {
  id: string;
  title: string;
  links: readonly FooterLink[];
}

const service = (slug: keyof typeof serviceBySlug): FooterLink => ({
  label: serviceBySlug[slug].name,
  to: serviceBySlug[slug].path,
});

export const FOOTER_GROUPS: readonly FooterGroup[] = [
  {
    id: 'explore',
    title: 'Explore',
    links: [
      { label: 'Discover destinations', to: DISCOVER.path },
      service('flights'),
      service('hotels'),
      service('trains'),
      service('buses'),
    ],
  },
  {
    id: 'more-travel',
    title: 'More travel',
    links: [
      service('metro'),
      service('cabs'),
      service('holidays'),
      { label: 'Travel inspiration', to: `${DISCOVER.path}#inspiration` },
      { label: 'Offers and coupons', to: INFO_PATHS.offers },
    ],
  },
  {
    id: 'company',
    title: 'Company',
    links: [
      { label: 'About Wayora', to: INFO_PATHS.about },
      { label: 'Help and support', to: INFO_PATHS.help },
      { label: 'Platform status', to: INFO_PATHS.status },
    ],
  },
];

/**
 * Legal links for the footer's bottom bar. Both pages are clearly marked
 * drafts until legal review (see docs/layouts.md). There is no separate cookie
 * policy yet: the only cookie is the strictly necessary session cookie
 * (Phase 8), described in the privacy draft.
 */
export const LEGAL_LINKS: readonly FooterLink[] = [
  { label: 'Privacy policy', to: INFO_PATHS.privacy },
  { label: 'Terms and conditions', to: INFO_PATHS.terms },
];

export interface SocialLink {
  label: string;
  href: `https://${string}`;
  icon: LucideIcon;
}

/** Official social profiles. None are configured yet, so the footer shows none. */
export const SOCIAL_LINKS: readonly SocialLink[] = [];
