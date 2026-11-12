/**
 * Readable connection failures for the logs, without credentials.
 *
 * Node reports "connection refused" for a host with several addresses
 * (localhost → ::1 and 127.0.0.1) as an `AggregateError` with an empty
 * message; the reasons are in its `errors`. Messages are stripped of URL
 * credentials and trimmed (the same rule as the API's log-safety scrub).
 */
const MAX = 300;

function stripCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?/gi, '$1').slice(0, MAX);
}

export function connectionErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return stripCredentials(String(error));
  const inner =
    error instanceof AggregateError
      ? [...new Set(error.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))))]
          .filter(Boolean)
          .join('; ')
      : '';
  const code = (error as { code?: unknown }).code;
  return stripCredentials(
    error.message || inner || (typeof code === 'string' ? code : '') || error.name || 'unknown',
  );
}

/** The error's code (ECONNREFUSED…), when it has one. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** `host:port` of a connection URL without credentials; undefined when unparsable. */
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
