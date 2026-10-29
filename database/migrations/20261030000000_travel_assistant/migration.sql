-- Phase 21: travel assistant (docs/assistant.md).
-- Additive: four new tables and two enums. No existing table or row
-- changes. Rollback SQL is in docs/assistant.md#rollback.

-- CreateEnum
CREATE TYPE "assistant_message_role" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "assistant_request_outcome" AS ENUM ('OK', 'INVALID_OUTPUT', 'TIMEOUT', 'PROVIDER_ERROR');

-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trip_id" UUID,
    "title" VARCHAR(120) NOT NULL,
    "pending_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "assistant_message_role" NOT NULL,
    "text" VARCHAR(2000),
    "blocks" JSONB,
    "intent" VARCHAR(20),
    "provider" VARCHAR(40),
    "provider_label" VARCHAR(80),
    "simulated" BOOLEAN,
    "model" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(120),
    "intent" VARCHAR(20) NOT NULL,
    "outcome" "assistant_request_outcome" NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trip_id" UUID,
    "action" VARCHAR(30) NOT NULL,
    "block_id" VARCHAR(4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversations_user_id_updated_at_id_idx" ON "assistant_conversations"("user_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "assistant_conversations_trip_id_idx" ON "assistant_conversations"("trip_id");

-- CreateIndex
CREATE INDEX "assistant_messages_conversation_id_created_at_id_idx" ON "assistant_messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "assistant_requests_user_id_created_at_idx" ON "assistant_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_requests_created_at_outcome_idx" ON "assistant_requests"("created_at", "outcome");

-- CreateIndex
CREATE INDEX "assistant_actions_message_id_idx" ON "assistant_actions"("message_id");

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "planned_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity rules Prisma can't express.

-- A user message is text only; an assistant message is validated blocks
-- (a JSON array) with the provider that produced it. Never both.
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_shape_check" CHECK (
    ("role" = 'USER' AND "text" IS NOT NULL AND char_length("text") >= 1 AND "blocks" IS NULL)
    OR ("role" = 'ASSISTANT' AND "text" IS NULL AND "blocks" IS NOT NULL
        AND jsonb_typeof("blocks") = 'array' AND "provider" IS NOT NULL)
);

ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_title_check"
    CHECK (char_length("title") >= 1);

ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_numbers_check" CHECK (
    "latency_ms" >= 0
    AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
    AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
);

ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_action_check" CHECK (
    "action" IN ('add_itinerary', 'create_plan', 'add_activity', 'apply_budget', 'move_activity')
    AND "block_id" ~ '^b[0-9]{1,2}$'
);
