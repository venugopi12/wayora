import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../utils/logger.js';

const QUIET_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);

/** Structured access log: one line per request, correlated by requestId. */
export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (_req: IncomingMessage, res: ServerResponse) =>
      (res as ServerResponse & { locals?: { requestId?: string } }).locals?.requestId ?? 'unknown',
    customAttributeKeys: { reqId: 'requestId' },
    autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url?.split('?')[0] ?? '') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { method: string; url: string; headers: Record<string, unknown> }) => ({
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
