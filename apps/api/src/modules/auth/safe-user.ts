import type { SafeUser, Traveller, UserRole } from '@wayora/contracts';
import type { TravellerModel as TravellerRow, UserModel as User } from '@wayora/database';

/** Database enum → API value. */
export const toUserRole = (role: User['role']): UserRole => role.toLowerCase() as UserRole;

/** The only way a user row leaves the API: an explicit allow-list of fields. */
export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.displayName ?? '',
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    role: toUserRole(user.role),
    createdAt: user.createdAt.toISOString(),
  };
}

export function toTraveller(row: TravellerRow): Traveller {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    // `@db.Date` comes back as midnight UTC.
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
    nationality: row.nationality,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
