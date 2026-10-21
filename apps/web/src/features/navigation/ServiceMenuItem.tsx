import type { LucideIcon } from 'lucide-react';
import type { CategoryAvailability } from '@wayora/contracts';
import { Badge, ICON_STROKE, cn } from '@wayora/ui';

/** Badge per catalog status: nothing once a service is live. */
const AVAILABILITY_BADGE: Record<CategoryAvailability, string | null> = {
  planned: 'Soon',
  beta: 'Demo',
  live: null,
};

/**
 * Shared row content for a service in the desktop "More" panel and the mobile
 * drawer: icon tile, name, availability badge and one-line summary. The
 * caller provides the link element (and any menu wrapper) around it.
 */
export function ServiceMenuItem({
  icon: Icon,
  title,
  summary,
  availability,
}: {
  icon: LucideIcon;
  title: string;
  summary: string;
  /**
   * From the catalog: "Soon" while planned, "Demo" while it offers demo search
   * only. Omit for entries that aren't catalog services (Discover).
   */
  availability?: CategoryAvailability;
}) {
  const badge = availability ? AVAILABILITY_BADGE[availability] : null;
  return (
    <>
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-ink [&_svg]:size-5',
          'transition-colors duration-(--duration-fast) ease-standard',
          'group-hover/item:bg-brand group-hover/item:text-ink-inverse',
        )}
        aria-hidden="true"
      >
        <Icon strokeWidth={ICON_STROKE} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-label text-ink">{title}</span>
          {badge ? <Badge size="sm">{badge}</Badge> : null}
        </span>
        <span className="text-body-sm text-ink-secondary">{summary}</span>
      </span>
    </>
  );
}

/** Row classes shared by both menus (callers add alignment and padding). */
export const serviceMenuRow =
  'group/item flex gap-3.5 rounded-lg outline-none transition-colors duration-(--duration-fast) ease-standard hover:bg-brand-50 focus-visible:bg-brand-50';
