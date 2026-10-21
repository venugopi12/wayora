import { Users } from 'lucide-react';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';

export interface TravellerCounts {
  adults: number;
  children?: number;
  infants?: number;
  /** Hotels and holidays. */
  rooms?: number;
}

export interface TravellerCountDisplayProps extends TravellerCounts {
  /** e.g. "Economy", "AC 2 Tier", "Sleeper". */
  travelClass?: string;
  /** `compact` collapses to "3 travellers" for tight spaces (search bars). */
  variant?: 'full' | 'compact';
  showIcon?: boolean;
  className?: string;
}

export function describeTravellers({
  adults,
  children = 0,
  infants = 0,
  rooms,
}: TravellerCounts): string {
  const people = [
    plural(adults, 'adult'),
    children ? plural(children, 'child', 'children') : '',
    infants ? plural(infants, 'infant') : '',
  ].filter(Boolean);
  return [...people, rooms ? plural(rooms, 'room') : ''].filter(Boolean).join(', ');
}

/** Summarises who is travelling, e.g. "2 adults, 1 child, 1 room". */
export function TravellerCountDisplay({
  adults,
  children = 0,
  infants = 0,
  rooms,
  travelClass,
  variant = 'full',
  showIcon = true,
  className,
}: TravellerCountDisplayProps) {
  const total = adults + children + infants;
  const text =
    variant === 'compact'
      ? [plural(total, 'traveller'), rooms ? plural(rooms, 'room') : ''].filter(Boolean).join(', ')
      : describeTravellers({ adults, children, infants, rooms });

  return (
    <span className={cn('inline-flex items-center gap-2 text-body-sm text-ink', className)}>
      {showIcon ? (
        <Users className="size-4 shrink-0 text-ink-secondary" aria-hidden="true" />
      ) : null}
      <span>
        {text}
        {travelClass ? <span className="text-ink-secondary">, {travelClass}</span> : null}
      </span>
    </span>
  );
}
