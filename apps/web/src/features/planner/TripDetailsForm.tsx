import { useEffect, type ReactNode } from 'react';
import { useForm, useWatch, type UseFormSetError } from 'react-hook-form';
import {
  PLANNER_INTERESTS,
  PLANNER_LIMITS,
  createPlannedTripSchema,
  daysBetween,
  type CreatePlannedTripInput,
  type PlannedTrip,
  type PlannerDestination,
  type PlannerInterest,
  type PlanningBudget,
  type PlanningGroup,
  type PlanningPace,
} from '@wayora/contracts';
import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
} from '@wayora/ui';
import {
  BUDGET_LABEL,
  GROUP_LABEL,
  PACE_HINT,
  PACE_LABEL,
  categoryLabel,
  localToday,
} from './format';

/*
 * Trip details and planning preferences, for creating a plan and editing one.
 * Checked here with the same contract the API uses; the API checks again
 * (and owns "not in the past", against its own clock).
 */

export const OTHER_DESTINATION = '__other';

export interface TripFormValues {
  title: string;
  /** A curated destination id, OTHER_DESTINATION, or '' (not chosen). */
  destinationId: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  notes: string;
  pace: '' | PlanningPace;
  budget: '' | PlanningBudget;
  group: '' | PlanningGroup;
  interests: PlannerInterest[];
  /** Edit only: a confirmed booking reference, or '' for none. */
  bookingReference: string;
}

export const EMPTY_TRIP_VALUES: TripFormValues = {
  title: '',
  destinationId: '',
  destinationName: '',
  startDate: '',
  endDate: '',
  notes: '',
  pace: '',
  budget: '',
  group: '',
  interests: [],
  bookingReference: '',
};

export function valuesFromTrip(trip: PlannedTrip): TripFormValues {
  return {
    title: trip.title,
    destinationId: trip.destination.id ?? OTHER_DESTINATION,
    destinationName: trip.destination.id ? '' : trip.destination.name,
    startDate: trip.startDate,
    endDate: trip.endDate,
    notes: trip.notes ?? '',
    pace: trip.preferences.pace ?? '',
    budget: trip.preferences.budget ?? '',
    group: trip.preferences.group ?? '',
    interests: trip.preferences.interests,
    bookingReference: trip.linkedBooking?.reference ?? '',
  };
}

/** The API body for these values (create shape; edits add `version`). */
export function tripBody(values: TripFormValues): CreatePlannedTripInput {
  const other = values.destinationId === OTHER_DESTINATION || values.destinationId === '';
  return {
    title: values.title,
    destinationId: other ? null : values.destinationId,
    destinationName: other ? values.destinationName : null,
    startDate: values.startDate,
    endDate: values.endDate,
    notes: values.notes,
    preferences: {
      pace: values.pace || null,
      budget: values.budget || null,
      group: values.group || null,
      interests: values.interests,
    },
  };
}

type Fields = keyof TripFormValues;
const FIELD_FOR_PATH: Record<string, Fields> = {
  title: 'title',
  destinationId: 'destinationId',
  destinationName: 'destinationName',
  startDate: 'startDate',
  endDate: 'endDate',
  notes: 'notes',
  bookingReference: 'bookingReference',
};
export const TRIP_FORM_FIELDS = Object.values(FIELD_FOR_PATH);

export interface LinkableBooking {
  reference: string;
  label: string;
}

