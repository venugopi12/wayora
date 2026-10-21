import { Link } from 'react-router';
import { cn, effects } from '@wayora/ui';
import type { FooterLink } from '../../features/navigation/footer';

/** A footer link: muted on navy, brightens with a drawn underline on hover/focus. */
export function FooterNavLink({ link, className }: { link: FooterLink; className?: string }) {
  return (
    <Link
      to={link.to}
      className={cn(
        'rounded-xs text-ink-inverse-secondary transition-colors duration-(--duration-fast) hover:text-ink-inverse',
        effects.underline,
        className,
      )}
    >
      {link.label}
    </Link>
  );
}
