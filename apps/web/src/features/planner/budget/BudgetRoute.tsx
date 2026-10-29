import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  ArrowRight,
  HandCoins,
  Pencil,
  Plus,
  ReceiptText,
  RotateCw,
  Scale,
  SearchX,
  Trash2,
  Wallet,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  plannedTripIdSchema,
  type Balances,
  type BudgetCurrency,
  type BudgetOverview,
  type BudgetPerson,
  type Expense,
  type PlannedTrip,
  type Settlement,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  cn,
  useToast,
} from '@wayora/ui';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';
import { ApiClientError } from '../../../lib/api-client';
import {
  addBookingExpense,
  deleteExpense,
  deleteSettlement,
  getBalances,
  getBudget,
  getPlannedTrip,
  listExpenses,
  type ExpenseFilters,
} from '../../../services/planner';
import { formatDay, localToday } from '../format';
import { plannerKeys } from '../keys';
import { usePlanLiveUpdates } from '../live';
import { PLANS_PATH, planPath } from '../paths';
import { BudgetDialog } from './BudgetDialog';
import { ExpenseDialog } from './ExpenseDialog';
import { abs, balanceText, barWidth, money, percent } from './money';
import { SettlementDialog, type SettlementDraft } from './SettlementDialog';

/*
 * /plans/:tripId/budget (docs/planner.md#budget): the plan's budget, its
 * expenses, who owes whom, and suggested ways to settle up. Every figure comes
 * from the API, computed from saved records in integer minor units. Amounts
 * in different currencies are never added together or converted. Wayora
 * doesn't move money: payments between members happen outside Wayora and can
 * be recorded here afterwards.
 */

export function BudgetRoute() {
  const { tripId = '' } = useParams();
  const valid = plannedTripIdSchema.safeParse(tripId).success;
  const trip = useQuery({
    queryKey: plannerKeys.detail(tripId),
    queryFn: ({ signal }) => getPlannedTrip(tripId, signal),
    enabled: valid,
    retry: false,
  });
  const overview = useQuery({
    queryKey: plannerKeys.budget(tripId),
    queryFn: ({ signal }) => getBudget(tripId, signal),
    enabled: valid,
    retry: false,
  });
  useDocumentTitle(trip.data ? `Budget · ${trip.data.title}` : 'Trip budget');

  const notFound = (e: unknown) => e instanceof ApiClientError && e.status === 404;
  if (!valid || notFound(trip.error) || notFound(overview.error)) return <BudgetNotFound />;
  if (trip.isPending || overview.isPending) {
    return (
      <Container className="py-section-sm">
        <div role="status" aria-label="Loading the budget" className="flex flex-col gap-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-80 max-w-full" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </Container>
    );
  }
  if (trip.isError || overview.isError) {
    const error = trip.error ?? overview.error;
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Trip budget</h1>
        <ErrorState
          title="We couldn't load this budget"
          description="Check your connection, then try again."
          reference={error instanceof ApiClientError ? (error.requestId ?? undefined) : undefined}
          action={
            <Button
              variant="secondary"
              loading={trip.isFetching || overview.isFetching}
              onClick={() => {
                void trip.refetch();
                void overview.refetch();
              }}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </Container>
    );
  }
  return <BudgetView trip={trip.data} overview={overview.data} />;
}

