-- Phase 8: authentication and sessions.
-- Additive only: adds a nullable column and a new table. No existing data is
-- changed or removed. Rollback SQL is in docs/auth.md#migrations.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_hash" VARCHAR(255);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-written constraints (Prisma schema cannot express these).
-- ─────────────────────────────────────────────────────────────────────────

-- Only Argon2id PHC strings may be stored as password hashes.
ALTER TABLE "users" ADD CONSTRAINT "users_password_hash_chk" CHECK ("password_hash" IS NULL OR "password_hash" LIKE '$argon2id$%');

-- Emails are stored normalized: lower-case (Phase 1) and with no surrounding whitespace.
ALTER TABLE "users" ADD CONSTRAINT "users_email_trimmed_chk" CHECK ("email" = btrim("email"));

-- Token hashes are hex SHA-256; sessions expire after they start.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expiry_chk" CHECK ("expires_at" > "created_at");
