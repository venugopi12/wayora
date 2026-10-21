import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { sendError } from '../utils/respond.js';

/** Errors raised by express.json() / body-parser carry a `type` and `status`. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** 404 for any route that did not match. */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, {
    code: 'NOT_FOUND',
    message: `No route matches ${req.method} ${req.path}.`,
  });
};

/**
 * Central error handler. Converts known errors to the standard envelope and
 * hides internals of unexpected errors (logged with the requestId instead).
 */
export function errorHandler(logger: Logger, options: { exposeInternals: boolean }) {
  const handler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId: res.locals.requestId }, err.message);
      sendError(res, err.status, {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }

    const bodyError = err as BodyParserError;
    if (bodyError?.type === 'entity.parse.failed') {
      sendError(res, 400, { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
      return;
    }
    if (bodyError?.type === 'entity.too.large') {
      sendError(res, 413, {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body exceeds the allowed size.',
      });
      return;
    }
    if (
      typeof bodyError?.status === 'number' &&
      bodyError.status >= 400 &&
      bodyError.status < 500
    ) {
      sendError(res, bodyError.status, {
        code: 'BAD_REQUEST',
        message: 'The request could not be processed.',
      });
      return;
    }

    logger.error(
      { err, requestId: res.locals.requestId, method: req.method, path: req.path },
      'Unhandled error',
    );
    sendError(res, 500, {
      code: 'INTERNAL_ERROR',
      message:
        options.exposeInternals && err instanceof Error
          ? err.message
          : 'Something went wrong on our side. Quote the request ID if you contact support.',
    });
  };
  return handler;
}
