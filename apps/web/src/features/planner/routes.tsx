import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Link2,
  MapPin,
  NotebookPen,
  Plus,
  Users,
  RotateCw,
} from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { PlannedTripSummary } from '@wayora/contracts';
import { Badge, Button, EmptyState, ErrorState, Skeleton, cn } from '@wayora/ui';
import { RevealGroup, RevealItem } from '@wayora/ui/motion';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  createPlannedTrip,
  listPlannedTrips,
  listPlannerDestinations,
} from '../../services/planner';
import { AccountShell, Panel } from '../account/AccountShell';
import { applyServerError } from '../auth/form-errors';
import {
  EMPTY_TRIP_VALUES,
  TRIP_FORM_FIELDS,
  TripDetailsForm,
  tripBody,
  type TripFormValues,
} from './TripDetailsForm';
import { formatDateRange } from './format';
import { InvitationsPanel } from './invitations';
import { ROLE_LABEL } from './members';
import { plannerKeys } from './keys';
import { NEW_PLAN_PATH, PLANS_PATH, planPath } from './paths';
import { LeaveDialog, useUnsavedChanges } from './unsaved';

export { PlanDetailRoute } from './PlanDetail';
export { InvitationRoute } from './invitations';
export { BudgetRoute } from './budget/BudgetRoute';

/*
 * /plans and /plans/new (docs/planner.md#web). Signed-in only; the API
 * returns only this account's plans. Plans are not bookings: they live under
 * their own "Trip planner" entry, apart from My trips.
 */

const PAGE_SIZE = 20;
const PLANNER_DESCRIPTION =
  'Plan day-by-day itineraries for trips you’re thinking about. Plans are private to your account. They are not bookings: nothing is reserved or paid for.';

// ─── /plans ───────────────────────────────────────────────────────────────

