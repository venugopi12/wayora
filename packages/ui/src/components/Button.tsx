import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Spinner } from '../feedback/Spinner';
import { interaction } from '../motion/presets';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'inverse'
  | 'outline-inverse'
  | 'ghost-inverse';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface BaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Render the single child element (e.g. a router Link) with button styles. */
  asChild?: boolean;
}

export interface ButtonProps extends BaseProps {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

const base = cn(
  'inline-flex shrink-0 select-none items-center justify-center font-semibold whitespace-nowrap',
  interaction.press,
  'disabled:pointer-events-none aria-disabled:pointer-events-none [&_svg]:shrink-0',
);

/**
 * Light surfaces: `primary` (one per view), `secondary` (filled, bordered),
 * `outline` (transparent, bordered), `ghost` (text only), `destructive`.
 * Deep or photographic surfaces: `inverse`, `outline-inverse`, `ghost-inverse`.
 */
export const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-ink-inverse shadow-xs hover:bg-brand-hover active:bg-brand-active disabled:bg-brand-300',
  secondary:
    'border border-line-strong bg-card text-ink shadow-xs hover:border-brand-300 hover:bg-brand-50 disabled:text-ink-subtle disabled:bg-sunken',
  outline:
    'border border-line-strong text-ink hover:border-brand hover:bg-brand-soft hover:text-brand-ink disabled:text-ink-subtle disabled:border-line',
  ghost: 'text-ink hover:bg-brand-soft hover:text-brand-ink disabled:text-ink-subtle',
  /** Ghost button for deep or photographic surfaces (e.g. a header over a hero image). */
  'ghost-inverse':
    'text-ink-inverse hover:bg-white/12 focus-ring-inverse disabled:text-ink-inverse-secondary',
  inverse:
    'bg-card text-deep hover:bg-brand-100 focus-ring-inverse disabled:bg-white/40 disabled:text-deep/60',
  /** Irreversible or destructive actions (delete, cancel booking). Always label the consequence. */
  destructive: 'bg-danger text-ink-inverse shadow-xs hover:bg-danger-ink disabled:opacity-50',
  /** Bordered ghost for deep or photographic surfaces (secondary hero/CTA actions). */
  'outline-inverse':
    'text-ink-inverse ring-1 ring-white/35 ring-inset hover:bg-white/12 hover:ring-white/60 focus-ring-inverse disabled:text-ink-inverse-secondary disabled:ring-white/20',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 gap-1.5 rounded-sm px-3.5 text-body-sm [&_svg]:size-4',
  md: 'h-11 gap-2 rounded-md px-5 text-body [&_svg]:size-[18px]',
  lg: 'h-13 gap-2.5 rounded-md px-6 text-body-lg [&_svg]:size-5',
};

/** Primary action component. Minimum touch target 44px at size md and lg. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    asChild = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    disabled,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  const classes = cn(base, buttonVariants[variant], sizes[size], fullWidth && 'w-full', className);

  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...rest}
    >
      {loading ? <Spinner size="sm" label="" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends Omit<BaseProps, 'children' | 'aria-label'> {
  /** Required accessible name — icon-only buttons have no visible text. */
  label: string;
  icon: ReactNode;
}

const iconSizes: Record<ButtonSize, string> = {
  sm: 'size-9 rounded-sm [&_svg]:size-4',
  md: 'size-11 rounded-md [&_svg]:size-5',
  lg: 'size-13 rounded-md [&_svg]:size-6',
};

/** Square, icon-only button. `label` becomes its accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    loading = false,
    asChild = false,
    disabled,
    className,
    type,
    ...rest
  },
  ref,
) {
  const classes = cn(base, buttonVariants[variant], iconSizes[size], className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} aria-label={label} className={classes} {...rest}>
        {icon}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...rest}
    >
      {loading ? <Spinner size="sm" label="" /> : icon}
    </button>
  );
});
