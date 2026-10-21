import type { ProviderInfo, SearchServiceType } from '@wayora/contracts';
import type { SearchProvider } from './provider.js';

export interface ProviderRegistryOptions {
  /** Serve demo (fixture) providers. Off in production unless explicitly enabled. */
  demoEnabled: boolean;
  /** Provider ids switched off by configuration. */
  disabledIds?: readonly string[];
  /** Whether a named configuration value is present (for `requiredConfig`). */
  isConfigured?: (name: string) => boolean;
}

interface Registration {
  provider: SearchProvider;
  enabled: boolean;
  disabledReason: string | null;
}

/**
 * Explicit list of the providers this API instance knows, and which are
 * enabled. Registration happens once at startup (app.ts); nothing is
 * discovered dynamically, so the set of outbound integrations is always
 * visible in code.
 */
export class ProviderRegistry {
  private readonly registrations: Registration[] = [];

  constructor(private readonly options: ProviderRegistryOptions) {}

  register(provider: SearchProvider): this {
    if (this.registrations.some((r) => r.provider.id === provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    const { demoEnabled, disabledIds = [], isConfigured = () => false } = this.options;
    const missing = provider.requiredConfig.filter((name) => !isConfigured(name));
    let disabledReason: string | null = null;
    if (disabledIds.includes(provider.id)) disabledReason = 'Disabled by configuration.';
    else if (provider.kind === 'demo' && !demoEnabled)
      disabledReason = 'Demo data is switched off.';
    else if (missing.length > 0) disabledReason = 'Not configured.';
    this.registrations.push({ provider, enabled: disabledReason === null, disabledReason });
    return this;
  }

  /** Enabled providers that support search for this category, in registration order. */
  searchProvidersFor(serviceType: SearchServiceType): SearchProvider[] {
    return this.registrations
      .filter(
        (r) =>
          r.enabled &&
          r.provider.operations.search === 'supported' &&
          r.provider.serviceTypes.includes(serviceType),
      )
      .map((r) => r.provider);
  }

  /** Safe metadata for GET /providers: no configuration values, URLs or credentials. */
  describe(): ProviderInfo[] {
    return this.registrations.map(({ provider, enabled, disabledReason }) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      serviceTypes: [...provider.serviceTypes],
      operations: { ...provider.operations },
      enabled,
      disabledReason,
      timeoutMs: provider.timeoutMs,
    }));
  }
}
