-- Phase 25: loyalty points, tiers and travel credits (docs/rewards.md).
-- Additive: five enums, one notification type, six new tables, the first
-- rule version, and triggers that keep the ledger append-only. No existing
-- row changes. Rollback SQL is in docs/rewards.md#rollback.

-- AlterEnum: rewards notifications (in-app only).
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'REWARDS';

-- CreateEnum
CREATE TYPE "reward_transaction_type" AS ENUM ('POINTS_EARNED', 'POINTS_REDEEMED', 'POINTS_RESTORED', 'POINTS_REVERSED', 'POINTS_EXPIRED', 'POINTS_ADJUSTED', 'CREDIT_ISSUED', 'CREDIT_REDEEMED', 'CREDIT_RESTORED', 'CREDIT_EXPIRED', 'CREDIT_REVOKED');

-- CreateEnum
CREATE TYPE "reward_origin" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "travel_credit_status" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "travel_credit_reason" AS ENUM ('PROMOTION', 'SUPPORT_COMPENSATION', 'BOOKING_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "reward_redemption_status" AS ENUM ('APPLIED', 'CONSUMED', 'RELEASED', 'RESTORED');

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "points_balance" BIGINT NOT NULL DEFAULT 0,
    "tier" VARCHAR(32) NOT NULL DEFAULT 'explorer',
    "tier_qualified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id"),
    -- Spending more than the balance is impossible, whatever the code does.
    CONSTRAINT "loyalty_accounts_balance_not_negative" CHECK ("points_balance" >= 0)
);

-- CreateTable
CREATE TABLE "loyalty_rule_versions" (
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_id" UUID,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_rule_versions_pkey" PRIMARY KEY ("version"),
    CONSTRAINT "loyalty_rule_versions_positive" CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "reward_transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "user_id" UUID NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "type" "reward_transaction_type" NOT NULL,
    "origin" "reward_origin" NOT NULL,
    "points" BIGINT NOT NULL DEFAULT 0,
    "qualifying_points" BIGINT NOT NULL DEFAULT 0,
    "balance_after" BIGINT,
    "amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3),
    "credit_id" UUID,
    "booking_id" UUID,
    "redemption_id" UUID,
    "rule_version" INTEGER,
    "description" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(500),
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" UUID,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_transactions_pkey" PRIMARY KEY ("id"),
    -- The sign of each change follows its type.
    CONSTRAINT "reward_transactions_points_sign" CHECK (
      CASE "type"
        WHEN 'POINTS_EARNED' THEN "points" >= 0 AND "account_id" IS NOT NULL
        WHEN 'POINTS_RESTORED' THEN "points" > 0 AND "account_id" IS NOT NULL
        WHEN 'POINTS_REDEEMED' THEN "points" < 0 AND "account_id" IS NOT NULL
        WHEN 'POINTS_REVERSED' THEN "points" <= 0 AND "account_id" IS NOT NULL
        WHEN 'POINTS_EXPIRED' THEN "points" < 0 AND "account_id" IS NOT NULL
        WHEN 'POINTS_ADJUSTED' THEN "points" <> 0 AND "account_id" IS NOT NULL
        ELSE "points" = 0
      END
    ),
    CONSTRAINT "reward_transactions_credit_sign" CHECK (
      CASE "type"
        WHEN 'CREDIT_ISSUED' THEN "amount_minor" > 0 AND "credit_id" IS NOT NULL AND "currency" IS NOT NULL
        WHEN 'CREDIT_RESTORED' THEN "amount_minor" > 0 AND "credit_id" IS NOT NULL AND "currency" IS NOT NULL
        WHEN 'CREDIT_REDEEMED' THEN "amount_minor" < 0 AND "credit_id" IS NOT NULL AND "currency" IS NOT NULL
        WHEN 'CREDIT_EXPIRED' THEN "amount_minor" < 0 AND "credit_id" IS NOT NULL AND "currency" IS NOT NULL
        WHEN 'CREDIT_REVOKED' THEN "amount_minor" <= 0 AND "credit_id" IS NOT NULL AND "currency" IS NOT NULL
        ELSE "amount_minor" = 0
      END
    ),
    -- Manual rows always say why.
    CONSTRAINT "reward_transactions_manual_reason" CHECK ("origin" <> 'MANUAL' OR ("reason" IS NOT NULL AND "actor_id" IS NOT NULL)),
    CONSTRAINT "reward_transactions_balance_after" CHECK ("balance_after" IS NULL OR "balance_after" >= 0)
);

