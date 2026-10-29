import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EXPENSE_CATEGORY_LABELS,
  type ApplyAssistantProposalInput,
  type AssistantApplyResult,
  type AssistantBlockOf,
  type PlannedTripSummary,
} from '@wayora/contracts';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
} from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { applyAssistantProposal, checkAssistantItinerary } from '../../services/assistant';
import { getBudget, listPlannedTrips } from '../../services/planner';
import { money } from '../planner/budget/money';
import { datesBetweenInclusive, formatDateRange, formatDay, localToday } from './dates';
import { plannerKeys } from '../planner/keys';

/*
 * Applying a proposal (docs/assistant.md#applying). Nothing changes until the
 * user confirms here; the request carries `confirm: true` and the API checks
 * the user's role on the plan, the dates, limits and versions like any other
 * edit. Existing activities, expenses and bookings are never removed or
 * changed by these actions.
 */

export interface ApplyTarget {
  conversationId: string;
  messageId: string;
}

function errorText(error: unknown): string {
  const api = error instanceof ApiClientError ? error : null;
  if (!api || api.code === 'NETWORK_ERROR') {
    return 'We couldn’t reach Wayora. Check your connection and try again.';
  }
  if (api.code === 'PLAN_OUT_OF_DATE') {
    return `${api.message} Nothing was changed.`;
  }
  return [api.message, ...api.details.map((d) => d.message)].join(' ');
}

/** One Idempotency-Key per distinct attempt: retries of the same request reuse it. */
function useApply(target: ApplyTarget, onApplied: (result: AssistantApplyResult) => void) {
  const attempt = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (body: ApplyAssistantProposalInput) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return applyAssistantProposal(
        target.conversationId,
        target.messageId,
        body,
        attempt.current.key,
      );
    },
    onSuccess: onApplied,
  });
}

function useEditablePlans() {
  return useQuery({
    queryKey: [...plannerKeys.lists, 'editable'],
    queryFn: ({ signal }) => listPlannedTrips({ page: 1, pageSize: 50 }, signal),
    select: (list) => list.items.filter((p) => p.access.canEdit),
  });
}

