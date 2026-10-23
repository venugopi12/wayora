import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../utils/logger.js';

const QUIET_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);

/** `/a/b?x=1&y=2` → [`/a/b`, ['x', 'y']] (parameter names only, de-duplicated, bounded). */
export function splitUrl(url: string): [string, string[]] {
  const at = url.indexOf('?');
  if (at === -1) return [url, []];
  const names = new Set<string>();
  for (const part of url.slice(at + 1).split('&')) {
    const name = part.split('=')[0];
    if (name && /^[A-Za-z0-9_.-]{1,40}$/.test(name)) names.add(name);
    if (names.size >= 20) break;
  }
  return [url.slice(0, at), [...names]];
}

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
      // Query values stay out of the logs: they can hold searched emails
      // (admin user search), offer ids or other free text. Their names stay.
      req: (req: { method: string; url: string; headers: Record<string, unknown> }) => {
        const [path, query] = splitUrl(req.url);
        return {
          method: req.method,
          url: path,
          ...(query.length ? { query } : {}),
          userAgent: req.headers['user-agent'],
        };
      },
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
