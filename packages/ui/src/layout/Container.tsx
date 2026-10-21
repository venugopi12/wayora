import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type ContainerSize = 'prose' | 'narrow' | 'page' | 'wide' | 'full';

const sizes: Record<ContainerSize, string> = {
  prose: 'max-w-prose',
  narrow: 'max-w-narrow',
  page: 'max-w-page',
  wide: 'max-w-wide',
  full: 'max-w-none',
};

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  size?: ContainerSize;
  as?: ElementType;
}

/** Centres content at a token width with the fluid page gutter on both sides. */
export function Container({ size = 'page', as: Tag = 'div', className, ...rest }: ContainerProps) {
  return <Tag className={cn('mx-auto w-full px-gutter', sizes[size], className)} {...rest} />;
}
