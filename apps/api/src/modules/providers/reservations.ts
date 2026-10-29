import { z } from 'zod';
import type { SearchPrice, SearchResult } from '@wayora/contracts';

/*
 * Supplier reservations: the adapter boundary (Phase 23,
 * docs/bookings.md#supplier-reservations).
 *
 * A live adapter whose supplier has a documented booking API implements
 * `SupplierReservations` and declares `operations.book: 'supported'`. No
 * real supplier implements it today (docs/providers.md): only the
 * test-only fixture supplier does.
 *
 * Rules every adapter follows:
 * - `reserve` sends exactly one reservation request. It never retries by
 *   itself. Wayora decides whether and when to send again (only with the
 *   same idempotency key, and only to suppliers that de-duplicate by it).
 * - An adapter returns `rejected` only when the supplier definitively did
 *   not reserve (a documented refusal, or a request refused before
 *   processing, such as bad credentials). Anything else it can't map
 *   (timeouts, 5xx, unreadable answers) is thrown: Wayora then treats the
 *   outcome as UNKNOWN and never assumes it failed.
 * - Answers are validated with a schema before mapping; the mapped outcome
 *   is validated again here (`reservationOutcomeSchema`).
 * - References come from the supplier only. An adapter never makes one up.
 */

export interface ReservationTraveller {
  firstName: string;
  lastName: string;
  type: 'adult' | 'child' | 'infant' | null;
}

/** What Wayora asks a supplier to reserve: built only from server-side records. */
export interface ReservationRequest {
  /** Wayora's key for this reservation. Sent to suppliers that de-duplicate by it. */
  idempotencyKey: string;
  /** Wayora's own booking reference (WY-…), for the supplier's records. */
  bookingReference: string;
  /** The offer exactly as booked (from the booking's snapshot, never the client). */
  offer: SearchResult;
  /** The price Wayora showed and the traveller accepted (the snapshot's). */
  expectedPrice: SearchPrice;
  travellers: readonly ReservationTraveller[];
  contactPhone: string | null;
  partySize: number;
}

export interface ReservationLookup {
  idempotencyKey: string;
  bookingReference: string;
  /** Known once the supplier gave it. */
  supplierReference: string | null;
  offer: SearchResult;
}

export interface CancellationRequest {
  /** Wayora's key for this cancellation (one per reservation). */
  cancellationKey: string;
  supplierReference: string;
  bookingReference: string;
}

export interface ReservationCallContext {
  signal: AbortSignal;
  now: Date;
}

const reference = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII only');

export const travelDocumentSchema = z.object({
  type: z.enum(['ticket', 'voucher', 'itinerary']),
  reference,
  /** Position of the booked traveller it belongs to, when per traveller. */
  travellerIndex: z.number().int().min(0).max(49).nullable(),
});
export type SupplierTravelDocument = z.infer<typeof travelDocumentSchema>;

/** What a supplier said about a reservation (validated before Wayora uses it). */
export const reservationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'),
    supplierReference: reference,
    /** The price the supplier confirmed, if it says (compared with the booked price). */
    price: z
      .object({
        amountMinor: z.string().regex(/^(0|[1-9]\d{0,17})$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .nullable(),
    /** Tickets or vouchers the supplier actually issued (often none at first). */
    documents: z.array(travelDocumentSchema).max(50),
  }),
  /** Accepted, not confirmed yet (e.g. "on request"). */
  z.object({ status: z.literal('pending'), supplierReference: reference.nullable() }),
  /** Definitively not reserved. */
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['offer-unavailable', 'price-changed', 'invalid-details', 'other']),
  }),
  /** Lookups only: the supplier has no reservation under this key or reference. */
  z.object({ status: z.literal('not-found') }),
  /** Lookups only: the reservation exists and is cancelled. */
  z.object({ status: z.literal('cancelled'), cancellationReference: reference.nullable() }),
]);
export type ReservationOutcome = z.infer<typeof reservationOutcomeSchema>;

export const cancellationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled'), cancellationReference: reference.nullable() }),
  /** Accepted, not confirmed yet. */
  z.object({ status: z.literal('pending') }),
  /** The supplier refused: the reservation stays as it was. */
  z.object({ status: z.literal('rejected'), reason: z.enum(['not-cancellable', 'other']) }),
]);
export type CancellationOutcome = z.infer<typeof cancellationOutcomeSchema>;

export interface SupplierReservations {
  /**
   * Who takes the traveller's money. Only `supplier` exists: Wayora has no
   * real payment gateway, so it never takes payment for a supplier booking.
   * The traveller pays the supplier under the supplier's own terms (for
   * example at the property). Suppliers that need payment through Wayora
   * can't be booked until a real gateway exists.
   */
  readonly settlement: 'supplier';
  /**
   * The supplier documents that it de-duplicates reservation requests by
   * `idempotencyKey`. Only then may Wayora send the same request again after
   * an unknown outcome.
   */
  readonly idempotentReserve: boolean;
  /** Sends one reservation request. See the rules above. */
  reserve(
    request: ReservationRequest,
    context: ReservationCallContext,
  ): Promise<ReservationOutcome>;
  /** Read-only status lookup (by key or reference), if the supplier has one. */
  lookup?(request: ReservationLookup, context: ReservationCallContext): Promise<ReservationOutcome>;
  /** Cancels a confirmed reservation, if the supplier supports it. */
  cancel?(
    request: CancellationRequest,
    context: ReservationCallContext,
  ): Promise<CancellationOutcome>;
}
