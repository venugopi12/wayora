-- Phase 14: notifications (docs/notifications.md#database).
--
-- Additive: three new tables, no change to existing rows. Rollback SQL is in
-- docs/notifications.md#migration.

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_EXPIRED', 'PAYMENT_PENDING', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'TRAVEL_REMINDER');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "notification_delivery_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "is_demo" BOOLEAN NOT NULL,
    "booking_id" UUID,
    "payment_id" UUID,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "status" "notification_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" VARCHAR(255),
    "provider_message_id" VARCHAR(255),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "email_bookings" BOOLEAN NOT NULL DEFAULT true,
    "email_payments" BOOLEAN NOT NULL DEFAULT true,
    "email_reminders" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- Unread counts per user stay cheap however many notifications are read.
CREATE INDEX "notifications_unread_by_user" ON "notifications"("user_id") WHERE "read_at" IS NULL;
-- The worker's queue: pending deliveries in due order.
CREATE INDEX "notification_deliveries_due" ON "notification_deliveries"("next_attempt_at") WHERE "status" = 'PENDING';

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_title_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_chk" CHECK (length(btrim("message")) > 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_read_at_chk" CHECK ("read_at" IS NULL OR "read_at" >= "created_at");
-- A payment notification always names its booking too.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_payment_booking_chk" CHECK ("payment_id" IS NULL OR "booking_id" IS NOT NULL);

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_chk" CHECK ("attempts" >= 0);
-- "Sent" only with a send time; never sent without being marked so.
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_chk" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));

-- What a notification says, and to whom, never changes; only read_at does.
CREATE FUNCTION "notifications_protect_content"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."message" IS DISTINCT FROM OLD."message"
    OR NEW."is_demo" IS DISTINCT FROM OLD."is_demo"
    OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
    OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'notifications: only read_at can change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "notifications_content_immutable"
BEFORE UPDATE ON "notifications"
FOR EACH ROW EXECUTE FUNCTION "notifications_protect_content"();
