-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "travel_category" AS ENUM ('FLIGHT', 'HOTEL', 'TRAIN', 'BUS', 'METRO', 'CAB', 'HOLIDAY_PACKAGE');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING', 'HELD', 'CONFIRMED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "booking_item_status" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "idempotency_key_status" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'ADMIN', 'PROVIDER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "display_name" VARCHAR(120),
    "phone_e164" VARCHAR(16),
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travellers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "date_of_birth" DATE,
    "nationality" CHAR(2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "travellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "total_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "category" "travel_category" NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(64),
    "provider_reference" VARCHAR(128),
    "currency" CHAR(3) NOT NULL,
    "total_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_items" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "traveller_id" UUID,
    "status" "booking_item_status" NOT NULL DEFAULT 'ACTIVE',
    "description" VARCHAR(255) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL,
    "unit_amount_minor" BIGINT NOT NULL,
    "total_amount_minor" BIGINT NOT NULL,
    "attributes" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "user_id" UUID,
    "request_hash" CHAR(64) NOT NULL,
    "status" "idempotency_key_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" SMALLINT,
    "response_body" JSONB,
    "locked_until" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "webhook_event_status" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" VARCHAR(64),
    "action" VARCHAR(128) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "request_id" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "travellers_user_id_idx" ON "travellers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "bookings_order_id_idx" ON "bookings"("order_id");

-- CreateIndex
CREATE INDEX "bookings_category_status_idx" ON "bookings"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_provider_provider_reference_key" ON "bookings"("provider", "provider_reference");

-- CreateIndex
CREATE INDEX "booking_items_booking_id_idx" ON "booking_items"("booking_id");

-- CreateIndex
CREATE INDEX "booking_items_traveller_id_idx" ON "booking_items"("traveller_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_external_id_key" ON "webhook_events"("provider", "external_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_idx" ON "audit_logs"("actor_type", "actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "travellers" ADD CONSTRAINT "travellers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_traveller_id_fkey" FOREIGN KEY ("traveller_id") REFERENCES "travellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints (Prisma schema cannot express these).
-- Keep this block at the end of the migration. See docs/architecture.md.
-- ─────────────────────────────────────────────────────────────────────────

-- Identity
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_chk" CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "travellers" ADD CONSTRAINT "travellers_nationality_chk" CHECK ("nationality" IS NULL OR "nationality" ~ '^[A-Z]{2}$');

-- Money: ISO 4217 codes, non-negative integer minor units
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_amount_minor_chk" CHECK ("total_amount_minor" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_total_amount_minor_chk" CHECK ("total_amount_minor" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_reference_chk" CHECK ("provider_reference" IS NULL OR "provider" IS NOT NULL);
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_quantity_chk" CHECK ("quantity" > 0);
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_amounts_chk" CHECK ("unit_amount_minor" >= 0 AND "total_amount_minor" >= 0);

-- Reliability
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_response_status_chk" CHECK ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599);
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_expiry_chk" CHECK ("expires_at" > "created_at");
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_attempts_chk" CHECK ("attempts" >= 0);

-- Audit log is append-only: block UPDATE and DELETE at the database level.
CREATE FUNCTION "audit_logs_prevent_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "audit_logs_prevent_mutation"();
