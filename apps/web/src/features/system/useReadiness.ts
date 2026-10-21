import { useQuery } from '@tanstack/react-query';
import { fetchReadiness } from '../../services/system';

export function useReadiness() {
  return useQuery({
    queryKey: ['system', 'readiness'],
    queryFn: ({ signal }) => fetchReadiness(signal),
    staleTime: 15_000,
    retry: false,
  });
}
