import { Field, Select } from '@wayora/ui';
import type { Option } from '../config';

/** Sort order; the category's default is listed first and labelled. */
export function SortControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Sort by" className="w-full sm:w-60">
      <Select value={value} onChange={(e) => onChange(e.target.value)} options={[...options]} />
    </Field>
  );
}
