import { z } from 'zod';
import {
  offsetDateTimeSchema,
  providerStatusSchema,
  searchResultSchema,
  searchServiceTypeSchema,
  searchWarningSchema,
  type ProviderStatus,
  type SearchResult,
  type SearchServiceType,
  type SearchWarning,
} from '@wayora/contracts';
import type { Logger } from '../../utils/logger.js';
import { integrityProblem } from './integrity.js';

/*
 * Search sessions (docs/search.md#search-sessions).
 *
 * A session is one completed provider round: the validated, normalized
 * offers plus provider statuses, kept for SEARCH_SESSION_TTL_SECONDS. Paging,
 * sorting and filtering re-read it instead of calling providers again, and
 * offer pages read their offer from it, so the price a visitor sees always
 * comes from the server's copy. Sessions hold no request data and nothing
 * about the visitor: search is public and user-independent.
 */

export interface SearchSession {
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

/** The store could not be reached or failed. Never shown to clients as-is. */
export class SessionStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Search session store is unavailable', { cause });
    this.name = 'SessionStoreUnavailableError';
  }
}

export interface SearchSessionStore {
  readonly kind: 'redis' | 'memory';
  /** A live session that may be reused for an identical request, if any. */
  findReusable(requestKey: string): Promise<SearchSession | undefined>;
  /**
   * Keeps a session until its `expiresAt`. With `reusable`, identical
   * requests reuse it; only rounds where every provider answered are
   * reusable, so "Try again" after a failure really asks the providers again.
   */
  save(session: SearchSession, options: { requestKey: string; reusable: boolean }): Promise<void>;
  /** A live session by id; undefined when missing, expired or unreadable. */
  get(searchId: string): Promise<SearchSession | undefined>;
  /** Replaces a session's content (e.g. a revalidated price), keeping its expiry. */
  replace(session: SearchSession): Promise<void>;
}

// ─── Serialization ────────────────────────────────────────────────────────

const STORED_VERSION = 1;

/** What is written to the store. Read back through this schema, never trusted blindly. */
const storedSessionSchema = z
  .object({
    v: z.literal(STORED_VERSION),
    searchId: z.uuid(),
    serviceType: searchServiceTypeSchema,
    results: z.array(searchResultSchema),
    providerStatuses: z.array(providerStatusSchema),
    warnings: z.array(searchWarningSchema),
    generatedAt: offsetDateTimeSchema,
    expiresAt: offsetDateTimeSchema,
  })
  .superRefine((stored, ctx) => {
    stored.results.forEach((result, index) => {
      const problem = integrityProblem(result, { serviceType: stored.serviceType });
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['results', index] });
    });
  });

export function serializeSession(session: SearchSession): string {
  return JSON.stringify({
    v: STORED_VERSION,
    searchId: session.searchId,
    serviceType: session.serviceType,
    results: session.results,
    providerStatuses: session.providerStatuses,
    warnings: session.warnings,
    generatedAt: session.generatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  });
}

/** Parses and validates a stored session; null when it is malformed in any way. */
export function deserializeSession(raw: string): SearchSession | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedSessionSchema.safeParse(json);
  if (!parsed.success) return null;
  const { v: _v, generatedAt, expiresAt, ...rest } = parsed.data;
  return { ...rest, generatedAt: new Date(generatedAt), expiresAt: new Date(expiresAt) };
}

// ─── Redis ────────────────────────────────────────────────────────────────

/** The few Redis commands the store needs (ioredis-compatible). */
export interface SessionRedis {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  set(key: string, value: string, mode: 'PX', milliseconds: number): Promise<unknown>;
  multi(): {
    set(key: string, value: string, mode: 'PX', milliseconds: number): unknown;
    exec(): Promise<[Error | null, unknown][] | null>;
  };
}

export const SESSION_KEY_PREFIX = 'wayora:search:';

/**
 * Sessions in Redis, shared by every API instance and kept across restarts.
 *
 *   wayora:search:<searchId>              the session (JSON), PX = time left
 *   wayora:search:reuse:<requestKey>      searchId of the reusable session
 *
 * Both keys expire with the session, so Redis removes them on its own. Every
 * read is validated; a malformed entry is deleted and treated as missing.
 * Redis errors surface as SessionStoreUnavailableError: there is no fallback
 * to process memory, because a session only one instance can see would break
 * offer pages behind a load balancer.
 */
export class RedisSearchSessionStore implements SearchSessionStore {
  readonly kind = 'redis' as const;
  private readonly prefix: string;
  private readonly now: () => Date;

