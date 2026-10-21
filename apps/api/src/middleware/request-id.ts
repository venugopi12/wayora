import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { REQUEST_ID_HEADER } from '@wayora/contracts';

/** Accept only short, header-safe inbound IDs so clients cannot inject log noise. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Reuses a well-formed inbound `X-Request-Id` (e.g. from a load balancer) or
 * generates a UUID, then exposes it on `res.locals.requestId` and the response.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get(REQUEST_ID_HEADER);
  const id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
