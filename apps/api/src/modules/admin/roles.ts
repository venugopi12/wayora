import { normalizeEmail, type UserRole } from '@wayora/contracts';
import type { PrismaClient, UserRole as DbUserRole } from '@wayora/database';

/*
 * Staff provisioning (docs/admin.md#provisioning). There is deliberately no
 * role-management UI or API: roles change only through this server-side
 * operation, run by an operator with database access. Every change is
 * audited by the database trigger `users_role_change_audited`, which records
 * the actor and reason this function sets for the transaction.
 */

export class RoleChangeError extends Error {}

export interface RoleChange {
  email: string;
  role: UserRole;
  /** Why (recorded in the audit log). */
  reason: string;
  /** Who is making the change (recorded in the audit log), e.g. "cli:alice". */
  actor: string;
}

export interface RoleChangeResult {
  userId: string;
  from: UserRole;
  to: UserRole;
  changed: boolean;
}

export async function setUserRole(
  prisma: PrismaClient,
  change: RoleChange,
): Promise<RoleChangeResult> {
  const reason = change.reason.trim();
  if (reason.length < 3 || reason.length > 200)
    throw new RoleChangeError(
      'Give a reason of 3–200 characters (it is recorded in the audit log).',
    );
  const actor = change.actor.trim().slice(0, 64);
  if (!actor) throw new RoleChangeError('Name the actor making the change.');
  const to = change.role.toUpperCase() as DbUserRole;
  const email = normalizeEmail(change.email);

  return prisma.$transaction(async (tx) => {
    // Lock the active admins first, so two demotions can't both pass the
    // "last admin" check.
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY id FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, role: true, status: true },
    });
    if (!user) throw new RoleChangeError('No account has that email address.');
    const from = user.role.toLowerCase() as UserRole;
    if (user.role === to) return { userId: user.id, from, to: from, changed: false };
    if (to !== 'USER' && user.status !== 'ACTIVE')
      throw new RoleChangeError('Only active accounts can be given a staff role.');
    if (user.role === 'ADMIN' && user.status === 'ACTIVE' && admins.length <= 1)
      throw new RoleChangeError(
        'This is the last active administrator. Make another account an administrator first.',
      );

    // Transaction-local settings, read by the audit trigger.
    await tx.$executeRaw`SELECT set_config('wayora.actor_id', ${actor}, true), set_config('wayora.reason', ${reason}, true)`;
    await tx.user.update({ where: { id: user.id }, data: { role: to } });
    return { userId: user.id, from, to: change.role, changed: true };
  });
}

/** Staff accounts, for `--list`. */
export function listStaff(
  prisma: PrismaClient,
): Promise<{ email: string; role: DbUserRole; status: string }[]> {
  return prisma.user.findMany({
    where: { role: { in: ['SUPPORT', 'ADMIN'] } },
    orderBy: [{ role: 'desc' }, { email: 'asc' }],
    select: { email: true, role: true, status: true },
  });
}