export function PlansRoute() {
  useDocumentTitle('Trip planner');
  const [params, setParams] = useSearchParams();
  const pageParam = Number(params.get('page') ?? '1');
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 100 ? pageParam : 1;
  const list = useQuery({
    queryKey: plannerKeys.list(page),
    queryFn: ({ signal }) => listPlannedTrips({ page, pageSize: PAGE_SIZE }, signal),
    placeholderData: (previous) => previous,
  });
  const setPage = (next: number) => setParams(next === 1 ? {} : { page: String(next) });

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div role="status" aria-label="Loading your plans" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  } else if (list.isError) {
    body = (
      <ErrorState
        title="We couldn't load your plans"
        description="Check your connection, then try again."
        reference={
          list.error instanceof ApiClientError ? (list.error.requestId ?? undefined) : undefined
        }
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
          size="page"
          icon={<NotebookPen />}
          title="No plans yet"
          description="Start a plan with your destination and dates, then build each day — your own activities or sample suggestions."
          action={
            <Button asChild>
              <Link to={NEW_PLAN_PATH}>
                <Plus aria-hidden="true" />
                Start a plan
              </Link>
            </Button>
          }
        />
      </div>
    );
  } else {
    const totalPages = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    body = (
      <div className="flex flex-col gap-4">
        <RevealGroup
          as="ul"
          trigger="mount"
          stagger="tight"
          aria-label="Your plans"
          aria-busy={list.isPlaceholderData || undefined}
          className={cn('flex flex-col gap-3', list.isPlaceholderData && 'opacity-60')}
        >
          {list.data.items.map((plan) => (
            <RevealItem as="li" key={plan.id} distance="sm">
              <PlanCard plan={plan} />
            </RevealItem>
          ))}
        </RevealGroup>
        {totalPages > 1 ? (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <p className="text-body-sm text-ink-secondary" aria-live="polite">
              Page {page} of {totalPages}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
        {list.data.total >= list.data.limit ? (
          <p className="text-body-sm text-ink-secondary">
            You’ve reached {list.data.limit} plans, the most an account can keep. Delete one to
            start another.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <AccountShell
      title="Trip planner"
      description={PLANNER_DESCRIPTION}
      actions={
        list.data && list.data.items.length > 0 ? (
          <Button asChild>
            <Link to={NEW_PLAN_PATH}>
              <Plus aria-hidden="true" />
              New plan
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <InvitationsPanel />
        {body}
      </div>
    </AccountShell>
  );
}

function PlanCard({ plan }: { plan: PlannedTripSummary }) {
  return (
    <Link
      to={planPath(plan.id)}
      className="group flex flex-col gap-3 rounded-xl border border-line bg-card p-4 shadow-xs transition-colors hover:border-line-strong sm:flex-row sm:items-center sm:p-5"
    >
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:size-5"
      >
        <NotebookPen strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-title break-words group-hover:underline">{plan.title}</span>
          {plan.access.role !== 'owner' ? (
            <Badge size="sm" tone={plan.access.canEdit ? 'brand' : 'neutral'}>
              Shared with you · {ROLE_LABEL[plan.access.role]}
            </Badge>
          ) : plan.memberCount > 0 ? (
            <Badge size="sm" tone="neutral">
              <Users className="size-3.5" aria-hidden="true" />
              Shared with {plan.memberCount}
            </Badge>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-secondary">
          <span className="flex items-center gap-1">
            <MapPin className="size-3.5" aria-hidden="true" />
            {plan.destination.name}
          </span>
          <span className="flex items-center gap-1">
            <CalendarRange className="size-3.5" aria-hidden="true" />
            {formatDateRange(plan.startDate, plan.endDate)}
          </span>
          {plan.linkedBooking ? (
            <span className="flex items-center gap-1">
              <Link2 className="size-3.5" aria-hidden="true" />
              Linked to {plan.linkedBooking.reference}
            </span>
          ) : null}
          {!plan.owner.isYou ? <span>Owner: {plan.owner.name}</span> : null}
        </span>
      </span>
      <span className="text-body-sm text-ink-secondary sm:text-right">
        {plan.dayCount} {plan.dayCount === 1 ? 'day' : 'days'} · {plan.itemCount}{' '}
        {plan.itemCount === 1 ? 'activity' : 'activities'}
      </span>
    </Link>
  );
}

// ─── /plans/new ───────────────────────────────────────────────────────────

export function NewPlanRoute() {
  useDocumentTitle('New plan');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const destinations = useQuery({
    queryKey: plannerKeys.destinations,
    queryFn: ({ signal }) => listPlannerDestinations(signal),
    staleTime: Infinity,
  });

  const { blocker, allowNavigation } = useUnsavedChanges(dirty);

  // One idempotency key per distinct request: a retry or double submit
  // reuses it, so one plan is created.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: (values: TripFormValues) => {
      const body = tripBody(values);
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createPlannedTrip(body, attempt.current.key);
    },
    onSuccess: (trip) => {
      queryClient.setQueryData(plannerKeys.detail(trip.id), trip);
      void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
      allowNavigation();
      void navigate(planPath(trip.id), { replace: true });
    },
  });

  const preselected = params.get('destination');
  const defaults: TripFormValues = {
    ...EMPTY_TRIP_VALUES,
    destinationId: destinations.data?.items.some((d) => d.id === preselected)
      ? (preselected as string)
      : '',
  };

  let body: ReactNode;
  if (destinations.isPending) {
    body = (
      <div role="status" aria-label="Loading the form" className="flex flex-col gap-4">
        <Skeleton className="h-11 rounded-md" />
        <Skeleton className="h-11 rounded-md" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  } else if (destinations.isError) {
    body = (
      <ErrorState
        title="We couldn't load the planner"
        description="Check your connection, then try again."
        action={
          <Button
            variant="secondary"
            onClick={() => void destinations.refetch()}
            loading={destinations.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else {
    body = (
      <TripDetailsForm
        mode="create"
        destinations={destinations.data.items}
        defaultValues={defaults}
        submitting={create.isPending || create.isSuccess}
        formError={formError}
        submitLabel="Create plan"
        onDirtyChange={onDirtyChange}
        onCancel={() => void navigate(PLANS_PATH)}
        onSubmit={(values, setError) => {
          setFormError(null);
          create.mutate(values, {
            onError: (error) => setFormError(applyServerError(error, setError, TRIP_FORM_FIELDS)),
          });
        }}
      />
    );
  }

  return (
    <AccountShell title="New plan" description={PLANNER_DESCRIPTION}>
      <Panel title="Trip details" description="You can change any of this later.">
        {body}
      </Panel>
      <LeaveDialog blocker={blocker} />
    </AccountShell>
  );
}
