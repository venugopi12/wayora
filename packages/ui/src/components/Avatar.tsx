import { Avatar as AvatarPrimitive } from 'radix-ui';
import { cn } from '../lib/cn';

export interface AvatarProps {
  /** Person's name: used for the alt text and the initials fallback. */
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizes = {
  sm: 'size-8 text-caption',
  md: 'size-10 text-label',
  lg: 'size-14 text-title',
} as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** Image avatar that falls back to initials while loading or when the image fails. */
export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden rounded-full bg-brand-soft align-middle ring-2 ring-card',
        sizes[size],
        className,
      )}
    >
      {src ? (
        <AvatarPrimitive.Image src={src} alt={name} className="size-full object-cover" />
      ) : null}
      <AvatarPrimitive.Fallback
        className="flex size-full items-center justify-center font-semibold text-brand-ink"
        delayMs={src ? 300 : 0}
      >
        <span aria-hidden="true">{initials(name)}</span>
        <span className="sr-only">{name}</span>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
