import { X } from 'lucide-react';
import { Button } from '@wayora/ui';
import type { FilterChip } from '../filters';
import type { ParamUpdate } from './FilterPanel';

/**
 * The filters in effect, one removable chip per value, plus "Clear all".
 * Chips come from the URL, so they always match what is applied.
 */
export function ActiveFilterChips({
  chips,
  onChange,
  onClearAll,
}: {
  chips: readonly FilterChip[];
  onChange: (updates: ParamUpdate) => void;
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul className="flex flex-wrap gap-2" aria-label="Active filters">
        {chips.map((chip) => (
          <li key={chip.key}>
            <button
              type="button"
              onClick={() => onChange(chip.remove)}
              aria-label={`Remove filter: ${chip.label}`}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-soft py-1 pr-2 pl-3 text-body-sm text-brand-ink transition-colors duration-(--duration-fast) hover:border-brand hover:bg-brand-100"
            >
              {chip.label}
              <X aria-hidden="true" className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}
