-- Phase 31: analytics and business insights (docs/analytics.md).
-- Additive only: a new events table, new nullable columns on search_events,
-- triggers that record business events from the authoritative rows, and
-- indexes for date-range reporting. Nothing is back-filled: older records
-- keep no events, and reports say so.

CREATE TYPE "analytics_event_source" AS ENUM ('SERVER', 'CLIENT');

CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" VARCHAR(48) NOT NULL,
    "source" "analytics_event_source" NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "user_id" UUID,
    "entity_type" VARCHAR(32),
    "entity_id" UUID,
    "category" "travel_category",
    "is_demo" BOOLEAN,
    "currency" CHAR(3),
    "amount_minor" BIGINT,
    "search_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "analytics_events_type_format" CHECK ("type" ~ '^[a-z]+(\.[a-z_]+)+$'),
    CONSTRAINT "analytics_events_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
    CONSTRAINT "analytics_events_amount_currency" CHECK (("amount_minor" IS NULL) OR ("currency" IS NOT NULL))
);

CREATE UNIQUE INDEX "analytics_events_dedupe_key_key" ON "analytics_events"("dedupe_key");
CREATE INDEX "analytics_events_type_occurred_at_idx" ON "analytics_events"("type", "occurred_at");
CREATE INDEX "analytics_events_occurred_at_idx" ON "analytics_events"("occurred_at");
-- User-level counts (active, returning) and funnel joins.
CREATE INDEX "analytics_events_user_occurred_idx" ON "analytics_events"("user_id", "occurred_at") WHERE "user_id" IS NOT NULL;
CREATE INDEX "analytics_events_search_type_idx" ON "analytics_events"("search_id", "type") WHERE "search_id" IS NOT NULL;

-- Search requests: catalogue places, travel month, filter/sort field names.
ALTER TABLE "search_events"
  ADD COLUMN "origin_place" VARCHAR(80),
  ADD COLUMN "destination_place" VARCHAR(80),
  ADD COLUMN "travel_month" DATE,
  ADD COLUMN "filter_keys" VARCHAR(40)[] DEFAULT ARRAY[]::VARCHAR(40)[],
  ADD COLUMN "sort" VARCHAR(40),
  ADD COLUMN "reused" BOOLEAN NOT NULL DEFAULT false;

-- Date-range reporting over the authoritative tables.
CREATE INDEX "bookings_confirmed_at_idx" ON "bookings"("confirmed_at") WHERE "confirmed_at" IS NOT NULL;
CREATE INDEX "bookings_cancelled_at_idx" ON "bookings"("cancelled_at") WHERE "cancelled_at" IS NOT NULL;
CREATE INDEX "payments_completed_at_idx" ON "payments"("completed_at") WHERE "completed_at" IS NOT NULL;
CREATE INDEX "refunds_created_at_idx" ON "refunds"("created_at");
CREATE INDEX "refunds_completed_at_idx" ON "refunds"("completed_at") WHERE "completed_at" IS NOT NULL;
CREATE INDEX "promotion_redemptions_redeemed_at_idx" ON "promotion_redemptions"("redeemed_at") WHERE "redeemed_at" IS NOT NULL;
CREATE INDEX "reward_redemptions_created_at_idx" ON "reward_redemptions"("created_at");
CREATE INDEX "supplier_reservations_created_at_idx" ON "supplier_reservations"("created_at");
CREATE INDEX "support_tickets_resolved_at_idx" ON "support_tickets"("resolved_at") WHERE "resolved_at" IS NOT NULL;
CREATE INDEX "reviews_published_at_idx" ON "reviews"("published_at") WHERE "published_at" IS NOT NULL;

-- ─── Server-side business events ─────────────────────────────────────────
-- Recorded in the same transaction as the change they describe, so an
-- event exists exactly when its record does (a rolled-back booking leaves
-- no event). ON CONFLICT DO NOTHING on the dedupe key makes them
-- idempotent. Metadata holds ids, codes and categories only.

