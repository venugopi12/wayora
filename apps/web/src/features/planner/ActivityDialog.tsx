import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  ACTIVITY_CATEGORIES,
  PLANNER_LIMITS,
  createItineraryItemSchema,
  type CreateItineraryItemInput,
  type ItineraryItem,
  type PlannedTrip,
  type UpdateItineraryItemInput,
} from '@wayora/contracts';
import { Alert, Button, Dialog, DialogContent, Field, Input, Select, Textarea } from '@wayora/ui';
import { addItineraryItem, updateItineraryItem } from '../../services/planner';
import { applyServerError } from '../auth/form-errors';
import { categoryLabel, formatDay } from './format';

/*
 * Add or edit one activity. Edits send only what changed; a new day moves
 * the activity there (to the end of that day). Closing with unsaved changes
 * asks first. Mount it only while open, so every opening starts fresh.
 */

interface ActivityValues {
  title: string;
  category: string;
  day: string;
  startTime: string;
  durationMinutes: string;
  location: string;
  notes: string;
}

const FIELDS = [
  'title',
  'category',
  'day',
  'startTime',
  'durationMinutes',
  'location',
  'notes',
] as const;

function valuesFor(item: ItineraryItem | null, day: string): ActivityValues {
  return {
    title: item?.title ?? '',
    category: item?.category ?? '',
    day: item?.day ?? day,
    startTime: item?.startTime ?? '',
    durationMinutes: item && item.durationMinutes !== null ? String(item.durationMinutes) : '',
    location: item?.location ?? '',
    notes: item?.notes ?? '',
  };
}

function toBody(values: ActivityValues): CreateItineraryItemInput {
  const duration = values.durationMinutes.trim();
  return {
    day: values.day,
    title: values.title,
    category: values.category as CreateItineraryItemInput['category'],
    startTime: values.startTime || null,
    durationMinutes: duration === '' ? null : Number(duration),
    location: values.location,
    notes: values.notes,
  };
}

export function ActivityDialog({
  open,
  onOpenChange,
  trip,
  item,
  day,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trip: PlannedTrip;
  /** The activity to edit; null to add one. */
  item: ItineraryItem | null;
  /** Day to add to (and the default day). */
  day: string;
  onSaved: (trip: PlannedTrip, message: string) => void;
}) {
  const form = useForm<ActivityValues>({ defaultValues: valuesFor(item, day) });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = form;
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // One idempotency key per distinct "add" request: a retry or double
  // submit reuses it, so the activity is added once.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: CreateItineraryItemInput) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };

  const save = useMutation({
    mutationFn: async (values: ActivityValues) => {
      const body = toBody(values);
      if (!item) return addItineraryItem(trip.id, body, keyFor(body));
      const original = toBody(valuesFor(item, item.day));
      const changes: UpdateItineraryItemInput = {};
      if (body.title !== original.title) changes.title = body.title;
      if (body.category !== original.category) changes.category = body.category;
      if (body.day !== original.day) changes.day = body.day;
      if (body.startTime !== original.startTime) changes.startTime = body.startTime ?? null;
      if (body.durationMinutes !== original.durationMinutes)
        changes.durationMinutes = body.durationMinutes ?? null;
      if (body.location !== original.location) changes.location = body.location ?? null;
      if (body.notes !== original.notes) changes.notes = body.notes ?? null;
      if (Object.keys(changes).length === 0) return trip;
      return updateItineraryItem(trip.id, item.id, changes);
    },
    onSuccess: (updated, values) => {
      attempt.current = null;
      onSaved(updated, item ? `Saved “${values.title.trim()}”` : `Added “${values.title.trim()}”`);
      onOpenChange(false);
    },
    onError: (error) => setFormError(applyServerError(error, setError, FIELDS)),
  });

  const submit = handleSubmit((values) => {
    setFormError(null);
    const parsed = createItineraryItemSchema.safeParse(toBody(values));
    if (!parsed.success) {
      const seen = new Set<string>();
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '') as (typeof FIELDS)[number];
        if (FIELDS.includes(field) && !seen.has(field)) {
          setError(
            field,
            { type: 'validate', message: issue.message },
            { shouldFocus: seen.size === 0 },
          );
          seen.add(field);
        }
      }
      return;
    }
    save.mutate(values);
  });

  const requestClose = (next: boolean) => {
    if (next) return onOpenChange(true);
    if (save.isPending) return; // let the save finish
    if (isDirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const dayOptions = trip.days.map((d) => ({
    value: d.date,
    label: `Day ${d.dayNumber} · ${formatDay(d.date)}`,
  }));
  if (item && !trip.days.some((d) => d.date === item.day)) {
    dayOptions.unshift({
      value: item.day,
      label: `${formatDay(item.day)} (outside the trip dates)`,
    });
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        size="lg"
        title={item ? 'Edit activity' : 'Add an activity'}
        description="Times are local to the destination. Only you can see this plan."
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
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => requestClose(false)}
                disabled={save.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="activity-form"
                loading={save.isPending}
                disabled={save.isPending}
              >
                {item ? 'Save activity' : 'Add activity'}
              </Button>
            </>
          )
        }
      >
        {confirmDiscard ? (
          <Alert tone="warning" title="Discard your changes?" className="mb-4">
            You’ve changed this activity but haven’t saved it.
          </Alert>
        ) : null}
        <form
          id="activity-form"
          noValidate
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-5 pb-2"
          aria-busy={save.isPending || undefined}
        >
          {formError ? (
            <Alert tone="danger" title="We couldn’t save this activity">
              {formError}
            </Alert>
          ) : null}
          <Field label="What" required error={errors.title?.message}>
            <Input autoComplete="off" maxLength={120} {...register('title')} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Category" required error={errors.category?.message}>
              <Select
                placeholder="Choose a category"
                options={ACTIVITY_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                {...register('category')}
              />
            </Field>
            <Field label="Day" required error={errors.day?.message}>
              <Select options={dayOptions} {...register('day')} />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Start time" hint="Optional, local time" error={errors.startTime?.message}>
              <Input type="time" step={300} {...register('startTime')} />
            </Field>
            <Field
              label="Duration (minutes)"
              hint={`Optional, 5–${PLANNER_LIMITS.maxDurationMinutes}`}
              error={errors.durationMinutes?.message}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={5}
                max={PLANNER_LIMITS.maxDurationMinutes}
                step={5}
                {...register('durationMinutes')}
              />
            </Field>
          </div>
          <Field
            label="Location"
            hint="Optional, e.g. an area or address"
            error={errors.location?.message}
          >
            <Input autoComplete="off" maxLength={160} {...register('location')} />
          </Field>
          <Field label="Notes" hint="Optional" error={errors.notes?.message}>
            <Textarea rows={3} maxLength={1000} {...register('notes')} />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
