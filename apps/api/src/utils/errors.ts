import type { ApiErrorCode, ValidationIssue } from '@wayora/contracts';

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  // Search and offers (docs/search.md#errors).
  SEARCH_EXPIRED: 410,
  OFFER_NOT_FOUND: 404,
  OFFER_NOT_IN_SEARCH: 404,
  CATEGORY_MISMATCH: 409,
  OFFER_UNAVAILABLE: 410,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 503,
  SEARCH_FAILED: 502,
};

/**
 * An error that is safe to show to API clients. Anything that is *not* an
 * AppError is treated as an unexpected 500 and its message is hidden.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: { status?: number; details?: ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
  }

  readonly details: ValidationIssue[] | undefined;
}

export const notFound = (message = 'The requested resource was not found.') =>
  new AppError('NOT_FOUND', message);