CREATE FUNCTION "analytics_emit"(
  p_type TEXT, p_key TEXT, p_user UUID, p_entity_type TEXT, p_entity UUID,
  p_category "travel_category", p_demo BOOLEAN, p_currency CHAR(3), p_amount BIGINT,
  p_search UUID, p_meta JSONB, p_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "analytics_events" ("type", "source", "dedupe_key", "user_id", "entity_type",
    "entity_id", "category", "is_demo", "currency", "amount_minor", "search_id", "metadata",
    "occurred_at")
  VALUES (p_type, 'SERVER', p_key, p_user, p_entity_type, p_entity, p_category, p_demo,
    p_currency, p_amount, p_search, COALESCE(p_meta, '{}'::jsonb), COALESCE(p_at, now()))
  ON CONFLICT ("dedupe_key") DO NOTHING;
END $$;

-- Profile completion: a name and at least one saved traveller (the profile
-- data customers can give), recorded the first time both are present.
CREATE FUNCTION "analytics_profile_completed"(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" u WHERE u."id" = p_user AND u."role" = 'USER'
               AND u."display_name" IS NOT NULL AND btrim(u."display_name") <> '')
     AND EXISTS (SELECT 1 FROM "travellers" t WHERE t."user_id" = p_user) THEN
    PERFORM "analytics_emit"('user.profile_completed', 'user.profile_completed:' || p_user,
      p_user, 'user', p_user, NULL, NULL, NULL, NULL, NULL, '{}', now());
  END IF;
END $$;

CREATE FUNCTION "analytics_users"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" <> 'USER' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM "analytics_emit"('user.registered', 'user.registered:' || NEW."id", NEW."id", 'user',
      NEW."id", NULL, NULL, NULL, NULL, NULL, '{}', NEW."created_at");
  ELSE
    PERFORM "analytics_profile_completed"(NEW."id");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "users_analytics" AFTER INSERT OR UPDATE OF "display_name" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "analytics_users"();

CREATE FUNCTION "analytics_travellers"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "analytics_profile_completed"(NEW."user_id");
  RETURN NEW;
END $$;
CREATE TRIGGER "travellers_analytics" AFTER INSERT ON "travellers"
  FOR EACH ROW EXECUTE FUNCTION "analytics_travellers"();

CREATE FUNCTION "analytics_bookings"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "analytics_emit"('booking.created', 'booking.created:' || NEW."id", NEW."user_id",
      'booking', NEW."id", NEW."category", NEW."is_demo", NEW."currency", NEW."total_amount_minor",
      NEW."search_id", '{}', NEW."created_at");
  END IF;
  IF NEW."status" = 'CANCELLED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'CANCELLED') THEN
    PERFORM "analytics_emit"('booking.cancelled', 'booking.cancelled:' || NEW."id", NEW."user_id",
      'booking', NEW."id", NEW."category", NEW."is_demo", NULL, NULL, NEW."search_id", '{}',
      COALESCE(NEW."cancelled_at", now()));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bookings_analytics" AFTER INSERT OR UPDATE OF "status" ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "analytics_bookings"();

CREATE FUNCTION "analytics_payments"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE b RECORD;
BEGIN
  SELECT "category", "search_id" INTO b FROM "bookings" WHERE "id" = NEW."booking_id";
  IF TG_OP = 'INSERT' THEN
    PERFORM "analytics_emit"('payment.initiated', 'payment.initiated:' || NEW."id", NEW."user_id",
      'payment', NEW."id", b."category", NEW."mode" = 'DEMO', NEW."currency", NEW."amount_minor",
      b."search_id", jsonb_build_object('attempt', NEW."attempt"), NEW."created_at");
  END IF;
  IF NEW."status" = 'SUCCEEDED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'SUCCEEDED') THEN
    PERFORM "analytics_emit"('payment.succeeded', 'payment.succeeded:' || NEW."id", NEW."user_id",
      'payment', NEW."id", b."category", NEW."mode" = 'DEMO', NEW."currency", NEW."amount_minor",
      b."search_id", '{}', COALESCE(NEW."completed_at", now()));
  ELSIF NEW."status" = 'FAILED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'FAILED') THEN
    PERFORM "analytics_emit"('payment.failed', 'payment.failed:' || NEW."id", NEW."user_id",
      'payment', NEW."id", b."category", NEW."mode" = 'DEMO', NEW."currency", NEW."amount_minor",
      b."search_id", jsonb_build_object('failureCode', NEW."failure_code"),
      COALESCE(NEW."completed_at", now()));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payments_analytics" AFTER INSERT OR UPDATE OF "status" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "analytics_payments"();

CREATE FUNCTION "analytics_refunds"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "analytics_emit"('refund.initiated', 'refund.initiated:' || NEW."id", NEW."user_id",
      'refund', NEW."id", NULL, NEW."mode" = 'DEMO', NEW."currency", NEW."amount_minor", NULL,
      jsonb_build_object('reason', NEW."reason"), NEW."created_at");
  END IF;
  IF NEW."status" = 'SUCCEEDED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'SUCCEEDED') THEN
    PERFORM "analytics_emit"('refund.completed', 'refund.completed:' || NEW."id", NEW."user_id",
      'refund', NEW."id", NULL, NEW."mode" = 'DEMO', NEW."currency", NEW."amount_minor", NULL,
      jsonb_build_object('reason', NEW."reason"), COALESCE(NEW."completed_at", now()));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "refunds_analytics" AFTER INSERT OR UPDATE OF "status" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "analytics_refunds"();