-- CreateTable
CREATE TABLE "loyalty_point_lots" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "remaining" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "expiry_notice_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_point_lots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_point_lots_remaining" CHECK ("points" > 0 AND "remaining" >= 0 AND "remaining" <= "points")
);

-- CreateTable
CREATE TABLE "travel_credits" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "original_amount_minor" BIGINT NOT NULL,
    "remaining_amount_minor" BIGINT NOT NULL,
    "reason" "travel_credit_reason" NOT NULL,
    "note" VARCHAR(255) NOT NULL,
    "status" "travel_credit_status" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "booking_id" UUID,
    "campaign" VARCHAR(80),
    "issued_by_id" UUID,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "expiry_notice_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "travel_credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "travel_credits_amounts" CHECK ("original_amount_minor" > 0 AND "remaining_amount_minor" >= 0 AND "remaining_amount_minor" <= "original_amount_minor"),
    CONSTRAINT "travel_credits_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- A used-up credit has nothing left; an active one has something.
    CONSTRAINT "travel_credits_status_amount" CHECK (
      ("status" = 'ACTIVE' AND "remaining_amount_minor" > 0)
      OR ("status" = 'USED' AND "remaining_amount_minor" = 0)
      OR "status" IN ('EXPIRED', 'REVOKED')
    )
);

-- CreateTable
CREATE TABLE "reward_redemptions" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "payment_mode" NOT NULL,
    "status" "reward_redemption_status" NOT NULL DEFAULT 'APPLIED',
    "currency" CHAR(3) NOT NULL,
    "points" BIGINT NOT NULL,
    "points_amount_minor" BIGINT NOT NULL,
    "credit_amount_minor" BIGINT NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "allocations" JSONB NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reward_redemptions_amounts" CHECK (
      "points" >= 0 AND "points_amount_minor" >= 0 AND "credit_amount_minor" >= 0
      AND "total_amount_minor" = "points_amount_minor" + "credit_amount_minor"
      AND "total_amount_minor" > 0
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_user_id_mode_key" ON "loyalty_accounts"("user_id", "mode");

-- CreateIndex
CREATE INDEX "loyalty_rule_versions_effective_from_idx" ON "loyalty_rule_versions"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "reward_transactions_idempotency_key_key" ON "reward_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "reward_transactions_user_id_mode_created_at_idx" ON "reward_transactions"("user_id", "mode", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reward_transactions_booking_id_idx" ON "reward_transactions"("booking_id");

-- CreateIndex
CREATE INDEX "reward_transactions_credit_id_idx" ON "reward_transactions"("credit_id");

-- CreateIndex
CREATE INDEX "reward_transactions_type_created_at_idx" ON "reward_transactions"("type", "created_at");

-- CreateIndex
CREATE INDEX "reward_transactions_origin_created_at_idx" ON "reward_transactions"("origin", "created_at");

-- CreateIndex
CREATE INDEX "reward_transactions_created_at_idx" ON "reward_transactions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_point_lots_transaction_id_key" ON "loyalty_point_lots"("transaction_id");

