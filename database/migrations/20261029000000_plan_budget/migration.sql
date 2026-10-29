-- Phase 20: trip budget, expenses and group split (docs/planner.md#budget).
-- Additive: five new tables, three enums, seven planner_activity_type
-- values. No existing table or row changes. Rollback SQL is in
-- docs/planner.md#rollback-phase-20.

-- AlterEnum
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'BUDGET_UPDATED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'BUDGET_REMOVED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'EXPENSE_ADDED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'EXPENSE_UPDATED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'EXPENSE_DELETED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'SETTLEMENT_RECORDED';
ALTER TYPE "planner_activity_type" ADD VALUE IF NOT EXISTS 'SETTLEMENT_DELETED';

-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('FLIGHTS', 'HOTELS', 'TRAINS', 'BUSES', 'LOCAL_TRANSPORT', 'FOOD', 'ACTIVITIES', 'SHOPPING', 'OTHER');

-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('PAID', 'PLANNED');

-- CreateEnum
CREATE TYPE "expense_split_method" AS ENUM ('EQUAL', 'CUSTOM', 'PERCENT');

-- CreateTable
CREATE TABLE "plan_budgets" (
    "trip_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_budgets_pkey" PRIMARY KEY ("trip_id")
);

-- CreateTable
CREATE TABLE "plan_category_budgets" (
    "trip_id" UUID NOT NULL,
    "category" "expense_category" NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "plan_category_budgets_pkey" PRIMARY KEY ("trip_id","category")
);

-- CreateTable
CREATE TABLE "plan_expenses" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "description" VARCHAR(120) NOT NULL,
    "category" "expense_category" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "spent_on" DATE NOT NULL,
    "status" "expense_status" NOT NULL,
    "split_method" "expense_split_method",
    "notes" VARCHAR(500),
    "booking_id" UUID,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_expense_parts" (
    "expense_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "paid_minor" BIGINT NOT NULL,
    "share_minor" BIGINT NOT NULL,
    "basis_points" INTEGER,

    CONSTRAINT "plan_expense_parts_pkey" PRIMARY KEY ("expense_id","user_id")
);

-- CreateTable
CREATE TABLE "plan_settlements" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "settled_on" DATE NOT NULL,
    "note" VARCHAR(500),
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_expenses_trip_id_spent_on_id_idx" ON "plan_expenses"("trip_id", "spent_on", "id");

-- CreateIndex
CREATE INDEX "plan_expense_parts_user_id_idx" ON "plan_expense_parts"("user_id");

-- CreateIndex
CREATE INDEX "plan_settlements_trip_id_created_at_idx" ON "plan_settlements"("trip_id", "created_at");

-- AddForeignKey
ALTER TABLE "plan_budgets" ADD CONSTRAINT "plan_budgets_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_category_budgets" ADD CONSTRAINT "plan_category_budgets_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "plan_budgets"("trip_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_expense_parts" ADD CONSTRAINT "plan_expense_parts_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "plan_expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_expense_parts" ADD CONSTRAINT "plan_expense_parts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- Money: positive integer minor units, at most 10,000,000,000.00; ISO codes.
ALTER TABLE "plan_budgets" ADD CONSTRAINT "plan_budgets_amount_chk" CHECK ("total_amount_minor" > 0 AND "total_amount_minor" <= 1000000000000);
ALTER TABLE "plan_budgets" ADD CONSTRAINT "plan_budgets_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "plan_budgets" ADD CONSTRAINT "plan_budgets_version_chk" CHECK ("version" >= 1);
ALTER TABLE "plan_category_budgets" ADD CONSTRAINT "plan_category_budgets_amount_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000);

ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_amount_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000);
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_description_chk" CHECK (length(btrim("description")) > 0);
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_version_chk" CHECK ("version" >= 1);
-- A paid expense says how it was split; a planned one isn't split.
ALTER TABLE "plan_expenses" ADD CONSTRAINT "plan_expenses_split_chk" CHECK (("status" = 'PAID') = ("split_method" IS NOT NULL));

ALTER TABLE "plan_expense_parts" ADD CONSTRAINT "plan_expense_parts_amounts_chk" CHECK ("paid_minor" >= 0 AND "share_minor" >= 0 AND ("paid_minor" > 0 OR "share_minor" > 0));
ALTER TABLE "plan_expense_parts" ADD CONSTRAINT "plan_expense_parts_basis_points_chk" CHECK ("basis_points" IS NULL OR "basis_points" BETWEEN 1 AND 10000);

ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_amount_chk" CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000);
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "plan_settlements" ADD CONSTRAINT "plan_settlements_people_chk" CHECK ("from_user_id" <> "to_user_id");

-- A booking is counted at most once per plan (no double counting).
CREATE UNIQUE INDEX "plan_expenses_one_per_booking" ON "plan_expenses"("trip_id", "booking_id") WHERE "booking_id" IS NOT NULL;

-- Every paid expense's parts add up exactly: what was paid and the shares
-- each equal the amount. A planned expense has no parts. Checked when the
-- transaction commits (constraint triggers, deferred), so an expense and its
-- parts are written together and can never be left half-updated.
CREATE FUNCTION "plan_expense_check"(target UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
  paid NUMERIC;
  shared NUMERIC;
  n INTEGER;
BEGIN
  SELECT "amount_minor", "status" INTO e FROM "plan_expenses" WHERE "id" = target;
  IF NOT FOUND THEN
    RETURN; -- deleted: its parts went with it
  END IF;
  SELECT coalesce(sum("paid_minor"), 0), coalesce(sum("share_minor"), 0), count(*)
    INTO paid, shared, n FROM "plan_expense_parts" WHERE "expense_id" = target;
  IF e."status" = 'PAID' AND (n = 0 OR paid <> e."amount_minor" OR shared <> e."amount_minor") THEN
    RAISE EXCEPTION 'plan_expenses: parts of expense % don''t add up to its amount', target
      USING ERRCODE = 'check_violation';
  END IF;
  IF e."status" = 'PLANNED' AND n > 0 THEN
    RAISE EXCEPTION 'plan_expenses: planned expense % can''t have parts', target
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "plan_expenses_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'plan_expenses' THEN
    PERFORM "plan_expense_check"(NEW."id");
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM "plan_expense_check"(OLD."expense_id"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM "plan_expense_check"(NEW."expense_id"); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "plan_expenses_balanced_check"
AFTER INSERT OR UPDATE ON "plan_expenses"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "plan_expenses_balanced"();

CREATE CONSTRAINT TRIGGER "plan_expense_parts_balanced_check"
AFTER INSERT OR UPDATE OR DELETE ON "plan_expense_parts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "plan_expenses_balanced"();

-- An expense may only come from a booking of the plan's owner.
CREATE FUNCTION "plan_expenses_booking_owner"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."booking_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "bookings" b JOIN "planned_trips" t ON t."user_id" = b."user_id"
     WHERE b."id" = NEW."booking_id" AND t."id" = NEW."trip_id"
  ) THEN
    RAISE EXCEPTION 'plan_expenses: the booking must belong to the plan''s owner'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "plan_expenses_booking_owner_check"
BEFORE INSERT OR UPDATE OF "booking_id", "trip_id" ON "plan_expenses"
FOR EACH ROW EXECUTE FUNCTION "plan_expenses_booking_owner"();
