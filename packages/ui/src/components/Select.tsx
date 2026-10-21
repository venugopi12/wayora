import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { controlBase, controlBorder, useFieldControl } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options?: SelectOption[];
  /** Shown as a disabled first option when no value is selected. */
  placeholder?: string;
  size?: 'md' | 'lg';
}

/**
 * Native select, styled. Native is deliberate: it gives the platform picker on
 * mobile, full keyboard and screen-reader support, and works with form libraries.
 * Use DropdownMenu for actions, not for form values.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, size = 'md', className, children, ...props },
  ref,
) {
  const { invalid, ...wiring } = useFieldControl(props);
  return (
    <div
      className={cn(
        controlBase,
        controlBorder(invalid),
        'relative flex items-center',
        size === 'lg' ? 'h-13' : 'h-11',
        className,
      )}
    >
      <select
        ref={ref}
        {...props}
        {...wiring}
        defaultValue={
          props.value === undefined && placeholder ? (props.defaultValue ?? '') : props.defaultValue
        }
        className="h-full w-full cursor-pointer appearance-none bg-transparent pr-10 pl-3.5 outline-none focus-visible:outline-none disabled:cursor-not-allowed"
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3.5 size-[18px] text-ink-secondary"
        aria-hidden="true"
      />
    </div>
  );
});
