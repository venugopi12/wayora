import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ToastProvider, TooltipProvider } from '@wayora/ui';
import { createRoutes, type CreateRoutesOptions } from '../src/app/routes';
import { AuthProvider } from '../src/features/auth/AuthProvider';
import { CurrencyProvider } from '../src/features/preferences/currency';

/** Renders the real route table at `path` with an isolated, non-retrying QueryClient. */
export function renderRoute(
  path: string,
  {
    reducedMotion = 'never',
    ...options
  }: CreateRoutesOptions & { reducedMotion?: 'always' | 'never' } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(createRoutes(options), { initialEntries: [path] });
  return {
    router,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion={reducedMotion}>
          <TooltipProvider>
            <ToastProvider>
              <AuthProvider>
                <CurrencyProvider>
                  <RouterProvider router={router} />
                </CurrencyProvider>
              </AuthProvider>
            </ToastProvider>
          </TooltipProvider>
        </MotionConfig>
      </QueryClientProvider>,
    ),
  };
}