-- CreateIndex
CREATE INDEX "loyalty_point_lots_account_id_expires_at_idx" ON "loyalty_point_lots"("account_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "travel_credits_reference_key" ON "travel_credits"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "travel_credits_idempotency_key_key" ON "travel_credits"("idempotency_key");

-- CreateIndex
CREATE INDEX "travel_credits_user_id_mode_status_expires_at_idx" ON "travel_credits"("user_id", "mode", "status", "expires_at");

-- CreateIndex
CREATE INDEX "travel_credits_status_expires_at_idx" ON "travel_credits"("status", "expires_at");

-- CreateIndex
CREATE INDEX "reward_redemptions_booking_id_idx" ON "reward_redemptions"("booking_id");

-- CreateIndex
CREATE INDEX "reward_redemptions_status_updated_at_idx" ON "reward_redemptions"("status", "updated_at");

-- At most one live redemption per booking (two checkouts can't both spend).
CREATE UNIQUE INDEX "reward_redemptions_one_open_per_booking" ON "reward_redemptions"("booking_id") WHERE "status" IN ('APPLIED', 'CONSUMED');

-- Points are earned on a booking at most once, and taken back at most once.
CREATE UNIQUE INDEX "reward_transactions_one_earn_per_booking" ON "reward_transactions"("booking_id") WHERE "type" = 'POINTS_EARNED';
CREATE UNIQUE INDEX "reward_transactions_one_reversal_per_booking" ON "reward_transactions"("booking_id") WHERE "type" = 'POINTS_REVERSED';

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "travel_credits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_redemption_id_fkey" FOREIGN KEY ("redemption_id") REFERENCES "reward_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_rule_version_fkey" FOREIGN KEY ("rule_version") REFERENCES "loyalty_rule_versions"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_point_lots" ADD CONSTRAINT "loyalty_point_lots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_point_lots" ADD CONSTRAINT "loyalty_point_lots_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "reward_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_rule_version_fkey" FOREIGN KEY ("rule_version") REFERENCES "loyalty_rule_versions"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ledger is append-only: corrections are new rows, never edits.
CREATE FUNCTION "reward_transactions_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reward_transactions is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "reward_transactions_append_only"
BEFORE UPDATE OR DELETE ON "reward_transactions"
FOR EACH ROW EXECUTE FUNCTION "reward_transactions_prevent_mutation"();

-- Rule versions are history: a change is a new version.
CREATE FUNCTION "loyalty_rule_versions_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loyalty_rule_versions is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "loyalty_rule_versions_append_only"
BEFORE UPDATE OR DELETE ON "loyalty_rule_versions"
FOR EACH ROW EXECUTE FUNCTION "loyalty_rule_versions_prevent_mutation"();

-- Credits keep their facts (who, how much, why, which currency) for audit; only the
-- remaining amount, status and notice time change. They are never deleted.
CREATE FUNCTION "travel_credits_protect_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'travel_credits are kept for audit (DELETE blocked)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."original_amount_minor" IS DISTINCT FROM OLD."original_amount_minor"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
    OR NEW."issued_by_id" IS DISTINCT FROM OLD."issued_by_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
  THEN
    RAISE EXCEPTION 'travel_credits: issue facts are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "travel_credits_facts_immutable"
BEFORE UPDATE OR DELETE ON "travel_credits"
FOR EACH ROW EXECUTE FUNCTION "travel_credits_protect_facts"();

-- Version 1 of the rules (DEFAULT_LOYALTY_RULES in @wayora/contracts).
INSERT INTO "loyalty_rule_versions" ("version", "config", "reason", "created_by_id", "effective_from")
VALUES (1, '{"earn":{"spendMinorPerPoint":{"INR":"1000"},"categoryMultiplierBps":{"flights":10000,"hotels":10000,"trains":10000,"buses":10000,"metro":10000,"cabs":10000,"holidays":10000},"campaigns":[],"availableAfterDays":1,"expiryMonths":24},"redeem":{"pointValueMinor":{"INR":"25"},"minPoints":200,"maxPointsPerBooking":20000,"maxPointsCoverageBps":5000,"minCashMinor":{"INR":"100"},"categories":["flights","hotels","trains","buses","holidays"]},"tiers":[{"id":"explorer","name":"Explorer","minQualifyingPoints":0,"earnMultiplierBps":10000},{"id":"silver","name":"Silver","minQualifyingPoints":2000,"earnMultiplierBps":12500},{"id":"gold","name":"Gold","minQualifyingPoints":6000,"earnMultiplierBps":15000},{"id":"platinum","name":"Platinum","minQualifyingPoints":15000,"earnMultiplierBps":20000}],"qualificationMonths":12}'::jsonb, 'Initial rules shipped with Phase 25.', NULL, '2026-01-01T00:00:00Z');
