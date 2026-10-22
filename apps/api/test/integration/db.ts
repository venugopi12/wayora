import { createPrismaClient, type PrismaClient } from '@wayora/database';
import { pino } from 'pino';
import type { Env } from '../../src/config/env.js';
import { buildTestApp } from '../helpers.js';

/**
 * Integration tests use a dedicated database named in TEST_DATABASE_URL. They
 * refuse to run unless the database name ends in `_test`, because every test
 * empties the account tables. Prepare it with:
 *
 *   createdb wayora_test
 *   DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate:deploy
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${name}": TEST_DATABASE_URL must point at a database whose name ends in _test.`,
    );
  }
}

let prisma: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  assertTestDatabase(TEST_DATABASE_URL);
  prisma ??= createPrismaClient({ url: TEST_DATABASE_URL, maxConnections: 4 });
  return prisma;
}

/**
 * Empties the tables these tests write to. Users cascade to sessions,
 * travellers and bookings (and bookings to their travellers and history);
 * idempotency keys and audit logs have no foreign key, so they are listed.
 * TRUNCATE doesn't fire the append-only row triggers.
 */
export async function resetAccounts(): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    'TRUNCATE TABLE "sessions", "travellers", "users", "idempotency_keys", "audit_logs" CASCADE',
  );
}

export const ORIGIN = 'http://localhost:5173';

/** A clock the tests can move forward. */
export function testClock(start = Date.now()) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

export function buildAccountsApp(options: { env?: Partial<Env>; now?: () => Date } = {}) {
  return buildTestApp({
    prisma: testPrisma(),
    logger: pino({ level: 'silent' }),
    ...(options.env ? { env: options.env } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

export async function disconnect(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}
