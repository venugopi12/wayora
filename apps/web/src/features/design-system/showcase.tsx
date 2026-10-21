import type { ReactNode } from 'react';
import { cn } from '@wayora/ui';

export function ShowcaseSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-(--header-offset) border-t border-line pt-12 first:border-0 first:pt-0"
    >
      <h2 id={`${id}-title`} className="text-heading-2">
        {title}
      </h2>
      {description ? (
        <p className="mt-3 max-w-prose text-body text-ink-secondary">{description}</p>
      ) : null}
      <div className="mt-8 flex flex-col gap-8">{children}</div>
    </section>
  );
}

/** A labelled specimen panel. */
export function Specimen({
  label,
  note,
  tone = 'card',
  className,
  children,
}: {
  label: string;
  note?: ReactNode;
  tone?: 'card' | 'page' | 'deep';
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-label">{label}</span>
        {note ? <span className="text-caption text-ink-secondary">{note}</span> : null}
      </figcaption>
      <div
        className={cn(
          'rounded-xl border p-6',
          tone === 'card' && 'border-line bg-card',
          tone === 'page' && 'border-line bg-page',
          tone === 'deep' && 'border-transparent bg-deep text-ink-inverse focus-ring-inverse',
          className,
        )}
      >
        {children}
      </div>
    </figure>
  );
}

/**
 * Reads a CSS custom property from :root (single source of truth). The
 * stylesheet is loaded before React renders, so reading during render is safe.
 */
export function useCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrastRatio(a: string, b: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-sunken px-1.5 py-0.5 font-mono text-caption text-ink">
      {children}
    </code>
  );
}
