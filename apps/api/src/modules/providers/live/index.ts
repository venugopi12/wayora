import type { ConfigSource } from '../credentials.js';
import type { SearchProvider } from '../provider.js';

/*
 * Live supplier adapters (docs/providers.md#adding-a-real-supplier).
 *
 * NONE IS INTEGRATED. Wayora has no supplier contract, API documentation,
 * SDK, credentials or sandbox access in this repository, and no adapter is
 * written against an API that hasn't been made available: endpoints, fields
 * and capabilities are never guessed. Every search result is therefore demo
 * data, labelled as such.
 *
 * To add a supplier once access exists:
 * 1. Write `live/<supplier>.ts` implementing SearchProvider (`kind: 'live'`),
 *    using ProviderHttpClient (../http.ts) and readProviderConfig
 *    (../credentials.ts); validate every response with a schema before
 *    mapping it to the normalized result types.
 * 2. Declare `requiredConfig` (env var NAMES) and only the operations the
 *    supplier really supports (`revalidate` only with a read-only offer
 *    check; `book` stays unsupported until a reservation flow exists).
 * 3. Return it from createLiveProviders below and add the names, empty, to
 *    apps/api/.env.example.
 * 4. Add tests with recorded or hand-written responses (no credentials), and
 *    sandbox tests that run only when the sandbox variables are set.
 */
export function createLiveProviders(_config: ConfigSource): SearchProvider[] {
  return [];
}
