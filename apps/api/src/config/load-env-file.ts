import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads `apps/api/.env` into process.env when present (Node's built-in loader;
 * already-set variables win). Production deployments inject env vars directly.
 */
export function loadEnvFile(appRoot: string): void {
  const file = path.join(appRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
