import { createHash, randomUUID } from 'node:crypto';
import {
  DEMO_DATA_DISCLAIMER,
  TRAVEL_CATEGORIES,
  searchResultSchemas,
  type OfferResponse,
  type ProviderStatus,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchServiceType,
  type SearchWarning,
} from '@wayora/contracts';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { ProviderError, type SearchProvider } from '../providers/provider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AggregatedSearch, SearchCache } from './cache.js';
import { TimeoutError, mapWithConcurrency, withTimeout } from './concurrency.js';
import { computeFacets } from './facets.js';
import { applyFilters, applySort, priceAmount } from './refine.js';

export interface SearchServiceOptions {
  registry: ProviderRegistry;
  logger: Logger;
  /** Optional cache of provider rounds; search works the same without it. */
  cache?: SearchCache;
  /** Providers queried at once. */
  concurrency?: number;
  /** How long a provider round is reused (and offered as `expiresAt`). */
  resultTtlMs?: number;
  now?: () => Date;
}

/** Safe, user-facing messages per outcome. Never include provider internals. */
const STATUS_MESSAGES = {
  timeout: 'This provider took too long to answer.',
  unavailable: 'This provider is unavailable right now.',
  error: 'This provider could not complete the search.',
  invalid: 'This provider returned results Wayora could not use.',
} as const;

interface ProviderRound {
  status: ProviderStatus;
  results: { result: SearchResult; dedupeKey: string | undefined }[];
  invalidCount: number;
}

const categoryName = (type: SearchRequest['serviceType']) =>
  TRAVEL_CATEGORIES.find((c) => c.slug === type)?.name ?? type;

/**
 * The search engine: one orchestration for every category
 * (docs/search.md#orchestration).
 *
 * 1. resolve enabled providers for the category, 2. query them with bounded
 * concurrency and per-provider time limits, 3. validate every result against
 * the shared contract, 4. merge and de-duplicate, 5. filter, sort and page.
 * A failing provider becomes a status entry; only when every provider fails
 * does the search fail.
 */
