import type { SearchServiceType } from '@wayora/contracts';
import type { TravelCategory } from '@wayora/database';

/** API category slug → database enum. */
export const CATEGORY: Record<SearchServiceType, TravelCategory> = {
  flights: 'FLIGHT',
  hotels: 'HOTEL',
  trains: 'TRAIN',
  buses: 'BUS',
  metro: 'METRO',
  cabs: 'CAB',
  holidays: 'HOLIDAY_PACKAGE',
};

/** Database enum → API category slug. */
export const SERVICE_TYPE = Object.fromEntries(
  Object.entries(CATEGORY).map(([slug, db]) => [db, slug]),
) as Record<TravelCategory, SearchServiceType>;
