-- Phase 12: demo bookings (docs/bookings.md#database).
--
-- Additive for every table in use. The Phase 1 `bookings` table had no writer
-- until now, so it gains required columns; the guard below stops the
-- migration (changing nothing) if it unexpectedly holds rows, instead of
-- inventing values for them. Rollback SQL is in docs/bookings.md#migration.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bookings") THEN
    RAISE EXCEPTION 'bookings already has rows; this migration adds required columns and expects it empty (see docs/bookings.md#migration)';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "passenger_type" AS ENUM ('ADULT', 'CHILD', 'INFANT');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "contact_phone" VARCHAR(16),
ADD COLUMN     "ends_on" DATE,
ADD COLUMN     "is_demo" BOOLEAN NOT NULL,
ADD COLUMN     "offer_snapshot" JSONB NOT NULL,
ADD COLUMN     "party_size" INTEGER NOT NULL,
ADD COLUMN     "reference" VARCHAR(32) NOT NULL,
ADD COLUMN     "search_id" UUID,
ADD COLUMN     "starts_on" DATE,
ADD COLUMN     "user_id" UUID NOT NULL,
ALTER COLUMN "order_id" DROP NOT NULL,
ALTER COLUMN "total_amount_minor" DROP NOT NULL,
ALTER COLUMN "total_amount_minor" DROP DEFAULT;

-- CreateTable
CREATE TABLE "booking_travellers" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "type" "passenger_type",
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_travellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_status_events" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "from_status" "booking_status",
    "to_status" "booking_status" NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "note" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_travellers_booking_id_position_key" ON "booking_travellers"("booking_id", "position");

-- CreateIndex
CREATE INDEX "booking_status_events_booking_id_created_at_idx" ON "booking_status_events"("booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE INDEX "bookings_user_id_created_at_idx" ON "bookings"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bookings_user_id_status_starts_on_idx" ON "bookings"("user_id", "status", "starts_on");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_travellers" ADD CONSTRAINT "booking_travellers_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_events" ADD CONSTRAINT "booking_status_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- References: WYD- (demo) or WY- (reserved for real bookings) + 2×4 characters
-- from an alphabet without look-alikes; demo bookings always use WYD-.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_reference_chk" CHECK ("reference" ~ '^WYD?-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_demo_reference_chk" CHECK (NOT "is_demo" OR "reference" LIKE 'WYD-%');
-- A demo booking never carries a supplier reference (no fake PNRs).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_demo_no_provider_reference_chk" CHECK (NOT "is_demo" OR "provider_reference" IS NULL);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_party_size_chk" CHECK ("party_size" BETWEEN 1 AND 50);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dates_chk" CHECK ("ends_on" IS NULL OR "starts_on" IS NULL OR "ends_on" >= "starts_on");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_phone_chk" CHECK ("contact_phone" IS NULL OR "contact_phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_offer_snapshot_chk" CHECK (jsonb_typeof("offer_snapshot") = 'object');
-- Status timestamps follow the status.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_at_chk" CHECK ("status" <> 'CONFIRMED' OR "confirmed_at" IS NOT NULL);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_at_chk" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));

ALTER TABLE "booking_travellers" ADD CONSTRAINT "booking_travellers_position_chk" CHECK ("position" >= 0);
ALTER TABLE "booking_status_events" ADD CONSTRAINT "booking_status_events_change_chk" CHECK ("from_status" IS DISTINCT FROM "to_status");

-- What was booked never changes: only the status, its timestamps, and the
-- links a later payment or supplier step adds (order, provider reference).
CREATE FUNCTION "bookings_protect_booked_facts"() RETURNS trigger
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
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bookings: booked facts are immutable (only status changes)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bookings_booked_facts_immutable"
BEFORE UPDATE ON "bookings"
FOR EACH ROW EXECUTE FUNCTION "bookings_protect_booked_facts"();

-- Booked travellers are a snapshot: no edits after booking.
CREATE FUNCTION "booking_travellers_prevent_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking_travellers are immutable (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "booking_travellers_immutable"
BEFORE UPDATE ON "booking_travellers"
FOR EACH ROW EXECUTE FUNCTION "booking_travellers_prevent_update"();

-- Status history is append-only (like audit_logs).
CREATE FUNCTION "booking_status_events_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking_status_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "booking_status_events_append_only"
BEFORE UPDATE OR DELETE ON "booking_status_events"
FOR EACH ROW EXECUTE FUNCTION "booking_status_events_prevent_mutation"();
