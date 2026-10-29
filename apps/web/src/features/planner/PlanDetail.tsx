import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Clock,
  Copy,
  Ellipsis,
  Eye,
  History,
  Link2,
  ListOrdered,
  MapPin,
  NotebookPen,
  Pencil,
  Plus,
  RotateCw,
  SearchX,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  plannedTripIdSchema,
  type ItineraryItem,
  type ItineraryWarning,
  type PlannedTrip,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  useToast,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { listBookings } from '../../services/bookings';
import {
  deleteItineraryItem,
  deletePlannedTrip,
  duplicateItineraryItem,
  getPlannedTrip,
  getTripMembers,
  listPlannerDestinations,
  reorderItineraryDay,
  updateItineraryItem,
  updatePlannedTrip,
} from '../../services/planner';
import { applyServerError } from '../auth/form-errors';
import { bookingKeys } from '../bookings/keys';
import { tripPath } from '../bookings/paths';
import { serviceBySlug } from '../navigation/config';
import { ActivityDialog } from './ActivityDialog';
import { assistantForPlanPath } from '../assistant/paths';
import { PlanBudgetCard } from './budget/PlanBudgetCard';
import { HistorySheet } from './history';
import { usePlanLiveUpdates } from './live';
import { MemberAvatars, MembersDialog, ROLE_LABEL } from './members';
import { SuggestionsPanel } from './SuggestionsPanel';
import {
  TRIP_FORM_FIELDS,
  TripDetailsForm,
  tripBody,
  valuesFromTrip,
  type LinkableBooking,
  type TripFormValues,
} from './TripDetailsForm';
import {
  CATEGORY_ICON,
  categoryLabel,
  formatDateRange,
  formatDay,
  formatLongDay,
  formatMinutes,
} from './format';
import { plannerKeys } from './keys';
import { PLANS_PATH } from './paths';
import { useUnsavedChanges } from './unsaved';

/*
 * /plans/:tripId — one planned trip (docs/planner.md#web): day tabs, each
 * day's schedule in the saved order, schedule warnings, curated sample
 * suggestions, and every edit. Reordering is done with Move up / Move down
 * buttons (keyboard and touch friendly); there is no drag and drop.
 *
 * Shared plans (Phase 19): controls follow the user's role (viewers see no
 * edit controls; only the owner manages members and deletes) — the API
 * enforces the same rules. Other members' changes arrive live (live.ts); a
 * change based on stale data is refused by the API and explained here.
 */

const REORDER_DELAY_MS = 400;

const WARNING_SHORT: Record<ItineraryWarning['code'], string> = {
  overlap: 'Overlaps another activity',
  outside_trip_dates: 'Outside the trip dates',
  missing_start_time: 'No start time',
  out_of_order: 'Listed out of time order',
  ends_next_day: 'Runs past midnight',
  long_day: 'Part of a long day',
};

export function PlanDetailRoute() {
  const { tripId = '' } = useParams();
  const valid = plannedTripIdSchema.safeParse(tripId).success;
  const query = useQuery({
    queryKey: plannerKeys.detail(tripId),
    queryFn: ({ signal }) => getPlannedTrip(tripId, signal),
    enabled: valid,
    retry: false,
  });
  useDocumentTitle(query.data?.title ?? 'Trip plan');

  if (!valid) return <PlanNotFound />;
  if (query.isPending) {
    return (
      <Container className="py-section-sm">
        <div role="status" aria-label="Loading your plan" className="flex flex-col gap-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-80 max-w-full" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </Container>
    );
  }
  if (query.isError) {
    const api = query.error instanceof ApiClientError ? query.error : null;
    if (api?.status === 404) return <PlanNotFound />;
    return (
      <Container size="narrow" className="py-section-sm">
        <h1 className="sr-only">Trip plan</h1>
        <ErrorState
          title="We couldn't load this plan"
          description="Check your connection, then try again."
          reference={api?.requestId ?? undefined}
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
      </Container>
    );
  }
  return <PlanView trip={query.data} />;
}

