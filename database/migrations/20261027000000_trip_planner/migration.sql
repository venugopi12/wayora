-- Phase 18: trip planner — planned trips and itinerary items (docs/planner.md#database).
-- Additive: two new tables and four enums; no existing table or row changes.
-- Rollback SQL is in docs/planner.md#rollback.

-- CreateEnum
CREATE TYPE "activity_category" AS ENUM ('SIGHTSEEING', 'CULTURE', 'FOOD', 'NATURE', 'BEACH', 'ADVENTURE', 'SHOPPING', 'NIGHTLIFE', 'WELLNESS', 'TRANSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "planning_pace" AS ENUM ('RELAXED', 'BALANCED', 'PACKED');

-- CreateEnum
CREATE TYPE "planning_budget" AS ENUM ('SHOESTRING', 'MODERATE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "planning_group" AS ENUM ('SOLO', 'COUPLE', 'FAMILY', 'FRIENDS');

-- CreateTable
CREATE TABLE "planned_trips" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "destination_id" VARCHAR(40),
    "destination_name" VARCHAR(120) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "notes" VARCHAR(2000),
    "pace" "planning_pace",
    "budget" "planning_budget",
    "group_type" "planning_group",
    "interests" "activity_category"[] DEFAULT ARRAY[]::"activity_category"[],
    "booking_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "planned_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_items" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "category" "activity_category" NOT NULL,
    "start_minute" SMALLINT,
    "duration_minutes" SMALLINT,
    "location" VARCHAR(160),
    "notes" VARCHAR(1000),
    "suggestion_id" VARCHAR(102),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "itinerary_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planned_trips_user_id_start_date_id_idx" ON "planned_trips"("user_id", "start_date", "id");

-- CreateIndex
CREATE INDEX "planned_trips_booking_id_idx" ON "planned_trips"("booking_id");

-- AddForeignKey
ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_title_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_destination_name_chk" CHECK (length(btrim("destination_name")) > 0);
-- At most 30 days, end on or after start (matches PLANNER_LIMITS.maxTripDays).
ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_dates_chk" CHECK ("end_date" >= "start_date" AND "end_date" - "start_date" <= 29);
ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_version_chk" CHECK ("version" >= 1);

ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_title_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_position_chk" CHECK ("position" >= 0);
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_start_minute_chk" CHECK ("start_minute" IS NULL OR "start_minute" BETWEEN 0 AND 1439);
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_duration_chk" CHECK ("duration_minutes" IS NULL OR "duration_minutes" BETWEEN 5 AND 720);

-- One activity per (day, position). Deferrable (checked at the end of each
-- statement, or of the transaction if deferred) so a reorder can swap
-- positions in a single UPDATE. Also the index for reading a trip's itinerary.
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_trip_day_position_key" UNIQUE ("trip_id", "day", "position") DEFERRABLE INITIALLY IMMEDIATE;

-- A curated suggestion appears at most once per trip.
CREATE UNIQUE INDEX "itinerary_items_one_suggestion_per_trip" ON "itinerary_items"("trip_id", "suggestion_id") WHERE "suggestion_id" IS NOT NULL;

-- A planned trip may only link a booking of the same user. (The API checks
-- this too; the trigger makes it impossible to get wrong.)
CREATE FUNCTION "planned_trips_booking_owner"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."booking_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "bookings" b WHERE b."id" = NEW."booking_id" AND b."user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'planned_trips: linked booking must belong to the same user'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "planned_trips_booking_owner_check"
BEFORE INSERT OR UPDATE OF "booking_id", "user_id" ON "planned_trips"
FOR EACH ROW EXECUTE FUNCTION "planned_trips_booking_owner"();