function BudgetNotFound() {
  useDocumentTitle('Plan not found');
  return (
    <Container size="narrow" className="py-section-sm">
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          titleAs="h1"
          icon={<SearchX />}
          title="We couldn't find that plan"
          description="It may have been deleted, or you may no longer be a member."
          action={
            <Button asChild>
              <Link to={PLANS_PATH}>Go to the trip planner</Link>
            </Button>
          }
        />
      </div>
    </Container>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────

type DialogState =
  | { kind: 'budget' }
  | { kind: 'expense'; expense: Expense | null }
  | { kind: 'delete-expense'; expense: Expense }
  | { kind: 'settlement'; draft: SettlementDraft }
  | { kind: 'delete-settlement'; settlement: Settlement }
  | null;

function BudgetView({ trip, overview }: { trip: PlannedTrip; overview: BudgetOverview }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // The budget's people list is always freshly read, so it also catches a
  // member who joined after the plan itself was loaded.
  const shared = trip.memberCount > 0 || trip.access.role !== 'owner' || overview.people.length > 1;
  usePlanLiveUpdates(trip.id, trip.revision, shared);
  const [dialog, setDialog] = useState<DialogState>(null);

  const people = overview.people;
  const byId = new Map(people.map((p) => [p.id, p]));
  const you = people.find((p) => p.isYou);
  const today = localToday();
  const defaultDay = today >= trip.startDate && today <= trip.endDate ? today : trip.startDate;
  const defaultCurrency: BudgetCurrency =
    overview.budget?.currency ?? overview.totals[0]?.currency ?? 'INR';

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: plannerKeys.budget(trip.id) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.expenses(trip.id) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.balances(trip.id) });
    void queryClient.invalidateQueries({ queryKey: plannerKeys.activity(trip.id) });
  };
  const reportError = (error: unknown, title: string) => {
    const api = error instanceof ApiClientError ? error : null;
    toast({
      tone: 'danger',
      title,
      description:
        api && api.code !== 'NETWORK_ERROR' ? api.message : 'Check your connection and try again.',
    });
    refresh();
  };

  const balances = useQuery({
    queryKey: plannerKeys.balances(trip.id),
    queryFn: ({ signal }) => getBalances(trip.id, signal),
  });

  const removeExpense = useMutation({
    mutationFn: (expense: Expense) => deleteExpense(trip.id, expense.id),
    onSuccess: (_data, expense) => {
      toast({ tone: 'success', title: `Deleted “${expense.description}”` });
      setDialog(null);
      refresh();
    },
    onError: (error) => {
      setDialog(null);
      reportError(error, 'We couldn’t delete that expense');
    },
  });
  const removeSettlement = useMutation({
    mutationFn: (settlement: Settlement) => deleteSettlement(trip.id, settlement.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(plannerKeys.balances(trip.id), updated);
      toast({ tone: 'success', title: 'Recorded payment deleted' });
      setDialog(null);
      refresh();
    },
    onError: (error) => {
      setDialog(null);
      reportError(error, 'We couldn’t delete that payment');
    },
  });

  return (
    <Container className="py-section-sm">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6">
          <Breadcrumbs
            items={[
              { label: 'Home', link: <Link to="/" /> },
              { label: 'Trip planner', link: <Link to={PLANS_PATH} /> },
              { label: trip.title, link: <Link to={planPath(trip.id)} /> },
              { label: 'Budget' },
            ]}
          />
          <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-caption text-ink-secondary">
                <Badge size="sm" tone="neutral">
                  <Wallet className="size-3.5" aria-hidden="true" />
                  Budget &amp; expenses
                </Badge>
              </p>
              <h1 className="text-heading-1 break-words">Budget for {trip.title}</h1>
              <p className="max-w-3xl text-body text-ink-secondary">
                Track what the trip costs and who owes whom. Wayora doesn’t move money: settle up
                outside Wayora, then record the payment here.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {overview.canAddExpenses ? (
                <Button onClick={() => setDialog({ kind: 'expense', expense: null })}>
                  <Plus aria-hidden="true" />
                  Add expense
                </Button>
              ) : null}
              {overview.canManageBudget && overview.budget ? (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'budget' })}>
                  <Pencil aria-hidden="true" />
                  Edit budget
                </Button>
              ) : null}
            </div>
          </header>
          {trip.access.role === 'viewer' ? (
            <p className="text-body-sm text-ink-secondary">
              You can view this budget. Ask {trip.owner.name} for editor access to add expenses. You
              can still record a payment you made or received.
            </p>
          ) : null}
        </div>

        <BudgetSummary overview={overview} onSetBudget={() => setDialog({ kind: 'budget' })} />

        {overview.bookingImport && trip.access.canManage ? (
          <BookingImport
            tripId={trip.id}
            offer={overview.bookingImport}
            onAdded={(expense) => {
              toast({ tone: 'success', title: `Added “${expense.description}”` });
              refresh();
            }}
            onError={(error) => reportError(error, 'We couldn’t add the booking')}
          />
        ) : null}

        <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_26rem]">
          <ExpensesSection
            tripId={trip.id}
            people={people}
            canAdd={overview.canAddExpenses}
            onAdd={() => setDialog({ kind: 'expense', expense: null })}
            onEdit={(expense) => setDialog({ kind: 'expense', expense })}
            onDelete={(expense) => setDialog({ kind: 'delete-expense', expense })}
          />
          <BalancesSection
            query={balances}
            people={byId}
            you={you}
            onRecord={(draft) => setDialog({ kind: 'settlement', draft })}
            onDeleteSettlement={(settlement) =>
              setDialog({ kind: 'delete-settlement', settlement })
            }
            defaultCurrency={defaultCurrency}
          />
        </div>
      </div>

      {dialog?.kind === 'budget' && overview.canManageBudget ? (
        <BudgetDialog
          tripId={trip.id}
          budget={overview.budget}
          onClose={() => setDialog(null)}
          onSaved={(updated, message) => {
            queryClient.setQueryData(plannerKeys.budget(trip.id), updated);
            toast({ tone: 'success', title: message });
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'expense' ? (
        <ExpenseDialog
          tripId={trip.id}
          expense={dialog.expense}
          people={people}
          defaults={{ currency: defaultCurrency, day: defaultDay, you: you?.id ?? '' }}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onSaved={(_expense, message) => toast({ tone: 'success', title: message })}
        />
      ) : null}
      {dialog?.kind === 'settlement' ? (
        <SettlementDialog
          tripId={trip.id}
          people={people}
          initial={dialog.draft}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(updated, message) => {
            queryClient.setQueryData(plannerKeys.balances(trip.id), updated);
            toast({ tone: 'success', title: message });
            refresh();
          }}
        />
      ) : null}
      <Dialog
        open={dialog?.kind === 'delete-expense'}
        onOpenChange={(open) => !open && !removeExpense.isPending && setDialog(null)}
      >
        {dialog?.kind === 'delete-expense' ? (
          <DialogContent
            size="sm"
            title="Delete this expense?"
            description={`“${dialog.expense.description}” (${money(dialog.expense.amountMinor, dialog.expense.currency)}) will be removed. Balances and budget totals are recalculated without it.`}
            footer={
              <>
                <Button
                  variant="secondary"
                  onClick={() => setDialog(null)}
                  disabled={removeExpense.isPending}
                >
                  Keep it
                </Button>
                <Button
                  variant="destructive"
                  loading={removeExpense.isPending}
                  disabled={removeExpense.isPending}
                  onClick={() => removeExpense.mutate(dialog.expense)}
                >
                  Delete expense
                </Button>
              </>
            }
          />
        ) : null}
      </Dialog>
      <Dialog
        open={dialog?.kind === 'delete-settlement'}
        onOpenChange={(open) => !open && !removeSettlement.isPending && setDialog(null)}
      >
        {dialog?.kind === 'delete-settlement' ? (
          <DialogContent
            size="sm"
            title="Delete this recorded payment?"
            description="Only the record in Wayora is deleted: it doesn’t undo or refund anything. Balances are recalculated without it."
            footer={
              <>
                <Button
                  variant="secondary"
                  onClick={() => setDialog(null)}
                  disabled={removeSettlement.isPending}
                >
                  Keep it
                </Button>
                <Button
                  variant="destructive"
                  loading={removeSettlement.isPending}
                  disabled={removeSettlement.isPending}
                  onClick={() => removeSettlement.mutate(dialog.settlement)}
                >
                  Delete record
                </Button>
              </>
            }
          />
        ) : null}
      </Dialog>
    </Container>
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'danger';
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-card p-4 shadow-xs sm:p-5">
      <dt className="text-body-sm text-ink-secondary">{label}</dt>
      <dd
        className={cn(
          'numeric text-heading-3 break-words',
          tone === 'danger' ? 'text-danger-ink' : 'text-ink',
        )}
      >
        {value}
      </dd>
      {detail ? <dd className="text-caption text-ink-secondary">{detail}</dd> : null}
    </div>
  );
}

