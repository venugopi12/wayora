import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CurrencyCode } from '@wayora/contracts';

export interface DisplayCurrency {
  code: CurrencyCode;
  symbol: string;
  name: string;
}

/** Currencies offered as a display preference. Order = menu order. */
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = [
  { code: 'INR', symbol: '₹', name: 'Indian rupee' },
  { code: 'USD', symbol: '$', name: 'US dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British pound' },
  { code: 'AED', symbol: 'AED', name: 'UAE dirham' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore dollar' },
];

export const DEFAULT_CURRENCY: CurrencyCode = 'INR';

interface CurrencyContextValue {
  currency: DisplayCurrency;
  setCurrency: (code: CurrencyCode) => void;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

/**
 * Display-currency preference, held in memory for this visit only.
 * It changes what the header shows; it does NOT convert prices or affect
 * bookings (there are none yet). Persistence arrives with user preferences
 * in a later phase — the app has no preference store to use today.
 */
export function CurrencyProvider({
  children,
  initial = DEFAULT_CURRENCY,
}: {
  children: ReactNode;
  initial?: CurrencyCode;
}) {
  const [code, setCode] = useState<CurrencyCode>(initial);
  const value = useMemo<CurrencyContextValue>(() => {
    const currency = DISPLAY_CURRENCIES.find((c) => c.code === code) ?? DISPLAY_CURRENCIES[0]!;
    return {
      currency,
      setCurrency: (next) => {
        if (DISPLAY_CURRENCIES.some((c) => c.code === next)) setCode(next);
      },
    };
  }, [code]);
  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useDisplayCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useDisplayCurrency must be used inside <CurrencyProvider>');
  return ctx;
}
