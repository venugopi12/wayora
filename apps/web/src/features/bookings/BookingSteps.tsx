import { Check } from 'lucide-react';
import { cn } from '@wayora/ui';
import { CHECKOUT_STEPS, type CheckoutStep } from './paths';

/** Where the visitor is in the booking flow. The current step is marked for screen readers. */
export function BookingSteps({ current }: { current: CheckoutStep }) {
  const index = CHECKOUT_STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Booking steps">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm">
        {CHECKOUT_STEPS.map((step, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <li
              key={step.id}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2',
                i > 0 && 'before:h-px before:w-5 before:bg-line-strong',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-caption font-semibold',
                  active && 'bg-brand text-ink-inverse',
                  done && 'bg-brand-soft text-brand-ink',
                  !active && !done && 'border border-line-strong text-ink-secondary',
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={2.5} /> : i + 1}
              </span>
              <span className={cn(active ? 'font-semibold text-ink' : 'text-ink-secondary')}>
                {step.label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