export function BudgetSummary({
  overview,
  onSetBudget,
}: {
  overview: BudgetOverview;
  onSetBudget?: () => void;
}) {
  const progress = overview.progress;
  const others = overview.totals.filter((t) => t.currency !== progress?.currency);
  const util = progress?.utilizationBasisPoints ?? 0;

  return (
    <section aria-labelledby="budget-summary-heading" className="flex flex-col gap-4">
      <h2 id="budget-summary-heading" className="text-heading-3">
        Summary
      </h2>
      {progress ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total budget" value={money(progress.totalMinor, progress.currency)} />
            <Stat
              label="Recorded (paid)"
              value={money(progress.recordedMinor, progress.currency)}
              detail="Expenses marked as paid"
            />
            <Stat
              label={BigInt(progress.remainingMinor) < 0n ? 'Over budget by' : 'Remaining'}
              value={money(abs(progress.remainingMinor), progress.currency)}
              tone={BigInt(progress.remainingMinor) < 0n ? 'danger' : undefined}
              detail={`Total budget minus recorded expenses`}
            />
            <Stat
              label="Planned (estimates)"
              value={money(progress.plannedMinor, progress.currency)}
              detail={
                BigInt(progress.remainingAfterPlannedMinor) < 0n
                  ? `Over by ${money(abs(progress.remainingAfterPlannedMinor), progress.currency)} once planned costs are paid`
                  : `${money(progress.remainingAfterPlannedMinor, progress.currency)} left after planned costs`
              }
            />
          </dl>
          <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span id="budget-utilization-label" className="text-label text-ink">
                Budget used
              </span>
              <span className="numeric text-body text-ink">
                {percent(util)} of {money(progress.totalMinor, progress.currency)}
              </span>
            </div>
            <div
              role="meter"
              aria-labelledby="budget-utilization-label"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(util, 10_000) / 100}
              aria-valuetext={`${percent(util)} of the budget used${progress.overBudget ? ', over budget' : ''}`}
              className="h-3 overflow-hidden rounded-full bg-sunken"
            >
              <div
                className={cn(
                  'h-full rounded-full',
                  progress.overBudget ? 'bg-danger' : util >= 8_000 ? 'bg-warning' : 'bg-brand',
                )}
                style={{ width: `${Math.min(util, 10_000) / 100}%` }}
              />
            </div>
            <p className="text-caption text-ink-secondary">
              Counts paid expenses in {progress.currency} only. Planned estimates and other
              currencies are shown separately and never converted.
            </p>
          </div>
          {progress.overBudget ? (
            <Alert tone="warning" role="none" title="Over budget">
              Recorded expenses are {money(abs(progress.remainingMinor), progress.currency)} more
              than the budget.
            </Alert>
          ) : null}
          <CategoryTable overview={overview} />
        </>
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-line-strong bg-card p-5">
          <div className="flex flex-col gap-1">
            <p className="text-title">No budget yet</p>
            <p className="text-body-sm text-ink-secondary">
              {onSetBudget && overview.canManageBudget
                ? 'Set a total (and, if you like, amounts per category) to see how spending compares.'
                : 'Nobody has set a budget for this trip. Expenses are still tracked below.'}
            </p>
          </div>
          {onSetBudget && overview.canManageBudget ? (
            <div>
              <Button variant="secondary" onClick={onSetBudget}>
                <Wallet aria-hidden="true" />
                Set a budget
              </Button>
            </div>
          ) : null}
          {overview.totals.length > 0 ? <TotalsList totals={overview.totals} /> : null}
        </div>
      )}
      {progress && others.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-4 sm:p-5">
          <p className="text-label text-ink">Other currencies (not converted)</p>
          <p className="text-caption text-ink-secondary">
            These expenses aren’t counted in the {progress.currency} budget. Wayora doesn’t convert
            between currencies.
          </p>
          <TotalsList totals={others} />
        </div>
      ) : null}
    </section>
  );
}

