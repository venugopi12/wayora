import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Readable long-form text (informational and legal pages): a ~65-character
 * measure, heading rhythm, list markers, and visible link underlines. Style
 * plain HTML children; no typography plugin needed.
 */
export function Prose({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'max-w-prose text-body text-ink-secondary',
        '[&>*+*]:mt-4 [&_h2]:mt-12 [&_h2]:text-heading-3 [&_h2]:text-ink [&_h2:first-child]:mt-0',
        '[&_h3]:mt-8 [&_h3]:text-title [&_h3]:text-ink',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-2 [&_li]:marker:text-brand-300',
        '[&_strong]:font-semibold [&_strong]:text-ink',
        '[&_a]:font-semibold [&_a]:text-brand-ink [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-brand',
        className,
      )}
      {...rest}
    />
  );
}
