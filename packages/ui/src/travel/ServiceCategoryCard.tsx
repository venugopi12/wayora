import { Slot } from 'radix-ui';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Badge } from '../components/Badge';
import { Card } from '../layout/Card';
import { cn } from '../lib/cn';

export type ServiceAvailability = 'planned' | 'beta' | 'live';

export interface ServiceCategoryCardProps {
  /** A Lucide icon element, e.g. <Plane />. Sized by the card. */
  icon: ReactNode;
  name: string;
  tagline: string;
  description?: string;
  availability: ServiceAvailability;
  /**
   * Link element for live services, e.g. <Link to="/flights" /> or <a href="/flights" />.
   * Ignored while `planned` — preview cards must not look bookable.
   */
  link?: ReactElement;
  /** Override the status badge text. */
  statusLabel?: string;
  headingLevel?: 'h2' | 'h3';
  /** Spans two columns from `md` (used to balance a 7-item grid). */
  featured?: boolean;
  className?: string;
}

const statusDefaults: Record<
  ServiceAvailability,
  { label: string; tone: 'neutral' | 'brand' | 'success' }
> = {
  planned: { label: 'Coming in a later phase', tone: 'neutral' },
  beta: { label: 'Beta', tone: 'brand' },
  live: { label: 'Available', tone: 'success' },
};

/**
 * One travel vertical (Flights, Hotels, …). Planned services render as calm,
 * non-interactive previews; live ones become a single stretched link.
 */
export function ServiceCategoryCard({
  icon,
  name,
  tagline,
  description,
  availability,
  link,
  statusLabel,
  headingLevel: Heading = 'h3',
  featured = false,
  className,
}: ServiceCategoryCardProps) {
  const status = statusDefaults[availability];
  const interactive = availability !== 'planned' && isValidElement(link);
  const title = interactive ? (
    <Slot.Root className="stretched-link rounded-xs outline-none focus-visible:outline-none">
      {cloneElement(link as ReactElement<{ children?: ReactNode }>, { children: name })}
    </Slot.Root>
  ) : (
    name
  );

  return (
    <Card
      interactive={interactive}
      padding="lg"
      className={cn('flex h-full flex-col gap-5', featured && 'md:col-span-2', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <span
          className={cn(
            'grid size-12 shrink-0 place-items-center rounded-lg [&_svg]:size-6',
            availability === 'planned'
              ? 'bg-brand-soft text-brand-ink'
              : 'bg-brand text-ink-inverse',
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
        <Badge tone={status.tone} size="sm" dot={availability !== 'planned'}>
          {statusLabel ?? status.label}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <Heading className="text-heading-3">{title}</Heading>
        <p className="text-body font-medium text-ink">{tagline}</p>
        {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
      </div>
    </Card>
  );
}
