import { useMutation, useQuery } from '@tanstack/react-query';
import { Clock, Lightbulb, MapPin, Plus, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  PLANNER_INTERESTS,
  type ActivitySuggestion,
  type PlannedTrip,
  type PlannerInterest,
} from '@wayora/contracts';
import { Alert, Badge, Button, EmptyState, ErrorState, Field, Select, Skeleton } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { addItineraryItem, getSuggestions } from '../../services/planner';
import {
  BEST_TIME_LABEL,
  CATEGORY_ICON,
  COST_LABEL,
  PACE_LABEL,
  categoryLabel,
  formatMinutes,
} from './format';
import { plannerKeys } from './keys';

/*
 * Sample suggestions (docs/planner.md#recommendations): hand-written sample
 * data, ranked by fixed rules from this plan's preferences and current
 * activities. Never AI, never live: no hours, prices, availability, ratings
 * or travel times — and the panel says so.
 */

export function SuggestionsPanel({
  trip,
  day,
  onAdded,
  canAdd = true,
}: {
  trip: PlannedTrip;
  /** The day suggestions are added to (the selected day tab). */
  day: string;
  onAdded: (trip: PlannedTrip, message: string) => void;
  /** Editors and owners can add suggestions; viewers just browse them. */
  canAdd?: boolean;
}) {
  const [category, setCategory] = useState<PlannerInterest | null>(null);
  const query = useQuery({
    queryKey: plannerKeys.suggestionsFor(trip.id, category),
    queryFn: ({ signal }) => getSuggestions(trip.id, category, signal),
    enabled: trip.destination.hasSuggestions,
  });
  const dayNumber = trip.days.find((d) => d.date === day)?.dayNumber ?? 1;

  const keys = useRef(new Map<string, string>());
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (s: ActivitySuggestion) => {
      const attempt = `${s.id}@${day}`;
      const key = keys.current.get(attempt) ?? crypto.randomUUID();
      keys.current.set(attempt, key);
      return addItineraryItem(
        trip.id,
        {
          day,
          title: s.title,
          category: s.category,
          durationMinutes: s.typicalMinutes,
          location: s.area,
          suggestionId: s.id,
        },
        key,
      );
    },
    onMutate: (s) => {
      setAdding(s.id);
      setError(null);
    },
    onSuccess: (updated, s) => {
      keys.current.delete(`${s.id}@${day}`);
      onAdded(updated, `Added “${s.title}” to day ${dayNumber}`);
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : 'We couldn’t add it. Try again.'),
    onSettled: () => setAdding(null),
  });

  let body;
  if (!trip.destination.hasSuggestions) {
    body = (
      <EmptyState
        icon={<Lightbulb />}
        title={`No sample suggestions for ${trip.destination.name}`}
        description="Suggestions exist only for Wayora’s sample destinations. Add your own activities any time."
      />
    );
  } else if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading suggestions" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title="Suggestions didn't load"
        description="Your plan is fine. Check your connection, then try again."
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else if (query.data.suggestions.length === 0) {
    body = (
      <EmptyState
        icon={<Lightbulb />}
        title={
          category
            ? `No more ${categoryLabel(category).toLowerCase()} suggestions`
            : 'You’ve used every suggestion'
        }
        description="Everything in the sample for this destination that fits is already in your plan."
      />
    );
  } else {
    const { capacity } = query.data;
    const target = capacity.days * capacity.perDay;
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-ink-secondary">
          {capacity.days} {capacity.days === 1 ? 'day' : 'days'} at a{' '}
          {(trip.preferences.pace ? PACE_LABEL[trip.preferences.pace] : 'Balanced').toLowerCase()}{' '}
          pace is roughly {target} activities; {capacity.planned} planned so far.
        </p>
        <ul className="flex flex-col gap-3" aria-label="Suggested activities">
          {query.data.suggestions.map((s) => {
            const Icon = CATEGORY_ICON[s.category];
            return (
              <li
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-card p-4"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" tone="neutral">
                    <Icon className="size-3.5" aria-hidden="true" />
                    {categoryLabel(s.category)}
                  </Badge>
                </span>
                <h3 className="text-title">{s.title}</h3>
                <p className="text-body-sm text-ink-secondary">{s.summary}</p>
                <dl className="grid gap-1 text-caption text-ink-secondary">
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">Area</dt>
                    <MapPin className="size-3.5" aria-hidden="true" />
                    <dd>{s.area}</dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">Time to allow</dt>
                    <Clock className="size-3.5" aria-hidden="true" />
                    <dd>Allow about {formatMinutes(s.typicalMinutes)} (estimate)</dd>
                  </div>
                  <div>
                    <dt className="sr-only">Cost</dt>
                    <dd>{COST_LABEL[s.costLevel]} — check before you go</dd>
                  </div>
                  <div>
                    <dt className="sr-only">When</dt>
                    <dd>{BEST_TIME_LABEL[s.bestTime]}</dd>
                  </div>
                </dl>
                <div className="rounded-md bg-sunken p-2.5">
                  <p className="text-caption font-semibold text-ink">Why it’s suggested</p>
                  <ul className="mt-1 list-disc pl-4 text-caption text-ink-secondary">
                    {s.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
                {canAdd ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    loading={adding === s.id}
                    disabled={adding !== null}
                    onClick={() => add.mutate(s)}
                  >
                    <Plus aria-hidden="true" />
                    Add to day {dayNumber}
                    <span className="sr-only">: {s.title}</span>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <aside
      aria-labelledby="suggestions-heading"
      className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start"
    >
      <div className="flex flex-col gap-1">
        <h2 id="suggestions-heading" className="flex items-center gap-2 text-heading-3">
          <Lightbulb className="size-5 text-brand" aria-hidden="true" />
          Sample suggestions
        </h2>
        <p className="text-body-sm text-ink-secondary">
          Hand-picked sample ideas, ordered by simple rules from your preferences — not AI and not
          live data. Check opening times, prices and how to get there before you go.
        </p>
      </div>
      {trip.destination.hasSuggestions ? (
        <Field label="Show">
          <Select
            value={category ?? ''}
            onChange={(e) => setCategory((e.target.value || null) as PlannerInterest | null)}
          >
            <option value="">All categories</option>
            {PLANNER_INTERESTS.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {error ? (
        <Alert tone="danger" title="Not added">
          {error}
        </Alert>
      ) : null}
      {body}
    </aside>
  );
}
