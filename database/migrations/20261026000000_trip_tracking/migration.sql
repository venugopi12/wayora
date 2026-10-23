-- Phase 17: trip timeline, travel status and disruptions (docs/trips.md#database).
-- Additive. Existing bookings get their timeline from their status histories
-- (backfill below). Rollback SQL is in docs/trips.md#rollback.

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'TRIP_DISRUPTION';

-- CreateEnum
CREATE TYPE "trip_event_type" AS ENUM ('BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_EXPIRED', 'BOOKING_FAILED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_REFUND_PENDING', 'PAYMENT_REFUNDED', 'TRAVEL_REMINDER', 'CHECK_OUT_REMINDER', 'STATUS_CHANGED', 'DISRUPTION_REPORTED', 'DISRUPTION_UPDATED', 'DISRUPTION_RESOLVED');

-- CreateEnum
CREATE TYPE "trip_event_source" AS ENUM ('WAYORA', 'DEMO_PROVIDER', 'LIVE_PROVIDER');

-- CreateEnum
CREATE TYPE "disruption_type" AS ENUM ('DEPARTURE_DELAY', 'ARRIVAL_DELAY', 'CANCELLATION', 'SCHEDULE_CHANGE', 'SERVICE_DISRUPTION', 'BOOKING_CHANGE');

-- CreateEnum
CREATE TYPE "disruption_severity" AS ENUM ('INFO', 'MINOR', 'MAJOR', 'SEVERE');

-- CreateEnum
CREATE TYPE "disruption_state" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateTable
CREATE TABLE "trip_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "trip_event_type" NOT NULL,
    "source" "trip_event_source" NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "observed_at" TIMESTAMPTZ(3),
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_statuses" (
    "booking_id" UUID NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "source" "trip_event_source" NOT NULL,
    "legs" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(3),
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "last_error_code" VARCHAR(32),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_statuses_pkey" PRIMARY KEY ("booking_id")
);

-- CreateTable
CREATE TABLE "trip_disruptions" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "source" "trip_event_source" NOT NULL,
    "external_key" VARCHAR(128) NOT NULL,
    "type" "disruption_type" NOT NULL,
    "severity" "disruption_severity" NOT NULL,
    "state" "disruption_state" NOT NULL,
    "leg_index" SMALLINT,
    "details" JSONB NOT NULL,
    "first_detected_at" TIMESTAMPTZ(3) NOT NULL,
    "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_disruptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_events_seq_key" ON "trip_events"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "trip_events_dedupe_key_key" ON "trip_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "trip_events_booking_id_occurred_at_seq_idx" ON "trip_events"("booking_id", "occurred_at", "seq");

-- CreateIndex
CREATE INDEX "trip_statuses_checked_at_idx" ON "trip_statuses"("checked_at");

