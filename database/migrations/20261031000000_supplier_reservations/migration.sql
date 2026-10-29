-- Phase 23: supplier reservations, travel documents and refunds
-- (docs/bookings.md#supplier-reservations, docs/payments.md#refunds).
-- Additive: five enums, one notification type, four new tables, and a
-- stricter version of the bookings trigger. No existing row changes. Rollback SQL is in
-- docs/bookings.md#phase-23-rollback.

-- AlterEnum: a supplier reservation can fail (never used by demo bookings).
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'BOOKING_FAILED';

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'CANCELLATION_PENDING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "reservation_error_category" AS ENUM ('TIMEOUT', 'UNAVAILABLE', 'INVALID_RESPONSE', 'OFFER_UNAVAILABLE', 'PRICE_CHANGED', 'INVALID_DETAILS', 'REJECTED', 'NOT_FOUND', 'NOT_CANCELLABLE', 'PRICE_MISMATCH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "travel_document_type" AS ENUM ('TICKET', 'VOUCHER', 'ITINERARY');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('REQUIRED', 'REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "refund_reason" AS ENUM ('BOOKING_CANCELLED', 'PAID_AFTER_CLOSE', 'MANUAL');

-- CreateTable
CREATE TABLE "supplier_reservations" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" UUID NOT NULL,
    "supplier_reference" VARCHAR(128),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "checks" SMALLINT NOT NULL DEFAULT 0,
    "cancel_attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "next_check_at" TIMESTAMPTZ(3),
    "error_category" "reservation_error_category",
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "needs_attention" BOOLEAN NOT NULL DEFAULT false,
    "request_id" VARCHAR(128),
    "confirmed_details" JSONB,
    "confirmed_at" TIMESTAMPTZ(3),
    "cancellation_key" UUID,
    "cancellation_reference" VARCHAR(128),
    "cancellation_requested_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_events" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "from_status" "reservation_status",
    "to_status" "reservation_status" NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "error_category" "reservation_error_category",
    "note" VARCHAR(255),
    "request_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_documents" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "travel_document_type" NOT NULL,
    "reference" VARCHAR(128) NOT NULL,
    "traveller_position" SMALLINT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travel_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "status" "refund_status" NOT NULL,
    "reason" "refund_reason" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "failure_code" VARCHAR(64),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "needs_attention" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_reservations_booking_id_key" ON "supplier_reservations"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_reservations_idempotency_key_key" ON "supplier_reservations"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_reservations_cancellation_key_key" ON "supplier_reservations"("cancellation_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_reservations_provider_supplier_reference_key" ON "supplier_reservations"("provider", "supplier_reference");

-- CreateIndex
CREATE INDEX "supplier_reservations_status_next_check_at_idx" ON "supplier_reservations"("status", "next_check_at");

-- CreateIndex
CREATE INDEX "supplier_reservations_needs_attention_idx" ON "supplier_reservations"("needs_attention");

-- CreateIndex
CREATE INDEX "reservation_events_reservation_id_created_at_idx" ON "reservation_events"("reservation_id", "created_at");

-- CreateIndex
CREATE INDEX "travel_documents_booking_id_idx" ON "travel_documents"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "travel_documents_reservation_id_type_reference_key" ON "travel_documents"("reservation_id", "type", "reference");

-- CreateIndex
CREATE INDEX "refunds_booking_id_idx" ON "refunds"("booking_id");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_status_next_attempt_at_idx" ON "refunds"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_events" ADD CONSTRAINT "reservation_events_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "supplier_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "supplier_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- Reservations: counters, references and timestamps follow the status.
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_counts_chk" CHECK ("attempts" >= 0 AND "checks" >= 0 AND "cancel_attempts" >= 0);
-- Confirmed (and anything after it) means the supplier gave a reference.
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_confirmed_chk" CHECK ("status" NOT IN ('CONFIRMED', 'CANCELLATION_PENDING', 'CANCELLED') OR ("supplier_reference" IS NOT NULL AND "confirmed_at" IS NOT NULL));
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_cancelled_chk" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_cancellation_chk" CHECK ("status" NOT IN ('CANCELLATION_PENDING', 'CANCELLED') OR ("cancellation_key" IS NOT NULL AND "cancellation_requested_at" IS NOT NULL));
-- Only an unanswered request is ambiguous.
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_ambiguous_chk" CHECK (NOT "ambiguous" OR "status" IN ('UNKNOWN', 'CANCELLATION_PENDING'));
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_supplier_reference_chk" CHECK ("supplier_reference" IS NULL OR length(btrim("supplier_reference")) > 0);
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_confirmed_details_chk" CHECK ("confirmed_details" IS NULL OR jsonb_typeof("confirmed_details") = 'object');
ALTER TABLE "reservation_events" ADD CONSTRAINT "reservation_events_change_chk" CHECK ("from_status" IS DISTINCT FROM "to_status");
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_reference_chk" CHECK (length(btrim("reference")) > 0);
ALTER TABLE "travel_documents" ADD CONSTRAINT "travel_documents_traveller_position_chk" CHECK ("traveller_position" IS NULL OR "traveller_position" >= 0);

-- A reservation belongs to a supplier booking (never a demo one) of the same provider.
CREATE FUNCTION "supplier_reservations_check_booking"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "bookings" b
    WHERE b."id" = NEW."booking_id" AND NOT b."is_demo" AND b."provider" = NEW."provider"
  ) THEN
    RAISE EXCEPTION 'supplier_reservations: only a non-demo booking of the same provider can have a supplier reservation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "supplier_reservations_booking_check"
BEFORE INSERT ON "supplier_reservations"
FOR EACH ROW EXECUTE FUNCTION "supplier_reservations_check_booking"();

-- What identifies a reservation never changes; references are set once.
CREATE FUNCTION "supplier_reservations_protect_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."supplier_reference" IS NOT NULL AND NEW."supplier_reference" IS DISTINCT FROM OLD."supplier_reference")
    OR (OLD."cancellation_key" IS NOT NULL AND NEW."cancellation_key" IS DISTINCT FROM OLD."cancellation_key")
    OR (OLD."confirmed_details" IS NOT NULL AND NEW."confirmed_details" IS DISTINCT FROM OLD."confirmed_details") THEN
    RAISE EXCEPTION 'supplier_reservations: identity and supplier references are immutable once set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "supplier_reservations_facts_immutable"
BEFORE UPDATE ON "supplier_reservations"
FOR EACH ROW EXECUTE FUNCTION "supplier_reservations_protect_facts"();

-- Reservation history is append-only.
CREATE FUNCTION "reservation_events_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reservation_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "reservation_events_append_only"
BEFORE UPDATE OR DELETE ON "reservation_events"
FOR EACH ROW EXECUTE FUNCTION "reservation_events_prevent_mutation"();

-- Tickets and vouchers exist only for a confirmed supplier reservation, are
-- recorded as the supplier issued them, and never change.
CREATE FUNCTION "travel_documents_check_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "supplier_reservations" r
    WHERE r."id" = NEW."reservation_id" AND r."booking_id" = NEW."booking_id"
      AND r."status" IN ('CONFIRMED', 'CANCELLATION_PENDING')
  ) THEN
    RAISE EXCEPTION 'travel_documents: only a confirmed supplier reservation can have documents'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "travel_documents_insert_check"
