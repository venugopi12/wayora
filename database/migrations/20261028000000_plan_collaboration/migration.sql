-- Phase 19: collaborative trip planning (docs/planner.md#collaboration).
-- Additive: three new tables, four enums, new columns with defaults on
-- planned_trips, itinerary_items and notifications, five notification types.
-- Existing plans stay personal (no members) and keep working unchanged.
-- Rollback SQL is in docs/planner.md#rollback-phase-19.

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PLAN_INVITATION';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PLAN_INVITATION_ACCEPTED';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PLAN_INVITATION_DECLINED';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PLAN_MEMBER_CHANGED';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PLAN_UPDATED';

-- CreateEnum
CREATE TYPE "trip_member_role" AS ENUM ('EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "trip_invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "planner_activity_type" AS ENUM ('TRIP_UPDATED', 'ITEM_ADDED', 'ITEM_UPDATED', 'ITEM_MOVED', 'ITEM_DELETED', 'ITEM_DUPLICATED', 'DAY_REORDERED', 'MEMBER_INVITED', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED', 'INVITATION_REVOKED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED', 'MEMBER_LEFT');

-- AlterTable
ALTER TABLE "planned_trips" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "itinerary_items" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "created_by_id" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "planned_trip_id" UUID,
ADD COLUMN "trip_invitation_id" UUID;

-- CreateTable
CREATE TABLE "trip_members" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "trip_member_role" NOT NULL,
    "invited_by_id" UUID,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_invitations" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "invited_by_id" UUID,
    "role" "trip_member_role" NOT NULL,
    "status" "trip_invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_activities" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor_id" UUID,
    "type" "planner_activity_type" NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_members_user_id_idx" ON "trip_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_members_trip_id_user_id_key" ON "trip_members"("trip_id", "user_id");

-- CreateIndex
CREATE INDEX "trip_invitations_invitee_id_status_idx" ON "trip_invitations"("invitee_id", "status");

-- CreateIndex
CREATE INDEX "trip_invitations_trip_id_status_idx" ON "trip_invitations"("trip_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "planner_activities_trip_id_revision_key" ON "planner_activities"("trip_id", "revision");

-- CreateIndex
CREATE INDEX "notifications_planned_trip_id_idx" ON "notifications"("planned_trip_id");

-- CreateIndex
CREATE INDEX "notifications_trip_invitation_id_idx" ON "notifications"("trip_invitation_id");

-- AddForeignKey
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_planned_trip_id_fkey" FOREIGN KEY ("planned_trip_id") REFERENCES "planned_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_trip_invitation_id_fkey" FOREIGN KEY ("trip_invitation_id") REFERENCES "trip_invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_activities" ADD CONSTRAINT "planner_activities_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_activities" ADD CONSTRAINT "planner_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints and triggers (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "planned_trips" ADD CONSTRAINT "planned_trips_revision_chk" CHECK ("revision" >= 0);
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_version_chk" CHECK ("version" >= 1);
ALTER TABLE "planner_activities" ADD CONSTRAINT "planner_activities_revision_chk" CHECK ("revision" >= 1);
ALTER TABLE "planner_activities" ADD CONSTRAINT "planner_activities_data_chk" CHECK (jsonb_typeof("data") = 'object');

-- An invitation is answered exactly when it was accepted, declined or revoked.
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_responded_chk" CHECK (("status" IN ('ACCEPTED', 'DECLINED', 'REVOKED')) = ("responded_at" IS NOT NULL));
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_expiry_chk" CHECK ("expires_at" > "created_at");

-- At most one open invitation per person and trip.
CREATE UNIQUE INDEX "trip_invitations_one_pending" ON "trip_invitations"("trip_id", "invitee_id") WHERE "status" = 'PENDING';

-- The owner is planned_trips.user_id (exactly one, never null). Members are
-- everyone else: the owner can never also be a member or be invited, so the
-- owner can't be demoted or removed through membership.
CREATE FUNCTION "trip_members_not_owner"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  person UUID;
BEGIN
  IF TG_TABLE_NAME = 'trip_members' THEN
    person := NEW."user_id";
  ELSE
    person := NEW."invitee_id";
  END IF;
  IF EXISTS (SELECT 1 FROM "planned_trips" t WHERE t."id" = NEW."trip_id" AND t."user_id" = person) THEN
    RAISE EXCEPTION 'The trip owner can''t be a member or an invitee of their own trip'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_members_not_owner_check"
BEFORE INSERT OR UPDATE OF "trip_id", "user_id" ON "trip_members"
FOR EACH ROW EXECUTE FUNCTION "trip_members_not_owner"();

CREATE TRIGGER "trip_invitations_not_owner_check"
BEFORE INSERT OR UPDATE OF "trip_id", "invitee_id" ON "trip_invitations"
FOR EACH ROW EXECUTE FUNCTION "trip_members_not_owner"();

-- Ownership is fixed: a plan's owner can't be changed (no transfer yet), so
-- no update can hand a plan to someone else or leave a member as its owner.
CREATE FUNCTION "planned_trips_owner_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'planned_trips: the owner can''t change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "planned_trips_owner_fixed_check"
BEFORE UPDATE OF "user_id" ON "planned_trips"
FOR EACH ROW EXECUTE FUNCTION "planned_trips_owner_fixed"();

-- Activity history is append-only. Only actor_id may change (to NULL, when
-- that account is deleted); rows go away only with their trip.
CREATE FUNCTION "planner_activities_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."data" IS DISTINCT FROM OLD."data"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (NEW."actor_id" IS NOT NULL AND NEW."actor_id" IS DISTINCT FROM OLD."actor_id") THEN
    RAISE EXCEPTION 'planner_activities: history can''t be rewritten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "planner_activities_immutable"
BEFORE UPDATE ON "planner_activities"
FOR EACH ROW EXECUTE FUNCTION "planner_activities_append_only"();

-- Realtime: each change is announced on commit (ids only) to the API
-- instances listening; browsers re-read through the authorized endpoints.
CREATE FUNCTION "planner_activities_announce"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('wayora_planner_activity', json_build_object('tripId', NEW."trip_id", 'seq', NEW."revision")::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "planner_activities_announce"
AFTER INSERT ON "planner_activities"
FOR EACH ROW EXECUTE FUNCTION "planner_activities_announce"();
