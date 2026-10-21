import { MapPin, Search, SearchX, X } from 'lucide-react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { DestinationSummary } from '@wayora/contracts';
import { Badge, IconButton, cn } from '@wayora/ui';
import { placeLine } from '../discover/format';
import { searchDestinations } from '../discover/search';

export interface DestinationComboboxProps {
  /** Accessible name for the input. */
  label: string;
  placeholder?: string;
  /**
   * inline   – suggestions always listed under the input (inside a popover).
   * floating – a form field whose suggestions open in a dropdown.
   */
  variant?: 'inline' | 'floating';
  onSelect: (destination: DestinationSummary) => void;
  /** Called when a floating field's chosen destination is cleared or edited. */
  onClear?: () => void;
  /** Id for the input, so an external <label htmlFor> can name it. */
  id?: string;
  /** Ids of extra descriptions (hints) for the input. */
  describedBy?: string;
  /** Lets a parent focus the input (e.g. when a popover opens). */
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}

/**
 * WAI-ARIA combobox over the SAMPLE destination dataset (features/discover/data.ts, no API).
 * The input owns a listbox; ArrowUp/Down, Home/End move the active option
 * (aria-activedescendant); Enter selects; Escape closes the floating list.
 */
export function DestinationCombobox({
  label,
  placeholder = 'Where would you like to go?',
  variant = 'inline',
  onSelect,
  onClear,
  id,
  describedBy,
  inputRef,
  className,
}: DestinationComboboxProps) {
  const generated = useId();
  const inputId = id ?? `${generated}-input`;
  const listId = `${generated}-list`;
  const labelId = `${generated}-label`;
  const optionId = (i: number) => `${generated}-option-${i}`;
  const localRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = inputRef ?? localRef;

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(variant === 'inline');
  const [chosen, setChosen] = useState<DestinationSummary | null>(null);

  const results = useMemo(
    () => (chosen && query === chosen.name ? searchDestinations('') : searchDestinations(query)),
    [query, chosen],
  );
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));
  const floating = variant === 'floating';
  const listVisible = floating ? open : true;

  function choose(destination: DestinationSummary) {
    setActiveIndex(0);
    if (floating) {
      setChosen(destination);
      setQuery(destination.name);
      setOpen(false);
    } else {
      setQuery('');
    }
    onSelect(destination);
  }

  function clear() {
    setQuery('');
    setActiveIndex(0);
    if (chosen) {
      setChosen(null);
      onClear?.();
    }
    fieldRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (floating && event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (floating && !open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (results.length === 0 || !listVisible) return;
    const last = results.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: active >= last ? 0 : active + 1,
      ArrowUp: active <= 0 ? last : active - 1,
      Home: 0,
      End: last,
    };
    if (event.key in moves) {
      event.preventDefault();
      setActiveIndex(moves[event.key]!);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = results[active];
      if (choice) choose(choice);
    }
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (floating && !event.currentTarget.contains(event.relatedTarget as Node | null))
      setOpen(false);
  }

  const list = (
    <div className="p-2">
      <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1.5">
        <p className="text-caption text-ink-secondary" id={labelId}>
          {query && !chosen ? 'Matching sample destinations' : 'Sample destinations'}
        </p>
        <Badge size="sm" title="These suggestions are sample data, not live search results">
          Sample data
        </Badge>
      </div>
      {results.length > 0 ? (
        <ul id={listId} role="listbox" aria-labelledby={labelId} className="flex flex-col gap-0.5">
          {results.map((d, i) => (
            <li
              key={d.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActiveIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(d)}
              className={cn(
                'flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                i === active ? 'bg-brand-soft text-brand-ink' : 'text-ink',
              )}
            >
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-sm',
                  i === active ? 'bg-card text-brand' : 'bg-sunken text-ink-secondary',
                )}
                aria-hidden="true"
              >
                <MapPin className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-label">{d.name}</span>
                <span className="truncate text-caption text-ink-secondary">{placeLine(d)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div
          id={listId}
          role="status"
          className="flex flex-col items-center gap-2 px-6 py-8 text-center"
        >
          <span
            className="grid size-10 place-items-center rounded-full bg-sunken text-ink-secondary"
            aria-hidden="true"
          >
            <SearchX className="size-5" />
          </span>
          <p className="text-label text-ink">No sample destination matches “{query.trim()}”</p>
          <p className="text-body-sm text-ink-secondary">
            Try Goa, Kyoto or Bali. The sample set is small; more destinations are added over time.
          </p>
        </div>
      )}
    </div>
  );

  const input = (
    <input
      ref={fieldRef}
      id={inputId}
      type="text"
      role="combobox"
      aria-label={label}
      aria-describedby={describedBy}
      aria-expanded={listVisible && results.length > 0}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={listVisible && results.length > 0 ? optionId(active) : undefined}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={query}
      onFocus={() => floating && setOpen(true)}
      onClick={() => floating && setOpen(true)}
      onChange={(e) => {
        setQuery(e.target.value);
        setActiveIndex(0);
        if (floating) setOpen(true);
        if (chosen) {
          setChosen(null);
          onClear?.();
        }
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-subtle focus-visible:outline-none',
        floating ? 'text-body-lg font-medium' : 'text-body',
      )}
    />
  );

  const clearButton = query ? (
    <IconButton label="Clear search" icon={<X />} size="sm" onClick={clear} />
  ) : null;

  if (!floating) {
    return (
      <div className={className}>
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Search className="size-[18px] shrink-0 text-ink-secondary" aria-hidden="true" />
          {input}
          {clearButton}
        </div>
        {list}
      </div>
    );
  }

  return (
    <div className={cn('relative', className)} onBlur={onBlur}>
      <div
        className={cn(
          'flex h-14 items-center gap-3 rounded-md border bg-card pr-2 pl-4 shadow-xs',
          'border-line-control transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
          'hover:border-ink-secondary focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--color-brand-200)]',
        )}
      >
        <MapPin className="size-5 shrink-0 text-brand" aria-hidden="true" />
        {input}
        {clearButton}
      </div>
      {open ? (
        <div className="absolute inset-x-0 top-full z-(--z-dropdown) mt-2 max-h-[min(24rem,60dvh)] overflow-y-auto rounded-lg border border-line bg-card shadow-lg">
          {list}
        </div>
      ) : (
        <div id={listId} hidden />
      )}
    </div>
  );
}
