import { Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { SearchServiceType } from '@wayora/contracts';
import { Button } from '@wayora/ui';
import type { FormValues } from '../params';
import { summarizeSearch } from '../summary';

/**
 * The current search in one line, with an "Edit search" action that opens
 * the form. Used once a search is running, so results get the space.
 */
export function SearchSummary({
  serviceType,
  values,
  onEdit,
  focusOnMount = false,
}: {
  serviceType: SearchServiceType;
  values: FormValues;
  onEdit: () => void;
  /** Return focus here (after "Cancel" in the edit form). */
  focusOnMount?: boolean;
}) {
  const { title, details } = summarizeSearch(serviceType, values);
  const editRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOnMount) editRef.current?.focus();
  }, [focusOnMount]);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-caption text-ink-secondary">Your search</p>
        <p className="text-title text-ink">{title}</p>
        <p className="text-body-sm text-ink-secondary">{details.filter(Boolean).join(' · ')}</p>
      </div>
      <Button
        ref={editRef}
        variant="secondary"
        onClick={onEdit}
        className="shrink-0"
        aria-label={`Edit search: ${title}`}
      >
        <Pencil aria-hidden="true" />
        Edit search
      </Button>
    </div>
  );
}
