import { deriveReadinessStatus, type DependencyHealth, type Readiness } from '@wayora/contracts';

/**
 * A dependency the API can probe. `check` resolves when healthy and rejects
 * otherwise. Return `'disabled'` when the dependency is intentionally off.
 */
export interface DependencyCheck {
  name: string;
  essential: boolean;
  check: () => Promise<void | 'disabled'>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(dep: DependencyCheck, timeoutMs: number): Promise<DependencyHealth> {
  const started = performance.now();
  try {
    const result = await withTimeout(dep.check(), timeoutMs);
    if (result === 'disabled')
      return { name: dep.name, essential: dep.essential, state: 'disabled' };
    return {
      name: dep.name,
      essential: dep.essential,
      state: 'up',
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      name: dep.name,
      essential: dep.essential,
      state: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: describeError(error),
    };
  }
}

/** Short, single-line reason. Some drivers throw errors with an empty message. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const message = error.message.split('\n')[0]?.trim();
  if (message) return message;
  const code = (error as { code?: unknown }).code;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause || (typeof code === 'string' ? `${error.name} (${code})` : error.name);
}

/** Probes all dependencies in parallel; a slow dependency cannot exceed `timeoutMs`. */
export async function checkReadiness(
  dependencies: readonly DependencyCheck[],
  timeoutMs: number,
): Promise<Readiness> {
  const results = await Promise.all(dependencies.map((dep) => runCheck(dep, timeoutMs)));
  return {
    status: deriveReadinessStatus(results),
    timestamp: new Date().toISOString(),
    dependencies: results,
  };
}
