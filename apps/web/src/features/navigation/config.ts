import { Compass, type LucideIcon } from 'lucide-react';
import {
  TRAVEL_CATEGORIES,
  type CategoryAvailability,
  type TravelCategory,
  type TravelCategorySlug,
} from '@wayora/contracts';
import { categoryIcons } from '../catalog/category-icons';

/**
 * Single source of truth for navigation: labels, paths, icons and short
 * descriptions used by the desktop header, mega menu, mobile drawer, footer
 * and service search pages. Names and availability come from the shared catalog
 * contract so the navigation can never disagree with the API.
 */

export type AppPath = `/${string}`;

export interface ServiceNavItem {
  slug: TravelCategorySlug;
  name: string;
  path: AppPath;
  icon: LucideIcon;
  /** One line for menus. */
  summary: string;
  availability: CategoryAvailability;
  category: TravelCategory;
}

const summaries: Record<TravelCategorySlug, string> = {
  flights: 'Domestic and international fares.',
  hotels: 'Stays from boutique to business.',
  trains: 'Intercity and long-distance rail.',
  buses: 'Comfortable road journeys.',
  metro: 'Urban transport and city travel.',
  cabs: 'Plan your local and airport transfers.',
  holidays: 'Explore curated travel experiences.',
};

export const SERVICE_NAV: readonly ServiceNavItem[] = TRAVEL_CATEGORIES.map((category) => ({
  slug: category.slug,
  name: category.name,
  path: `/${category.slug}` as AppPath,
  icon: categoryIcons[category.slug],
  summary: summaries[category.slug],
  availability: category.availability,
  category,
}));

export const serviceBySlug = Object.fromEntries(SERVICE_NAV.map((s) => [s.slug, s])) as Record<
  TravelCategorySlug,
  ServiceNavItem
>;

export const DISCOVER = {
  name: 'Discover',
  path: '/discover' as AppPath,
  icon: Compass,
  summary: 'Destination ideas and travel guides.',
} as const;

/** Accounts (Phase 8). `/sign-in` (Phase 3–7 link target) redirects to `/login`. */
export const ACCOUNT_PATHS = {
  login: '/login',
  register: '/register',
  profile: '/profile',
  travellers: '/profile/travellers',
} as const satisfies Record<string, AppPath>;

export const SIGN_IN_PATH: AppPath = ACCOUNT_PATHS.login;
export const REGISTER_PATH: AppPath = ACCOUNT_PATHS.register;
/** Old path, kept as a redirect so existing links keep working. */
export const LEGACY_SIGN_IN_PATH: AppPath = '/sign-in';

/** Informational and legal pages (Phase 7). Legal pages are drafts until reviewed. */
export const INFO_PATHS = {
  about: '/about',
  help: '/help',
  status: '/status',
  privacy: '/legal/privacy',
  terms: '/legal/terms',
} as const satisfies Record<string, AppPath>;

/**
 * Desktop header layout. `collapseBelowXl` items move into the "More" mega
 * menu between the `lg` and `xl` breakpoints so the header never crowds.
 */
export interface HeaderServiceLink {
  slug: TravelCategorySlug;
  collapseBelowXl?: boolean;
}

export const HEADER_SERVICE_LINKS: readonly HeaderServiceLink[] = [
  { slug: 'flights' },
  { slug: 'hotels' },
  { slug: 'trains' },
  { slug: 'buses', collapseBelowXl: true },
];

/** Always inside the "More" mega menu. */
export const MORE_MENU_SLUGS: readonly TravelCategorySlug[] = ['metro', 'cabs', 'holidays'];

/** Paths that should mark the "More" trigger as active. */
export const MORE_MENU_PATHS: readonly AppPath[] = MORE_MENU_SLUGS.map(
  (s) => serviceBySlug[s].path,
);

/**
 * Header colour mode. `inverse` is used while the header floats over a dark
 * hero (white text); everything else uses `default`.
 */
export type HeaderTone = 'default' | 'inverse';
