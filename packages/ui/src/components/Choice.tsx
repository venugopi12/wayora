import { Check } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
}

const row = 'group/choice relative flex items-start gap-3 py-1.5';
const control =
  'peer relative grid size-5 shrink-0 cursor-pointer appearance-none place-items-center border-[1.5px] border-line-control bg-card ' +
  'transition-[background-color,border-color] duration-(--duration-fast) ease-standard ' +
  'hover:border-brand checked:border-brand checked:bg-brand ' +
  'disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-sunken ' +
  'aria-invalid:border-danger mt-[2px]';

function ChoiceText({
  id,
  label,
  description,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <span className="flex flex-col">
      <label
        htmlFor={id}
        className="cursor-pointer text-body text-ink group-has-[:disabled]/choice:cursor-not-allowed group-has-[:disabled]/choice:text-ink-subtle"
      >
        {label}
      </label>
      {description ? (
        <span id={`${id}-description`} className="text-body-sm text-ink-secondary">
          {description}
        </span>
      ) : null}
    </span>
  );
}

/** Native checkbox with label and optional description. Toggles with Space. */
export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps>(function Checkbox(
  { label, description, id, className, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? `checkbox-${generated}`;
  return (
    <div className={cn(row, className)}>
      <span className="relative mt-0 flex">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          aria-describedby={description ? `${inputId}-description` : undefined}
          className={cn(control, 'rounded-xs')}
          {...rest}
        />
        <Check
          className="pointer-events-none absolute top-[4px] left-[2px] size-4 text-ink-inverse opacity-0 peer-checked:opacity-100"
          strokeWidth={3}
          aria-hidden="true"
        />
      </span>
      <ChoiceText id={inputId} label={label} description={description} />
    </div>
  );
});

interface RadioGroupContextValue {
  name: string;
}
const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps {
  /** Group label, rendered as the fieldset legend. */
  legend: ReactNode;
  /** Shared `name` for the radios. Generated when omitted. */
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Lay options out in a row from the `sm` breakpoint. */
  inline?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Groups radios in a fieldset/legend so the group label is announced.
 * Arrow keys move between options (native radio behaviour).
 */
export function RadioGroup({
  legend,
  name,
  hint,
  error,
  inline,
  className,
  children,
}: RadioGroupProps) {
  const generated = useId();
  const groupName = name ?? `radio-${generated}`;
  const hintId = hint ? `${groupName}-hint` : undefined;
  const errorId = error ? `${groupName}-error` : undefined;
  return (
    <RadioGroupContext.Provider value={{ name: groupName }}>
      <fieldset
        className={cn('flex flex-col gap-2', className)}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        aria-invalid={error ? true : undefined}
      >
        <legend className="mb-1 text-label text-ink">{legend}</legend>
        {hint ? (
          <p id={hintId} className="-mt-1 text-body-sm text-ink-secondary">
            {hint}
          </p>
        ) : null}
        <div className={cn('flex flex-col', inline && 'sm:flex-row sm:flex-wrap sm:gap-x-6')}>
          {children}
        </div>
        {error ? (
          <p id={errorId} className="text-body-sm text-danger-ink">
            {error}
          </p>
        ) : null}
      </fieldset>
    </RadioGroupContext.Provider>
  );
}

/** Native radio. Use inside <RadioGroup>, which supplies the shared name. */
export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio(
  { label, description, id, name, className, ...rest },
  ref,
) {
  const group = useContext(RadioGroupContext);
  const generated = useId();
  const inputId = id ?? `radio-${generated}`;
  return (
    <div className={cn(row, className)}>
      <span className="relative flex">
        <input
          ref={ref}
          id={inputId}
          type="radio"
          name={name ?? group?.name}
          aria-describedby={description ? `${inputId}-description` : undefined}
          className={cn(control, 'rounded-full')}
          {...rest}
        />
        <span
          className="pointer-events-none absolute top-[8px] left-[6px] size-2 rounded-full bg-card opacity-0 peer-checked:opacity-100"
          aria-hidden="true"
        />
      </span>
      <ChoiceText id={inputId} label={label} description={description} />
    </div>
  );
});
