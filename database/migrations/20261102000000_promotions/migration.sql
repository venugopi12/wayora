-- Phase 26: coupons, automatic promotions and their usage (docs/promotions.md).
-- Additive: three enums and two tables. No existing row changes and no
-- promotions are created: offers exist only when an admin creates them.
-- Rollback SQL is in docs/promotions.md#rollback.

-- CreateEnum
CREATE TYPE "promotion_kind" AS ENUM ('COUPON', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "promotion_discount_type" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "promotion_redemption_status" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED', 'REVERSED');

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "kind" "promotion_kind" NOT NULL,
    "code" VARCHAR(24),
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "terms" VARCHAR(2000) NOT NULL,
    "discount_type" "promotion_discount_type" NOT NULL,
    "percent_bps" INTEGER,
    "amount_minor" BIGINT,
    "max_discount_minor" BIGINT,
    "min_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "categories" "travel_category"[] NOT NULL DEFAULT ARRAY[]::"travel_category"[],
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "usage_limit" INTEGER,
    "per_user_limit" INTEGER,
    "first_booking_only" BOOLEAN NOT NULL DEFAULT false,
    "user_id" UUID,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"),
    -- A coupon has a normalized code; an automatic promotion has none and never stacks.
    CONSTRAINT "promotions_code_by_kind" CHECK (
      ("kind" = 'COUPON' AND "code" ~ '^[A-Z0-9][A-Z0-9-]{2,23}$')
      OR ("kind" = 'AUTOMATIC' AND "code" IS NULL AND "stackable" = false)
    ),
    -- Exactly one way of discounting, with sane values.
    CONSTRAINT "promotions_discount" CHECK (
      ("discount_type" = 'PERCENTAGE' AND "percent_bps" BETWEEN 1 AND 9000 AND "amount_minor" IS NULL
        AND ("max_discount_minor" IS NULL OR "max_discount_minor" > 0))
      OR ("discount_type" = 'FIXED' AND "amount_minor" > 0 AND "percent_bps" IS NULL AND "max_discount_minor" IS NULL)
    ),
    CONSTRAINT "promotions_amounts" CHECK ("min_amount_minor" >= 0 AND "currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "promotions_dates" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "promotions_limits" CHECK (
      ("usage_limit" IS NULL OR "usage_limit" >= 1) AND ("per_user_limit" IS NULL OR "per_user_limit" >= 1)
    ),
    CONSTRAINT "promotions_personal_unlisted" CHECK ("user_id" IS NULL OR "listed" = false)
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "promotion_kind" NOT NULL,
    "status" "promotion_redemption_status" NOT NULL DEFAULT 'RESERVED',
    "code" VARCHAR(24),
    "eligible_amount_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "promotion_version" INTEGER NOT NULL,
    "reserved_until" TIMESTAMPTZ(3) NOT NULL,
    "redeemed_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id"),
    -- A discount is positive and always leaves something to pay.
    CONSTRAINT "promotion_redemptions_amounts" CHECK ("discount_minor" > 0 AND "discount_minor" < "eligible_amount_minor"),
    CONSTRAINT "promotion_redemptions_closed" CHECK (
      ("status" IN ('RESERVED', 'REDEEMED') AND "closed_at" IS NULL)
      OR ("status" IN ('RELEASED', 'REVERSED') AND "closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)
    ),
    CONSTRAINT "promotion_redemptions_redeemed" CHECK ("status" <> 'REDEEMED' OR "redeemed_at" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_kind_active_starts_at_ends_at_idx" ON "promotions"("kind", "active", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "promotions_user_id_idx" ON "promotions"("user_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_status_idx" ON "promotion_redemptions"("promotion_id", "status");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_user_id_status_idx" ON "promotion_redemptions"("promotion_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "promotion_redemptions_booking_id_idx" ON "promotion_redemptions"("booking_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_status_reserved_until_idx" ON "promotion_redemptions"("status", "reserved_until");

-- At most one live coupon and one live automatic promotion per booking.
CREATE UNIQUE INDEX "promotion_redemptions_one_open_per_kind" ON "promotion_redemptions"("booking_id", "kind") WHERE "status" IN ('RESERVED', 'REDEEMED');

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Usage history is kept: redemptions and promotions are never deleted.
CREATE FUNCTION "promotions_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are kept for audit (DELETE blocked)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "promotions_no_delete"
BEFORE DELETE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION "promotions_prevent_delete"();

CREATE TRIGGER "promotion_redemptions_no_delete"
BEFORE DELETE ON "promotion_redemptions"
FOR EACH ROW EXECUTE FUNCTION "promotions_prevent_delete"();

-- A use's facts (which promotion, booking, customer, amounts) never change; only its status does.
CREATE FUNCTION "promotion_redemptions_protect_facts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."promotion_id" IS DISTINCT FROM OLD."promotion_id"
    OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."discount_minor" IS DISTINCT FROM OLD."discount_minor"
    OR NEW."eligible_amount_minor" IS DISTINCT FROM OLD."eligible_amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."promotion_version" IS DISTINCT FROM OLD."promotion_version"
  THEN
    RAISE EXCEPTION 'promotion_redemptions: facts are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed uses stay closed.
  IF OLD."status" IN ('RELEASED', 'REVERSED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'promotion_redemptions: a closed use can''t reopen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotion_redemptions_facts_immutable"
BEFORE UPDATE ON "promotion_redemptions"
FOR EACH ROW EXECUTE FUNCTION "promotion_redemptions_protect_facts"();
