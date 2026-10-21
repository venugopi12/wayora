import {
  TRAVEL_CATEGORIES,
  type ListCategoriesQuery,
  type TravelCategory,
  type TravelCategorySlug,
} from '@wayora/contracts';

/**
 * Example module service. Phase 1 serves the static catalog from contracts;
 * later phases can swap in a database- or CMS-backed source without touching
 * the routes or the response contract.
 */
export class CatalogService {
  constructor(private readonly source: readonly TravelCategory[] = TRAVEL_CATEGORIES) {}

  list(query: ListCategoriesQuery = {}): TravelCategory[] {
    return this.source.filter(
      (category) => !query.availability || category.availability === query.availability,
    );
  }

  get(slug: TravelCategorySlug): TravelCategory | undefined {
    return this.source.find((category) => category.slug === slug);
  }
}
