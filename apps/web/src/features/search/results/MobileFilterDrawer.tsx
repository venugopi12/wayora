import { SlidersHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Sheet, SheetClose, SheetContent, SheetTrigger } from '@wayora/ui';

/**
 * Filters on small screens: a button that opens a sheet with the same filter
 * panel as the desktop sidebar. Filters apply as they change (results update
 * behind the sheet); "Show results" closes it and focus returns to the button.
 */
export function MobileFilterDrawer({
  activeCount,
  resultLabel,
  onClearAll,
  children,
}: {
  activeCount: number;
  /** "Show 4 results" */
  resultLabel: string;
  onClearAll: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="secondary" className="w-full sm:w-auto lg:hidden">
          <SlidersHorizontal aria-hidden="true" />
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </SheetTrigger>
      <SheetContent
        title="Filters"
        closeLabel="Close filters"
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={onClearAll} disabled={activeCount === 0}>
              Clear all
            </Button>
            <SheetClose asChild>
              <Button>{resultLabel}</Button>
            </SheetClose>
          </div>
        }
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}
