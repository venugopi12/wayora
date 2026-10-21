import type { PrismaClient, SessionModel as Session, UserModel as User } from '@wayora/database';
import { generateSessionToken, hashSessionToken, isWellFormedToken } from './session-token.js';

export interface SessionPolicy {
  /** End a session after this long without a request. */
  idleTimeoutMs: number;
  /** End a session this long after sign-in, regardless of activity. */
  absoluteTimeoutMs: number;
  /** Persist activity at most this often (avoids a write on every request). */
  touchIntervalMs: number;
}

export interface ResolvedSession {
  session: Session;
  user: User;
}

/**
 * Database-backed sessions (docs/auth.md#session-lifecycle).
 *
 * A session authenticates only while: it isn't revoked, `expiresAt` is in the
 * future, and its user is ACTIVE. `expiresAt` always equals
 * min(createdAt + absolute timeout, lastActivityAt + idle timeout).
 */
export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: SessionPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private expiryFor(createdAt: Date, lastActivityAt: Date): Date {
    return new Date(
      Math.min(
        createdAt.getTime() + this.policy.absoluteTimeoutMs,
        lastActivityAt.getTime() + this.policy.idleTimeoutMs,
      ),
    );
  }

  /** Creates a session and returns the raw token (shown to the browser once, never stored). */
  async create(userId: string, db: Pick<PrismaClient, 'session'> = this.prisma) {
    const token = generateSessionToken();
    const now = this.now();
    const session = await db.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        createdAt: now,
        lastActivityAt: now,
        expiresAt: this.expiryFor(now, now),
      },
    });
    return { token, session };
  }

  /**
   * Returns the session and user for a cookie token, or null if the token is
   * unknown, revoked, expired or belongs to a non-active user. Slides the idle
   * expiry forward (at most once per touch interval).
   */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || !isWellFormedToken(token)) return null;
    const found = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });
    if (!found) return null;
    const { user, ...session } = found;
    const now = this.now();
    if (session.revokedAt || session.expiresAt <= now || user.status !== 'ACTIVE') return null;

    if (now.getTime() - session.lastActivityAt.getTime() >= this.policy.touchIntervalMs) {
      const expiresAt = this.expiryFor(session.createdAt, now);
      // Conditional update: never resurrect a session revoked meanwhile.
      await this.prisma.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastActivityAt: now, expiresAt },
      });
      return { session: { ...session, lastActivityAt: now, expiresAt }, user };
    }
    return { session, user };
  }

  /** Revokes the session behind a token. Safe to call repeatedly or with no token. */
  async revokeToken(token: string | undefined): Promise<void> {
    if (!token || !isWellFormedToken(token)) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  /** Revokes every active session of a user (e.g. "sign out everywhere"). Returns how many. */
  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.now() } },
      data: { revokedAt: this.now() },
    });
    return count;
  }

  /**
   * Deletes sessions that can never authenticate again: expired or revoked
   * more than `graceMs` ago (kept briefly for troubleshooting). Idempotent;
   * safe to run from several API instances.
   */
  async purgeExpired(graceMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(this.now().getTime() - graceMs);
    const { count } = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return count;
  }
}
