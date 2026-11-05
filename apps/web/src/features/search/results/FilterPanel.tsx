import { useId, useState, type FormEvent } from 'react';
import type { SearchFacets, SearchServiceType } from '@wayora/contracts';
import { Button, Checkbox, Field, Input, Radio, RadioGroup, Select, formatMoney } from '@wayora/ui';
import { SEARCH_CONFIG, type FilterConfig, type Option } from '../config';
import { formatHours, readFilters } from '../filters';

/*
 * Filter controls for one category, used by the desktop sidebar and the
 * mobile sheet. Choices come from the response's facets (values that exist
 * in this search's results), so no filter offers something that can't
 * match. Every change updates the URL at once.
 */

export type ParamUpdate = Record<string, string | null>;

interface ControlProps<K extends FilterConfig['kind']> {
  filter: Extract<FilterConfig, { kind: K }>;
  params: URLSearchParams;
  facets: SearchFacets;
  currency: string;
  onChange: (updates: ParamUpdate) => void;
}

function OptionsFilter({ filter, params, facets, onChange }: ControlProps<'options'>) {
  const options: readonly (Option & { count?: number })[] =
    filter.options ?? (filter.facet ? (facets.options[filter.facet] ?? []) : []);
  if (options.length === 0) return null;
  const selected = new Set((params.get(filter.param) ?? '').split(',').filter(Boolean));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-label text-ink">
        {filter.label}
        {filter.matchAll && options.length > 1 ? (
          <span className="block text-caption font-normal text-ink-secondary">
            Shows results with all the selected items
          </span>
        ) : null}
      </legend>
      {options.map((option) => (
        <Checkbox
          key={option.value}
          label={
            <span className="flex w-full items-baseline justify-between gap-3">
              <span>{option.label}</span>
              {option.count !== undefined ? (
                <span className="numeric text-caption text-ink-secondary" aria-hidden="true">
                  {option.count}
                </span>
              ) : null}
            </span>
          }
          checked={selected.has(option.value)}
          onChange={(e) => {
            const next = new Set(selected);
            if (e.target.checked) next.add(option.value);
            else next.delete(option.value);
            // Keep option order so the URL stays stable.
            const ordered = options.map((o) => o.value).filter((v) => next.has(v));
            onChange({ [filter.param]: ordered.length ? ordered.join(',') : null });
          }}
        />
      ))}
    </fieldset>
  );
}

/** "At most" / "at least" over small integers present in the results. */
function CountFilter({
  filter,
  params,
  facets,
  onChange,
}: ControlProps<'at-most'> | ControlProps<'at-least'>) {
  const values = (facets.options[filter.facet] ?? []).map((o) => Number(o.value));
  if (values.length < 2) return null; // one value: nothing to choose between
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const choices =
    filter.kind === 'at-most'
      ? values.filter((n) => n < highest)
      : values.filter((n) => n > lowest);
  const current = params.get(filter.param) ?? '';
  return (
    <RadioGroup legend={filter.label}>
      <Radio
        label="Any"
        value=""
        checked={current === ''}
        onChange={() => onChange({ [filter.param]: null })}
      />
      {choices.map((n) => (
        <Radio
          key={n}
          label={filter.describe(n)}
          value={String(n)}
          checked={current === String(n)}
          onChange={() => onChange({ [filter.param]: String(n) })}
        />
      ))}
    </RadioGroup>
  );
}

