import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEMO_DATA_DISCLAIMER,
  TRAVEL_CATEGORIES,
  searchPriceSchema,
  searchResultSchemas,
  type Money,
  type OfferResponse,
  type OfferValidation,
  type ProviderStatus,
  type SearchPrice,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchServiceType,
  type SearchWarning,
} from '@wayora/contracts';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import type { SearchProvider } from '../providers/provider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { outcomeFor, providerCalls, type SearchEventRecorder } from './analytics.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  PROVIDER_STATUS_MESSAGES,
  STORE_UNAVAILABLE_MESSAGE,
  errorForLog,
  outcomeOf,
  revalidationFailedError,
  searchFailedError,
} from './errors.js';
import { computeFacets } from './facets.js';
import { integrityProblem, parseOfferId } from './integrity.js';
import { applyFilters, applySort, priceAmount } from './refine.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  callProvider,
  type BreakerOptions,
  type RetryPolicy,
} from './resilience.js';
import {
  SessionStoreUnavailableError,
  type SearchSession,
  type SearchSessionStore,
} from './sessions.js';

export interface ResilienceOptions {
  /** Overall time budget for one search or offer check, retries included. */
  deadlineMs: number;
  retry: RetryPolicy;
  breaker: BreakerOptions;
  /** Monotonic milliseconds (deadlines, breaker cooldowns). */
  clock: () => number;
  /** Jitter source (injectable for tests). */
  random: () => number;
}

export const DEFAULT_RESILIENCE: ResilienceOptions = {
  deadlineMs: 8_000,
  retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 1_600 },
  breaker: { failureThreshold: 5, cooldownMs: 30_000 },
  clock: () => performance.now(),
  random: Math.random,
};

export interface SearchServiceOptions {
  registry: ProviderRegistry;
  logger: Logger;
  /** Where search sessions live (Redis in production; docs/search.md#search-sessions). */
  sessions: SearchSessionStore;
  /** Providers queried at once. */
  concurrency?: number;
  /** How long a session lives (and is offered as `expiresAt`). */
  sessionTtlMs?: number;
  now?: () => Date;
  resilience?: Partial<ResilienceOptions>;
  /** Search analytics (docs/admin.md#search-activity); off when absent. */
  recordEvent?: SearchEventRecorder;
}

/** Per-request context: cancellation and log correlation. */
export interface CallContext {
  /** Aborted when the client goes away. */
  signal?: AbortSignal | undefined;
  requestId?: string | undefined;
}

interface ProviderRound {
  status: ProviderStatus;
  results: { result: SearchResult; dedupeKey: string | undefined }[];
  invalidCount: number;
  /** Calls made to the provider for this round (1 + retries; 0 when its breaker was open). */
  attempts: number;
}

/** What a fresh provider round did, for analytics and logs. */
interface CallRecord {
  statuses: ProviderStatus[];
  attempts: Map<string, number>;
}

const categoryName = (type: SearchRequest['serviceType']) =>
  TRAVEL_CATEGORIES.find((c) => c.slug === type)?.name ?? type;

/** What a provider may answer when asked about one offer; validated before use. */
const revalidationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), price: searchPriceSchema.nullable() }),
  z.object({ status: z.literal('unavailable') }),
]);

/**
 * The search engine: one orchestration for every category
 * (docs/search.md#orchestration).
 *
 * 1. resolve enabled providers for the category, 2. query them with bounded
 * concurrency, per-call time limits within one deadline, retries for
 * transient failures and a circuit breaker per provider, 3. validate every
 * result against the shared contract and the integrity rules, 4. merge and
 * de-duplicate, 5. store the round as a search session, 6. filter, sort and
 * page. A failing provider becomes a status entry; only when every provider
 * fails does the search fail, with a code that says how.
 */
