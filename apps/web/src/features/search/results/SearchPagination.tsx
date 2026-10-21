import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@wayora/ui';

export function SearchPagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Result pages" className="flex items-center justify-between gap-3 pt-2">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden="true" />
        Previous
      </Button>
      <p className="text-body-sm text-ink-secondary">
        Page {Math.min(page, totalPages)} of {totalPages}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        Next
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
