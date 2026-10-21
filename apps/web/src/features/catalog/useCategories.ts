import { useQuery } from '@tanstack/react-query';
import { fetchCategories } from '../../services/catalog';

export const categoriesQueryKey = ['catalog', 'categories'] as const;

export function useCategories() {
  return useQuery({
    queryKey: categoriesQueryKey,
    queryFn: ({ signal }) => fetchCategories(signal),
    staleTime: 5 * 60_000,
    // A bundled fallback exists, so fail fast rather than leaving skeletons up.
    retry: 1,
    retryDelay: 400,
  });
}
