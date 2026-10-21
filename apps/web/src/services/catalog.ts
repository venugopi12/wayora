import { travelCategoryListSchema, type TravelCategory } from '@wayora/contracts';
import { api } from './api';

export function fetchCategories(signal?: AbortSignal): Promise<TravelCategory[]> {
  return api.request('/catalog/categories', { schema: travelCategoryListSchema, signal });
}