function PlanNotFound() {
  useDocumentTitle('Plan not found');
  return (
    <Container size="narrow" className="py-section-sm">
      <div className="rounded-xl border border-dashed border-line-strong bg-card">
        <EmptyState
          size="page"
          titleAs="h1"
          icon={<SearchX />}
          title="We couldn't find that plan"
          description="It may have been deleted. You can only see plans made with this account."
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

// ─── The plan ─────────────────────────────────────────────────────────────

function PlanView({ trip }: { trip: PlannedTrip }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const requestedDay = params.get('day');
  const selectedDay = trip.days.some((d) => d.date === requestedDay)
    ? (requestedDay as string)
    : (trip.days[0]?.date ?? trip.startDate);
  const selectDay = (date: string) =>
    setParams(
      (current) => {
        const q = new URLSearchParams(current);
        if (date === trip.days[0]?.date) q.delete('day');
        else q.set('day', date);
        return q;
      },
      { replace: true },
    );

  /** Every write returns the whole trip: store it, refresh what depends on it. */
  const applyTrip = useCallback(
    (updated: PlannedTrip) => {
      queryClient.setQueryData(plannerKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: plannerKeys.suggestions(updated.id) });
      void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
    },
    [queryClient],
  );
  const reportError = useCallback(
    (error: unknown, title: string) => {
      const api = error instanceof ApiClientError ? error : null;
      toast({
        tone: 'danger',
        title,
        description:
          api && api.code !== 'NETWORK_ERROR'
            ? api.message
            : 'Check your connection and try again.',
      });
      if (api?.code === 'PLAN_OUT_OF_DATE' || api?.status === 404 || api?.status === 409) {
        void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(trip.id) });
      }
    },
    [queryClient, toast, trip.id],
  );

  // ── Reorder: optimistic, batched, rolled back on failure ──────────────
  // Moves are shown at once and sent as one request after a short pause, so
  // pressing Move several times sends one reorder, not one per press. Each
  // request says which order it was based on (`base`, the day's saved
  // order); if another member reordered the day meanwhile, the API refuses
  // it and the latest order is shown instead. One request at a time: a batch
  // made while one is saving is sent after it, based on the order it saved.
  type PendingOrder = { day: string; ids: string[]; base: string[] };
  const [pendingOrder, setPendingOrderState] = useState<PendingOrder | null>(null);
  const pendingRef = useRef<PendingOrder | null>(null);
  const setPendingOrder = (value: PendingOrder | null) => {
    pendingRef.current = value;
    setPendingOrderState(value);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const waiting = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const reorder = useMutation({
    mutationFn: (vars: PendingOrder) => reorderItineraryDay(trip.id, vars.day, vars.ids, vars.base),
    onSuccess: (updated, vars) => {
      applyTrip(updated);
      const pending = pendingRef.current;
      if (pending && pending.ids !== vars.ids && pending.day === vars.day) {
        // More moves were made meanwhile: they are based on what was just saved.
        const saved = updated.days.find((d) => d.date === vars.day)?.items.map((i) => i.id);
        if (saved) setPendingOrder({ ...pending, base: saved });
      }
    },
    onError: (error) => {
      // Roll back: drop the local order; the saved (or newer) order is shown again.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      waiting.current = false;
      setPendingOrder(null);
      const conflict = error instanceof ApiClientError && error.code === 'PLAN_OUT_OF_DATE';
      if (conflict) {
        toast({
          tone: 'warning',
          title: 'Someone else changed this day',
          description:
            'Your new order wasn’t saved. The latest order is shown now; move again if you need to.',
        });
        void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(trip.id) });
      } else {
        reportError(error, 'We couldn’t save the new order');
      }
      setAnnouncement('The new order couldn’t be saved, so the saved order is back.');
    },
    onSettled: (_data, error, vars) => {
      inFlight.current = false;
      if (error) return;
      if (pendingRef.current?.ids === vars.ids) setPendingOrder(null);
      else if (waiting.current && pendingRef.current) {
        waiting.current = false;
        send(pendingRef.current);
      }
    },
  });
  const { mutate: mutateOrder } = reorder;
  const send = useCallback(
    (order: PendingOrder) => {
      if (inFlight.current) {
        waiting.current = true; // sent when the current one settles
        return;
      }
      inFlight.current = true;
      mutateOrder(order);
    },
    [mutateOrder],
  );
  /** Sends an order that is still waiting for its pause to end. */
  const flushOrder = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    if (pendingRef.current) send(pendingRef.current);
  }, [send]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // Leaving while an order is waiting or saving: send it now, then continue
  // (or stay, if saving failed).
  const saving = Boolean(pendingOrder) || reorder.isPending;
  const { blocker } = useUnsavedChanges(saving);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (timer.current) flushOrder();
    else if (reorder.isError) blocker.reset();
    else if (!saving) blocker.proceed();
  }, [blocker, saving, reorder.isError, flushOrder]);

  const orderedItems = (date: string, items: ItineraryItem[]) => {
    if (pendingOrder?.day !== date) return items;
    const byId = new Map(items.map((i) => [i.id, i]));
    return pendingOrder.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  };

  // Keep focus on the moved activity's button (or its other one, at an end).
  const moveButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const registerMoveButton = useCallback((key: string, el: HTMLButtonElement | null) => {
    moveButtons.current.set(key, el);
  }, []);
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const [id, dir] = target.split(':');
    const preferred = moveButtons.current.get(`${id}:${dir}`);
    const other = moveButtons.current.get(`${id}:${dir === 'up' ? 'down' : 'up'}`);
    (preferred && !preferred.disabled ? preferred : other)?.focus();
  }, [pendingOrder]);

  const queueOrder = (date: string, ids: string[]) => {
    if (pendingRef.current && pendingRef.current.day !== date) flushOrder();
    const base =
      pendingRef.current?.day === date
        ? pendingRef.current.base
        : (trip.days.find((d) => d.date === date)?.items.map((i) => i.id) ?? []);
    const next = { day: date, ids, base };
    setPendingOrder(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pendingRef.current) send(pendingRef.current);
    }, REORDER_DELAY_MS);
  };

  const move = (date: string, items: ItineraryItem[], index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    queueOrder(date, ids);
    focusAfterMove.current = `${moved}:${delta < 0 ? 'up' : 'down'}`;
    setAnnouncement(`Moved “${items[index]!.title}” to position ${target + 1} of ${items.length}.`);
  };

  const sortByTime = (date: string, items: ItineraryItem[]) => {
    const timed = items
      .filter((i) => i.startTime)
      .sort((a, b) => a.startTime!.localeCompare(b.startTime!));
    const untimed = items.filter((i) => !i.startTime);
    queueOrder(
      date,
      [...timed, ...untimed].map((i) => i.id),
    );
    setAnnouncement('Sorted the day by start time. Activities without a time are now last.');
  };

  // ── Dialog state ──────────────────────────────────────────────────────
  const [activity, setActivity] = useState<{
    open: boolean;
    item: ItineraryItem | null;
    day: string;
  }>({
    open: false,
    item: null,
    day: selectedDay,
  });
  const [moving, setMoving] = useState<ItineraryItem | null>(null);
  const [removing, setRemoving] = useState<ItineraryItem | null>(null);
  const [deletingTrip, setDeletingTrip] = useState(false);
  const [editing, setEditing] = useState(false);

  const duplicateKey = useRef<{ id: string; key: string } | null>(null);
  const duplicate = useMutation({
    mutationFn: (item: ItineraryItem) => {
      if (duplicateKey.current?.id !== item.id)
        duplicateKey.current = { id: item.id, key: crypto.randomUUID() };
      return duplicateItineraryItem(trip.id, item.id, {}, duplicateKey.current.key);
    },
    onSuccess: (updated, item) => {
      duplicateKey.current = null;
      applyTrip(updated);
      toast({ tone: 'success', title: `Duplicated “${item.title}”` });
    },
    onError: (error) => reportError(error, 'We couldn’t duplicate that activity'),
  });
  const removeItem = useMutation({
    mutationFn: (item: ItineraryItem) => deleteItineraryItem(trip.id, item.id),
    onSuccess: (updated, item) => {
      applyTrip(updated);
      setRemoving(null);
      toast({ tone: 'success', title: `Deleted “${item.title}”` });
    },
    onError: (error) => {
      setRemoving(null);
      reportError(error, 'We couldn’t delete that activity');
    },
  });
  // After a delete, the plan's cached data is dropped once this page is gone
  // (dropping it while the page still watches it would fetch it again).
  const deleted = useRef(false);
  useEffect(() => {
    const id = trip.id;
    return () => {
      if (!deleted.current) return;
      setTimeout(() => {
        queryClient.removeQueries({ queryKey: plannerKeys.detail(id) });
        queryClient.removeQueries({ queryKey: plannerKeys.suggestions(id) });
      }, 0);
    };
  }, [queryClient, trip.id]);
  const removeTrip = useMutation({
    mutationFn: () => deletePlannedTrip(trip.id),
    onSuccess: () => {
      toast({ tone: 'success', title: `Deleted the plan “${trip.title}”` });
      deleted.current = true;
      void queryClient.invalidateQueries({ queryKey: plannerKeys.lists });
      void navigate(PLANS_PATH, { replace: true });
    },
    onError: (error) => {
      setDeletingTrip(false);
      reportError(error, 'We couldn’t delete this plan');
    },
  });

  const warningsByItem = useMemo(() => {
    const map = new Map<string, ItineraryWarning[]>();
    for (const w of trip.warnings) {
      for (const id of w.itemIds) map.set(id, [...(map.get(id) ?? []), w]);
    }
    return map;
  }, [trip.warnings]);
  const dayWarnings = (date: string) => trip.warnings.filter((w) => w.day === date);

  const { canEdit, canManage } = trip.access;
  const shared = trip.memberCount > 0 || trip.access.role !== 'owner';
  const live = usePlanLiveUpdates(trip.id, trip.revision, shared);
  const [membersOpen, setMembersOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const members = useQuery({
    queryKey: plannerKeys.members(trip.id),
    queryFn: ({ signal }) => getTripMembers(trip.id, signal),
    enabled: shared,
  });

  const openAdd = (date: string) => setActivity({ open: true, item: null, day: date });
  const openEdit = (item: ItineraryItem) => setActivity({ open: true, item, day: item.day });

  return (
    <Container className="py-section-sm">
      <div className="flex flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: 'Home', link: <Link to="/" /> },
            { label: 'Trip planner', link: <Link to={PLANS_PATH} /> },
            { label: trip.title },
          ]}
        />

        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
              <Badge size="sm" tone="neutral">
                <NotebookPen className="size-3.5" aria-hidden="true" />
                Plan · not booked
              </Badge>
              {shared ? (
                <Badge size="sm" tone={canEdit ? 'brand' : 'neutral'}>
                  {canEdit ? (
                    <Users className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Eye className="size-3.5" aria-hidden="true" />
                  )}
                  {trip.access.role === 'viewer'
                    ? 'View only'
                    : `Shared · ${ROLE_LABEL[trip.access.role]}`}
                </Badge>
              ) : null}
              {shared ? <LiveStatus mode={live} /> : null}
            </p>
            <h1 className="text-heading-1 break-words">{trip.title}</h1>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-ink-secondary">
              <span className="flex items-center gap-1.5">
                <MapPin className="size-4" aria-hidden="true" />
                {trip.destination.country
                  ? `${trip.destination.name}, ${trip.destination.country}`
                  : trip.destination.name}
              </span>
              <span className="flex items-center gap-1.5">
                <CalendarRange className="size-4" aria-hidden="true" />
                {formatDateRange(trip.startDate, trip.endDate)} · {trip.dayCount}{' '}
                {trip.dayCount === 1 ? 'day' : 'days'}
              </span>
              <span>
                {trip.itemCount} {trip.itemCount === 1 ? 'activity' : 'activities'}
              </span>
              {!trip.owner.isYou ? <span>Owner: {trip.owner.name}</span> : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setMembersOpen(true)}>
              {shared && members.data ? (
                <MemberAvatars members={members.data} />
              ) : (
                <Users aria-hidden="true" />
              )}
              {canManage ? 'Share' : 'Members'}
              {shared ? <span className="sr-only">: {trip.memberCount + 1} people</span> : null}
            </Button>
            <Button variant="ghost" onClick={() => setHistoryOpen(true)}>
              <History aria-hidden="true" />
              History
            </Button>
            <Button asChild variant="ghost">
              <Link to={assistantForPlanPath(trip.id)}>
                <Sparkles aria-hidden="true" />
                Ask the assistant
              </Link>
            </Button>
            {canEdit ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" />
                Edit details
              </Button>
            ) : null}
            {canManage ? (
              <Button variant="ghost" onClick={() => setDeletingTrip(true)}>
                <Trash2 aria-hidden="true" />
                Delete plan
              </Button>
            ) : null}
          </div>
        </header>

        <Alert tone="info" role="none" title="A plan, not a booking">
          Nothing here is reserved or paid for. Times are local to {trip.destination.name}
          {trip.destination.timeZone ? ` (${trip.destination.timeZone})` : ''}.{' '}
          <strong className="font-semibold text-ink">Not travel-time-validated:</strong> Wayora
          doesn’t check how long it takes to get between activities.
        </Alert>

        {trip.linkedBooking ? (
          <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-secondary">
            <Link2 className="size-4" aria-hidden="true" />
            Linked booking:{' '}
            <Link
              to={tripPath(trip.linkedBooking.reference)}
              className="font-mono text-ink underline"
            >
              {trip.linkedBooking.reference}
            </Link>
            <span>
              ({serviceBySlug[trip.linkedBooking.category].name}
              {trip.linkedBooking.demo ? ', demo booking' : ''}, {trip.linkedBooking.status})
            </span>
          </p>
        ) : null}

        {trip.access.role === 'viewer' ? (
          <p className="text-body-sm text-ink-secondary">
            You can view this plan. Ask {trip.owner.name} for editor access if you’d like to change
            it.
          </p>
        ) : null}

        {trip.notes ? (
          <p className="max-w-3xl text-body whitespace-pre-line text-ink-secondary">{trip.notes}</p>
        ) : null}

        <PlanBudgetCard tripId={trip.id} />

        <WarningsSummary trip={trip} onShowDay={selectDay} />

        {trip.outsideDates.length > 0 ? (
          <section
            aria-labelledby="outside-heading"
            className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 sm:p-5"
          >
            <h2 id="outside-heading" className="flex items-center gap-2 text-title">
              <TriangleAlert className="size-5 text-warning" aria-hidden="true" />
              Outside the trip dates
            </h2>
            <p className="text-body-sm text-ink-secondary">
              The trip dates changed. These activities were kept
              {canEdit ? ' — move each one to a trip day, or delete it.' : '.'}
            </p>
            <ul className="flex flex-col gap-2">
              {trip.outsideDates.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-3"
                >
                  <span className="min-w-0">
                    <span className="block text-body font-semibold break-words text-ink">
                      {item.title}
                    </span>
                    <span className="text-body-sm text-ink-secondary">
                      Was on {formatDay(item.day)}
                    </span>
                  </span>
                  {canEdit ? (
                    <span className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setMoving(item)}>
                        Move to a trip day
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(item)}>
                        Delete
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
          <section aria-labelledby="itinerary-heading" className="flex min-w-0 flex-col gap-4">
            <h2 id="itinerary-heading" className="sr-only">
              Itinerary
            </h2>
            <Tabs
              value={selectedDay}
              onValueChange={(value) => {
                flushOrder();
                selectDay(value);
              }}
            >
              <div className="-mx-1 overflow-x-auto px-1 pb-1">
                <TabsList label="Trip days" className="w-max rounded-lg bg-sunken p-1">
                  {trip.days.map((d) => (
                    <TabsTrigger
                      key={d.date}
                      value={d.date}
                      meta={
                        <span className="numeric text-caption text-ink-secondary">
                          {d.items.length}
                          <span className="sr-only">
                            {' '}
                            {d.items.length === 1 ? 'activity' : 'activities'}
                          </span>
                          {dayWarnings(d.date).length > 0 ? (
                            <>
                              <TriangleAlert
                                className="ml-1 inline size-3.5 text-warning"
                                aria-hidden="true"
                              />
                              <span className="sr-only">, has warnings</span>
                            </>
                          ) : null}
                        </span>
                      }
                    >
                      <span className="flex flex-col items-start leading-tight">
                        <span>Day {d.dayNumber}</span>
                        <span className="text-caption font-normal">{formatDay(d.date)}</span>
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {trip.days.map((d) =>
                d.date === selectedDay ? (
                  <TabsContent key={d.date} value={d.date} className="pt-4">
                    <DaySchedule
                      date={d.date}
                      dayNumber={d.dayNumber}
                      items={orderedItems(d.date, d.items)}
                      saving={
                        pendingOrder?.day === d.date ||
                        (reorder.isPending && reorder.variables?.day === d.date)
                      }
                      warnings={dayWarnings(d.date)}
                      warningsByItem={warningsByItem}
                      registerMoveButton={registerMoveButton}
                      onAdd={() => openAdd(d.date)}
                      onEdit={openEdit}
                      onMove={(items, index, delta) => move(d.date, items, index, delta)}
                      onSortByTime={(items) => sortByTime(d.date, items)}
                      onMoveToDay={setMoving}
                      onDuplicate={(item) => duplicate.mutate(item)}
                      onDelete={setRemoving}
                      busy={duplicate.isPending}
                      canEdit={canEdit}
                      shared={shared}
                    />
                  </TabsContent>
                ) : null,
              )}
            </Tabs>
            <p aria-live="polite" className="sr-only">
              {announcement}
            </p>
          </section>

          <SuggestionsPanel
            trip={trip}
            day={selectedDay}
            canAdd={canEdit}
            onAdded={(updated, message) => {
              applyTrip(updated);
              toast({ tone: 'success', title: message });
            }}
          />
        </div>
      </div>

      {activity.open && canEdit ? (
        <ActivityDialog
          open
          onOpenChange={(open) => setActivity((a) => ({ ...a, open }))}
          trip={trip}
          item={activity.item}
          day={activity.day}
          onSaved={(updated, message) => {
            applyTrip(updated);
            toast({ tone: 'success', title: message });
          }}
        />
      ) : null}
      {moving && canEdit ? (
        <MoveDialog
          key={moving.id}
          trip={trip}
          item={moving}
          onClose={() => setMoving(null)}
          onMoved={(updated, message) => {
            applyTrip(updated);
            toast({ tone: 'success', title: message });
          }}
          onError={(error) => reportError(error, 'We couldn’t move that activity')}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && !removeItem.isPending && setRemoving(null)}
      >
        <DialogContent
          size="sm"
          title="Delete this activity?"
          description={removing ? `“${removing.title}” will be removed from this plan.` : undefined}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setRemoving(null)}
                disabled={removeItem.isPending}
              >
                Keep it
              </Button>
              <Button
                variant="destructive"
                loading={removeItem.isPending}
                disabled={removeItem.isPending}
                onClick={() => removing && removeItem.mutate(removing)}
              >
                Delete activity
              </Button>
            </>
          }
        />
      </Dialog>
      <Dialog
        open={deletingTrip}
        onOpenChange={(open) => !removeTrip.isPending && setDeletingTrip(open)}
      >
        <DialogContent
          size="sm"
          title="Delete this plan?"
          description={`“${trip.title}” and its ${trip.itemCount} ${trip.itemCount === 1 ? 'activity' : 'activities'} will be deleted. This can’t be undone. Bookings aren’t affected.`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDeletingTrip(false)}
                disabled={removeTrip.isPending}
              >
                Keep plan
              </Button>
              <Button
                variant="destructive"
                loading={removeTrip.isPending}
                disabled={removeTrip.isPending}
                onClick={() => removeTrip.mutate()}
              >
                Delete plan
              </Button>
            </>
          }
        />
      </Dialog>
      {editing && canEdit ? (
        <EditDetailsDialog
          open
          onOpenChange={setEditing}
          trip={trip}
          onSaved={(updated) => {
            applyTrip(updated);
            toast({ tone: 'success', title: 'Plan details saved' });
          }}
        />
      ) : null}
      <MembersDialog trip={trip} open={membersOpen} onOpenChange={setMembersOpen} />
      <HistorySheet
        trip={trip}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onShowDay={selectDay}
      />
    </Container>
  );
}

/** Whether other members' changes arrive by themselves. */
function LiveStatus({ mode }: { mode: ReturnType<typeof usePlanLiveUpdates> }) {
  if (mode === 'off') return null;
  const text =
    mode === 'live'
      ? 'Live: changes by others appear automatically'
      : mode === 'polling'
        ? 'Checks for changes every 30 seconds'
        : 'Connecting for live updates…';
  return (
    <span className="flex items-center gap-1.5 text-caption text-ink-secondary">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          mode === 'live' ? 'bg-success' : mode === 'polling' ? 'bg-warning' : 'bg-line-strong',
        )}
      />
      {text}
    </span>
  );
}