export function TripDetailsForm({
  mode,
  destinations,
  defaultValues,
  linkableBookings,
  submitting,
  formError,
  formErrorAction,
  submitLabel,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  mode: 'create' | 'edit';
  destinations: readonly PlannerDestination[];
  defaultValues: TripFormValues;
  /** Edit only: the user's confirmed bookings that may be linked. */
  linkableBookings?: readonly LinkableBooking[];
  submitting: boolean;
  formError: string | null;
  formErrorAction?: ReactNode;
  submitLabel: string;
  onSubmit: (values: TripFormValues, setError: UseFormSetError<TripFormValues>) => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const form = useForm<TripFormValues>({ defaultValues });
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isDirty },
  } = form;

  useEffect(() => onDirtyChange?.(isDirty), [isDirty, onDirtyChange]);

  const destinationId = useWatch({ control, name: 'destinationId' });
  const startDate = useWatch({ control, name: 'startDate' });
  const endDate = useWatch({ control, name: 'endDate' });
  const today = localToday();
  const initialStart = defaultValues.startDate;

  const submit = handleSubmit((values) => {
    let ok = true;
    const flagged = new Set<Fields>();
    const parsed = createPlannedTripSchema.safeParse(tripBody(values));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        let field = FIELD_FOR_PATH[key];
        if (key === 'destinationName' && values.destinationId === '') field = 'destinationId';
        if (field && !flagged.has(field)) {
          flagged.add(field);
          setError(field, { type: 'validate', message: issue.message }, { shouldFocus: ok });
          ok = false;
        }
      }
    }
    // "Not in the past" (the API checks too, against its own clock). An
    // existing trip may keep a start date that has since passed.
    const earliest = mode === 'edit' && initialStart < today ? initialStart : today;
    if (
      !flagged.has('startDate') &&
      values.startDate &&
      values.startDate < earliest &&
      values.startDate !== initialStart
    ) {
      setError(
        'startDate',
        { type: 'validate', message: 'That date has already passed.' },
        { shouldFocus: ok },
      );
      ok = false;
    }
    if (ok) onSubmit(values, setError);
  });

  const destinationOptions = [
    ...destinations.map((d) => ({
      value: d.id ?? '',
      label: d.country ? `${d.name}, ${d.country}` : d.name,
    })),
    { value: OTHER_DESTINATION, label: 'Somewhere else…' },
  ];
  const tripDays =
    startDate && endDate && endDate >= startDate ? daysBetween(startDate, endDate) + 1 : null;

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
      {formError ? (
        <Alert tone="danger" title="We couldn’t save this plan" action={formErrorAction}>
          {formError}
        </Alert>
      ) : null}

      <Field
        label="Trip name"
        required
        error={errors.title?.message}
        hint="For example: Goa long weekend"
      >
        <Input autoComplete="off" maxLength={120} {...register('title')} />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Destination"
          required
          error={errors.destinationId?.message}
          hint="Sample destinations come with sample suggestions."
        >
          <Select
            placeholder="Choose a destination"
            options={destinationOptions}
            {...register('destinationId')}
          />
        </Field>
        {destinationId === OTHER_DESTINATION ? (
          <Field label="Where are you going?" required error={errors.destinationName?.message}>
            <Input autoComplete="off" maxLength={120} {...register('destinationName')} />
          </Field>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-label text-ink">Dates</legend>
        <p className="-mt-1 text-body-sm text-ink-secondary">
          Local dates at the destination. Up to {PLANNER_LIMITS.maxTripDays} days.
          {tripDays ? ` This plan has ${tripDays} ${tripDays === 1 ? 'day' : 'days'}.` : ''}
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="First day" required error={errors.startDate?.message}>
            <Input
              type="date"
              min={mode === 'create' ? today : undefined}
              {...register('startDate')}
            />
          </Field>
          <Field label="Last day" required error={errors.endDate?.message}>
            <Input type="date" min={startDate || undefined} {...register('endDate')} />
          </Field>
        </div>
        {mode === 'edit' ? (
          <p className="text-body-sm text-ink-secondary">
            Changing the dates never deletes activities: any that fall outside the new dates are
            kept and listed so you can move them.
          </p>
        ) : null}
      </fieldset>

      <Field label="Notes" hint="Optional. Only you can see them." error={errors.notes?.message}>
        <Textarea rows={3} maxLength={2000} {...register('notes')} />
      </Field>

      <fieldset className="flex flex-col gap-5 rounded-xl border border-line bg-sunken/40 p-4 sm:p-5">
        <legend className="px-1 text-title">Planning preferences</legend>
        <p className="-mt-2 text-body-sm text-ink-secondary">
          All optional. They only change the order of sample suggestions for this plan, and you can
          change them any time. Leave them blank for the default order.
        </p>
        <RadioGroup legend="Pace" inline>
          <Radio label="No preference" value="" {...register('pace')} />
          {(['relaxed', 'balanced', 'packed'] as const).map((p) => (
            <Radio
              key={p}
              label={PACE_LABEL[p]}
              description={PACE_HINT[p]}
              value={p}
              {...register('pace')}
            />
          ))}
        </RadioGroup>
        <RadioGroup legend="Budget" inline>
          <Radio label="No preference" value="" {...register('budget')} />
          {(['shoestring', 'moderate', 'premium'] as const).map((b) => (
            <Radio key={b} label={BUDGET_LABEL[b]} value={b} {...register('budget')} />
          ))}
        </RadioGroup>
        <RadioGroup legend="Travelling as" inline>
          <Radio label="No preference" value="" {...register('group')} />
          {(['solo', 'couple', 'family', 'friends'] as const).map((g) => (
            <Radio key={g} label={GROUP_LABEL[g]} value={g} {...register('group')} />
          ))}
        </RadioGroup>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label text-ink">Interests</legend>
          <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
            {PLANNER_INTERESTS.map((interest) => (
              <Checkbox
                key={interest}
                label={categoryLabel(interest)}
                value={interest}
                {...register('interests')}
              />
            ))}
          </div>
        </fieldset>
      </fieldset>

      {mode === 'edit' ? (
        <Field
          label="Linked booking"
          error={errors.bookingReference?.message}
          hint="Optional. Link one of your confirmed bookings for reference. Linking changes nothing about the booking."
        >
          <Select {...register('bookingReference')}>
            <option value="">No linked booking</option>
            {(linkableBookings ?? []).map((b) => (
              <option key={b.reference} value={b.reference}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={submitting} disabled={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
