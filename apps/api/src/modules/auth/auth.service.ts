import type { SafeUser } from '@wayora/contracts';
import { Prisma, type PrismaClient, type UserModel as User } from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import { burnVerifyTime, hashPassword, needsRehash, verifyPassword } from './password.js';
import { toSafeUser } from './safe-user.js';
import type { SessionService } from './session.service.js';

/** One message for every login failure, so responses don't reveal which emails exist. */
export const INVALID_CREDENTIALS = 'That email and password combination is not correct.';

/**
 * Deliberately vague: without email verification there's no way to say "check
 * your inbox" instead, so the response confirms as little as possible.
 */
export const DUPLICATE_ACCOUNT =
  "We couldn't create an account with that email. If you already have one, sign in instead.";

export interface SignedIn {
  user: SafeUser;
  /** Raw session token for the cookie. Never logged or returned in a body. */
  token: string;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Registration and sign-in. Route handlers stay thin; rules live here. */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Creates the account and its first session in one transaction: either both
   * exist afterwards or neither does. Inputs arrive validated and normalized.
   */
  async register(input: { name: string; email: string; password: string }): Promise<SignedIn> {
    // Hash before touching the database so duplicate and new emails take
    // similar time.
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, displayName: input.name, passwordHash },
        });
        const { token } = await this.sessions.create(user.id, tx);
        return { user: toSafeUser(user), token };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('CONFLICT', DUPLICATE_ACCOUNT);
      throw error;
    }
  }

  /**
   * Verifies credentials and starts a fresh session. Unknown email, missing
   * password, wrong password and inactive account all fail identically.
   */
  async login(
    input: { email: string; password: string },
    context: { requestId?: string | undefined } = {},
  ): Promise<SignedIn> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash) {
      await burnVerifyTime(input.password);
      throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);
    }
    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid || user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);
    }
    await this.upgradeHashIfNeeded(user, input.password);
    const { token } = await this.sessions.create(user.id);
    // Staff sign-ins are audited (docs/admin.md#audit-log). No IP, user agent or token.
    if (user.role !== 'USER') {
      await this.prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: user.id,
          action: 'admin.sign_in',
          entityType: 'user',
          entityId: user.id,
          requestId: context.requestId ?? null,
          metadata: { role: user.role.toLowerCase() },
        },
      });
    }
    return { user: toSafeUser(user), token };
  }

  /** Transparently moves old hashes to the current Argon2id parameters. */
  private async upgradeHashIfNeeded(user: User, password: string): Promise<void> {
    if (!user.passwordHash || !needsRehash(user.passwordHash)) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
  }
}