-- CreateIndex
CREATE INDEX "trip_disruptions_booking_id_state_idx" ON "trip_disruptions"("booking_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "trip_disruptions_booking_id_provider_id_external_key_key" ON "trip_disruptions"("booking_id", "provider_id", "external_key");

-- AddForeignKey
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_statuses" ADD CONSTRAINT "trip_statuses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_disruptions" ADD CONSTRAINT "trip_disruptions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints, triggers and backfill.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_data_chk" CHECK (jsonb_typeof("data") = 'object');
ALTER TABLE "trip_statuses" ADD CONSTRAINT "trip_statuses_legs_chk" CHECK (jsonb_typeof("legs") = 'array');
ALTER TABLE "trip_disruptions" ADD CONSTRAINT "trip_disruptions_details_chk" CHECK (jsonb_typeof("details") = 'object');
-- Resolved exactly when it has a resolution time.
ALTER TABLE "trip_disruptions" ADD CONSTRAINT "trip_disruptions_resolved_chk" CHECK (("state" = 'RESOLVED') = ("resolved_at" IS NOT NULL));
-- Wayora's own records never carry a provider observation time; provider data always does.
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_observed_chk" CHECK (("source" = 'WAYORA') = ("observed_at" IS NULL));

-- The timeline is append-only, like the status histories it mirrors.
CREATE FUNCTION "trip_events_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip_events is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "trip_events_append_only"
BEFORE UPDATE OR DELETE ON "trip_events"
FOR EACH ROW EXECUTE FUNCTION "trip_events_prevent_mutation"();

-- Realtime: every new timeline entry is announced on commit (pg_notify is
-- transactional), to the API instances listening (docs/trips.md#live-updates).
-- The payload holds ids only.
CREATE FUNCTION "trip_events_announce"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('wayora_trip_events', json_build_object('bookingId', NEW."booking_id", 'seq', NEW."seq")::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trip_events_announce"
AFTER INSERT ON "trip_events"
FOR EACH ROW EXECUTE FUNCTION "trip_events_announce"();

-- Booking status changes appear on the timeline in the same transaction, from
-- whichever code path made them (the history row is the single source).
CREATE FUNCTION "trip_events_from_booking_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  event_type "trip_event_type";
BEGIN
  IF NEW."from_status" IS NULL THEN
    event_type := 'BOOKING_CREATED';
  ELSIF NEW."to_status" IN ('CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED') THEN
    event_type := ('BOOKING_' || NEW."to_status"::text)::"trip_event_type";
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO "trip_events" ("booking_id", "type", "source", "dedupe_key", "occurred_at", "data")
  VALUES (
    NEW."booking_id", event_type, 'WAYORA', 'booking_status_event:' || NEW."id"::text, NEW."created_at",
    jsonb_build_object('status', NEW."to_status", 'by', NEW."actor_type", 'note', NEW."note")
  )
  ON CONFLICT ("dedupe_key") DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "booking_status_events_to_timeline"
AFTER INSERT ON "booking_status_events"
FOR EACH ROW EXECUTE FUNCTION "trip_events_from_booking_status"();

-- Payment outcomes likewise (started/pending/cancelled attempts stay off the
-- timeline; the booking's own entries cover them).
CREATE FUNCTION "trip_events_from_payment_status"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."to_status" NOT IN ('SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED') THEN
    RETURN NULL;
  END IF;
  INSERT INTO "trip_events" ("booking_id", "type", "source", "dedupe_key", "occurred_at", "data")
  SELECT p."booking_id", ('PAYMENT_' || NEW."to_status"::text)::"trip_event_type", 'WAYORA',
         'payment_status_event:' || NEW."id"::text, NEW."created_at",
         jsonb_build_object('paymentId', p."id", 'attempt', p."attempt", 'status', NEW."to_status",
                            'mode', p."mode", 'amountMinor', p."amount_minor"::text,
                            'currency', p."currency", 'note', NEW."note")
    FROM "payments" p WHERE p."id" = NEW."payment_id"
  ON CONFLICT ("dedupe_key") DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "payment_status_events_to_timeline"
AFTER INSERT ON "payment_status_events"
FOR EACH ROW EXECUTE FUNCTION "trip_events_from_payment_status"();

-- Backfill: existing bookings' histories, in time order.
INSERT INTO "trip_events" ("booking_id", "type", "source", "dedupe_key", "occurred_at", "data")
SELECT e."booking_id",
       (CASE WHEN e."from_status" IS NULL THEN 'BOOKING_CREATED' ELSE 'BOOKING_' || e."to_status"::text END)::"trip_event_type",
       'WAYORA', 'booking_status_event:' || e."id"::text, e."created_at",
       jsonb_build_object('status', e."to_status", 'by', e."actor_type", 'note', e."note")
  FROM "booking_status_events" e
 WHERE e."from_status" IS NULL OR e."to_status" IN ('CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED')
 ORDER BY e."created_at", e."id"
ON CONFLICT ("dedupe_key") DO NOTHING;

INSERT INTO "trip_events" ("booking_id", "type", "source", "dedupe_key", "occurred_at", "data")
SELECT p."booking_id", ('PAYMENT_' || e."to_status"::text)::"trip_event_type", 'WAYORA',
       'payment_status_event:' || e."id"::text, e."created_at",
       jsonb_build_object('paymentId', p."id", 'attempt', p."attempt", 'status', e."to_status",
                          'mode', p."mode", 'amountMinor', p."amount_minor"::text,
                          'currency', p."currency", 'note', e."note")
  FROM "payment_status_events" e JOIN "payments" p ON p."id" = e."payment_id"
 WHERE e."to_status" IN ('SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')
 ORDER BY e."created_at", e."id"
ON CONFLICT ("dedupe_key") DO NOTHING;

INSERT INTO "trip_events" ("booking_id", "type", "source", "dedupe_key", "occurred_at", "data")
SELECT n."booking_id", 'TRAVEL_REMINDER', 'WAYORA', 'reminder:' || n."booking_id"::text || ':DAY_BEFORE',
       n."created_at", jsonb_build_object('startsOn', b."starts_on")
  FROM "notifications" n JOIN "bookings" b ON b."id" = n."booking_id"
 WHERE n."type" = 'TRAVEL_REMINDER'
 ORDER BY n."created_at"
ON CONFLICT ("dedupe_key") DO NOTHING;
