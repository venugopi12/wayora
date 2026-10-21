import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { controlBase, controlBorder, useFieldControl } from './Field';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Decorative icon or text before the value (e.g. a MapPin icon). */
  leading?: ReactNode;
  /** Icon, unit or button after the value. */
  trailing?: ReactNode;
  size?: 'md' | 'lg';
}

/**
 * Single-line text input. Place inside <Field> for a label, hint and error.
 * Works with React Hook Form's register() via ref forwarding.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, size = 'md', className, ...props },
  ref,
) {
  const { invalid, ...wiring } = useFieldControl(props);
  return (
    <div
      className={cn(
        controlBase,
        controlBorder(invalid),
        'flex items-center gap-2.5 px-3.5',
        size === 'lg' ? 'h-13' : 'h-11',
        className,
      )}
    >
      {leading ? (
        <span className="flex text-ink-secondary [&_svg]:size-[18px]" aria-hidden="true">
          {leading}
        </span>
      ) : null}
      <input
        ref={ref}
        {...props}
        {...wiring}
        className="h-full min-w-0 flex-1 bg-transparent outline-none focus-visible:outline-none disabled:cursor-not-allowed"
      />
      {trailing ? (
        <span className="flex items-center text-ink-secondary [&_svg]:size-[18px]">{trailing}</span>
      ) : null}
    </div>
  );
});