-- Supplier reservations exist only for real (supplier) bookings.
CREATE FUNCTION "analytics_reservations"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE b RECORD;
BEGIN
  IF NEW."status" NOT IN ('CONFIRMED', 'FAILED') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  SELECT "user_id", "category", "search_id" INTO b FROM "bookings" WHERE "id" = NEW."booking_id";
  IF NEW."status" = 'CONFIRMED' THEN
    PERFORM "analytics_emit"('reservation.confirmed', 'reservation.confirmed:' || NEW."id",
      b."user_id", 'reservation', NEW."id", b."category", false, NULL, NULL, b."search_id",
      jsonb_build_object('provider', NEW."provider"), COALESCE(NEW."confirmed_at", now()));
  ELSE
    PERFORM "analytics_emit"('reservation.failed', 'reservation.failed:' || NEW."id",
      b."user_id", 'reservation', NEW."id", b."category", false, NULL, NULL, b."search_id",
      jsonb_build_object('provider', NEW."provider", 'errorCategory', NEW."error_category"), now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "supplier_reservations_analytics" AFTER INSERT OR UPDATE OF "status" ON "supplier_reservations"
  FOR EACH ROW EXECUTE FUNCTION "analytics_reservations"();

CREATE FUNCTION "analytics_coupons"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE b RECORD;
BEGIN
  IF NEW."kind" <> 'COUPON' THEN RETURN NEW; END IF;
  SELECT "category", "is_demo", "search_id" INTO b FROM "bookings" WHERE "id" = NEW."booking_id";
  PERFORM "analytics_emit"('coupon.applied', 'coupon.applied:' || NEW."id", NEW."user_id",
    'promotion_redemption', NEW."id", b."category", b."is_demo", NEW."currency",
    NEW."discount_minor", b."search_id", jsonb_build_object('promotionId', NEW."promotion_id"),
    NEW."created_at");
  RETURN NEW;
END $$;
CREATE TRIGGER "promotion_redemptions_analytics" AFTER INSERT ON "promotion_redemptions"
  FOR EACH ROW EXECUTE FUNCTION "analytics_coupons"();

-- Points and credit are "redeemed" when the payment they reduced succeeded (CONSUMED).
CREATE FUNCTION "analytics_reward_redemptions"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'CONSUMED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'CONSUMED') THEN
    PERFORM "analytics_emit"('rewards.redeemed', 'rewards.redeemed:' || NEW."id", NEW."user_id",
      'reward_redemption', NEW."id", NULL, NEW."mode" = 'DEMO', NEW."currency",
      NEW."total_amount_minor", NULL, jsonb_build_object('points', NEW."points"::text), now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "reward_redemptions_analytics" AFTER INSERT OR UPDATE OF "status" ON "reward_redemptions"
  FOR EACH ROW EXECUTE FUNCTION "analytics_reward_redemptions"();

CREATE FUNCTION "analytics_support_tickets"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "analytics_emit"('support.ticket_created', 'support.ticket_created:' || NEW."id",
    NEW."user_id", 'support_ticket', NEW."id", NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('category', NEW."category"), NEW."created_at");
  RETURN NEW;
END $$;
CREATE TRIGGER "support_tickets_analytics" AFTER INSERT ON "support_tickets"
  FOR EACH ROW EXECUTE FUNCTION "analytics_support_tickets"();

CREATE FUNCTION "analytics_reviews"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "analytics_emit"('review.submitted', 'review.submitted:' || NEW."id", NEW."user_id",
    'review', NEW."id", NULL, NEW."verification" = 'DEMO_BOOKING', NULL, NULL, NULL,
    jsonb_build_object('verification', NEW."verification", 'subjectType', NEW."subject_type"),
    NEW."created_at");
  RETURN NEW;
END $$;
CREATE TRIGGER "reviews_analytics" AFTER INSERT ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION "analytics_reviews"();

-- When event tracking began: reports treat events as complete from here
-- (the retention purge moves it forward when it deletes older events).
INSERT INTO "analytics_events" ("type", "source", "dedupe_key", "occurred_at")
VALUES ('analytics.tracking_started', 'SERVER', 'analytics.tracking_started', now());
