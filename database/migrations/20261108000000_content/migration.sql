-- Phase 29: editorial content (CMS) and first-party page-view counts (docs/seo.md).
-- Additive: new enums, tables and triggers. No existing data changes.

CREATE TYPE "content_type" AS ENUM ('GUIDE', 'ARTICLE', 'TIP', 'FAQ', 'COLLECTION', 'LANDING');
CREATE TYPE "content_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- ─── Entries ─────────────────────────────────────────────────────────────

CREATE TABLE "content_entries" (
    "id" UUID NOT NULL,
    "type" "content_type" NOT NULL,
    -- One namespace for every type: /guides/, /collections/ and /explore/ never collide.
    "slug" VARCHAR(80) NOT NULL,
    "status" "content_status" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(120) NOT NULL,
    "summary" VARCHAR(400) NOT NULL DEFAULT '',
    -- Structured blocks (validated by contentBlockSchema); never HTML.
    "body" JSONB NOT NULL DEFAULT '[]',
    "cover_media" VARCHAR(64),
    "cover_alt" VARCHAR(200),
    "seo_title" VARCHAR(60),
    "meta_description" VARCHAR(160),
    "destinations" TEXT[] NOT NULL DEFAULT '{}',
    "related" TEXT[] NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "author_id" UUID NOT NULL,
    "editor_id" UUID NOT NULL,
    "first_published_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "content_entries_slug_format" CHECK (
      "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 80
    ),
    CONSTRAINT "content_entries_body_array" CHECK (jsonb_typeof("body") = 'array'),
    CONSTRAINT "content_entries_cover" CHECK (("cover_media" IS NULL) = ("cover_alt" IS NULL)),
    CONSTRAINT "content_entries_published" CHECK (
      ("status" <> 'PUBLISHED' OR ("published_at" IS NOT NULL AND "first_published_at" IS NOT NULL))
      AND ("status" <> 'ARCHIVED' OR "archived_at" IS NOT NULL)
    ),
    CONSTRAINT "content_entries_revision" CHECK ("revision" >= 1)
);

CREATE UNIQUE INDEX "content_entries_slug_key" ON "content_entries"("slug");
CREATE INDEX "content_entries_status_type_idx" ON "content_entries"("status", "type");
CREATE INDEX "content_entries_destinations_idx" ON "content_entries" USING GIN ("destinations");
CREATE INDEX "content_entries_updated_at_idx" ON "content_entries"("updated_at");

ALTER TABLE "content_entries" ADD CONSTRAINT "content_entries_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_entries" ADD CONSTRAINT "content_entries_editor_id_fkey"
  FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Revisions (every saved version) ─────────────────────────────────────

CREATE TABLE "content_revisions" (
    "entry_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "content_status" NOT NULL,
    -- The entry's fields at this revision (contentInputSchema shape).
    "snapshot" JSONB NOT NULL,
    "editor_id" UUID NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("entry_id", "revision")
);
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "content_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_editor_id_fkey"
  FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── First-party page-view counts ────────────────────────────────────────
-- Daily totals only: no user, session, cookie, IP address or user agent.

CREATE TABLE "content_daily_counts" (
    "day" DATE NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "content_daily_counts_pkey" PRIMARY KEY ("day", "event", "key"),
    CONSTRAINT "content_daily_counts_count" CHECK ("count" >= 0)
);
CREATE INDEX "content_daily_counts_event_day_idx" ON "content_daily_counts"("event", "day");

-- ─── Integrity ───────────────────────────────────────────────────────────

CREATE FUNCTION "content_prevent_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are kept for audit (DELETE blocked)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "content_entries_no_delete" BEFORE DELETE ON "content_entries"
FOR EACH ROW EXECUTE FUNCTION "content_prevent_delete"();

CREATE FUNCTION "content_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "content_revisions_append_only" BEFORE UPDATE OR DELETE ON "content_revisions"
FOR EACH ROW EXECUTE FUNCTION "content_append_only"();

-- The type, author and creation never change; revisions only go up; once
-- published, the slug (the public URL) is fixed.
CREATE FUNCTION "content_entries_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."type" <> OLD."type" OR NEW."author_id" <> OLD."author_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'content_entries: type, author and creation are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'content_entries: every change needs a new revision' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."first_published_at" IS NOT NULL AND NEW."slug" <> OLD."slug" THEN
    RAISE EXCEPTION 'content_entries: a published slug is permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."first_published_at" IS NOT NULL AND NEW."first_published_at" IS DISTINCT FROM OLD."first_published_at" THEN
    RAISE EXCEPTION 'content_entries: the first publication date is permanent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "content_entries_guard" BEFORE UPDATE ON "content_entries"
FOR EACH ROW EXECUTE FUNCTION "content_entries_guard"();
