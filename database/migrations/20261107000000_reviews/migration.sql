-- Phase 28: reviews, ratings and travel feedback (docs/reviews.md).
-- Additive: new enums, tables and triggers, and one new notification type.
-- No existing data changes.

-- ─── Notification type ────────────────────────────────────────────────────

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REVIEW';

-- ─── Enums ───────────────────────────────────────────────────────────────

CREATE TYPE "review_subject_type" AS ENUM ('HOTEL', 'HOLIDAY_PACKAGE', 'DESTINATION');
CREATE TYPE "review_status" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'FLAGGED', 'REMOVED');
CREATE TYPE "review_verification" AS ENUM ('VERIFIED_BOOKING', 'DEMO_BOOKING', 'UNVERIFIED');
CREATE TYPE "review_event_kind" AS ENUM ('SUBMITTED', 'EDITED', 'MODERATED', 'REPORTS_DISMISSED');
CREATE TYPE "review_actor_kind" AS ENUM ('AUTHOR', 'STAFF', 'SYSTEM');
CREATE TYPE "review_report_reason" AS ENUM (
  'SPAM', 'FAKE_EXPERIENCE', 'OFFENSIVE', 'PERSONAL_INFORMATION', 'HARASSMENT',
  'IRRELEVANT', 'CONFLICT_OF_INTEREST', 'OTHER'
);
CREATE TYPE "review_report_status" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- ─── Reviews ─────────────────────────────────────────────────────────────

CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject_type" "review_subject_type" NOT NULL,
    -- `<providerId>:<ref>` for hotels and packages; a destination slug.
    "subject_key" VARCHAR(160) NOT NULL,
    -- The property, package or destination name when the review was written.
    "subject_name" VARCHAR(200) NOT NULL,
    "booking_id" UUID,
    "verification" "review_verification" NOT NULL,
    "status" "review_status" NOT NULL DEFAULT 'PENDING',
    "rating" SMALLINT NOT NULL,
    "cleanliness" SMALLINT,
    "location" SMALLINT,
    "service" SMALLINT,
    "comfort" SMALLINT,
    "value" SMALLINT,
    "experience" SMALLINT,
    "organisation" SMALLINT,
    "title" VARCHAR(100) NOT NULL,
    "body" TEXT NOT NULL,
    "travel_from" DATE,
    "travel_to" DATE,
    "visited_month" DATE,
    -- Bumped by every edit and moderation decision (stale changes are refused).
    "revision" INTEGER NOT NULL DEFAULT 1,
    -- Content version: bumped only by the author's edits.
    "version" INTEGER NOT NULL DEFAULT 1,
    "moderation_note" VARCHAR(300),
    "published_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reviews_rating" CHECK ("rating" BETWEEN 1 AND 5),
    CONSTRAINT "reviews_aspect_range" CHECK (
      ("cleanliness" IS NULL OR "cleanliness" BETWEEN 1 AND 5)
      AND ("location" IS NULL OR "location" BETWEEN 1 AND 5)
      AND ("service" IS NULL OR "service" BETWEEN 1 AND 5)
      AND ("comfort" IS NULL OR "comfort" BETWEEN 1 AND 5)
      AND ("value" IS NULL OR "value" BETWEEN 1 AND 5)
      AND ("experience" IS NULL OR "experience" BETWEEN 1 AND 5)
      AND ("organisation" IS NULL OR "organisation" BETWEEN 1 AND 5)
    ),
    -- Each subject type takes only its own aspects (mirrors ASPECTS_FOR).
    CONSTRAINT "reviews_aspects_by_subject" CHECK (
      CASE "subject_type"
        WHEN 'HOTEL' THEN "experience" IS NULL AND "organisation" IS NULL
        WHEN 'HOLIDAY_PACKAGE' THEN "cleanliness" IS NULL AND "location" IS NULL
          AND "service" IS NULL AND "comfort" IS NULL
        ELSE "cleanliness" IS NULL AND "location" IS NULL AND "service" IS NULL
          AND "comfort" IS NULL AND "value" IS NULL AND "experience" IS NULL
          AND "organisation" IS NULL
      END
    ),
    -- Hotels and packages come from a booking; destinations never do, and
    -- only a booking review can be verified or demo-booking.
    CONSTRAINT "reviews_booking_by_subject" CHECK (
      ("subject_type" = 'DESTINATION') = ("booking_id" IS NULL)
    ),
    CONSTRAINT "reviews_verification" CHECK (
      ("verification" = 'UNVERIFIED') = ("booking_id" IS NULL)
    ),
    CONSTRAINT "reviews_dates" CHECK (
      ("booking_id" IS NULL OR "travel_from" IS NOT NULL)
      AND ("travel_to" IS NULL OR "travel_to" >= "travel_from")
      AND ("visited_month" IS NULL OR ("booking_id" IS NULL AND EXTRACT(DAY FROM "visited_month") = 1))
    ),
    CONSTRAINT "reviews_text" CHECK (
      char_length("title") BETWEEN 4 AND 100 AND char_length("body") BETWEEN 30 AND 3000
    ),
    CONSTRAINT "reviews_published" CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL),
    CONSTRAINT "reviews_counters" CHECK ("revision" >= 1 AND "version" >= 1 AND "version" <= "revision")
);

-- One review per booking; one destination feedback per customer per destination.
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id") WHERE "booking_id" IS NOT NULL;
CREATE UNIQUE INDEX "reviews_one_feedback_per_subject" ON "reviews"("user_id", "subject_type", "subject_key")
  WHERE "booking_id" IS NULL;
