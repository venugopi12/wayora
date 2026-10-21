import { ArrowLeftRight, ArrowUpDown, Minus, Plus, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { findPlace, type SearchServiceType } from '@wayora/contracts';
import { Alert, Button, Field, IconButton, Input, Select, cn } from '@wayora/ui';
import { SEARCH_CONFIG, placeOptions, type FieldConfig } from './config';
import type { FormValues, ParamIssue } from './params';

/** Local date (YYYY-MM-DD) of the browser, for date input minimums. */
function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function Counter({
  field,
  value,
  error,
  onChange,
}: {
  field: Extract<FieldConfig, { kind: 'count' }>;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const number = Number.isFinite(Number(value)) ? Number(value) : field.defaultValue;
  const noun = field.label.toLowerCase();
  return (
    <div
      role="group"
      data-invalid={error ? '' : undefined}
      aria-labelledby={`${id}-label`}
      aria-describedby={
        [field.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') ||
        undefined
      }
      className="flex flex-col gap-2"
    >
      <span id={`${id}-label`} className="text-label text-ink">
        {field.label}
      </span>
      <div
        className={cn(
          'flex h-11 items-center justify-between gap-2 rounded-md border bg-card px-1.5 shadow-xs',
          error ? 'border-danger' : 'border-line-control',
        )}
      >
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          label={`Fewer ${noun}`}
          icon={<Minus />}
          disabled={number <= field.min}
          onClick={() => onChange(String(Math.max(field.min, number - 1)))}
        />
        <output
          aria-live="polite"
          aria-label={`${field.label}: ${number}`}
          className="numeric min-w-6 text-center text-body"
        >
          {number}
        </output>
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          label={`More ${noun}`}
          icon={<Plus />}
          disabled={number >= field.max}
          onClick={() => onChange(String(Math.min(field.max, number + 1)))}
        />
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-body-sm text-danger-ink">
          {error}
        </p>
      ) : null}
      {field.hint ? (
        <p id={`${id}-hint`} className="text-caption text-ink-secondary">
          {field.hint}
        </p>
      ) : null}
    </div>
  );
}

export interface SearchFormProps {
  serviceType: SearchServiceType;
  /** Values to show; the form takes them over when they change (e.g. Back). */
  initialValues: FormValues;
  /** Problems to show on fields (from the URL or a failed submit). */
  issues: readonly ParamIssue[];
  /** Validate and run the search; returns problems to show, or none. */
  onSearch: (values: FormValues) => readonly ParamIssue[];
  /** Shown as a Cancel button when editing an existing search. */
  onCancel?: () => void;
  /** Move focus to the first field on open ("Edit search"). */
  autoFocusFirstField?: boolean;
}

/**
 * Category-aware search form. Fields come from the category's config;
 * validation uses the shared request contract (the API applies the same
 * rules). Errors appear on their fields, and focus moves to the first one.
 */
export function SearchForm({
  serviceType,
  initialValues,
  issues,
  onSearch,
  onCancel,
  autoFocusFirstField = false,
}: SearchFormProps) {
  const config = SEARCH_CONFIG[serviceType];
  const [values, setValues] = useState<FormValues>(initialValues);
  const [shownIssues, setShownIssues] = useState<readonly ParamIssue[]>(issues);

  // When the URL describes a different search (Back/Forward, a shared link),
  // take its values. Adjusted during render rather than by remounting, so
  // keyboard focus (e.g. on the Search button) survives a search.
  const sourceKey = `${JSON.stringify(initialValues)}|${JSON.stringify(issues)}`;
  const [seenSource, setSeenSource] = useState(sourceKey);
  if (sourceKey !== seenSource) {
    setSeenSource(sourceKey);
    setValues(initialValues);
    setShownIssues(issues);
  }
  const formRef = useRef<HTMLFormElement>(null);

  // Opened with "Edit search": start at the first field.
  useEffect(() => {
    if (autoFocusFirstField) {
      formRef.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    }
  }, [autoFocusFirstField]);
  const idPrefix = useId();

  const set = (param: string, value: string) => {
    setValues((v) => ({ ...v, [param]: value }));
    setShownIssues((current) => current.filter((i) => i.param !== param));
  };
  const errorFor = (param: string) => shownIssues.find((i) => i.param === param)?.message;
  const general = shownIssues.filter(
    (i) => i.param === null || !config.fields.some((f) => f.param === i.param),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = onSearch(values);
    setShownIssues(problems);
    if (problems.length > 0) {
      // Focus the first field with a problem.
      requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"], [role="group"][data-invalid] button')
          ?.focus();
      });
    }
  };

  const today = localToday();
  const fieldId = (param: string) => `${idPrefix}-${param}`;

  const renderField = (field: FieldConfig) => {
    const value = values[field.param] ?? '';
    const error = errorFor(field.param);
    switch (field.kind) {
      case 'count':
        return (
          <Counter
            key={field.param}
            field={field}
            value={value}
            error={error}
            onChange={(v) => set(field.param, v)}
          />
        );
      case 'place':
        return (
          <Field
            key={field.param}
            id={fieldId(field.param)}
            label={field.label}
            error={error}
            required
          >
            <Select
              value={value}
              onChange={(e) => set(field.param, e.target.value)}
              placeholder="Choose…"
              options={placeOptions(field.placeKinds)}
            />
          </Field>
        );
      case 'date':
        return (
          <Field
            key={field.param}
            id={fieldId(field.param)}
            label={field.label}
            error={error}
            hint={field.hint}
            required={field.required}
          >
            <Input
              type="date"
              min={today}
              value={value}
              onChange={(e) => set(field.param, e.target.value)}
            />
          </Field>
        );
      case 'datetime': {
        const zone = findPlace(values[field.zoneFrom])?.cityName;
        return (
          <Field
            key={field.param}
            id={fieldId(field.param)}
            label={field.label}
            error={error}
            hint={zone ? `Local time in ${zone}.` : 'Local time at the pick-up place.'}
            required
          >
            <Input
              type="datetime-local"
              min={`${today}T00:00`}
              value={value}
              onChange={(e) => set(field.param, e.target.value)}
            />
          </Field>
        );
      }
      case 'select':
        return (
          <Field key={field.param} id={fieldId(field.param)} label={field.label} error={error}>
            <Select
              value={value}
              onChange={(e) => set(field.param, e.target.value)}
              options={[...field.options]}
            />
          </Field>
        );
    }
  };

  const [fromParam, toParam] = config.swap ?? [null, null];
  const routeFields = config.fields.filter((f) => f.param === fromParam || f.param === toParam);
  const otherFields = config.fields.filter((f) => !routeFields.includes(f));
  const counters = otherFields.filter((f) => f.kind === 'count');
  const rest = otherFields.filter((f) => f.kind !== 'count');

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      aria-label={config.submitLabel}
      className="flex flex-col gap-5 rounded-xl border border-line bg-card p-5 shadow-sm sm:p-6"
    >
      {general.length > 0 ? (
        <Alert tone="danger" title="Check this search">
          <ul className="list-disc pl-5">
            {general.map((i) => (
              <li key={`${i.param}-${i.message}`}>{i.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {routeFields.length === 2 ? (
        <div className="grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {renderField(routeFields[0]!)}
          <IconButton
            type="button"
            variant="secondary"
            label={`Swap ${routeFields[0]!.label.toLowerCase()} and ${routeFields[1]!.label.toLowerCase()}`}
            icon={
              <>
                <ArrowLeftRight className="hidden md:block" />
                <ArrowUpDown className="md:hidden" />
              </>
            }
            className="justify-self-center md:mt-7"
            onClick={() => {
              setValues((v) => ({
                ...v,
                [fromParam!]: v[toParam!] ?? '',
                [toParam!]: v[fromParam!] ?? '',
              }));
              setShownIssues((current) =>
                current.filter((i) => i.param !== fromParam && i.param !== toParam),
              );
            }}
          />
          {renderField(routeFields[1]!)}
        </div>
      ) : null}

      {rest.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{rest.map(renderField)}</div>
      ) : null}

      {counters.length > 0 ? (
        <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="sr-only">Travellers</legend>
          {counters.map(renderField)}
        </fieldset>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-caption text-ink-secondary">{config.coverage}</p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          {onCancel ? (
            <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="lg" className="sm:min-w-48">
            <Search aria-hidden="true" />
            {config.submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