BEFORE INSERT ON "travel_documents"
FOR EACH ROW EXECUTE FUNCTION "travel_documents_check_insert"();

CREATE FUNCTION "travel_documents_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'travel_documents are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "travel_documents_immutable"
BEFORE UPDATE OR DELETE ON "travel_documents"
FOR EACH ROW EXECUTE FUNCTION "travel_documents_prevent_mutation"();

-- Refunds: the payment's own amount and currency, never another figure.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_minor_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_attempts_chk" CHECK ("attempts" >= 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_completed_at_chk" CHECK (("status" IN ('SUCCEEDED', 'FAILED')) = ("completed_at" IS NOT NULL));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_failure_chk" CHECK ("failure_code" IS NULL OR "status" = 'FAILED');
-- At most one refund in flight (or done) per payment; a failed one may be followed by another.
CREATE UNIQUE INDEX "refunds_one_open_per_payment" ON "refunds"("payment_id") WHERE "status" <> 'FAILED';

CREATE FUNCTION "refunds_check_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."id" = NEW."payment_id"
      AND p."booking_id" = NEW."booking_id"
      AND p."user_id" = NEW."user_id"
      AND p."provider" = NEW."provider"
      AND p."mode" = NEW."mode"
      AND p."amount_minor" = NEW."amount_minor"
      AND p."currency" = NEW."currency"
      AND p."status" IN ('SUCCEEDED', 'REFUND_PENDING')
  ) THEN
    RAISE EXCEPTION 'refunds: a refund must match a successful payment (same booking, owner, provider, amount and currency)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "refunds_insert_check"
BEFORE INSERT ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "refunds_check_insert"();

CREATE FUNCTION "refunds_protect_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
    OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'refunds: payment, amount and currency are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "refunds_facts_immutable"
BEFORE UPDATE ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "refunds_protect_facts"();

CREATE FUNCTION "refunds_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'refunds can''t be deleted' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "refunds_no_delete"
BEFORE DELETE ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "refunds_prevent_delete"();

-- Bookings: the supplier reference is set once, and a supplier booking's
-- status follows its reservation (no confirmation without the supplier's).
CREATE OR REPLACE FUNCTION "bookings_protect_booked_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."is_demo" IS DISTINCT FROM OLD."is_demo"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."search_id" IS DISTINCT FROM OLD."search_id"
    OR NEW."offer_snapshot" IS DISTINCT FROM OLD."offer_snapshot"
    OR NEW."party_size" IS DISTINCT FROM OLD."party_size"
    OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on"
    OR NEW."ends_on" IS DISTINCT FROM OLD."ends_on"
    OR NEW."contact_phone" IS DISTINCT FROM OLD."contact_phone"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
    OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    OR NEW."payment_due_at" IS DISTINCT FROM OLD."payment_due_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."provider_reference" IS NOT NULL AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference") THEN
    RAISE EXCEPTION 'bookings: booked facts are immutable (only status changes)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT NEW."is_demo" AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF (NEW."status" = 'CONFIRMED' AND NOT EXISTS (
          SELECT 1 FROM "supplier_reservations" r
          WHERE r."booking_id" = NEW."id" AND r."status" IN ('CONFIRMED', 'CANCELLATION_PENDING')))
      OR (NEW."status" = 'CANCELLED' AND NOT EXISTS (
          SELECT 1 FROM "supplier_reservations" r
          WHERE r."booking_id" = NEW."id" AND r."status" = 'CANCELLED'))
      OR (NEW."status" = 'FAILED' AND NOT EXISTS (
          SELECT 1 FROM "supplier_reservations" r
          WHERE r."booking_id" = NEW."id" AND r."status" = 'FAILED')) THEN
      RAISE EXCEPTION 'bookings: a supplier booking''s status must follow its supplier reservation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