export class SearchService {
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly resilience: ResilienceOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: SearchServiceOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.ttlMs = options.sessionTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.resilience = { ...DEFAULT_RESILIENCE, ...options.resilience };
  }

  /**
   * Breaker states in this API process, read-only (admin health). Providers
   * never called here yet have no breaker: they are reported `closed`, which
   * says nothing about their health on its own.
   */
  breakerStates(): ReadonlyMap<string, 'closed' | 'open' | 'half-open'> {
    return new Map([...this.breakers.entries()].map(([id, b]) => [id, b.state]));
  }

  /** The circuit breaker for one provider (per process; shared by its operations). */
  breakerFor(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.resilience.breaker, this.resilience.clock);
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  private logFor(context: CallContext): Logger {
    return context.requestId
      ? this.options.logger.child({ requestId: context.requestId })
      : this.options.logger;
  }

  /** Runs a session-store operation; an unreachable store is a 503, never a silent fallback. */
  private async store<T>(operation: () => Promise<T>, log: Logger): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SessionStoreUnavailableError)) throw error;
      log.error(
        { store: this.options.sessions.kind, err: errorForLog(error.cause) },
        'Search session store unavailable',
      );
      throw new AppError('SERVICE_UNAVAILABLE', STORE_UNAVAILABLE_MESSAGE);
    }
  }

  async search(request: SearchRequest, context: CallContext = {}): Promise<SearchResponse> {
    const record = this.options.recordEvent;
    if (!record) return this.runSearch(request, context);
    const started = this.resilience.clock();
    const elapsed = () => this.resilience.clock() - started;
    const calls: CallRecord = { statuses: [], attempts: new Map() };
    try {
      const response = await this.runSearch(request, context, calls);
      record({
        serviceType: request.serviceType,
        outcome: outcomeFor(response.providerStatuses, response.pagination.totalResults),
        searchId: response.searchId,
        resultCount: response.pagination.totalResults,
        durationMs: elapsed(),
        errorCode: null,
        providers: providerCalls(calls.statuses, calls.attempts),
      });
      return response;
    } catch (error) {
      // A visitor who left isn't a failed search.
      if (!context.signal?.aborted) {
        record({
          serviceType: request.serviceType,
          outcome: 'FAILED',
          searchId: null,
          resultCount: 0,
          durationMs: elapsed(),
          errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          providers: providerCalls(calls.statuses, calls.attempts),
        });
      }
      throw error;
    }
  }

  private async runSearch(
    request: SearchRequest,
    context: CallContext,
    calls?: CallRecord,
  ): Promise<SearchResponse> {
    const log = this.logFor(context);
    const providers = this.options.registry.searchProvidersFor(request.serviceType);
    if (providers.length === 0) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `${categoryName(request.serviceType)} search isn't available right now.`,
      );
    }

    const key = requestKey(request, providers);
    const { sessions } = this.options;
    let session = await this.store(() => sessions.findReusable(key), log);
    const reused = session !== undefined;
    if (!session) {
      session = await this.queryProviders(request, providers, context.signal, log, calls);
      const complete = session.providerStatuses.every(
        (s) => s.status === 'success' || s.status === 'empty',
      );
      const round = session;
      // Every round is kept as a session (offer pages read it by searchId);
      // only complete rounds are reused, so "Try again" after a failure really retries.
      await this.store(() => sessions.save(round, { requestKey: key, reusable: complete }), log);
    }

    const response = this.present(request, session);
    log.info(
      {
        search: {
          serviceType: request.serviceType,
          searchId: session.searchId,
          cached: reused,
          store: sessions.kind,
          providers: session.providerStatuses.map(
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
    log: Logger,
    calls?: CallRecord,
  ): Promise<SearchSession> {
    const deadline = this.resilience.clock() + this.resilience.deadlineMs;
    const rounds = await mapWithConcurrency(providers, this.concurrency, (provider) =>
      this.runProvider(provider, request, { signal, deadline, log }),
    );
    signal?.throwIfAborted();

    const statuses = rounds.map((r) => r.status);
    if (calls) {
      calls.statuses = statuses;
      calls.attempts = new Map(rounds.map((r) => [r.status.providerId, r.attempts]));
    }
    // One line per provider call: duration, outcome (a normalized category,
    // never supplier text) and retries. Correlated by the request's requestId.
    for (const round of rounds) {
      log.info(
        {
          provider: {
            providerId: round.status.providerId,
            kind: round.status.kind,
            serviceType: request.serviceType,
            operation: 'search',
            outcome: round.status.status,
            durationMs: round.status.durationMs,
            attempts: round.attempts,
            resultCount: round.status.resultCount,
            invalidCount: round.invalidCount,
          },
        },
        'Provider call finished',
      );
    }
    if (statuses.every((s) => s.status !== 'success' && s.status !== 'empty')) {
      log.warn(
        {
          search: {
            serviceType: request.serviceType,
            providers: statuses.map((s) => [s.providerId, s.status]),
          },
        },
        'Search failed: no provider answered',
      );
      throw searchFailedError(categoryName(request.serviceType), statuses);
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
    { signal, deadline, log }: { signal: AbortSignal | undefined; deadline: number; log: Logger },
  ): Promise<ProviderRound> {
    const started = performance.now();
    let attempts = 0;
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

    let output: Awaited<ReturnType<SearchProvider['search']>>;
    try {
      output = await callProvider(
        {
          providerId: provider.id,
          timeoutMs: provider.timeoutMs,
          deadline,
          signal,
          retry: this.resilience.retry,
          breaker: this.breakerFor(provider.id),
          idempotent: true, // search is a read
          clock: this.resilience.clock,
          random: this.resilience.random,
          onRetry: ({ attempt, delayMs, error }) =>
            log.warn(
              {
                providerId: provider.id,
                operation: 'search',
                attempt,
                delayMs,
                err: errorForLog(error),
              },
              'Retrying provider call',
            ),
        },
        (attemptSignal) => {
          attempts += 1;
          return provider.search(request, { signal: attemptSignal, now: this.now() });
        },
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const outcome = outcomeOf(error);
      if (error instanceof CircuitOpenError) {
        log.warn({ providerId: provider.id }, 'Provider skipped: circuit breaker open');
      } else {
        // Scrubbed class and message only: never raw supplier payloads.
        log.warn(
          { providerId: provider.id, operation: 'search', outcome, err: errorForLog(error) },
          'Provider search failed',
        );
      }
      return {
        status: status(outcome, 0, PROVIDER_STATUS_MESSAGES[outcome]),
        results: [],
        invalidCount: 0,
        attempts,
      };
    }

    const raw: unknown = (output as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(raw)) {
      log.warn({ providerId: provider.id }, 'Provider returned no result list');
      return {
        status: status('error', 0, PROVIDER_STATUS_MESSAGES.invalid),
        results: [],
        invalidCount: 0,
        attempts,
      };
    }

    // Trust nothing: each result must match the contract for this category,
    // claim to come from this provider with this provider's kind, and pass
    // the integrity rules (id = <providerId>:<offerRef>, one currency per price).
    const schema = searchResultSchemas[request.serviceType];
    const results: ProviderRound['results'] = [];
    let invalidCount = 0;
    for (const item of raw) {
      const parsed = schema.safeParse(item);
      if (
        parsed.success &&
        parsed.data.source === provider.kind &&
        integrityProblem(parsed.data, {
          serviceType: request.serviceType,
          providerId: provider.id,
        }) === null
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
      log.warn({ providerId: provider.id, invalidCount }, 'Provider returned invalid results');
    }

    if (results.length > 0)
      return { status: status('success', results.length, null), results, invalidCount, attempts };
    if (raw.length === 0)
      return { status: status('empty', 0, null), results, invalidCount, attempts };
    return {
      status: status('error', 0, PROVIDER_STATUS_MESSAGES.invalid),
      results,
      invalidCount,
      attempts,
    };
  }

  /** Filters, sorts and pages a provider round into the API response. */
  private present(request: SearchRequest, round: SearchSession): SearchResponse {
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
   * One offer from a stored search, for offer pages (docs/search.md#offer-validation).
   *
   * Only the two identifiers come from the client; everything returned (price
   * included) is the server's copy. Checks, in order:
   * 1. the offer id has Wayora's shape and names a registered provider
   *    (OFFER_NOT_FOUND) that serves this category (CATEGORY_MISMATCH),
   * 2. the session exists and hasn't expired (SEARCH_EXPIRED),
   * 3. the session is for this category (CATEGORY_MISMATCH),
   * 4. the offer is part of this session (OFFER_NOT_IN_SEARCH),
   * 5. the stored offer still passes the integrity rules,
   * 6. if the provider supports it, the supplier rechecks the offer now:
   *    unchanged, new price (price-changed), or gone (OFFER_UNAVAILABLE).
   */
  async offer(
    serviceType: SearchServiceType,
    searchId: string,
    offerId: string,
    context: CallContext = {},
  ): Promise<OfferResponse> {
    const log = this.logFor(context);
    const parsedId = parseOfferId(offerId);
    const registered = parsedId ? this.options.registry.find(parsedId.providerId) : undefined;
    if (!parsedId || !registered) {
      throw new AppError(
        'OFFER_NOT_FOUND',
        "We couldn't find that offer. Check the link, or search again.",
      );
    }
    const category = categoryName(serviceType).toLowerCase();
    if (!registered.provider.serviceTypes.includes(serviceType)) {
      throw new AppError(
        'CATEGORY_MISMATCH',
        `That offer belongs to another kind of travel, not ${category}.`,
      );
    }

    const session = await this.store(() => this.options.sessions.get(searchId), log);
    if (!session) {
      throw new AppError(
        'SEARCH_EXPIRED',
        'This search has expired. Search again to see current results.',
      );
    }
    if (session.serviceType !== serviceType) {
      throw new AppError(
        'CATEGORY_MISMATCH',
        `This search is for ${categoryName(session.serviceType).toLowerCase()}, not ${category}.`,
      );
    }
    const stored = session.results.find((r) => r.id === offerId);
    if (!stored) {
      throw new AppError(
        'OFFER_NOT_IN_SEARCH',
        "That offer isn't part of this search. It may come from a different search.",
      );
    }
    const problem = integrityProblem(stored, { serviceType, providerId: parsedId.providerId });
    if (problem) {
      // Sessions are validated when written and read; this means corruption.
      log.error({ searchId, offerId, problem }, 'Stored offer failed its integrity check');
      throw new AppError(
        'SEARCH_EXPIRED',
        "This search can't be used any more. Search again to see current results.",
      );
    }

    const { provider, enabled } = registered;
    let result = stored;
    let validation: OfferValidation = { status: 'session', checkedAt: null, previousPrice: null };
    if (enabled && provider.operations.revalidate === 'supported' && provider.revalidate) {
      ({ result, validation } = await this.revalidate(provider, session, stored, context, log));
    }

    return {
      searchId: session.searchId,
      serviceType,
      result,
      disclaimer: result.source === 'demo' ? DEMO_DATA_DISCLAIMER : null,
      generatedAt: session.generatedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      validation,
    };
  }

  /** Asks the supplier about one offer, through the same time limits, retries and breaker. */
  private async revalidate(
    provider: SearchProvider,
    session: SearchSession,
    offer: SearchResult,
    context: CallContext,
    log: Logger,
  ): Promise<{ result: SearchResult; validation: OfferValidation }> {
    const { signal } = context;
    let answer: unknown;
    let attempts = 0;
    const started = performance.now();
    const finished = (outcome: string) =>
      log.info(
        {
          provider: {
            providerId: provider.id,
            kind: provider.kind,
            serviceType: session.serviceType,
            operation: 'revalidate',
            outcome,
            durationMs: Math.round(performance.now() - started),
            attempts,
          },
        },
        'Provider call finished',
      );
    try {
      answer = await callProvider(
        {
          providerId: provider.id,
          timeoutMs: provider.timeoutMs,
          deadline: this.resilience.clock() + this.resilience.deadlineMs,
          signal,
          retry: this.resilience.retry,
          breaker: this.breakerFor(provider.id),
          idempotent: true, // revalidation is a read
          clock: this.resilience.clock,
          random: this.resilience.random,
          onRetry: ({ attempt, delayMs, error }) =>
            log.warn(
              {
                providerId: provider.id,
                operation: 'revalidate',
                attempt,
                delayMs,
                err: errorForLog(error),
              },
              'Retrying provider call',
            ),
        },
        (attemptSignal) => {
          attempts += 1;
          return provider.revalidate!(offer, { signal: attemptSignal, now: this.now() });
        },
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const outcome = outcomeOf(error);
      finished(outcome);
      log.warn(
        { providerId: provider.id, operation: 'revalidate', outcome, err: errorForLog(error) },
        error instanceof CircuitOpenError
          ? 'Offer check skipped: circuit breaker open'
          : 'Offer revalidation failed',
      );
      throw revalidationFailedError(outcome);
    }

    const parsed = revalidationOutcomeSchema.safeParse(answer);
    finished(parsed.success ? parsed.data.status : 'invalid');
    if (!parsed.success) {
      log.warn({ providerId: provider.id }, 'Provider returned an invalid revalidation answer');
      throw revalidationFailedError('invalid');
    }
    if (parsed.data.status === 'unavailable') {
      log.info(
        { providerId: provider.id, offerId: offer.id },
        'Provider reports offer unavailable',
      );
      throw new AppError(
        'OFFER_UNAVAILABLE',
        'This offer is no longer available. Have a look at the current results.',
      );
    }

    const checkedAt = this.now().toISOString();
    const price = parsed.data.price;
    if (pricesEqual(price, offer.price)) {
      return { result: offer, validation: { status: 'confirmed', checkedAt, previousPrice: null } };
    }
    // A new price must be a valid price in the same currency: never a silent conversion.
    const updated = searchResultSchemas[session.serviceType].safeParse({ ...offer, price });
    if (!updated.success || currencyOf(price) !== currencyOf(offer.price)) {
      log.warn({ providerId: provider.id }, 'Provider quoted an inconsistent price');
      throw revalidationFailedError('invalid');
    }
    const result = updated.data;
    log.info(
      { providerId: provider.id, offerId: offer.id, searchId: session.searchId },
      'Offer price changed on revalidation',
    );
    // Keep the session consistent with what the visitor now sees. Best effort:
    // if the store is down, the next read simply checks with the supplier again.
    await this.options.sessions
      .replace({
        ...session,
        results: session.results.map((r) => (r.id === offer.id ? result : r)),
      })
      .catch((error: unknown) =>
        log.warn({ err: errorForLog(error) }, 'Could not store the revalidated price'),
      );
    return {
      result,
      validation: { status: 'price-changed', checkedAt, previousPrice: offer.price },
    };
  }
}

function isCheaper(candidate: SearchResult, existing: SearchResult): boolean {
  const a = priceAmount(candidate.price);
  const b = priceAmount(existing.price);
  return !!a && !!b && a.currency === b.currency && a.amount < b.amount;
}

const moneyEqual = (a: Money, b: Money) =>
  a.currency === b.currency && BigInt(a.amountMinor) === BigInt(b.amountMinor);

/** Exact comparison of two prices (integer minor units, never floats). */
export function pricesEqual(a: SearchPrice | null, b: SearchPrice | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'range' && b.kind === 'range') {
    return moneyEqual(a.min, b.min) && moneyEqual(a.max, b.max);
  }
  if (a.kind === 'total' && b.kind === 'total') {
    if (!moneyEqual(a.total, b.total)) return false;
    if (a.perUnit === null || b.perUnit === null) return a.perUnit === b.perUnit;
    return a.perUnit.unit === b.perUnit.unit && moneyEqual(a.perUnit.amount, b.perUnit.amount);
  }
  return false;
}

function currencyOf(price: SearchPrice | null): string | null {
  if (price === null) return null;
  return price.kind === 'total' ? price.total.currency : price.min.currency;
}

/**
 * Identity of a provider round: everything that changes what providers return
 * (route, dates, party, cabin, currency…) plus the providers and their
 * versions. Filters, sort and page are applied afterwards, so they're excluded.
 */
export function requestKey(request: SearchRequest, providers: readonly SearchProvider[]): string {
  const { filters: _filters, sortBy: _sort, page: _page, pageSize: _size, ...core } = request;
  const sortedEntries = Object.entries(core).sort(([a], [b]) => a.localeCompare(b));
  const identity = JSON.stringify([sortedEntries, providers.map((p) => `${p.id}@${p.version}`)]);
  return `${request.serviceType}:${createHash('sha256').update(identity).digest('hex')}`;
}
