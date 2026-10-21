import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { controlBase, controlBorder, useFieldControl } from './Field';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line text input. Place inside <Field>. Resizes vertically only. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 4, ...props },
  ref,
) {
  const { invalid, ...wiring } = useFieldControl(props);
  return (
    <div className={cn(controlBase, controlBorder(invalid), 'px-3.5 py-2.5', className)}>
      <textarea
        ref={ref}
        rows={rows}
        {...props}
        {...wiring}
        className="block w-full resize-y bg-transparent outline-none focus-visible:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
});
