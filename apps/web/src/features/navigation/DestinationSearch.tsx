import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Popover, PopoverContent, PopoverTrigger, cn } from '@wayora/ui';
import { destinationPath } from '../discover/paths';
import { type HeaderTone } from './config';
import { DestinationCombobox } from './DestinationCombobox';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Header destination search: a popover around DestinationCombobox, searching
 * the small, clearly labelled SAMPLE destination dataset (no API, no fares).
 * Choosing one opens its Discover page.
 * Press "/" anywhere (outside a text field) to open it.
 */
export function DestinationSearch({
  className,
  tone = 'default',
}: {
  className?: string;
  tone?: HeaderTone;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inverse = tone === 'inverse';

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={inverse ? 'ghost-inverse' : 'ghost'}
          size="sm"
          aria-label="Search destinations"
          className={cn(
            'h-10 min-w-10 gap-2 px-2.5 xl:border xl:pr-2 xl:pl-3',
            inverse
              ? 'xl:border-white/25 xl:bg-white/10 xl:hover:bg-white/16'
              : 'xl:border-line xl:bg-card xl:shadow-xs',
            className,
          )}
        >
          <Search className="size-[18px]" aria-hidden="true" />
          <span
            className={cn(
              'hidden font-medium xl:inline',
              inverse ? 'text-ink-inverse-secondary' : 'text-ink-secondary',
            )}
          >
            Search destinations
          </span>
          <kbd
            className={cn(
              'hidden h-6 min-w-6 place-items-center rounded-xs border px-1.5 font-sans text-caption xl:grid',
              inverse
                ? 'border-white/25 bg-white/10 text-ink-inverse-secondary'
                : 'border-line bg-sunken text-ink-secondary',
            )}
          >
            /
          </kbd>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Search destinations"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DestinationCombobox
          label="Search sample destinations"
          inputRef={inputRef}
          onSelect={(destination) => {
            setOpen(false);
            navigate(destinationPath(destination.slug));
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
