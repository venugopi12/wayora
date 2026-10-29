import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Skeleton, cn } from '@wayora/ui';
import { getBudget } from '../../../services/planner';
import { plannerKeys } from '../keys';
import { budgetPath } from '../paths';
import { abs, money, percent } from './money';

/**
 * The budget at a glance on the plan page, linking to the full budget page.
 * Shows only figures the API computed; nothing is converted between currencies.
 */
export function PlanBudgetCard({ tripId }: { tripId: string }) {
  const query = useQuery({
    queryKey: plannerKeys.budget(tripId),
    queryFn: ({ signal }) => getBudget(tripId, signal),
  });

  let summary;
  if (query.isPending) {
    summary = <Skeleton className="h-5 w-64 max-w-full" />;
  } else if (query.isError) {
    summary = (
      <p className="text-body-sm text-ink-secondary">We couldn’t load the budget just now.</p>
    );
  } else {
    const { progress, totals } = query.data;
    if (progress) {
      const over = BigInt(progress.remainingMinor) < 0n;
      summary = (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-ink-secondary">
          <span>
            Budget{' '}
            <span className="numeric text-ink">
              {money(progress.totalMinor, progress.currency)}
            </span>
          </span>
          <span>
            Recorded{' '}
            <span className="numeric text-ink">
              {money(progress.recordedMinor, progress.currency)}
            </span>{' '}
            ({percent(progress.utilizationBasisPoints)})
          </span>
          <span className={cn(over && 'text-danger-ink')}>
            {over ? 'Over by ' : 'Remaining '}
            <span className={cn('numeric', !over && 'text-ink')}>
              {money(abs(progress.remainingMinor), progress.currency)}
            </span>
          </span>
        </p>
      );
    } else if (totals.length > 0) {
      summary = (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-ink-secondary">
          {totals.map((t) => (
            <span key={t.currency}>
              Recorded{' '}
              <span className="numeric text-ink">{money(t.recordedMinor, t.currency)}</span>
            </span>
          ))}
          <span>No budget set</span>
        </p>
      );
    } else {
      summary = (
        <p className="text-body-sm text-ink-secondary">
          No budget or expenses yet. Track costs and split them with the group.
        </p>
      );
    }
  }

  return (
    <section
      aria-labelledby="plan-budget-heading"
      className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="plan-budget-heading" className="flex items-center gap-2 text-title">
          <Wallet className="size-5 text-ink-secondary" aria-hidden="true" />
          Budget &amp; expenses
        </h2>
        {summary}
      </div>
      <Button asChild variant="secondary" size="sm">
        <Link to={budgetPath(tripId)}>
          Open budget
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
