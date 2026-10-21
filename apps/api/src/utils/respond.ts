import type { Response } from 'express';
import type { ApiErrorEnvelope, ApiSuccessEnvelope } from '@wayora/contracts';

export function getRequestId(res: Response): string {
  return (res.locals.requestId as string | undefined) ?? 'unknown';
}

/** Sends the standard success envelope `{ data, meta: { requestId } }`. */
export function sendData<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessEnvelope<T> = { data, meta: { requestId: getRequestId(res) } };
  res.status(status).json(body);
}

/** Sends the standard error envelope `{ error: { code, message, requestId, details? } }`. */
export function sendError(
  res: Response,
  status: number,
  error: Omit<ApiErrorEnvelope['error'], 'requestId'>,
): void {
  const body: ApiErrorEnvelope = { error: { ...error, requestId: getRequestId(res) } };
  res.status(status).json(body);
}