// ─── Warnings ────────────────────────────────────────────────────────────

function WarningsSummary({
  trip,
  onShowDay,
}: {
  trip: PlannedTrip;
  onShowDay: (day: string) => void;
}) {
  const relevant = trip.warnings.filter((w) => w.code !== 'outside_trip_dates');
  if (relevant.length === 0) return null;
  const dayNumber = new Map(trip.days.map((d) => [d.date, d.dayNumber]));
  return (
    <section
      aria-labelledby="warnings-heading"
      className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 sm:p-5"
    >
      <h2 id="warnings-heading" className="flex items-center gap-2 text-title">
        <TriangleAlert className="size-5 text-warning" aria-hidden="true" />
        {relevant.length === 1 ? '1 thing to check' : `${relevant.length} things to check`}
      </h2>
      <p className="text-body-sm text-ink-secondary">
        Based only on the times and durations you entered. Your plan is saved either way.
      </p>
      <ul className="flex flex-col gap-2">
        {relevant.map((w, index) => (
          <li
            key={`${w.code}-${w.day}-${index}`}
            className="flex flex-wrap items-start justify-between gap-2 text-body-sm"
          >
            <span className="flex min-w-0 gap-2">
              <span className="shrink-0 font-semibold text-ink">
                Day {dayNumber.get(w.day)} · {formatDay(w.day)}:
              </span>
              <span className="break-words text-ink-secondary">{w.message}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => onShowDay(w.day)}>
              Show day {dayNumber.get(w.day)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── One day ─────────────────────────────────────────────────────────────

function DaySchedule({
  date,
  dayNumber,
  items,
  saving,
  warnings,
  warningsByItem,
  registerMoveButton,
  onAdd,
  onEdit,
  onMove,
  onSortByTime,
  onMoveToDay,
  onDuplicate,
  onDelete,
  busy,
  canEdit,
  shared,
}: {
  date: string;
  dayNumber: number;
  items: ItineraryItem[];
  saving: boolean;
  warnings: ItineraryWarning[];
  warningsByItem: Map<string, ItineraryWarning[]>;
  registerMoveButton: (key: string, el: HTMLButtonElement | null) => void;
  onAdd: () => void;
  onEdit: (item: ItineraryItem) => void;
  onMove: (items: ItineraryItem[], index: number, delta: -1 | 1) => void;
  onSortByTime: (items: ItineraryItem[]) => void;
  onMoveToDay: (item: ItineraryItem) => void;
  onDuplicate: (item: ItineraryItem) => void;
  onDelete: (item: ItineraryItem) => void;
  busy: boolean;
  /** Show edit controls (owners and editors; the API checks again). */
  canEdit: boolean;
  /** A shared plan shows who added each activity. */
  shared: boolean;
}) {
  const headingId = `day-${date}-heading`;
  const outOfOrder = warnings.some((w) => w.code === 'out_of_order');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-heading-3">
          Day {dayNumber}{' '}
          <span className="font-normal text-ink-secondary">· {formatLongDay(date)}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {saving ? (
            <span role="status" className="text-caption text-ink-secondary">
              Saving order…
            </span>
          ) : null}
          {outOfOrder && canEdit ? (
            <Button size="sm" variant="secondary" onClick={() => onSortByTime(items)}>
              <ListOrdered aria-hidden="true" />
              Sort by time
            </Button>
          ) : null}
          {canEdit ? (
            <Button size="sm" onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add activity
            </Button>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            icon={<CalendarRange />}
            title={`Nothing planned for day ${dayNumber} yet`}
            description={
              canEdit
                ? 'Add your own activity, or pick one of the sample suggestions.'
                : 'Activities added by the plan’s editors will appear here.'
            }
            action={
              canEdit ? (
                <Button onClick={onAdd}>
                  <Plus aria-hidden="true" />
                  Add the first activity
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ol aria-labelledby={headingId} className="relative flex flex-col gap-3">
          {items.map((item, index) => (
            <ActivityCard
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              warnings={warningsByItem.get(item.id) ?? []}
              registerButton={(dir, el) => registerMoveButton(`${item.id}:${dir}`, el)}
              onMoveUp={() => onMove(items, index, -1)}
              onMoveDown={() => onMove(items, index, 1)}
              onEdit={() => onEdit(item)}
              onMoveToDay={() => onMoveToDay(item)}
              onDuplicate={() => onDuplicate(item)}
              onDelete={() => onDelete(item)}
              busy={busy}
              canEdit={canEdit}
              shared={shared}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ActivityCard({
  item,
  index,
  count,
  warnings,
  registerButton,
  onMoveUp,
  onMoveDown,
  onEdit,
  onMoveToDay,
  onDuplicate,
  onDelete,
  busy,
  canEdit,
  shared,
}: {
  item: ItineraryItem;
  index: number;
  count: number;
  warnings: ItineraryWarning[];
  registerButton: (dir: 'up' | 'down', el: HTMLButtonElement | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onMoveToDay: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  busy: boolean;
  canEdit: boolean;
  shared: boolean;
}) {
  const Icon = CATEGORY_ICON[item.category];
  const shortWarnings = [...new Set(warnings.map((w) => WARNING_SHORT[w.code]))];
  const time = item.startTime
    ? item.endTime
      ? `${item.startTime}–${item.endTime}${item.endsNextDay ? ' (+1 day)' : ''}`
      : item.startTime
    : 'Any time';
  return (
    <li
      className={cn(
        'grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-xl border bg-card p-4 shadow-xs sm:gap-4',
        canEdit && 'sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]',
        !canEdit && 'sm:grid-cols-[5.5rem_minmax(0,1fr)]',
        warnings.length > 0 ? 'border-warning/40' : 'border-line',
      )}
    >
      <div className="flex flex-col gap-1 pt-0.5">
        <span
          className={cn(
            'numeric text-body-sm font-semibold',
            item.startTime ? 'text-ink' : 'text-ink-secondary',
          )}
        >
          {time}
        </span>
        {item.durationMinutes ? (
          <span className="flex items-center gap-1 text-caption text-ink-secondary">
            <Clock className="size-3.5" aria-hidden="true" />
            {formatMinutes(item.durationMinutes)}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <Badge size="sm" tone="brand">
            <Icon className="size-3.5" aria-hidden="true" />
            {categoryLabel(item.category)}
          </Badge>
          {item.suggestionId ? (
            <span className="text-caption text-ink-secondary">From sample suggestions</span>
          ) : null}
          {shared && item.addedBy ? (
            <span className="text-caption text-ink-secondary">
              Added by {item.addedBy.isYou ? 'you' : item.addedBy.name}
            </span>
          ) : null}
        </span>
        <h4 className="text-title break-words">{item.title}</h4>
        {item.location ? (
          <p className="flex items-center gap-1.5 text-body-sm text-ink-secondary">
            <MapPin className="size-4 shrink-0" aria-hidden="true" />
            <span className="break-words">{item.location}</span>
          </p>
        ) : null}
        {item.notes ? (
          <p className="text-body-sm break-words whitespace-pre-line text-ink-secondary">
            {item.notes}
          </p>
        ) : null}
        {shortWarnings.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-body-sm font-medium text-warning-ink">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            <span className="sr-only">Warning: </span>
            {shortWarnings.join(' · ')}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <div className="col-span-2 flex items-center justify-end gap-1 border-t border-line pt-2 sm:col-span-1 sm:flex-col sm:items-end sm:border-0 sm:pt-0">
          <span className="flex gap-1">
            <IconButton
              ref={(el) => registerButton('up', el)}
              label={`Move “${item.title}” up`}
              icon={<ArrowUp />}
              size="md"
              disabled={index === 0}
              onClick={onMoveUp}
            />
            <IconButton
              ref={(el) => registerButton('down', el)}
              label={`Move “${item.title}” down`}
              icon={<ArrowDown />}
              size="md"
              disabled={index === count - 1}
              onClick={onMoveDown}
            />
          </span>
          <span className="flex gap-1">
            <IconButton
              label={`Edit “${item.title}”`}
              icon={<Pencil />}
              size="md"
              onClick={onEdit}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={`More actions for “${item.title}”`}
                  icon={<Ellipsis />}
                  size="md"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem icon={<CalendarRange />} onSelect={onMoveToDay}>
                  Move to another day
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Copy />} onSelect={onDuplicate} disabled={busy}>
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Trash2 />} destructive onSelect={onDelete}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      ) : null}
    </li>
  );
}

// ─── Move to another day ─────────────────────────────────────────────────

function MoveDialog({
  trip,
  item,
  onClose,
  onMoved,
  onError,
}: {
  trip: PlannedTrip;
  item: ItineraryItem;
  onClose: () => void;
  onMoved: (trip: PlannedTrip, message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [day, setDay] = useState(() => trip.days.find((d) => d.date !== item.day)?.date ?? '');
  const move = useMutation({
    mutationFn: (vars: { item: ItineraryItem; day: string }) =>
      updateItineraryItem(trip.id, vars.item.id, { version: vars.item.version, day: vars.day }),
    onSuccess: (updated, vars) => {
      const target = updated.days.find((d) => d.date === vars.day);
      onMoved(updated, `Moved “${vars.item.title}” to day ${target?.dayNumber ?? ''}`.trim());
      onClose();
    },
    onError: (error) => {
      onError(error);
      onClose();
    },
  });
  const options = trip.days
    .filter((d) => d.date !== item.day)
    .map((d) => ({ value: d.date, label: `Day ${d.dayNumber} · ${formatDay(d.date)}` }));
  return (
    <Dialog open onOpenChange={(open) => !open && !move.isPending && onClose()}>
      <DialogContent
        size="sm"
        title="Move to another day"
        description={`“${item.title}” goes to the end of the day you choose.`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={move.isPending}>
              Cancel
            </Button>
            <Button
              loading={move.isPending}
              disabled={move.isPending || !day}
              onClick={() => day && move.mutate({ item, day })}
            >
              Move activity
            </Button>
          </>
        }
      >
        {options.length === 0 ? (
          <p>This trip has only one day.</p>
        ) : (
          <Field label="Day">
            <Select value={day} onChange={(e) => setDay(e.target.value)} options={options} />
          </Field>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit trip details ───────────────────────────────────────────────────

function EditDetailsDialog({
  open,
  onOpenChange,
  trip,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trip: PlannedTrip;
  onSaved: (trip: PlannedTrip) => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [outOfDate, setOutOfDate] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const destinations = useQuery({
    queryKey: plannerKeys.destinations,
    queryFn: ({ signal }) => listPlannerDestinations(signal),
    enabled: open,
    staleTime: Infinity,
  });
  const bookings = useQuery({
    queryKey: [...bookingKeys.lists, 'upcoming', 'linkable'],
    queryFn: ({ signal }) => listBookings({ view: 'upcoming', page: 1, pageSize: 50 }, signal),
    // Only the owner links a booking (their own); members never see one.
    enabled: open && trip.access.canManage,
  });

  const linkable: LinkableBooking[] = (bookings.data?.items ?? [])
    .filter((b) => b.status === 'confirmed')
    .map((b) => ({
      reference: b.reference,
      label: `${b.reference} · ${serviceBySlug[b.serviceType].name}${b.startsOn ? ` · ${formatDay(b.startsOn)}` : ''}`,
    }));
  if (trip.linkedBooking && !linkable.some((b) => b.reference === trip.linkedBooking!.reference)) {
    linkable.unshift({
      reference: trip.linkedBooking.reference,
      label: `${trip.linkedBooking.reference} (${trip.linkedBooking.status})`,
    });
  }

  const save = useMutation({
    mutationFn: (values: TripFormValues) => {
      const body = tripBody(values);
      const linked = trip.linkedBooking?.reference ?? '';
      return updatePlannedTrip(trip.id, {
        version: trip.version,
        title: body.title,
        destinationId: body.destinationId ?? null,
        destinationName: body.destinationName ?? null,
        startDate: body.startDate,
        endDate: body.endDate,
        notes: body.notes ?? null,
        ...(body.preferences ? { preferences: body.preferences } : {}),
        ...(trip.access.canManage && values.bookingReference !== linked
          ? { bookingReference: values.bookingReference || null }
          : {}),
      });
    },
    onSuccess: (updated) => {
      onSaved(updated);
      onOpenChange(false);
    },
  });

  const requestClose = (next: boolean) => {
    if (next) return onOpenChange(true);
    if (save.isPending) return;
    if (dirty && !confirmDiscard) return setConfirmDiscard(true);
    onOpenChange(false);
  };

  let body: ReactNode;
  if (destinations.isPending) {
    body = <Skeleton className="h-96 rounded-xl" />;
  } else if (destinations.isError) {
    body = (
      <ErrorState
        title="We couldn't load the destinations"
        description="Check your connection, then try again."
        action={
          <Button variant="secondary" onClick={() => void destinations.refetch()}>
            Try again
          </Button>
        }
      />
    );
  } else {
    body = (
      <TripDetailsForm
        mode="edit"
        destinations={destinations.data.items}
        defaultValues={valuesFromTrip(trip)}
        linkableBookings={trip.access.canManage ? linkable : undefined}
        submitting={save.isPending}
        formError={formError}
        formErrorAction={
          outOfDate ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: plannerKeys.detail(trip.id) });
                onOpenChange(false);
              }}
            >
              Reload the plan
            </Button>
          ) : undefined
        }
        submitLabel="Save details"
        onDirtyChange={setDirty}
        onCancel={() => requestClose(false)}
        onSubmit={(values, setError) => {
          setFormError(null);
          setOutOfDate(false);
          save.mutate(values, {
            onError: (error) => {
              setOutOfDate(error instanceof ApiClientError && error.code === 'PLAN_OUT_OF_DATE');
              setFormError(applyServerError(error, setError, TRIP_FORM_FIELDS));
            },
          });
        }}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        size="lg"
        title="Edit plan details"
        description="Dates, destination, notes and planning preferences."
        footer={
          confirmDiscard ? (
            <>
              <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="destructive" onClick={() => onOpenChange(false)}>
                Discard changes
              </Button>
            </>
          ) : undefined
        }
      >
        {confirmDiscard ? (
          <Alert tone="warning" title="Discard your changes?" className="mb-4">
            You’ve changed this plan’s details but haven’t saved them.
          </Alert>
        ) : null}
        <div className={cn(confirmDiscard && 'hidden')}>{body}</div>
      </DialogContent>
    </Dialog>
  );
}
