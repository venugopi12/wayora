import { z } from 'zod';

/**
 * `up`       – dependency responded correctly.
 * `down`     – dependency is configured but failing.
 * `disabled` – dependency is intentionally not configured in this environment.
 */
export const dependencyStateSchema = z.enum(['up', 'down', 'disabled']);
export type DependencyState = z.infer<typeof dependencyStateSchema>;

export const dependencyHealthSchema = z.object({
  name: z.string(),
  /** Essential dependencies decide readiness; optional ones only degrade it. */
  essential: z.boolean(),
  state: dependencyStateSchema,
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const livenessSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type Liveness = z.infer<typeof livenessSchema>;

/**
 * `ready`    – all essential dependencies are up (HTTP 200).
 * `degraded` – essential dependencies up, at least one optional dependency down (HTTP 200).
 * `unready`  – at least one essential dependency is down (HTTP 503).
 */
export const readinessStatusSchema = z.enum(['ready', 'degraded', 'unready']);
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>;

export const readinessSchema = z.object({
  status: readinessStatusSchema,
  timestamp: z.iso.datetime(),
  dependencies: z.array(dependencyHealthSchema),
});
export type Readiness = z.infer<typeof readinessSchema>;

/** Pure helper so the API and its tests agree on how readiness is derived. */
export function deriveReadinessStatus(dependencies: readonly DependencyHealth[]): ReadinessStatus {
  if (dependencies.some((d) => d.essential && d.state !== 'up')) return 'unready';
  if (dependencies.some((d) => !d.essential && d.state === 'down')) return 'degraded';
  return 'ready';
}
