import { inspect } from 'node:util';

/*
 * Supplier configuration for live adapters (docs/providers.md#configuration-and-credentials).
 *
 * - Values come from the API's environment only (never `VITE_*`, never the
 *   browser). `.env.example` lists names with empty values.
 * - A provider declares the NAMES it needs (`requiredConfig`); the registry
 *   disables it, with the reason "Not configured.", while any is missing, so
 *   an optional supplier never stops the API from starting.
 * - Secrets are wrapped in ProviderSecret: it can't be serialized, logged or
 *   printed by accident (JSON, string conversion and util.inspect all give
 *   "[redacted]"); only `reveal()`, at the point of building a request
 *   header, returns the value.
 */

export class ProviderSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value, for one outbound header. Never log what this returns. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'ProviderSecret([redacted])';
  }
}

export type ConfigSource = Readonly<Record<string, string | undefined>>;

export interface ProviderConfigSpec<Plain extends string, Secret extends string> {
  /** Non-secret settings, e.g. a base URL or an environment name. */
  plain: readonly Plain[];
  /** Credentials, e.g. an API key or client secret. */
  secret: readonly Secret[];
}

export type ProviderConfig<Plain extends string, Secret extends string> = {
  [K in Plain]: string;
} & { [K in Secret]: ProviderSecret };

/** Every name a spec needs, for `requiredConfig`. */
export function requiredNames(spec: ProviderConfigSpec<string, string>): string[] {
  return [...spec.plain, ...spec.secret];
}

/**
 * The provider's configuration, or null when anything is missing or blank.
 * Values are trimmed; URLs must be absolute http(s) (https outside
 * development) so a typo can't send credentials to the wrong place.
 */
export function readProviderConfig<Plain extends string, Secret extends string>(
  spec: ProviderConfigSpec<Plain, Secret>,
  source: ConfigSource,
  options: { requireHttps?: boolean } = {},
): ProviderConfig<Plain, Secret> | null {
  const out: Record<string, string | ProviderSecret> = {};
  for (const name of spec.plain) {
    const value = source[name]?.trim();
    if (!value) return null;
    if (/_(URL|BASE_URL|ORIGIN)$/.test(name)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return null;
      }
      const allowed = options.requireHttps ? ['https:'] : ['https:', 'http:'];
      if (!allowed.includes(url.protocol) || url.username || url.password) return null;
    }
    out[name] = value;
  }
  for (const name of spec.secret) {
    const value = source[name]?.trim();
    if (!value) return null;
    out[name] = new ProviderSecret(value);
  }
  return out as ProviderConfig<Plain, Secret>;
}
