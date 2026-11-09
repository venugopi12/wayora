-- Phase 30: browser push notifications (docs/pwa.md#push).
-- Additive: a delivery channel, a subscriptions table, preference columns.

ALTER TYPE "notification_channel" ADD VALUE IF NOT EXISTS 'PUSH';

-- One row per browser that turned push on while signed in. Tied to the
-- session it was created in: when that session is revoked or expires, the
-- device gets nothing more, and the row goes when the session row is purged.
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    -- The push service URL (it identifies this browser to its push service).
    "endpoint" VARCHAR(2048) NOT NULL,
    -- The browser's public key and auth secret, used to encrypt each message to it.
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_endpoint_https" CHECK ("endpoint" LIKE 'https://%'),
    CONSTRAINT "push_subscriptions_failure_count" CHECK ("failure_count" >= 0)
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");
CREATE INDEX "push_subscriptions_session_id_idx" ON "push_subscriptions"("session_id");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which topics are pushed (devices with push on). Defaults: on.
ALTER TABLE "notification_preferences"
  ADD COLUMN "push_bookings" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_payments" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_reminders" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_support" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_rewards" BOOLEAN NOT NULL DEFAULT true;
