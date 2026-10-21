import { ChevronDown } from 'lucide-react';
import { Accordion as AccordionPrimitive } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { interaction } from '../motion/presets';

/**
 * Accessible accordion (WAI-ARIA accordion pattern via Radix): each header is
 * a heading containing a button with aria-expanded / aria-controls; Enter and
 * Space toggle, Up/Down/Home/End move between headers. Use `type="multiple"`
 * so opening one section doesn't close another unless that is the intent.
 *
 * Closed content is removed from the accessibility tree. Opening fades the
 * content in (opacity only); the reduced-motion policy shortens it to ~0 ms.
 */
export const Accordion = AccordionPrimitive.Root;

export type AccordionTone = 'default' | 'inverse';

export const AccordionItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof AccordionPrimitive.Item> & { tone?: AccordionTone }
>(function AccordionItem({ className, tone = 'default', ...props }, ref) {
  return (
    <AccordionPrimitive.Item
      ref={ref}
      className={cn(
        'border-b',
        tone === 'inverse' ? 'border-line-inverse' : 'border-line',
        className,
      )}
      {...props}
    />
  );
});

export interface AccordionTriggerProps extends ComponentPropsWithoutRef<
  typeof AccordionPrimitive.Trigger
> {
  /** Heading level wrapping the button, so the outline stays correct. Default h3. */
  headingLevel?: 'h2' | 'h3' | 'h4';
  tone?: AccordionTone;
  children: ReactNode;
}

export const AccordionTrigger = forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  function AccordionTrigger(
    { className, children, headingLevel = 'h3', tone = 'default', ...props },
    ref,
  ) {
    const Heading = headingLevel;
    return (
      <AccordionPrimitive.Header asChild>
        <Heading className="flex">
          <AccordionPrimitive.Trigger
            ref={ref}
            className={cn(
              'group flex min-h-12 flex-1 items-center justify-between gap-4 rounded-xs py-3 text-start text-label',
              tone === 'inverse'
                ? 'text-ink-inverse hover:text-white'
                : 'text-ink hover:text-brand-ink',
              className,
            )}
            {...props}
          >
            {children}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0',
                tone === 'inverse' ? 'text-ink-inverse-secondary' : 'text-ink-secondary',
                interaction.iconRotate,
              )}
            />
          </AccordionPrimitive.Trigger>
        </Heading>
      </AccordionPrimitive.Header>
    );
  },
);

export const AccordionContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden data-[state=open]:animate-fade-in"
      {...props}
    >
      <div className={cn('pb-4', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
});
