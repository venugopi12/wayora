import {
  MAX_TRAVELLERS_PER_USER,
  type SafeUser,
  type Traveller,
  type UpdateProfileRequest,
} from '@wayora/contracts';
import type { PrismaClient } from '@wayora/database';
import { AppError, notFound } from '../../utils/errors.js';
import { toSafeUser, toTraveller } from '../auth/safe-user.js';

type TravellerInput = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  nationality?: string | null;
};

const TRAVELLER_NOT_FOUND = 'That traveller was not found.';

/** `YYYY-MM-DD` → Date at midnight UTC (Postgres DATE); null clears; undefined leaves as is. */
function toDateColumn(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(`${value}T00:00:00.000Z`);
}

function travellerData(input: TravellerInput) {
  return {
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: toDateColumn(input.dateOfBirth) } : {}),
    ...(input.nationality !== undefined ? { nationality: input.nationality } : {}),
  };
}

/**
 * Profile and saved travellers. Every method takes the authenticated user's
 * id (from the session, never from the request) and scopes every query to it:
 * another user's traveller is indistinguishable from a missing one (404).
 */
export class UsersService {
  constructor(private readonly prisma: PrismaClient) {}

  async updateProfile(
    userId: string,
    input: UpdateProfileRequest & { name: string },
  ): Promise<SafeUser> {
    // Only explicitly permitted fields; the request schema already rejects others.
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: input.name },
    });
    return toSafeUser(user);
  }

  async listTravellers(userId: string): Promise<Traveller[]> {
    const rows = await this.prisma.traveller.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toTraveller);
  }

  async createTraveller(
    userId: string,
    input: TravellerInput & { firstName: string; lastName: string },
  ): Promise<Traveller> {
    // Count and insert in one transaction so concurrent requests can't exceed the cap.
    const row = await this.prisma.$transaction(
      async (tx) => {
        const count = await tx.traveller.count({ where: { userId } });
        if (count >= MAX_TRAVELLERS_PER_USER) {
          throw new AppError(
            'CONFLICT',
            `You can save up to ${MAX_TRAVELLERS_PER_USER} travellers. Remove one to add another.`,
          );
        }
        return tx.traveller.create({
          data: {
            userId,
            firstName: input.firstName,
            lastName: input.lastName,
            ...travellerData(input),
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return toTraveller(row);
  }

  async updateTraveller(
    userId: string,
    travellerId: string,
    input: TravellerInput,
  ): Promise<Traveller> {
    const { count } = await this.prisma.traveller.updateMany({
      where: { id: travellerId, userId },
      data: travellerData(input),
    });
    if (count === 0) throw notFound(TRAVELLER_NOT_FOUND);
    const row = await this.prisma.traveller.findFirstOrThrow({
      where: { id: travellerId, userId },
    });
    return toTraveller(row);
  }

  async deleteTraveller(userId: string, travellerId: string): Promise<void> {
    const { count } = await this.prisma.traveller.deleteMany({
      where: { id: travellerId, userId },
    });
    if (count === 0) throw notFound(TRAVELLER_NOT_FOUND);
  }
}
