import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ToastProvider, TooltipProvider } from '@wayora/ui';
import { GlobalErrorBoundary } from '../components/GlobalErrorBoundary';
import { AuthProvider } from '../features/auth/AuthProvider';
import { CurrencyProvider } from '../features/preferences/currency';
import { createQueryClient } from '../lib/query-client';
import { createRoutes } from './routes';

const router = createBrowserRouter(createRoutes());

export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <GlobalErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* Honour the OS "reduce motion" setting for every Motion animation. */}
        <MotionConfig reducedMotion="user">
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
      </QueryClientProvider>
    </GlobalErrorBoundary>
  );
}
