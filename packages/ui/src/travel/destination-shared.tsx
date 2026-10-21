import { Slot } from 'radix-ui';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { MediaAspect } from '../components/MediaFrame';
import { cn } from '../lib/cn';

export type DestinationAspect = 'portrait' | 'landscape' | 'square';

export const destinationAspectClass: Record<DestinationAspect, string> = {
  portrait: 'aspect-[4/5]',
  landscape: 'aspect-[16/10]',
  square: 'aspect-square',
};

export const destinationMediaAspect: Record<DestinationAspect, MediaAspect> = {
  portrait: '4/5',
  landscape: '16/10',
  square: '1/1',
};

/** Turns the destination name into the card's single, stretched link. */
export function linkedTitle(
  name: string,
  link: ReactElement | undefined,
  linkClassName: string,
  describedBy?: string,
) {
  if (!isValidElement(link)) return { interactive: false, title: name };
  return {
    interactive: true,
    title: (
      <Slot.Root
        className={cn('stretched-link outline-none focus-visible:outline-none', linkClassName)}
      >
        {cloneElement(link as ReactElement<{ children?: ReactNode; 'aria-describedby'?: string }>, {
          children: name,
          'aria-describedby': describedBy,
        })}
      </Slot.Root>
    ),
  };
}
