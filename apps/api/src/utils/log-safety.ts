/*
 * What may reach the logs (docs/security.md#logging). Error messages from
 * drivers, suppliers and the ORM can embed URLs with credentials, tokens or
 * the values of a failed query, so they are scrubbed and trimmed before
 * logging. Pino's `redact` paths cover structured fields; this covers text.
 */

const MAX_LOGGED_MESSAGE = 300;

/**
 * Removes credentials and noise from text:
 * - URLs (any scheme, e.g. postgresql://, redis://, https://) lose user info
 *   and query strings, keeping scheme, host and path,
 * - `key=value` / `key: value` pairs for secret-looking keys are masked,
 * - bearer/basic credentials are masked (before key/value pairs, so a
 *   masked `Authorization:` key can't shield the token that follows),
 * - the result is truncated.
 */
export function scrub(text: string): string {
  return text
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?([^\s/?#]+)([^\s?#]*)(\?[^\s#]*)?(#\S*)?/gi,
      (_m, scheme: string, host: string, path: string, query?: string) =>
        `${scheme}${host}${path}${query ? '?[REDACTED]' : ''}`,
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|signature|sig|session|cookie|authorization)\b(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
      '$1$2[REDACTED]',
    )
    .slice(0, MAX_LOGGED_MESSAGE);
}

/** A failure as it may be logged: class, scrubbed message, and a code if one exists. */
export function errorForLog(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'NonError', message: scrub(String(error)) };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: scrub(error.message),
    ...(typeof code === 'string' ? { code: scrub(code) } : {}),
  };
}

/**
 * An unexpected error as it may be logged: enough to debug, nothing from
 * the data. Only the message's first and last lines are kept (ORM errors
 * print the failed query, values included, between "Invalid … invocation"
 * and the reason on the last line), the
 * stack keeps its frames only, and ORM metadata is reduced to the model and
 * constraint names.
 */
export function unexpectedErrorForLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'NonError', message: scrub(String(error)) };
  const base = errorForLog(
    Object.assign(new Error(outline(error.message)), {
      name: error.name,
      code: (error as { code?: unknown }).code,
    }),
  );
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 15)
    .map((line) => scrub(line.trim()));
  const meta = (error as { meta?: unknown }).meta;
  const safeMeta =
    meta && typeof meta === 'object'
      ? Object.fromEntries(
          Object.entries(meta as Record<string, unknown>)
            .filter(
              ([k]) =>
                k === 'modelName' ||
                k === 'target' ||
                k === 'field_name' ||
                k === 'driverAdapterError',
            )
            .map(([k, v]) => [k, typeof v === 'string' || Array.isArray(v) ? v : '[object]']),
        )
      : undefined;
  const cause = error.cause instanceof Error ? errorForLog(error.cause) : undefined;
  return {
    ...base,
    ...(frames.length ? { stack: frames } : {}),
    ...(safeMeta && Object.keys(safeMeta).length ? { meta: safeMeta } : {}),
    ...(cause ? { cause: { ...cause, message: firstLine(cause.message) } } : {}),
  };
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';

/** First and last non-empty lines ("Invalid `x()` invocation: … reason"). */
function outline(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? '';
  return `${lines[0]} … ${lines[lines.length - 1]}`;
}

/**
 * A readable, scrubbed reason for a failed network connection. Node reports
 * "connection refused" for a host with several addresses (localhost → ::1
 * and 127.0.0.1) as an `AggregateError` whose own message is empty; the
 * reasons are in its `errors`. Falls back to the error code.
 */
export function connectionErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return scrub(String(error));
  const inner =
    error instanceof AggregateError
      ? [...new Set(error.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))))]
          .filter(Boolean)
          .join('; ')
      : '';
  const code = (error as { code?: unknown }).code;
  return scrub(
    error.message || inner || (typeof code === 'string' ? code : '') || error.name || 'unknown',
  );
}

/** `host:port` of a connection URL, without credentials; undefined when unparsable. */
export function endpointForLog(url: string): string | undefined {
  try {
    const { hostname, port, protocol } = new URL(url);
    const fallback = protocol.startsWith('redis')
      ? '6379'
      : protocol.startsWith('postgres')
        ? '5432'
        : '';
    return `${hostname}:${port || fallback}`;
  } catch {
    return undefined;
  }
}
