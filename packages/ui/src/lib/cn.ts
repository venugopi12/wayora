export type ClassValue = string | false | null | undefined;

/**
 * Joins class names, skipping falsy values. Components put `className` last so
 * callers can extend styles; avoid passing classes that conflict with a variant.
 */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
