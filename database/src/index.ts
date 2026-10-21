import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient } from './generated/prisma/client.js';
export * from './generated/prisma/enums.js';
export type * from './generated/prisma/models.js';

export interface CreatePrismaClientOptions {
  /** PostgreSQL connection string. Defaults to process.env.DATABASE_URL. */
  url?: string;
  /** Log Prisma queries (development diagnostics only). */
  logQueries?: boolean;
  /** Maximum pool size for the pg driver. */
  maxConnections?: number;
}

/**
 * Creates a PrismaClient backed by the `pg` driver adapter. Each process
 * (API, worker) owns exactly one client and must call `$disconnect()` during
 * graceful shutdown.
 */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const connectionString = options.url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy database/.env.example to database/.env.');
  }
  const adapter = new PrismaPg({
    connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
  });
  return new PrismaClient({
    adapter,
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}
