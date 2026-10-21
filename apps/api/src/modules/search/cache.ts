import type {
  ProviderStatus,
  SearchResult,
  SearchServiceType,
  SearchWarning,
} from '@wayora/contracts';

/** One completed provider round, before filters, sorting and pagination. */
export interface AggregatedSearch {
  searchId: string;
  serviceType: SearchServiceType;
  /** Validated, de-duplicated results in provider order. */
  results: readonly SearchResult[];
  providerStatuses: readonly ProviderStatus[];
  /** Warnings that belong to the provider round (e.g. invalid provider data). */
  warnings: readonly SearchWarning[];
  generatedAt: Date;
  expiresAt: Date;
}

/**
 * Search sessions (docs/search.md#cache-and-sessions).
 *
 * - `getById`: any stored round, by its `searchId`, until it expires. Offer
 *   pages read results from here, so an offer is always the server's copy.
 * - `get`: a round that may be REUSED for an identical request (same request
 *   key). Only rounds where every provider answered are reusable, so "Try
 *   again" after a failure really asks the providers again.
 */
export interface SearchCache {
  get(key: string): AggregatedSearch | undefined;
  set(key: string, value: AggregatedSearch, options?: { reusable?: boolean }): void;
  getById(searchId: string): AggregatedSearch | undefined;
}

interface Entry {
  round: AggregatedSearch;
  key: string;
  reusable: boolean;
}

/**
 * In-process store of provider rounds. Entries live until their `expiresAt`
 * and the least recently used entry is evicted beyond `maxEntries`, so memory
 * stays bounded. Keys include every parameter that changes provider answers
 * (route, dates, party, currency, cabin…) plus provider ids and versions;
 * filters, sort and page are applied afterwards and are not part of the key.
 * Search is public and user-independent, so entries hold no personal data.
 *
 * Per-process by design: with several API instances each keeps its own, so an
 * offer page served by another instance reports the search as expired and
 * offers to refresh it. A shared store can implement this interface later.
 */
export class MemorySearchCache implements SearchCache {
  /** By searchId, in least-recently-used order. */
  private readonly entries = new Map<string, Entry>();
  /** Request key → searchId of its reusable round. */
  private readonly reusableByKey = new Map<string, string>();

  constructor(
    private readonly maxEntries = 200,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private live(searchId: string | undefined): Entry | undefined {
    if (searchId === undefined) return undefined;
    const entry = this.entries.get(searchId);
    if (!entry) return undefined;
    if (entry.round.expiresAt.getTime() <= this.now().getTime()) {
      this.remove(searchId);
      return undefined;
    }
    // Refresh recency (Map keeps insertion order).
    this.entries.delete(searchId);
    this.entries.set(searchId, entry);
    return entry;
  }

  private remove(searchId: string): void {
    const entry = this.entries.get(searchId);
    if (!entry) return;
    this.entries.delete(searchId);
    if (this.reusableByKey.get(entry.key) === searchId) this.reusableByKey.delete(entry.key);
  }

  get(key: string): AggregatedSearch | undefined {
    const entry = this.live(this.reusableByKey.get(key));
    return entry?.reusable ? entry.round : undefined;
  }

  getById(searchId: string): AggregatedSearch | undefined {
    return this.live(searchId)?.round;
  }

  set(
    key: string,
    round: AggregatedSearch,
    { reusable = true }: { reusable?: boolean } = {},
  ): void {
    this.remove(round.searchId);
    this.entries.set(round.searchId, { round, key, reusable });
    if (reusable) {
      const previous = this.reusableByKey.get(key);
      if (previous !== undefined && previous !== round.searchId) {
        // The older round stays readable by id until it expires; only reuse moves on.
        const old = this.entries.get(previous);
        if (old) old.reusable = false;
      }
      this.reusableByKey.set(key, round.searchId);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