  constructor(
    private readonly redis: SessionRedis,
    private readonly logger: Logger,
    options: { prefix?: string; now?: () => Date } = {},
  ) {
    this.prefix = options.prefix ?? SESSION_KEY_PREFIX;
    this.now = options.now ?? (() => new Date());
  }

  sessionKey(searchId: string): string {
    return `${this.prefix}${searchId}`;
  }

  reuseKey(requestKey: string): string {
    return `${this.prefix}reuse:${requestKey}`;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new SessionStoreUnavailableError(error);
    }
  }

  async findReusable(requestKey: string): Promise<SearchSession | undefined> {
    const searchId = await this.run(() => this.redis.get(this.reuseKey(requestKey)));
    return searchId ? this.get(searchId) : undefined;
  }

  async save(
    session: SearchSession,
    { requestKey, reusable }: { requestKey: string; reusable: boolean },
  ): Promise<void> {
    const ttlMs = session.expiresAt.getTime() - this.now().getTime();
    if (ttlMs <= 0) return;
    const value = serializeSession(session);
    await this.run(async () => {
      const tx = this.redis.multi();
      tx.set(this.sessionKey(session.searchId), value, 'PX', ttlMs);
      if (reusable) tx.set(this.reuseKey(requestKey), session.searchId, 'PX', ttlMs);
      const replies = await tx.exec();
      const failed = replies?.find(([error]) => error !== null);
      if (!replies || failed) throw failed?.[0] ?? new Error('Transaction aborted');
    });
  }

  async get(searchId: string): Promise<SearchSession | undefined> {
    const key = this.sessionKey(searchId);
    const raw = await this.run(() => this.redis.get(key));
    if (raw === null) return undefined;
    const session = deserializeSession(raw);
    if (!session || session.searchId !== searchId) {
      this.logger.warn({ searchId }, 'Discarded a malformed search session');
      await this.redis.del(key).catch(() => undefined);
      return undefined;
    }
    // Redis expires the key itself; this guards against clock skew between instances.
    return session.expiresAt.getTime() > this.now().getTime() ? session : undefined;
  }

  async replace(session: SearchSession): Promise<void> {
    const ttlMs = session.expiresAt.getTime() - this.now().getTime();
    if (ttlMs <= 0) return;
    await this.run(() =>
      this.redis.set(this.sessionKey(session.searchId), serializeSession(session), 'PX', ttlMs),
    );
  }
}

// ─── Memory (local development and tests only) ────────────────────────────

interface MemoryEntry {
  session: SearchSession;
  requestKey: string;
}

/**
 * Per-process sessions, for local development without Redis and for tests.
 * Production refuses to start with it (config/env.ts). Entries live until
 * their `expiresAt`; beyond `maxEntries` the least recently used is evicted.
 */
export class MemorySearchSessionStore implements SearchSessionStore {
  readonly kind = 'memory' as const;
  /** By searchId, in least-recently-used order. */
  private readonly entries = new Map<string, MemoryEntry>();
  /** Request key → searchId of its reusable session. */
  private readonly reusableByKey = new Map<string, string>();

  constructor(
    private readonly maxEntries = 200,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private live(searchId: string | undefined): MemoryEntry | undefined {
    if (searchId === undefined) return undefined;
    const entry = this.entries.get(searchId);
    if (!entry) return undefined;
    if (entry.session.expiresAt.getTime() <= this.now().getTime()) {
      this.remove(searchId);
      return undefined;
    }
    this.entries.delete(searchId);
    this.entries.set(searchId, entry);
    return entry;
  }

  private remove(searchId: string): void {
    const entry = this.entries.get(searchId);
    if (!entry) return;
    this.entries.delete(searchId);
    if (this.reusableByKey.get(entry.requestKey) === searchId) {
      this.reusableByKey.delete(entry.requestKey);
    }
  }

  async findReusable(requestKey: string): Promise<SearchSession | undefined> {
    return this.live(this.reusableByKey.get(requestKey))?.session;
  }

  async save(
    session: SearchSession,
    { requestKey, reusable }: { requestKey: string; reusable: boolean },
  ): Promise<void> {
    this.remove(session.searchId);
    this.entries.set(session.searchId, { session, requestKey });
    if (reusable) this.reusableByKey.set(requestKey, session.searchId);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  async get(searchId: string): Promise<SearchSession | undefined> {
    return this.live(searchId)?.session;
  }

  async replace(session: SearchSession): Promise<void> {
    const entry = this.live(session.searchId);
    if (entry) entry.session = session;
  }

  get size(): number {
    return this.entries.size;
  }
}
