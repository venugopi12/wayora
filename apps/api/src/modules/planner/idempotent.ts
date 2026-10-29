import { Prisma } from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import {
  requestHash,
  type IdempotencyMessages,
  type IdempotencyService,
} from '../bookings/idempotency.js';

type Tx = Prisma.TransactionClient;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Runs a creating POST at most once per Idempotency-Key (planner and budget
 * writes): a retry replays the stored outcome (the new row's id), a concurrent
 * duplicate is refused. `run` completes the key inside its own transaction.
 */
export async function runIdempotent(
  idempotency: IdempotencyService,
  logger: Logger,
  claimInput: {
    operation: string;
    userId: string;
    key: string;
    payload: unknown;
    messages: IdempotencyMessages;
  },
  run: (complete: (tx: Tx, id: string) => Promise<void>) => Promise<string>,
): Promise<{ id: string; replayed: boolean }> {
  const claim = await idempotency.claim<{ id: string }>({
    operation: claimInput.operation,
    userId: claimInput.userId,
    key: claimInput.key,
    hash: requestHash(claimInput.payload),
    messages: claimInput.messages,
  });
  if (claim.kind === 'replay') return { id: claim.body.id, replayed: true };
  try {
    const id = await run((tx, created) =>
      idempotency.complete(tx, claim, { status: 201, body: { id: created } }),
    );
    return { id, replayed: false };
  } catch (error) {
    await idempotency.release(claim);
    if (isUniqueViolation(error)) {
      logger.warn({ operation: claimInput.operation }, 'Planner write hit a unique constraint');
      throw new AppError('CONFLICT', 'That change clashes with another one. Reload and try again.');
    }
    throw error;
  }
}