CREATE INDEX "reviews_subject_type_subject_key_status_idx" ON "reviews"("subject_type", "subject_key", "status");
CREATE INDEX "reviews_status_created_at_idx" ON "reviews"("status", "created_at");
CREATE INDEX "reviews_user_id_created_at_idx" ON "reviews"("user_id", "created_at" DESC);
CREATE INDEX "reviews_created_at_idx" ON "reviews"("created_at");

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Revisions (every version the author wrote) ──────────────────────────

CREATE TABLE "review_revisions" (
    "review_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "rating" SMALLINT NOT NULL,
    "aspects" JSONB NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_revisions_pkey" PRIMARY KEY ("review_id", "version"),
    CONSTRAINT "review_revisions_rating" CHECK ("rating" BETWEEN 1 AND 5)
);
ALTER TABLE "review_revisions" ADD CONSTRAINT "review_revisions_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── History (submissions, edits, moderation) ────────────────────────────

CREATE TABLE "review_events" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "kind" "review_event_kind" NOT NULL,
    "actor_kind" "review_actor_kind" NOT NULL,
    "actor_id" UUID,
    "from_status" "review_status",
    "to_status" "review_status",
    "reason" VARCHAR(300),
    "revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_events_actor" CHECK (("actor_kind" = 'SYSTEM') = ("actor_id" IS NULL)),
    -- Moderation decisions are staff decisions with a recorded outcome.
    CONSTRAINT "review_events_moderated" CHECK (
      "kind" <> 'MODERATED' OR ("actor_kind" = 'STAFF' AND "to_status" IS NOT NULL)
    )
);
CREATE INDEX "review_events_review_id_created_at_idx" ON "review_events"("review_id", "created_at");
CREATE INDEX "review_events_kind_created_at_idx" ON "review_events"("kind", "created_at");
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Reports ─────────────────────────────────────────────────────────────

CREATE TABLE "review_reports" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" "review_report_reason" NOT NULL,
    "details" VARCHAR(500),
    "status" "review_report_status" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_reports_resolved" CHECK (("status" = 'OPEN') = ("resolved_at" IS NULL))
);
-- One report per customer per review.
CREATE UNIQUE INDEX "review_reports_review_id_reporter_id_key" ON "review_reports"("review_id", "reporter_id");
CREATE INDEX "review_reports_status_created_at_idx" ON "review_reports"("status", "created_at");
CREATE INDEX "review_reports_reporter_id_created_at_idx" ON "review_reports"("reporter_id", "created_at");
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reporter_id_fkey"
  FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Helpful votes ───────────────────────────────────────────────────────

CREATE TABLE "review_votes" (
    "review_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("review_id", "user_id")
);
CREATE INDEX "review_votes_user_id_created_at_idx" ON "review_votes"("user_id", "created_at");
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity triggers ──────────────────────────────────────────────────

-- Reviews, revisions, history and reports are never deleted.
CREATE FUNCTION "reviews_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are kept for audit (DELETE blocked)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "reviews_no_delete" BEFORE DELETE ON "reviews"
FOR EACH ROW EXECUTE FUNCTION "reviews_prevent_delete"();
CREATE TRIGGER "review_reports_no_delete" BEFORE DELETE ON "review_reports"
FOR EACH ROW EXECUTE FUNCTION "reviews_prevent_delete"();

-- Revisions and history are append-only.
CREATE FUNCTION "reviews_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "review_revisions_append_only" BEFORE UPDATE OR DELETE ON "review_revisions"
FOR EACH ROW EXECUTE FUNCTION "reviews_append_only"();
CREATE TRIGGER "review_events_append_only" BEFORE UPDATE OR DELETE ON "review_events"
FOR EACH ROW EXECUTE FUNCTION "reviews_append_only"();

-- Who wrote it, about what, from which booking and how it's verified never
-- change; status changes follow the lifecycle (mirrors MODERATION_FROM and
-- the author's edits in packages/contracts/src/reviews.ts); removal is final;
-- revisions only go up.
CREATE FUNCTION "reviews_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."user_id" <> OLD."user_id"
     OR NEW."subject_type" <> OLD."subject_type" OR NEW."subject_key" <> OLD."subject_key"
     OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
     OR NEW."verification" <> OLD."verification"
     OR NEW."travel_from" IS DISTINCT FROM OLD."travel_from"
     OR NEW."travel_to" IS DISTINCT FROM OLD."travel_to"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'reviews: authorship, subject, booking and verification are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."revision" < OLD."revision" OR NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'reviews: revisions only go up' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'REMOVED' AND (NEW."status" <> 'REMOVED' OR NEW."version" <> OLD."version") THEN
    RAISE EXCEPTION 'reviews: a removed review is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('PUBLISHED', 'REJECTED', 'FLAGGED', 'REMOVED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('FLAGGED', 'REMOVED', 'PENDING'))
    OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('PUBLISHED', 'REMOVED', 'PENDING'))
    OR (OLD."status" = 'FLAGGED' AND NEW."status" IN ('PUBLISHED', 'REJECTED', 'REMOVED'))
  ) THEN
    RAISE EXCEPTION 'reviews: % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A new content version always goes back to moderation.
  IF NEW."version" <> OLD."version" AND NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'reviews: an edited review must be moderated again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "reviews_guard" BEFORE UPDATE ON "reviews"
FOR EACH ROW EXECUTE FUNCTION "reviews_guard"();

-- A report's facts never change; it is resolved once.
CREATE FUNCTION "review_reports_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."review_id" <> OLD."review_id"
     OR NEW."reporter_id" <> OLD."reporter_id" OR NEW."reason" <> OLD."reason"
     OR NEW."details" IS DISTINCT FROM OLD."details" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'review_reports: report facts are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'review_reports: a resolved report is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "review_reports_guard" BEFORE UPDATE ON "review_reports"
FOR EACH ROW EXECUTE FUNCTION "review_reports_guard"();
