import { z } from 'zod';
import { offerValidationSchema, searchResultSchema } from '@wayora/contracts';

/** What is kept of the offer: validated, versioned, never changed (a DB trigger enforces it). */
export const bookingSnapshotSchema = z.object({
  v: z.literal(1),
  offer: searchResultSchema,
  providerName: z.string(),
  priceCheck: offerValidationSchema.shape.status,
  searchGeneratedAt: z.string(),
  searchExpiresAt: z.string(),
});
export type BookingSnapshot = z.infer<typeof bookingSnapshotSchema>;
