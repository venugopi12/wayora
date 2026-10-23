-- Phase 15: admin roles, search analytics events, admin list indexes
-- (docs/admin.md#database). Additive: every existing user becomes USER.
-- Rollback SQL is in docs/admin.md#rollback.

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('USER', 'SUPPORT', 'ADMIN');

-- CreateEnum
CREATE TYPE "search_outcome" AS ENUM ('SUCCESS', 'PARTIAL', 'EMPTY', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "search_events" (
    "id" UUID NOT NULL,
    "category" "travel_category" NOT NULL,
    "outcome" "search_outcome" NOT NULL,
    "search_id" UUID,
    "result_count" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "error_code" VARCHAR(64),
    "providers" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "bookings_created_at_idx" ON "bookings"("created_at" DESC);

-- CreateIndex
CREATE INDEX "bookings_search_id_idx" ON "bookings"("search_id");

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "search_events_created_at_idx" ON "search_events"("created_at");

-- CreateIndex
CREATE INDEX "search_events_category_created_at_idx" ON "search_events"("category", "created_at");

-- CreateIndex
CREATE INDEX "search_events_search_id_idx" ON "search_events"("search_id");

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "search_events" ADD CONSTRAINT "search_events_counts_chk" CHECK ("result_count" >= 0 AND "duration_ms" >= 0);
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_providers_chk" CHECK (jsonb_typeof("providers") = 'array');
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_outcome_chk" CHECK (("outcome" = 'FAILED') = ("error_code" IS NOT NULL));

-- Every role change is audited by the database itself, whatever changed it
-- (the provisioning script, or SQL run by hand). The script names itself and
-- the reason with SET LOCAL wayora.actor_id / wayora.reason.
CREATE FUNCTION "users_audit_role_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "audit_logs" ("id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "metadata", "created_at")
  VALUES (
    gen_random_uuid(),
    'ADMIN',
    NULLIF(current_setting('wayora.actor_id', true), ''),
    'user.role_changed',
    'user',
    NEW."id"::text,
    jsonb_build_object(
      'from', OLD."role",
      'to', NEW."role",
      'reason', NULLIF(current_setting('wayora.reason', true), '')
    ),
    CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_role_change_audited"
AFTER UPDATE OF "role" ON "users"
FOR EACH ROW WHEN (OLD."role" IS DISTINCT FROM NEW."role")
EXECUTE FUNCTION "users_audit_role_change"();
