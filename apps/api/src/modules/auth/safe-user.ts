import type { SafeUser, Traveller } from '@wayora/contracts';
import type { TravellerModel as TravellerRow, UserModel as User } from '@wayora/database';

/** The only way a user row leaves the API: an explicit allow-list of fields. */
export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.displayName ?? '',
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
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