export class SearchService {
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: SearchServiceOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.ttlMs = options.resultTtlMs ?? 2 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const providers = this.options.registry.searchProvidersFor(request.serviceType);
    if (providers.length === 0) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `${categoryName(request.serviceType)} search isn't available right now.`,
      );
    }

    const key = cacheKey(request, providers);
    let round = this.options.cache?.get(key);
    const cached = round !== undefined;
    if (!round) {
      round = await this.queryProviders(request, providers, signal);
      const complete = round.providerStatuses.every(
        (s) => s.status === 'success' || s.status === 'empty',
      );
      // Every round is kept as a session (offer pages read it by searchId);
      // only complete rounds are reused, so "Try again" after a failure really retries.
      this.options.cache?.set(key, round, { reusable: complete });
    }

    const response = this.present(request, round);
    this.options.logger.info(
      {
        search: {
          serviceType: request.serviceType,
          searchId: round.searchId,
          cached,
          providers: round.providerStatuses.map(
            ({ providerId, status, resultCount, durationMs }) => ({
              providerId,
              status,
              resultCount,
              durationMs,
            }),
          ),
          matched: response.pagination.totalResults,
        },
      },
      'Search completed',
    );
    return response;
  }

  private async queryProviders(
    request: SearchRequest,
    providers: readonly SearchProvider[],
    signal: AbortSignal | undefined,
  ): Promise<AggregatedSearch> {
    const rounds = await mapWithConcurrency(providers, this.concurrency, (provider) =>
      this.runProvider(provider, request, signal),
    );
    signal?.throwIfAborted();

    const statuses = rounds.map((r) => r.status);
    if (statuses.every((s) => s.status !== 'success' && s.status !== 'empty')) {
      this.options.logger.warn(
        {
          search: {
            serviceType: request.serviceType,
            providers: statuses.map((s) => [s.providerId, s.status]),
          },
        },
        'Search failed: no provider answered',
      );
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `We couldn't search ${categoryName(request.serviceType).toLowerCase()} right now. Please try again in a moment.`,
      );
    }

    // Merge in provider order; keep the cheaper of two results for the same offer.
    const merged = new Map<string, SearchResult>();
    const keyless: SearchResult[] = [];
    const order: (string | SearchResult)[] = [];
    for (const { results } of rounds) {
      for (const { result, dedupeKey } of results) {
        if (!dedupeKey) {
          keyless.push(result);
          order.push(result);
          continue;
        }
        const existing = merged.get(dedupeKey);
        if (!existing) {
          merged.set(dedupeKey, result);
          order.push(dedupeKey);
        } else if (isCheaper(result, existing)) {
          merged.set(dedupeKey, result);
        }
      }
    }
    const results = order.map((entry) => (typeof entry === 'string' ? merged.get(entry)! : entry));

    const invalid = rounds.reduce((n, r) => n + r.invalidCount, 0);
    const warnings: SearchWarning[] = [];
    if (invalid > 0) {
      warnings.push({
        code: 'INVALID_PROVIDER_RESULTS',
        message: `${invalid} result${invalid === 1 ? '' : 's'} with incomplete data ${invalid === 1 ? 'was' : 'were'} left out.`,
      });
    }

    const generatedAt = this.now();
    return {
      searchId: randomUUID(),
      serviceType: request.serviceType,
      results,
      providerStatuses: statuses,
      warnings,
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + this.ttlMs),
    };
  }

  private async runProvider(
    provider: SearchProvider,
    request: SearchRequest,
    parent: AbortSignal | undefined,
  ): Promise<ProviderRound> {
    const started = performance.now();
    const status = (
      outcome: ProviderStatus['status'],
      resultCount: number,
      message: string | null,
    ): ProviderStatus => ({
      providerId: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      status: outcome,
      resultCount,
      durationMs: Math.round(performance.now() - started),
      message,
    });

    let raw: readonly unknown[];
    try {
      const output = await withTimeout(provider.timeoutMs, parent, (signal) =>
        provider.search(request, { signal, now: this.now() }),
      );
      raw = Array.isArray(output?.results) ? output.results : [];
      if (!Array.isArray(output?.results))
        throw new ProviderError('error', STATUS_MESSAGES.invalid);
    } catch (error) {
      if (parent?.aborted) throw parent.reason;
      if (error instanceof TimeoutError) {
        this.options.logger.warn(
          { providerId: provider.id, timeoutMs: error.timeoutMs },
          'Provider timed out',
        );
        return {
          status: status('timeout', 0, STATUS_MESSAGES.timeout),
          results: [],
          invalidCount: 0,
        };
      }
      const kind = error instanceof ProviderError ? error.kind : 'error';
      // Log the error class and message only: never raw supplier payloads.
      this.options.logger.warn(
        {
          providerId: provider.id,
          err: {
            name: error instanceof Error ? error.name : 'Unknown',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        'Provider search failed',
      );
      const message = error instanceof ProviderError ? error.safeMessage : STATUS_MESSAGES[kind];
      return { status: status(kind, 0, message), results: [], invalidCount: 0 };
    }

    // Trust nothing: each result must match the contract for this category,
    // and must claim to come from this provider with this provider's kind.
    const schema = searchResultSchemas[request.serviceType];
    const results: ProviderRound['results'] = [];
    let invalidCount = 0;
    for (const item of raw) {
      const parsed = schema.safeParse(item);
      if (
        parsed.success &&
        parsed.data.providerId === provider.id &&
        parsed.data.source === provider.kind
      ) {
        const key = (item as { dedupeKey?: unknown }).dedupeKey;
        results.push({
          result: parsed.data,
          dedupeKey: typeof key === 'string' && key ? key : undefined,
        });
      } else {
        invalidCount += 1;
      }
    }
    if (invalidCount > 0) {
      this.options.logger.warn(
        { providerId: provider.id, invalidCount },
        'Provider returned invalid results',
      );
    }

    if (results.length > 0)
      return { status: status('success', results.length, null), results, invalidCount };
    if (raw.length === 0) return { status: status('empty', 0, null), results, invalidCount };
    return { status: status('error', 0, STATUS_MESSAGES.invalid), results, invalidCount };
  }

  /** Filters, sorts and pages a provider round into the API response. */
  private present(request: SearchRequest, round: AggregatedSearch): SearchResponse {
    const { results: filtered, hiddenForCurrency } = applyFilters(request, round.results);
    const sorted = applySort(request, filtered);
    const { page, pageSize } = request;
    const totalPages = Math.ceil(sorted.length / pageSize);
    const pageResults = sorted.slice((page - 1) * pageSize, page * pageSize);

    const sources = new Set(round.results.map((r) => r.source));
    const dataSource =
      sources.size === 0
        ? 'none'
        : sources.size > 1
          ? 'mixed'
          : sources.has('demo')
            ? 'demo'
            : 'live';
    const failed = round.providerStatuses.filter(
      (s) => s.status !== 'success' && s.status !== 'empty',
    );
    // Label by who answered, not only by what came back: an empty answer from
    // demo fixtures is still a demo answer, and must say so.
    const demoAnswered =
      sources.has('demo') ||
      round.providerStatuses.some(
        (s) => s.kind === 'demo' && (s.status === 'success' || s.status === 'empty'),
      );

    const warnings: SearchWarning[] = [];
    if (demoAnswered) warnings.push({ code: 'DEMO_DATA', message: DEMO_DATA_DISCLAIMER });
    if (failed.length > 0) {
      warnings.push({
        code: 'PARTIAL_RESULTS',
        message: `Some providers didn't answer (${failed.map((s) => s.providerName).join(', ')}), so results may be incomplete.`,
      });
    }
    warnings.push(...round.warnings);
    const otherCurrencies = new Set(
      round.results
        .map((r) => priceAmount(r.price)?.currency)
        .filter((c) => c && c !== request.currency),
    );
    if (otherCurrencies.size > 0) {
      warnings.push({
        code: 'CURRENCY_NOT_CONVERTED',
        message: `Some prices are shown in ${[...otherCurrencies].join(', ')}: currency conversion isn't available, so they are not converted to ${request.currency}.`,
      });
    }
    if (hiddenForCurrency > 0) {
      warnings.push({
        code: 'PRICE_FILTER_CURRENCY',
        message: `${hiddenForCurrency} result${hiddenForCurrency === 1 ? ' is' : 's are'} priced in another currency and can't be compared with your ${request.currency} price limit, so ${hiddenForCurrency === 1 ? 'it was' : 'they were'} left out.`,
      });
    }

    return {
      searchId: round.searchId,
      serviceType: request.serviceType,
      results: pageResults,
      pagination: { page, pageSize, totalResults: sorted.length, totalPages },
      providerStatuses: [...round.providerStatuses],
      dataSource,
      disclaimer: demoAnswered ? DEMO_DATA_DISCLAIMER : null,
      warnings,
      generatedAt: round.generatedAt.toISOString(),
      expiresAt: round.expiresAt.toISOString(),
      facets: computeFacets(request, round.results),
    };
  }

  /**
   * One result of a stored search, for offer pages. The result is the
   * server's own copy (price included); nothing from the client is trusted
   * beyond the two identifiers. Unknown and expired searches look the same:
   * the round is simply gone.
   */
  offer(serviceType: SearchServiceType, searchId: string, resultId: string): OfferResponse {
    const round = this.options.cache?.getById(searchId);
    if (!round || round.serviceType !== serviceType) {
      throw new AppError(
        'NOT_FOUND',
        'This search has expired. Search again to see current results.',
      );
    }
    const result = round.results.find((r) => r.id === resultId);
    if (!result) {
      throw new AppError('NOT_FOUND', "That offer isn't part of this search.");
    }
    const demo = result.source === 'demo';
    return {
      searchId: round.searchId,
      serviceType,
      result,
      disclaimer: demo ? DEMO_DATA_DISCLAIMER : null,
      generatedAt: round.generatedAt.toISOString(),
      expiresAt: round.expiresAt.toISOString(),
    };
  }
}

function isCheaper(candidate: SearchResult, existing: SearchResult): boolean {
  const a = priceAmount(candidate.price);
  const b = priceAmount(existing.price);
  return !!a && !!b && a.currency === b.currency && a.amount < b.amount;
}

/**
 * Identity of a provider round: everything that changes what providers return
 * (route, dates, party, cabin, currency…) plus the providers and their
 * versions. Filters, sort and page are applied afterwards, so they're excluded.
 */
export function cacheKey(request: SearchRequest, providers: readonly SearchProvider[]): string {
  const { filters: _filters, sortBy: _sort, page: _page, pageSize: _size, ...core } = request;
  const sortedEntries = Object.entries(core).sort(([a], [b]) => a.localeCompare(b));
  const identity = JSON.stringify([sortedEntries, providers.map((p) => `${p.id}@${p.version}`)]);
  return `search:${request.serviceType}:${createHash('sha256').update(identity).digest('hex')}`;
}
