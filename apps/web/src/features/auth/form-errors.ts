import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiClientError } from '../../lib/api-client';

/**
 * Turns a failed account request into what the form shows:
 * - validation errors from the API go on their fields (`body.email` → `email`),
 * - everything else becomes one form-level message (returned; `null` when
 *   every problem was placed on a field, which then has focus).
 *
 * Server messages for auth failures are deliberately generic (they don't say
 * whether an email is registered), so they can be shown as they are.
 */
export function applyServerError<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): string | null {
  if (!(error instanceof ApiClientError)) {
    return 'Something went wrong. Please try again.';
  }
  switch (error.code) {
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return "We couldn't reach Wayora. Check your connection and try again.";
    case 'INVALID_RESPONSE':
      return 'Something went wrong on our side. Please try again in a moment.';
    case 'VALIDATION_FAILED': {
      let placed = false;
      for (const issue of error.details) {
        const name = issue.path.replace(/^body\./, '') as Path<T>;
        if (fields.includes(name)) {
          setError(name, { type: 'server', message: issue.message }, { shouldFocus: !placed });
          placed = true;
        }
      }
      return placed ? null : error.message;
    }
    default:
      return error.message;
  }
}