function Frame({
  title,
  description,
  onClose,
  busy,
  confirm,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  busy: boolean;
  confirm: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        size="lg"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {confirm}
          </>
        }
      >
        <div className="flex flex-col gap-5 pb-2" aria-busy={busy || undefined}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const planLabel = (p: PlannedTripSummary) =>
  `${p.title} (${formatDateRange(p.startDate, p.endDate)})`;

// ─── Itinerary → existing or new plan ───────────────────────────────────

export function ItineraryDialog({
  target,
  block,
  defaultTripId,
  onClose,
  onApplied,
}: {
  target: ApplyTarget;
  block: AssistantBlockOf<'itinerary'>;
  /** The plan the conversation is about, if the user can edit it. */
  defaultTripId: string | null;
  onClose: () => void;
  onApplied: (result: AssistantApplyResult) => void;
}) {
  const all = useMemo(
    () =>
      block.days.flatMap((d) =>
        d.activities.map((a, index) => ({ dayNumber: d.dayNumber, index, activity: a })),
      ),
    [block],
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(all.map((a) => `${a.dayNumber}:${a.index}`)),
  );
  const plans = useEditablePlans();
  const [mode, setMode] = useState<'existing' | 'new'>(defaultTripId ? 'existing' : 'new');
  const [tripId, setTripId] = useState(defaultTripId ?? '');
  const [title, setTitle] = useState(block.title);
  const [startDate, setStartDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const apply = useApply(target, (result) => {
    onApplied(result);
    onClose();
  });

  const selected = all
    .filter((a) => chosen.has(`${a.dayNumber}:${a.index}`))
    .map(({ dayNumber, index }) => ({ dayNumber, index }));
  const check = useQuery({
    queryKey: ['assistant-check', target.messageId, block.id, tripId, selected],
    queryFn: ({ signal }) =>
      checkAssistantItinerary(
        target.conversationId,
        target.messageId,
        { blockId: block.id, tripId, selected },
        signal,
      ),
    enabled: mode === 'existing' && Boolean(tripId) && selected.length > 0,
    staleTime: 0,
  });
  const outside = check.data?.placements.filter((p) => p.day === null) ?? [];

  const submit = () => {
    setProblem(null);
    if (selected.length === 0) {
      setProblem('Choose at least one activity.');
      return;
    }
    if (mode === 'existing') {
      if (!tripId) {
        setProblem('Choose a plan.');
        return;
      }
      apply.mutate({ action: 'add_itinerary', blockId: block.id, tripId, selected, confirm: true });
    } else {
      if (!title.trim()) {
        setProblem('Enter a name for the new plan.');
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        setProblem('Choose the first day of the trip.');
        return;
      }
      apply.mutate({
        action: 'create_plan',
        blockId: block.id,
        title,
        startDate,
        selected,
        confirm: true,
      });
    }
  };

  return (
    <Frame
      title="Add this proposal to a plan"
      description="Choose the activities to keep. Nothing is booked or paid for, and nothing already on a plan is changed or removed."
      onClose={onClose}
      busy={apply.isPending}
      confirm={
        <Button
          onClick={submit}
          loading={apply.isPending}
          disabled={
            apply.isPending || selected.length === 0 || (mode === 'existing' && outside.length > 0)
          }
        >
          {mode === 'existing'
            ? `Add ${selected.length} ${selected.length === 1 ? 'activity' : 'activities'}`
            : `Create plan with ${selected.length}`}
        </Button>
      }
    >
      {apply.isError ? (
        <Alert tone="danger" title="Nothing was changed">
          {errorText(apply.error)}
        </Alert>
      ) : null}
      {problem ? (
        <Alert tone="warning" title="Check this first">
          {problem}
        </Alert>
      ) : null}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-label text-ink">Activities to add</legend>
        {block.days
          .filter((d) => d.activities.length > 0)
          .map((d) => (
            <div key={d.dayNumber} className="flex flex-col gap-1">
              <p className="text-body-sm font-semibold text-ink">Day {d.dayNumber}</p>
              {d.activities.map((a, index) => {
                const key = `${d.dayNumber}:${index}`;
                return (
                  <Checkbox
                    key={key}
                    label={a.title}
                    checked={chosen.has(key)}
                    onChange={(e) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                );
              })}
            </div>
          ))}
      </fieldset>
      <RadioGroup legend="Where to add them" inline>
        <Radio
          label="An existing plan"
          name="assistant-target"
          checked={mode === 'existing'}
          onChange={() => setMode('existing')}
        />
        <Radio
          label="A new plan"
          name="assistant-target"
          checked={mode === 'new'}
          onChange={() => setMode('new')}
        />
      </RadioGroup>
      {mode === 'existing' ? (
        plans.isPending ? (
          <Skeleton className="h-11 rounded-md" />
        ) : (
          <>
            <Field label="Plan" hint="Plans you can edit.">
              <Select
                placeholder="Choose a plan"
                value={tripId}
                onChange={(e) => setTripId(e.target.value)}
                options={(plans.data ?? []).map((p) => ({ value: p.id, label: planLabel(p) }))}
              />
            </Field>
            {(plans.data ?? []).length === 0 ? (
              <p className="text-body-sm text-ink-secondary">
                You have no plans you can edit yet: create a new one.
              </p>
            ) : null}
            {check.data ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                <p className="text-label text-ink">Checked against the plan</p>
                <ul className="flex flex-col gap-1 text-body-sm text-ink-secondary">
                  {check.data.placements.map((p, i) => (
                    <li key={i}>
                      Day {p.dayNumber}:{' '}
                      {p.day ? (
                        formatDay(p.day)
                      ) : (
                        <span className="text-danger-ink">
                          after this plan ends — untick it or choose a longer plan
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-body-sm text-ink-secondary">
                  The plan already has {check.data.existingActivities}{' '}
                  {check.data.existingActivities === 1 ? 'activity' : 'activities'}; they stay as
                  they are.
                </p>
                {check.data.warnings.length > 0 ? (
                  <Alert tone="warning" role="none" title="The planner flags these">
                    <ul className="flex list-disc flex-col gap-1 pl-5">
                      {check.data.warnings.map((w, i) => (
                        <li key={i}>
                          {formatDay(w.day)}: {w.message}
                        </li>
                      ))}
                    </ul>
                    You can still add them and change times on the plan page.
                  </Alert>
                ) : null}
              </div>
            ) : check.isFetching ? (
              <p className="text-body-sm text-ink-secondary" role="status">
                Checking against the plan…
              </p>
            ) : null}
          </>
        )
      ) : (
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Plan name" required>
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="First day"
            required
            hint={`${block.dayCount} ${block.dayCount === 1 ? 'day' : 'days'} long`}
          >
            <Input
              type="date"
              min={localToday()}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Frame>
  );
}

// ─── One activity → a plan day ──────────────────────────────────────────

export function ActivityDialog({
  target,
  block,
  index,
  defaultTripId,
  onClose,
  onApplied,
}: {
  target: ApplyTarget;
  block: AssistantBlockOf<'activities'>;
  index: number;
  defaultTripId: string | null;
  onClose: () => void;
  onApplied: (result: AssistantApplyResult) => void;
}) {
  const item = block.items[index]!;
  const plans = useEditablePlans();
  const [tripId, setTripId] = useState(defaultTripId ?? '');
  const plan = plans.data?.find((p) => p.id === tripId);
  const days = plan ? datesBetweenInclusive(plan.startDate, plan.endDate) : [];
  const [day, setDay] = useState('');
  const apply = useApply(target, (result) => {
    onApplied(result);
    onClose();
  });
  const chosenDay = days.includes(day) ? day : (days[0] ?? '');
  return (
    <Frame
      title={`Add “${item.title}” to a plan`}
      description="It’s added as an activity on the day you choose. Nothing is booked, and nothing else on the plan changes."
      onClose={onClose}
      busy={apply.isPending}
      confirm={
        <Button
          loading={apply.isPending}
          disabled={apply.isPending || !tripId || !chosenDay}
          onClick={() =>
            apply.mutate({
              action: 'add_activity',
              blockId: block.id,
              index,
              tripId,
              day: chosenDay,
              confirm: true,
            })
          }
        >
          Add activity
        </Button>
      }
    >
      {apply.isError ? (
        <Alert tone="danger" title="Nothing was changed">
          {errorText(apply.error)}
        </Alert>
      ) : null}
      {plans.isPending ? (
        <Skeleton className="h-11 rounded-md" />
      ) : (plans.data ?? []).length === 0 ? (
        <p className="text-body-sm text-ink-secondary">
          You have no plans you can edit. Start a plan first.
        </p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Plan">
            <Select
              placeholder="Choose a plan"
              value={tripId}
              onChange={(e) => setTripId(e.target.value)}
              options={(plans.data ?? []).map((p) => ({ value: p.id, label: planLabel(p) }))}
            />
          </Field>
          <Field label="Day">
            <Select
              value={chosenDay}
              disabled={!plan}
              onChange={(e) => setDay(e.target.value)}
              options={days.map((d, i) => ({ value: d, label: `Day ${i + 1} · ${formatDay(d)}` }))}
            />
          </Field>
        </div>
      )}
    </Frame>
  );
}

// ─── Budget proposal → this plan's budget ───────────────────────────────

export function BudgetProposalDialog({
  target,
  block,
  tripId,
  onClose,
  onApplied,
}: {
  target: ApplyTarget;
  block: AssistantBlockOf<'budget'>;
  tripId: string;
  onClose: () => void;
  onApplied: (result: AssistantApplyResult) => void;
}) {
  const current = useQuery({
    queryKey: plannerKeys.budget(tripId),
    queryFn: ({ signal }) => getBudget(tripId, signal),
  });
  const apply = useApply(target, (result) => {
    onApplied(result);
    onClose();
  });
  const existing = current.data?.budget ?? null;
  return (
    <Frame
      title="Use this as the plan’s budget?"
      description="The budget is a spending target. Your recorded and planned expenses stay exactly as they are."
      onClose={onClose}
      busy={apply.isPending}
      confirm={
        <Button
          loading={apply.isPending}
          disabled={apply.isPending || current.isPending}
          onClick={() =>
            apply.mutate({
              action: 'apply_budget',
              blockId: block.id,
              tripId,
              ...(existing ? { version: existing.version } : {}),
              confirm: true,
            })
          }
        >
          {existing ? 'Replace budget' : 'Save budget'}
        </Button>
      }
    >
      {apply.isError ? (
        <Alert tone="danger" title="Nothing was changed">
          {errorText(apply.error)}
        </Alert>
      ) : null}
      {current.isPending ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : existing ? (
        <Alert tone="warning" role="none" title="This replaces the current budget">
          Now: {money(existing.totalMinor, existing.currency)}
          {existing.categories.length > 0
            ? ` (${existing.categories.map((c) => `${EXPENSE_CATEGORY_LABELS[c.category]} ${money(c.amountMinor, existing.currency)}`).join(', ')})`
            : ''}
          .
        </Alert>
      ) : (
        <p className="text-body-sm text-ink-secondary">This plan has no budget yet.</p>
      )}
      <div className="flex flex-col gap-1 text-body-sm">
        <p className="text-label text-ink">New budget (estimates)</p>
        <ul className="flex flex-col gap-0.5 text-ink-secondary">
          {block.categories.map((c) => (
            <li key={c.category}>
              {EXPENSE_CATEGORY_LABELS[c.category]}:{' '}
              <span className="numeric text-ink">{money(c.amountMinor, block.currency)}</span>
            </li>
          ))}
        </ul>
        <p className="text-ink">
          Total:{' '}
          <span className="numeric font-semibold">{money(block.totalMinor, block.currency)}</span>
        </p>
        {existing && existing.currency !== block.currency ? (
          <p className="flex items-center gap-1.5 text-ink-secondary">
            <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
            The currency changes from {existing.currency} to {block.currency}. Amounts aren’t
            converted.
          </p>
        ) : null}
      </div>
    </Frame>
  );
}

// ─── A suggested move ───────────────────────────────────────────────────

export function MoveDialog({
  target,
  block,
  index,
  onClose,
  onApplied,
}: {
  target: ApplyTarget;
  block: AssistantBlockOf<'moves'>;
  index: number;
  onClose: () => void;
  onApplied: (result: AssistantApplyResult) => void;
}) {
  const move = block.items[index]!;
  const apply = useApply(target, (result) => {
    onApplied(result);
    onClose();
  });
  return (
    <Frame
      title={`Move “${move.title}”?`}
      description={`From ${formatDay(move.fromDay)} to ${formatDay(move.toDay)}. If someone changed this activity since the suggestion, nothing is moved.`}
      onClose={onClose}
      busy={apply.isPending}
      confirm={
        <Button
          loading={apply.isPending}
          disabled={apply.isPending}
          onClick={() =>
            apply.mutate({ action: 'move_activity', blockId: block.id, index, confirm: true })
          }
        >
          Move activity
        </Button>
      }
    >
      {apply.isError ? (
        <Alert tone="danger" title="Nothing was changed">
          {errorText(apply.error)}
        </Alert>
      ) : null}
      <p className="text-body-sm text-ink-secondary">{move.reason}</p>
    </Frame>
  );
}