function TotalsList({ totals }: { totals: BudgetOverview['totals'] }) {
  return (
    <ul className="flex flex-col gap-1 text-body-sm">
      {totals.map((t) => (
        <li key={t.currency} className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="font-semibold text-ink">{t.currency}</span>
          <span>
            Recorded: <span className="numeric text-ink">{money(t.recordedMinor, t.currency)}</span>
          </span>
          <span>
            Planned: <span className="numeric text-ink">{money(t.plannedMinor, t.currency)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function CategoryTable({ overview }: { overview: BudgetOverview }) {
  const progress = overview.progress!;
  const rows = progress.categories.filter(
    (c) => c.budgetMinor || c.recordedMinor !== '0' || c.plannedMinor !== '0',
  );
  if (rows.length === 0) {
    return (
      <p className="text-body-sm text-ink-secondary">
        No expenses in {progress.currency} yet. Each category’s spending appears here once you add
        expenses.
      </p>
    );
  }
  const c = progress.currency;
  return (
    <div
      // Scrolls sideways on small screens: focusable so keyboard users can scroll it.
      tabIndex={0}
      role="region"
      aria-label={`Spending by category in ${c}`}
      className="overflow-x-auto rounded-xl border border-line bg-card"
    >
      <table className="w-full min-w-[36rem] text-left text-body-sm">
        <caption className="sr-only">Spending by category in {c}</caption>
        <thead className="border-b border-line text-caption text-ink-secondary">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Category
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Recorded
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Planned
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Category budget
            </th>
            <th scope="col" className="w-40 px-4 py-3 font-semibold">
              Used
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const over =
              row.budgetMinor !== null && BigInt(row.recordedMinor) > BigInt(row.budgetMinor);
            const width = barWidth(row.recordedMinor, row.budgetMinor);
            return (
              <tr key={row.category} className="border-b border-line last:border-0">
                <th scope="row" className="px-4 py-3 font-normal text-ink">
                  {EXPENSE_CATEGORY_LABELS[row.category]}
                </th>
                <td className="numeric px-4 py-3 text-right">{money(row.recordedMinor, c)}</td>
                <td className="numeric px-4 py-3 text-right">{money(row.plannedMinor, c)}</td>
                <td className="numeric px-4 py-3 text-right">
                  {row.budgetMinor ? money(row.budgetMinor, c) : '—'}
                </td>
                <td className="px-4 py-3">
                  {row.budgetMinor ? (
                    <span className="flex flex-col gap-1">
                      <span
                        aria-hidden="true"
                        className="h-2 overflow-hidden rounded-full bg-sunken"
                      >
                        <span
                          className={cn(
                            'block h-full rounded-full',
                            over ? 'bg-danger' : 'bg-brand',
                          )}
                          style={{ width: `${width}%` }}
                        />
                      </span>
                      <span
                        className={cn(
                          'text-caption',
                          over ? 'text-danger-ink' : 'text-ink-secondary',
                        )}
                      >
                        {over
                          ? `Over by ${money((BigInt(row.recordedMinor) - BigInt(row.budgetMinor!)).toString(), c)}`
                          : `${money((BigInt(row.budgetMinor!) - BigInt(row.recordedMinor)).toString(), c)} left`}
                      </span>
                    </span>
                  ) : (
                    <span className="text-caption text-ink-secondary">No category budget</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Booking import ──────────────────────────────────────────────────────

function BookingImport({
  tripId,
  offer,
  onAdded,
  onError,
}: {
  tripId: string;
  offer: NonNullable<BudgetOverview['bookingImport']>;
  onAdded: (expense: Expense) => void;
  onError: (error: unknown) => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const add = useMutation({
    mutationFn: () => addBookingExpense(tripId, key),
    onSuccess: onAdded,
    onError,
  });
  return (
    <section
      aria-labelledby="booking-import-heading"
      className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="booking-import-heading" className="text-title">
          Add your linked booking {offer.reference}?
        </h2>
        <p className="text-body-sm text-ink-secondary">
          {money(offer.amountMinor, offer.currency)}.{' '}
          {offer.demo
            ? 'It’s a demo booking, so no money was charged: it will be added as a planned estimate, not as paid.'
            : offer.paid
              ? 'Its payment is confirmed, so it will be added as paid by you and split equally between everyone on the plan. You can change the split afterwards.'
              : 'Its payment isn’t confirmed, so it will be added as a planned estimate, not as paid.'}{' '}
          It can be added once.
        </p>
      </div>
      <Button
        variant="secondary"
        loading={add.isPending}
        disabled={add.isPending}
        onClick={() => add.mutate()}
      >
        <ReceiptText aria-hidden="true" />
        Add booking as expense
      </Button>
    </section>
  );
}

// ─── Expenses ────────────────────────────────────────────────────────────

const EMPTY_FILTERS: ExpenseFilters = {};

function ExpensesSection({
  tripId,
  people,
  canAdd,
  onAdd,
  onEdit,
  onDelete,
}: {
  tripId: string;
  people: BudgetPerson[];
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}) {
  const [filters, setFilters] = useState<ExpenseFilters>(EMPTY_FILTERS);
  const list = useQuery({
    queryKey: plannerKeys.expensesFor(tripId, { ...filters }),
    queryFn: ({ signal }) => listExpenses(tripId, filters, signal),
    placeholderData: (previous) => previous,
  });
  const setFilter = (key: keyof ExpenseFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || undefined, page: undefined }));
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'sort' && k !== 'page' && v);
  const page = Number(filters.page ?? '1');
  const byId = new Map(people.map((p) => [p.id, p]));
  const personOptions = people.map((p) => ({
    value: p.id,
    label: p.isYou ? `${p.name} (you)` : p.role === 'former' ? `${p.name} (former member)` : p.name,
  }));

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div role="status" aria-label="Loading expenses" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  } else if (list.isError) {
    body = (
      <ErrorState
        title="We couldn't load the expenses"
        description="Check your connection, then try again."
        action={
          <Button variant="secondary" onClick={() => void list.refetch()} loading={list.isFetching}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else if (list.data.items.length === 0) {
    body = (
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          icon={<ReceiptText />}
          title={filtered ? 'No expenses match these filters' : 'No expenses yet'}
          description={
            filtered
              ? 'Try another category, person or date range.'
              : canAdd
                ? 'Add what the group has spent, or expects to spend, and who shares each cost.'
                : 'Expenses added by the owner and editors appear here.'
          }
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </Button>
            ) : canAdd ? (
              <Button onClick={onAdd}>
                <Plus aria-hidden="true" />
                Add expense
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else {
    const totalPages = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-ink-secondary" aria-live="polite">
          {list.data.total} {list.data.total === 1 ? 'expense' : 'expenses'}
          {filtered ? ' match' : ''}
        </p>
        <ul
          aria-label="Expenses"
          aria-busy={list.isPlaceholderData || undefined}
          className={cn('flex flex-col gap-3', list.isPlaceholderData && 'opacity-60')}
        >
          {list.data.items.map((expense) => (
            <ExpenseRow
              key={expense.id}
              expense={expense}
              people={byId}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
        {totalPages > 1 ? (
          <nav aria-label="Expense pages" className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: String(page - 1) }))}
            >
              Previous
            </Button>
            <p className="text-body-sm text-ink-secondary">
              Page {page} of {totalPages}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: String(page + 1) }))}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="expenses-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="expenses-heading" className="flex items-center gap-2 text-heading-3">
          <ReceiptText className="size-5 text-ink-secondary" aria-hidden="true" />
          Expenses
        </h2>
        {canAdd ? (
          <Button size="sm" variant="secondary" onClick={onAdd}>
            <Plus aria-hidden="true" />
            Add expense
          </Button>
        ) : null}
      </div>
      <details className="group rounded-xl border border-line bg-card p-4 open:pb-5">
        <summary className="cursor-pointer text-label text-ink">
          Filter and sort{filtered ? ' (filters on)' : ''}
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category">
            <Select
              value={filters.category ?? ''}
              onChange={(e) => setFilter('category', e.target.value)}
            >
              <option value="">All categories</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {EXPENSE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status ?? ''}
              onChange={(e) => setFilter('status', e.target.value)}
            >
              <option value="">Paid and planned</option>
              <option value="paid">Paid</option>
              <option value="planned">Planned (estimates)</option>
            </Select>
          </Field>
          <Field label="Sort by">
            <Select
              value={filters.sort ?? 'date-desc'}
              onChange={(e) => setFilter('sort', e.target.value)}
            >
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="amount-desc">Largest amount first (by currency)</option>
            </Select>
          </Field>
          <Field label="Paid by">
            <Select
              value={filters.payer ?? ''}
              onChange={(e) => setFilter('payer', e.target.value)}
            >
              <option value="">Anyone</option>
              {personOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shared by">
            <Select
              value={filters.participant ?? ''}
              onChange={(e) => setFilter('participant', e.target.value)}
            >
              <option value="">Anyone</option>
              {personOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => setFilter('from', e.target.value)}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => setFilter('to', e.target.value)}
              />
            </Field>
          </div>
        </div>
        {filtered ? (
          <Button
            className="mt-4"
            size="sm"
            variant="ghost"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            Clear filters
          </Button>
        ) : null}
      </details>
      {body}
    </section>
  );
}

function splitSummary(expense: Expense, people: Map<string, BudgetPerson>): string {
  const name = (id: string) => {
    const p = people.get(id);
    return p ? (p.isYou ? 'You' : p.name) : 'Someone';
  };
  const payers = expense.parts.filter((p) => p.paidMinor !== '0');
  const sharers = expense.parts.filter((p) => p.shareMinor !== '0');
  const paid =
    payers.length === 1
      ? `Paid by ${name(payers[0]!.personId)}`
      : `Paid by ${payers.length} people`;
  const how =
    expense.splitMethod === 'equal'
      ? 'split equally'
      : expense.splitMethod === 'percent'
        ? 'split by percentage'
        : 'split by amount';
  return `${paid} · ${how} between ${sharers.length} ${sharers.length === 1 ? 'person' : 'people'}`;
}

function ExpenseRow({
  expense,
  people,
  onEdit,
  onDelete,
}: {
  expense: Expense;
  people: Map<string, BudgetPerson>;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}) {
  const name = (id: string) => {
    const p = people.get(id);
    return p ? (p.isYou ? 'You' : p.name) : 'Someone';
  };
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-body font-semibold break-words text-ink">{expense.description}</p>
          <p className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
            <Badge size="sm" tone="neutral">
              {EXPENSE_CATEGORY_LABELS[expense.category]}
            </Badge>
            {expense.status === 'planned' ? (
              <Badge size="sm" tone="warning">
                Planned · estimate
              </Badge>
            ) : (
              <Badge size="sm" tone="success">
                Paid
              </Badge>
            )}
            <span>{formatDay(expense.spentOn)}</span>
            {expense.bookingReference ? (
              <span className="font-mono">Booking {expense.bookingReference}</span>
            ) : null}
          </p>
        </div>
        <p className="numeric shrink-0 text-title text-ink sm:text-right">
          {money(expense.amountMinor, expense.currency)}
        </p>
      </div>
      {expense.status === 'paid' ? (
        <details className="text-body-sm text-ink-secondary">
          <summary className="cursor-pointer">{splitSummary(expense, people)}</summary>
          <table className="mt-2 w-full max-w-md text-left">
            <caption className="sr-only">Who paid and each share of {expense.description}</caption>
            <thead className="text-caption">
              <tr>
                <th scope="col" className="py-1 font-semibold">
                  Person
                </th>
                <th scope="col" className="py-1 text-right font-semibold">
                  Paid
                </th>
                <th scope="col" className="py-1 text-right font-semibold">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {expense.parts.map((part) => (
                <tr key={part.personId}>
                  <th scope="row" className="py-1 font-normal text-ink">
                    {name(part.personId)}
                    {part.basisPoints ? ` (${percent(part.basisPoints)})` : ''}
                  </th>
                  <td className="numeric py-1 text-right">
                    {money(part.paidMinor, expense.currency)}
                  </td>
                  <td className="numeric py-1 text-right">
                    {money(part.shareMinor, expense.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : (
        <p className="text-body-sm text-ink-secondary">
          An estimate: not counted as paid and not part of anyone’s balance.
        </p>
      )}
      {expense.notes ? (
        <p className="text-body-sm whitespace-pre-line text-ink-secondary">{expense.notes}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-ink-secondary">
          {expense.createdBy
            ? `Added by ${expense.createdBy.isYou ? 'you' : expense.createdBy.name}`
            : null}
        </p>
        {expense.canEdit ? (
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => onEdit(expense)}>
              <Pencil aria-hidden="true" />
              Edit<span className="sr-only"> {expense.description}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(expense)}>
              <Trash2 aria-hidden="true" />
              Delete<span className="sr-only"> {expense.description}</span>
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ─── Balances and settling up ────────────────────────────────────────────

function BalancesSection({
  query,
  people,
  you,
  defaultCurrency,
  onRecord,
  onDeleteSettlement,
}: {
  query: UseQueryResult<Balances>;
  people: Map<string, BudgetPerson>;
  you: BudgetPerson | undefined;
  defaultCurrency: BudgetCurrency;
  onRecord: (draft: SettlementDraft) => void;
  onDeleteSettlement: (settlement: Settlement) => void;
}) {
  const name = (id: string) => {
    const p = people.get(id);
    return p ? (p.isYou ? 'You' : p.name) : 'Someone';
  };
  /** Mid-sentence: "Ravi paid you". */
  const objectName = (id: string) => (people.get(id)?.isYou ? 'you' : name(id));
  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading balances">
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title="We couldn't load the balances"
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
    const data = query.data;
    const canRecordAny = data.canRecordSettlements || Boolean(you);
    const canRecord = (fromId: string, toId: string) =>
      data.canRecordSettlements || fromId === you?.id || toId === you?.id;
    body =
      data.currencies.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-card p-5 text-body-sm text-ink-secondary">
          No balances yet. They appear once a paid expense is shared between people.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {data.currencies.map((cur) => (
            <div
              key={cur.currency}
              className="flex flex-col gap-4 rounded-xl border border-line bg-card p-4 sm:p-5"
            >
              <h3 className="text-title">Balances in {cur.currency}</h3>
              <ul className="flex flex-col gap-2" aria-label={`Balances in ${cur.currency}`}>
                {cur.people.map((b) => {
                  const person = people.get(b.personId);
                  const net = BigInt(b.netMinor);
                  return (
                    <li
                      key={b.personId}
                      className="flex flex-col gap-0.5 border-b border-line pb-2 last:border-0 last:pb-0"
                    >
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'text-body',
                            net > 0n
                              ? 'text-success-ink'
                              : net < 0n
                                ? 'text-danger-ink'
                                : 'text-ink',
                          )}
                        >
                          {person
                            ? balanceText(b.netMinor, cur.currency, person)
                            : `Someone: ${money(b.netMinor, cur.currency)}`}
                        </span>
                        <span className="numeric text-body-sm text-ink" aria-hidden="true">
                          {net > 0n ? '+' : net < 0n ? '−' : ''}
                          {money(abs(b.netMinor), cur.currency)}
                        </span>
                      </span>
                      <span className="text-caption text-ink-secondary">
                        Paid {money(b.paidMinor, cur.currency)} · Share{' '}
                        {money(b.shareMinor, cur.currency)}
                        {b.sentMinor !== '0'
                          ? ` · Paid back ${money(b.sentMinor, cur.currency)}`
                          : ''}
                        {b.receivedMinor !== '0'
                          ? ` · Received ${money(b.receivedMinor, cur.currency)}`
                          : ''}
                        {person?.role === 'former' ? ' · Former member' : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-2">
                <h4 className="flex items-center gap-2 text-label text-ink">
                  <HandCoins className="size-4 text-ink-secondary" aria-hidden="true" />
                  Suggested payments
                </h4>
                {cur.suggestions.length === 0 ? (
                  <p className="text-body-sm text-ink-secondary">
                    Everyone is settled up in {cur.currency}.
                  </p>
                ) : (
                  <>
                    <p className="text-caption text-ink-secondary">
                      Recommendations only: the fewest payments that would settle everyone up.
                      Nothing has been paid. Pay outside Wayora, then record it.
                    </p>
                    <ul className="flex flex-col gap-2">
                      {cur.suggestions.map((s) => (
                        <li
                          key={`${s.fromId}-${s.toId}`}
                          className="flex flex-col gap-2 rounded-lg bg-sunken p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <span className="flex flex-wrap items-center gap-1.5 text-body-sm text-ink">
                            {name(s.fromId)}{' '}
                            <ArrowRight className="size-3.5" aria-label="should pay" />{' '}
                            {name(s.toId)}
                            <span className="numeric font-semibold">
                              {money(s.amountMinor, cur.currency)}
                            </span>
                          </span>
                          {canRecord(s.fromId, s.toId) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                onRecord({
                                  fromId: s.fromId,
                                  toId: s.toId,
                                  amountMinor: s.amountMinor,
                                  currency: cur.currency,
                                })
                              }
                            >
                              Record as paid outside Wayora
                              <span className="sr-only">
                                : {name(s.fromId)} to {objectName(s.toId)},{' '}
                                {money(s.amountMinor, cur.currency)}
                              </span>
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          ))}
          {canRecordAny ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  onRecord({
                    fromId: data.canRecordSettlements ? '' : (you?.id ?? ''),
                    toId: '',
                    amountMinor: null,
                    currency: defaultCurrency,
                  })
                }
              >
                <HandCoins aria-hidden="true" />
                Record a payment
              </Button>
            </div>
          ) : null}
        </div>
      );
    if (data.settlements.length > 0) {
      body = (
        <>
          {body}
          <div className="flex flex-col gap-3">
            <h3 className="text-title">Recorded payments</h3>
            <p className="text-caption text-ink-secondary">
              Payments members say were made outside Wayora. Wayora didn’t process or verify them.
            </p>
            <ul className="flex flex-col gap-2">
              {data.settlements.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-1 rounded-lg border border-line bg-card p-3"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-2 text-body-sm text-ink">
                    <span>
                      {name(s.fromId)} paid {objectName(s.toId)}
                    </span>
                    <span className="numeric font-semibold">
                      {money(s.amountMinor, s.currency)}
                    </span>
                  </span>
                  <span className="text-caption text-ink-secondary">
                    {formatDay(s.settledOn)}
                    {s.recordedBy
                      ? ` · recorded by ${s.recordedBy.isYou ? 'you' : s.recordedBy.name}`
                      : ''}
                  </span>
                  {s.note ? (
                    <span className="text-caption whitespace-pre-line text-ink-secondary">
                      {s.note}
                    </span>
                  ) : null}
                  {s.canDelete ? (
                    <span>
                      <Button size="sm" variant="ghost" onClick={() => onDeleteSettlement(s)}>
                        <Trash2 aria-hidden="true" />
                        Delete record
                        <span className="sr-only">
                          : {name(s.fromId)} paid {objectName(s.toId)}{' '}
                          {money(s.amountMinor, s.currency)}
                        </span>
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </>
      );
    }
  }

  return (
    <section aria-labelledby="balances-heading" className="flex min-w-0 flex-col gap-4">
      <h2 id="balances-heading" className="flex items-center gap-2 text-heading-3">
        <Scale className="size-5 text-ink-secondary" aria-hidden="true" />
        Who owes whom
      </h2>
      <p className="text-body-sm text-ink-secondary">
        Each person’s balance is what they paid minus their share, adjusted by payments recorded
        between members. <strong className="font-semibold text-ink">“Is owed”</strong> (+) means
        others owe them; <strong className="font-semibold text-ink">“owes”</strong> (−) means they
        owe others. Planned estimates don’t count. Each currency is balanced on its own.
      </p>
      {body}
    </section>
  );
}
