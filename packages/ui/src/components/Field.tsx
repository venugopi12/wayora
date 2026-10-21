import {
  type AriaAttributes,
  createContext,
  forwardRef,
  useContext,
  useId,
  type LabelHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Appends a visual required marker (the control itself carries `required`). */
  required?: boolean;
  /** Visually hidden but still read by assistive technology. */
  visuallyHidden?: boolean;
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { required, visuallyHidden, className, children, ...rest },
  ref,
) {
  return (
    <label
      ref={ref}
      className={cn('text-label text-ink', visuallyHidden && 'sr-only', className)}
      {...rest}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-danger-ink" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
});

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Wiring for controls rendered inside a <Field>: id, aria-describedby,
 * aria-invalid and required. Explicit props on the control win.
 */
export function useFieldControl(props: {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  required?: boolean;
}) {
  const field = useContext(FieldContext);
  const invalid = props['aria-invalid'] ?? (field?.invalid || undefined);
  return {
    id: props.id ?? field?.id,
    'aria-describedby':
      [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': invalid,
    required: props.required ?? (field?.required || undefined),
    invalid: invalid === true || invalid === 'true',
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Help text shown under the control. */
  hint?: ReactNode;
  /** Error message. Marks the control invalid and is announced with it. */
  error?: ReactNode;
  required?: boolean;
  hideLabel?: boolean;
  /** Explicit id for the control; generated when omitted. */
  id?: string;
  className?: string;
  /** Exactly one form control: Input, Textarea or Select. */
  children: ReactNode;
}

/**
 * Labels a single control and connects its hint and error text.
 *
 *   <Field label="Email" error={errors.email?.message}>
 *     <Input type="email" {...register('email')} />
 *   </Field>
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  id,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <FieldContext.Provider
      value={{
        id: controlId,
        describedBy: [errorId, hintId].filter(Boolean).join(' ') || undefined,
        invalid: Boolean(error),
        required,
      }}
    >
      <div className={cn('flex flex-col gap-2', className)}>
        <Label htmlFor={controlId} required={required} visuallyHidden={hideLabel}>
          {label}
        </Label>
        {children}
        {error ? (
          <p id={errorId} className="text-body-sm text-danger-ink">
            {error}
          </p>
        ) : null}
        {hint ? (
          <p id={hintId} className="text-body-sm text-ink-secondary">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Shared visual treatment for text-like controls (Input, Textarea, Select). */
export const controlBase =
  'w-full rounded-md border bg-card text-body text-ink shadow-xs ' +
  'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard ' +
  'hover:border-ink-secondary ' +
  'focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--color-brand-200)] ' +
  'has-[:is(input,select,textarea):disabled]:cursor-not-allowed has-[:is(input,select,textarea):disabled]:border-line-strong ' +
  'has-[:is(input,select,textarea):disabled]:bg-sunken has-[:is(input,select,textarea):disabled]:text-ink-subtle';

export const controlBorder = (invalid: boolean) =>
  invalid
    ? 'border-danger focus-within:border-danger focus-within:shadow-[0_0_0_3px_var(--color-danger-soft)]'
    : 'border-line-control';
