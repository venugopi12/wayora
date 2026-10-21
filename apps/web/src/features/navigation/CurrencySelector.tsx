import { ChevronDown } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@wayora/ui';
import type { CurrencyCode } from '@wayora/contracts';
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../preferences/currency';
import type { HeaderTone } from './config';

/** Header display-currency menu. A preference only; nothing is converted. */
export function CurrencySelector({
  className,
  tone = 'default',
}: {
  className?: string;
  tone?: HeaderTone;
}) {
  const { currency, setCurrency } = useDisplayCurrency();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={tone === 'inverse' ? 'ghost-inverse' : 'ghost'}
          size="sm"
          aria-label={`Display currency: ${currency.code}`}
          className={className}
        >
          <span className="numeric font-semibold">{currency.code}</span>
          <ChevronDown
            className={
              tone === 'inverse' ? 'size-4 text-ink-inverse-secondary' : 'size-4 text-ink-secondary'
            }
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Display currency</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          label="Display currency"
          value={currency.code}
          onValueChange={(code) => setCurrency(code as CurrencyCode)}
        >
          {DISPLAY_CURRENCIES.map((c) => (
            <DropdownMenuRadioItem key={c.code} value={c.code} hint={c.symbol}>
              <span className="numeric font-semibold">{c.code}</span>{' '}
              <span className="text-ink-secondary">{c.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-3 pt-1 pb-2 text-caption text-ink-secondary">
          A display preference for this visit. Prices aren&apos;t converted, and nothing is booked
          yet.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