function PriceRangeFilter({
  filter,
  params,
  facets,
  currency,
  onChange,
}: ControlProps<'price-range'>) {
  // Remounted when the URL values change (key below), so drafts start from them.
  const [minParam, maxParam] = filter.params;
  const [draft, setDraft] = useState({
    min: params.get(minParam) ?? '',
    max: params.get(maxParam) ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (!facets.price) return null;
  const { min, max } = facets.price;
  const unit = (v: string) => v.replace(/[,\s]/g, '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const low = unit(draft.min);
    const high = unit(draft.max);
    const valid = (v: string) => v === '' || /^[1-9]\d{0,10}$/.test(v);
    if (!valid(low) || !valid(high)) {
      setError('Enter whole amounts above zero.');
      return;
    }
    if (low && high && BigInt(low) > BigInt(high)) {
      setError('The maximum must be at least the minimum.');
      return;
    }
    setError(null);
    onChange({ [minParam]: low || null, [maxParam]: high || null });
  };
  const hintId = `${id}-hint`;
  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={`${id}-label`}
      className="flex flex-col gap-2"
    >
      <p id={`${id}-label`} className="text-label text-ink">
        {filter.label} ({currency})
      </p>
      <p id={hintId} className="text-caption text-ink-secondary">
        In these results: {formatMoney(min.amountMinor, min.currency)} –{' '}
        {formatMoney(max.amountMinor, max.currency)}
        {facets.price.basis === 'night' ? ' per night' : ''}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Minimum">
          <Input
            inputMode="numeric"
            value={draft.min}
            placeholder="Any"
            aria-describedby={hintId}
            onChange={(e) => setDraft((d) => ({ ...d, min: e.target.value }))}
          />
        </Field>
        <Field label="Maximum">
          <Input
            inputMode="numeric"
            value={draft.max}
            placeholder="Any"
            aria-describedby={hintId}
            onChange={(e) => setDraft((d) => ({ ...d, max: e.target.value }))}
          />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="text-body-sm text-danger-ink">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" size="sm" className="self-start">
        Apply price
      </Button>
    </form>
  );
}

function MaxDurationFilter({ filter, params, facets, onChange }: ControlProps<'max-duration'>) {
  const range = facets.durationMinutes;
  if (!range || range.max - range.min < 30) return null;
  // Whole-hour steps strictly inside the results' range (the top step means "any").
  const steps: number[] = [];
  for (let h = Math.ceil(range.min / 60); h * 60 < range.max; h += 1) {
    if (h * 60 >= 15) steps.push(h * 60);
  }
  if (steps.length === 0) return null;
  return (
    <Field label={filter.label}>
      <Select
        value={params.get(filter.param) ?? ''}
        onChange={(e) => onChange({ [filter.param]: e.target.value || null })}
        options={[
          { value: '', label: 'Any length' },
          ...steps.map((m) => ({ value: String(m), label: `Up to ${formatHours(m)}` })),
        ]}
      />
    </Field>
  );
}

function NightsRangeFilter({ filter, params, facets, onChange }: ControlProps<'nights-range'>) {
  const nights = (facets.options.nights ?? []).map((o) => Number(o.value));
  if (nights.length < 2) return null;
  const [minParam, maxParam] = filter.params;
  const options = nights.map((n) => ({ value: String(n), label: `${n} nights` }));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-label text-ink">{filter.label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <Field label="At least">
          <Select
            value={params.get(minParam) ?? ''}
            onChange={(e) => onChange({ [minParam]: e.target.value || null })}
            options={[{ value: '', label: 'Any' }, ...options]}
          />
        </Field>
        <Field label="At most">
          <Select
            value={params.get(maxParam) ?? ''}
            onChange={(e) => onChange({ [maxParam]: e.target.value || null })}
            options={[{ value: '', label: 'Any' }, ...options]}
          />
        </Field>
      </div>
    </fieldset>
  );
}

function ToggleFilter({ filter, params, facets, onChange }: ControlProps<'toggle'>) {
  // A feature only some suppliers report: offer it only if a result has it,
  // unless it is already applied (so it can still be turned off).
  const on = params.get(filter.param) === '1';
  if (filter.facet && !on && !facets.options[filter.facet]?.length) return null;
  return (
    <Checkbox
      label={filter.label}
      checked={on}
      onChange={(e) => onChange({ [filter.param]: e.target.checked ? '1' : null })}
    />
  );
}

function FilterControl(props: {
  filter: FilterConfig;
  params: URLSearchParams;
  facets: SearchFacets;
  currency: string;
  onChange: (updates: ParamUpdate) => void;
}) {
  const { filter } = props;
  switch (filter.kind) {
    case 'options':
      return <OptionsFilter {...props} filter={filter} />;
    case 'at-most':
      return <CountFilter {...props} filter={filter} />;
    case 'at-least':
      return <CountFilter {...props} filter={filter} />;
    case 'price-range': {
      const key = filter.params.map((p) => props.params.get(p) ?? '').join('|');
      return <PriceRangeFilter key={key} {...props} filter={filter} />;
    }
    case 'max-duration':
      return <MaxDurationFilter {...props} filter={filter} />;
    case 'nights-range':
      return <NightsRangeFilter {...props} filter={filter} />;
    case 'toggle':
      return <ToggleFilter {...props} filter={filter} />;
  }
}

/** All filter controls of a category; nothing for filters with no choices. */
export function FilterPanel({
  serviceType,
  params,
  facets,
  currency,
  onChange,
}: {
  serviceType: SearchServiceType;
  params: URLSearchParams;
  facets: SearchFacets;
  currency: string;
  onChange: (updates: ParamUpdate) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {SEARCH_CONFIG[serviceType].filters.map((filter) => (
        <FilterControl
          key={'params' in filter ? filter.params.join('-') : filter.param}
          filter={filter}
          params={params}
          facets={facets}
          currency={currency}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/** Number of active filter values, for the mobile "Filters (3)" button. */
export function activeFilterCount(serviceType: SearchServiceType, params: URLSearchParams): number {
  const { filters } = readFilters(serviceType, params);
  return Object.values(filters).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
}
