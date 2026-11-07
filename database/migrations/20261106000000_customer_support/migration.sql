-- Phase 27: customer support tickets, conversations and history (docs/support.md).
-- Additive: new enums, tables and triggers; two new notification types and a
-- nullable notifications.support_ticket_id column. No existing data changes.

-- ─── Notification types ───────────────────────────────────────────────────

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'SUPPORT_TICKET';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'SUPPORT_QUEUE';

-- ─── Enums ───────────────────────────────────────────────────────────────

CREATE TYPE "support_ticket_status" AS ENUM (
  'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_PROVIDER', 'RESOLVED', 'CLOSED'
);
CREATE TYPE "support_ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "support_ticket_category" AS ENUM (
  'BOOKING', 'PAYMENT', 'CANCELLATION', 'REFUND', 'FLIGHT', 'HOTEL', 'TRAIN_BUS',
  'REWARDS', 'PROMOTIONS', 'ACCOUNT', 'TECHNICAL', 'GENERAL'
);
CREATE TYPE "support_author_kind" AS ENUM ('CUSTOMER', 'AGENT', 'SYSTEM');
CREATE TYPE "support_event_type" AS ENUM (
  'CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'CATEGORY_CHANGED', 'ASSIGNED',
  'UNASSIGNED', 'ESCALATED', 'DE_ESCALATED', 'CUSTOMER_MESSAGE', 'AGENT_REPLY', 'INTERNAL_NOTE',
  'SYSTEM_MESSAGE'
);

-- ─── Tickets ─────────────────────────────────────────────────────────────

CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "user_id" UUID NOT NULL,
    "booking_id" UUID,
    "category" "support_ticket_category" NOT NULL,
    "priority" "support_ticket_priority" NOT NULL DEFAULT 'NORMAL',
    "status" "support_ticket_status" NOT NULL DEFAULT 'OPEN',
    "subject" VARCHAR(120) NOT NULL,
    "booking_context" JSONB,
    "assignee_id" UUID,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalated_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "customer_read_seq" INTEGER NOT NULL DEFAULT 0,
    "staff_read_seq" INTEGER NOT NULL DEFAULT 0,
    "last_customer_message_at" TIMESTAMPTZ(3),
    "last_agent_reply_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "first_response_due_at" TIMESTAMPTZ(3) NOT NULL,
    "resolution_due_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "client_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_reference_format" CHECK ("reference" ~ '^WYS-[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$'),
    CONSTRAINT "support_tickets_subject" CHECK (char_length("subject") BETWEEN 5 AND 120),
    CONSTRAINT "support_tickets_counters" CHECK (
      "revision" >= 0 AND "customer_read_seq" >= 0 AND "staff_read_seq" >= 0
      AND "customer_read_seq" <= "revision" AND "staff_read_seq" <= "revision" AND "reopen_count" >= 0
    ),
    CONSTRAINT "support_tickets_closed" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL)),
    CONSTRAINT "support_tickets_resolved" CHECK ("status" <> 'RESOLVED' OR "resolved_at" IS NOT NULL),
    CONSTRAINT "support_tickets_escalated" CHECK ("escalated" = ("escalated_at" IS NOT NULL)),
    CONSTRAINT "support_tickets_targets" CHECK ("resolution_due_at" >= "first_response_due_at")
);

CREATE UNIQUE INDEX "support_tickets_reference_key" ON "support_tickets"("reference");
CREATE UNIQUE INDEX "support_tickets_user_id_client_key_key" ON "support_tickets"("user_id", "client_key");
CREATE INDEX "support_tickets_user_id_updated_at_idx" ON "support_tickets"("user_id", "updated_at" DESC);
CREATE INDEX "support_tickets_booking_id_idx" ON "support_tickets"("booking_id");
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets"("status", "priority");
CREATE INDEX "support_tickets_assignee_id_status_idx" ON "support_tickets"("assignee_id", "status");
CREATE INDEX "support_tickets_escalated_status_idx" ON "support_tickets"("escalated", "status");
CREATE INDEX "support_tickets_status_resolution_due_at_idx" ON "support_tickets"("status", "resolution_due_at");
CREATE INDEX "support_tickets_created_at_idx" ON "support_tickets"("created_at");
CREATE INDEX "support_tickets_updated_at_idx" ON "support_tickets"("updated_at" DESC);

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Messages ────────────────────────────────────────────────────────────

CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "author_kind" "support_author_kind" NOT NULL,
    "author_id" UUID,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "ai_assisted" BOOLEAN NOT NULL DEFAULT false,
    "client_key" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_messages_body" CHECK (char_length("body") BETWEEN 1 AND 5000),
    CONSTRAINT "support_messages_seq" CHECK ("seq" > 0),
    CONSTRAINT "support_messages_author" CHECK (("author_kind" = 'SYSTEM') = ("author_id" IS NULL)),
    -- Internal notes are written by staff only; AI-assisted marks staff replies only.
    CONSTRAINT "support_messages_internal" CHECK (NOT "internal" OR "author_kind" = 'AGENT'),
    CONSTRAINT "support_messages_ai" CHECK (NOT "ai_assisted" OR ("author_kind" = 'AGENT' AND NOT "internal"))
);

