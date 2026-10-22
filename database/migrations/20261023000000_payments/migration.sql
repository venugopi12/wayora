-- Phase 13: payments (docs/payments.md#database).
--
-- Additive. Existing bookings get payment mode NONE, which is what they are:
-- Phase 12 bookings were confirmed without any payment. Rollback SQL is in
-- docs/payments.md#migration.
--
-- Note: the new booking_status value EXPIRED is added here but not used by any
-- statement in this file (PostgreSQL can't use an enum value in the
-- transaction that adds it).

-- AlterEnum
ALTER TYPE "booking_status" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- CreateEnum
CREATE TYPE "booking_payment_mode" AS ENUM ('NONE', 'DEMO');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment_mode" AS ENUM ('DEMO', 'LIVE');

-- AlterTable: existing bookings were made without payment (Phase 12).
ALTER TABLE "bookings" ADD COLUMN "payment_mode" "booking_payment_mode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "payment_due_at" TIMESTAMPTZ(3);
-- New bookings must say how they are paid.
ALTER TABLE "bookings" ALTER COLUMN "payment_mode" DROP DEFAULT;

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempt" SMALLINT NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "provider_reference" VARCHAR(128),
    "status" "payment_status" NOT NULL DEFAULT 'CREATED',
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "demo_scenario" VARCHAR(32),
    "idempotency_key_hash" CHAR(64),
    "failure_code" VARCHAR(64),
    "failure_message" VARCHAR(255),
    "refund_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_events" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "from_status" "payment_status",
    "to_status" "payment_status" NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "provider_event_id" VARCHAR(255),
    "note" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_status_payment_due_at_idx" ON "bookings"("status", "payment_due_at");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_booking_id_attempt_key" ON "payments"("booking_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_reference_key" ON "payments"("provider", "provider_reference");

-- CreateIndex
CREATE INDEX "payment_status_events_payment_id_created_at_idx" ON "payment_status_events"("payment_id", "created_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_events" ADD CONSTRAINT "payment_status_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- Bookings: a due date only for bookings that take a demo payment, and a
-- demo payment only for bookings with an exact total (not an estimate range).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_due_at_chk" CHECK ("payment_due_at" IS NULL OR "payment_mode" = 'DEMO');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_demo_payment_total_chk" CHECK ("payment_mode" <> 'DEMO' OR "total_amount_minor" IS NOT NULL);

-- At most one attempt in progress per booking, and at most one that took
-- (or would have taken) money: duplicate requests can never produce two
-- successful payments for one booking, whatever the application does.
CREATE UNIQUE INDEX "payments_one_active_per_booking" ON "payments"("booking_id") WHERE "status" IN ('CREATED', 'PENDING');
CREATE UNIQUE INDEX "payments_one_success_per_booking" ON "payments"("booking_id") WHERE "status" IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED');

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_minor_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_attempt_chk" CHECK ("attempt" >= 1);
ALTER TABLE "payments" ADD CONSTRAINT "payments_demo_scenario_chk" CHECK ("demo_scenario" IS NULL OR "mode" = 'DEMO');
ALTER TABLE "payments" ADD CONSTRAINT "payments_idempotency_key_hash_chk" CHECK ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[0-9a-f]{64}$');
-- completed_at is set exactly when the attempt has left created/pending.
ALTER TABLE "payments" ADD CONSTRAINT "payments_completed_at_chk" CHECK (("status" IN ('CREATED', 'PENDING')) = ("completed_at" IS NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_failure_chk" CHECK (("failure_code" IS NULL AND "failure_message" IS NULL) OR "status" IN ('FAILED', 'CANCELLED'));
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_required_chk" CHECK (NOT "refund_required" OR "status" IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'));

ALTER TABLE "payment_status_events" ADD CONSTRAINT "payment_status_events_change_chk" CHECK ("from_status" IS DISTINCT FROM "to_status");

-- What an attempt is for never changes: only its status, the provider
-- reference (set once), failure details, the refund flag and timestamps.
CREATE FUNCTION "payments_protect_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."demo_scenario" IS DISTINCT FROM OLD."demo_scenario"
    OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."provider_reference" IS NOT NULL AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference") THEN
    RAISE EXCEPTION 'payments: amount, booking, provider and reference are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_facts_immutable"
BEFORE UPDATE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "payments_protect_facts"();

-- Payment records are kept for audit.
CREATE FUNCTION "payments_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payments are kept for audit (DELETE blocked)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "payments_no_delete"
BEFORE DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "payments_prevent_delete"();

-- Status history is append-only (like booking_status_events and audit_logs).
CREATE FUNCTION "payment_status_events_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_status_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "payment_status_events_append_only"
BEFORE UPDATE OR DELETE ON "payment_status_events"
FOR EACH ROW EXECUTE FUNCTION "payment_status_events_prevent_mutation"();

-- A booking's payment mode and due date are part of what was booked.
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
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bookings: booked facts are immutable (only status changes)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
