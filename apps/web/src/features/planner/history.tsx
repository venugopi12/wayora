import { useInfiniteQuery } from '@tanstack/react-query';
import { History, RotateCw } from 'lucide-react';
import type { PlannedTrip } from '@wayora/contracts';
import { Avatar, Button, EmptyState, ErrorState, Sheet, SheetContent, Skeleton } from '@wayora/ui';
import { getPlanActivity } from '../../services/planner';
import { formatDay } from './format';
import { plannerKeys } from './keys';

/*
 * The plan's change history (docs/planner.md#activity-history): who did
 * what, newest first, in plain words written by the server. Any member can
 * read it; it's paged ("Show older changes").
 */

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function HistorySheet({
  trip,
  open,
  onOpenChange,
  onShowDay,
}: {
  trip: PlannedTrip;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowDay: (day: string) => void;
}) {
  const query = useInfiniteQuery({
    queryKey: plannerKeys.activity(trip.id),
    queryFn: ({ pageParam, signal }) => getPlanActivity(trip.id, pageParam, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: open,
  });
  const days = new Map(trip.days.map((d) => [d.date, d.dayNumber]));

  let body;
  if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading the history" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title="We couldn't load the history"
        description="Check your connection, then try again."
        action={
          <Button
            variant="secondary"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else {
    const entries = query.data.pages.flatMap((p) => p.items);
    body =
      entries.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No changes recorded yet"
          description="Changes made from now on appear here, with who made them."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ol aria-label="Changes, newest first" className="flex flex-col gap-3">
            {entries.map((entry) => (
              <li key={entry.revision} className="flex gap-3">
                <Avatar name={entry.actor?.name ?? '?'} size="sm" decorative className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-body-sm break-words text-ink">{entry.summary}</span>
                  <span className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
                    <time dateTime={entry.createdAt}>
                      {timeFormat.format(new Date(entry.createdAt))}
                    </time>
                    {entry.day && days.has(entry.day) ? (
                      <button
                        type="button"
                        className="min-h-6 underline hover:text-ink"
                        onClick={() => {
                          onShowDay(entry.day!);
                          onOpenChange(false);
                        }}
                      >
                        Day {days.get(entry.day)} · {formatDay(entry.day)}
                      </button>
                    ) : null}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {query.hasNextPage ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Show older changes
            </Button>
          ) : null}
        </div>
      );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Plan history"
        description="Who changed what, newest first."
        closeLabel="Close history"
      >
        {body}
      </SheetContent>
    </Sheet>
  );
}
