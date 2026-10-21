/**
 * Runs `task` for every item with at most `limit` running at once, and
 * returns the results in input order. `task` must not reject (wrap failures
 * into values): this keeps a failing provider from rejecting the whole batch
 * and leaves no unhandled rejections behind.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs `operation` with an AbortSignal that fires after `timeoutMs` (or when
 * `parent` aborts). Rejects with TimeoutError on timeout even if the
 * operation ignores the signal, so a stuck adapter can't hold a search open.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = new TimeoutError(timeoutMs);
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    });
  });
  // The losing promise of the race must never surface as an unhandled rejection.
  stopped.catch(() => undefined);
  try {
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