CREATE UNIQUE INDEX "support_messages_ticket_id_seq_key" ON "support_messages"("ticket_id", "seq");
CREATE UNIQUE INDEX "support_messages_ticket_id_author_id_client_key_key" ON "support_messages"("ticket_id", "author_id", "client_key");
CREATE INDEX "support_messages_author_id_idx" ON "support_messages"("author_id");

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── History ─────────────────────────────────────────────────────────────

CREATE TABLE "support_ticket_events" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "support_event_type" NOT NULL,
    "actor_kind" "support_author_kind" NOT NULL,
    "actor_id" UUID,
    "from_value" VARCHAR(40),
    "to_value" VARCHAR(40),
    "reason" VARCHAR(300),
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_ticket_events_seq" CHECK ("seq" > 0),
    CONSTRAINT "support_ticket_events_actor" CHECK (("actor_kind" = 'SYSTEM') = ("actor_id" IS NULL))
);

CREATE UNIQUE INDEX "support_ticket_events_ticket_id_seq_key" ON "support_ticket_events"("ticket_id", "seq");
CREATE INDEX "support_ticket_events_type_created_at_idx" ON "support_ticket_events"("type", "created_at");

ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Notifications link ──────────────────────────────────────────────────

ALTER TABLE "notifications" ADD COLUMN "support_ticket_id" UUID;
CREATE INDEX "notifications_support_ticket_id_idx" ON "notifications"("support_ticket_id");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_support_ticket_id_fkey" FOREIGN KEY ("support_ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Guards ──────────────────────────────────────────────────────────────

-- Tickets, messages and history are kept: no deletes.
CREATE FUNCTION "support_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are kept for audit (DELETE blocked)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "support_tickets_no_delete" BEFORE DELETE ON "support_tickets"
FOR EACH ROW EXECUTE FUNCTION "support_prevent_delete"();

-- Messages and history are append-only.
CREATE FUNCTION "support_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "support_messages_append_only" BEFORE UPDATE OR DELETE ON "support_messages"
FOR EACH ROW EXECUTE FUNCTION "support_append_only"();
CREATE TRIGGER "support_ticket_events_append_only" BEFORE UPDATE OR DELETE ON "support_ticket_events"
FOR EACH ROW EXECUTE FUNCTION "support_append_only"();

-- Status changes follow the lifecycle (mirrors SUPPORT_TRANSITIONS in
-- packages/contracts/src/support.ts); a closed ticket is final; the owner,
-- reference and opening facts never change; revisions only go up.
CREATE FUNCTION "support_tickets_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."reference" <> OLD."reference" OR NEW."user_id" <> OLD."user_id"
     OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
     OR NEW."booking_context" IS DISTINCT FROM OLD."booking_context"
     OR NEW."client_key" <> OLD."client_key" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'support_tickets: opening facts are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'support_tickets: revision can''t go back'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'OPEN' AND NEW."status" IN ('IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_PROVIDER', 'RESOLVED', 'CLOSED'))
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('WAITING_FOR_CUSTOMER', 'WAITING_FOR_PROVIDER', 'RESOLVED', 'CLOSED'))
    OR (OLD."status" = 'WAITING_FOR_CUSTOMER' AND NEW."status" IN ('IN_PROGRESS', 'WAITING_FOR_PROVIDER', 'RESOLVED', 'CLOSED'))
    OR (OLD."status" = 'WAITING_FOR_PROVIDER' AND NEW."status" IN ('IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'))
    OR (OLD."status" = 'RESOLVED' AND NEW."status" IN ('IN_PROGRESS', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION 'support_tickets: % → % is not an allowed status change', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CLOSED' AND (NEW."revision" <> OLD."revision") THEN
    RAISE EXCEPTION 'support_tickets: a closed ticket can''t change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "support_tickets_guard" BEFORE UPDATE ON "support_tickets"
FOR EACH ROW EXECUTE FUNCTION "support_tickets_guard"();

-- ─── Live updates ────────────────────────────────────────────────────────
-- Each history entry is announced on commit, ids and sequence only. Staff
-- streams hear everything; customer streams hear only customer-visible
-- entries, so an internal note doesn't even reveal that something happened.
CREATE FUNCTION "support_ticket_events_announce"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('wayora_support_staff', json_build_object('ticketId', NEW."ticket_id", 'seq', NEW."seq")::text);
  IF NOT NEW."internal" THEN
    PERFORM pg_notify('wayora_support_customer', json_build_object('ticketId', NEW."ticket_id", 'seq', NEW."seq")::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "support_ticket_events_announce" AFTER INSERT ON "support_ticket_events"
FOR EACH ROW EXECUTE FUNCTION "support_ticket_events_announce"();
