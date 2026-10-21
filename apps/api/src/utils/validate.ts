import type { Request } from 'express';
import type { z } from 'zod';
import type { ValidationIssue } from '@wayora/contracts';
import { AppError } from './errors.js';

type Part = 'params' | 'query' | 'body';

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

export type ValidatedRequest<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

/**
 * Validates the selected parts of a request and returns typed, parsed values.
 * All failing parts are reported together as one VALIDATION_FAILED error.
 *
 *   const { params } = validateRequest(req, { params: categoryParamsSchema });
 */
export function validateRequest<S extends RequestSchemas>(
  req: Request,
  schemas: S,
): ValidatedRequest<S> {
  const output: Partial<Record<Part, unknown>> = {};
  const issues: ValidationIssue[] = [];

  for (const part of ['params', 'query', 'body'] as const) {
    const schema = schemas[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part] ?? {});
    if (result.success) {
      output[part] = result.data;
    } else {
      for (const issue of result.error.issues) {
        issues.push({
          path: [part, ...issue.path.map(String)].join('.'),
          message: issue.message,
          code: issue.code,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'The request is invalid.', { details: issues });
  }
  return output as ValidatedRequest<S>;
}
