-- Durable PDF library. File bytes live in private object storage; PostgreSQL
-- holds authorization, immutable version history, editor state, and audit links.

CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "category" text NOT NULL DEFAULT 'general',
  "status" text NOT NULL DEFAULT 'uploading',
  "original_version_id" uuid,
  "current_version_id" uuid,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "updated_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "documents_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 180),
  CONSTRAINT "documents_category_check" CHECK (length(btrim("category")) BETWEEN 1 AND 80),
  CONSTRAINT "documents_status_check" CHECK ("status" IN ('uploading', 'active', 'archived')),
  CONSTRAINT "documents_archive_check" CHECK (
    ("status" = 'archived' AND "archived_at" IS NOT NULL)
    OR ("status" <> 'archived' AND "archived_at" IS NULL AND "archived_by_user_id" IS NULL)
  )
);--> statement-breakpoint

CREATE INDEX "documents_status_updated_idx"
  ON "documents" ("status", "updated_at" DESC, "id");--> statement-breakpoint
CREATE INDEX "documents_creator_idx"
  ON "documents" ("created_by_user_id", "updated_at" DESC);--> statement-breakpoint

CREATE TABLE "document_blobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "storage_pathname" text NOT NULL,
  "storage_etag" text NOT NULL,
  "content_type" text NOT NULL DEFAULT 'application/pdf',
  "byte_size" bigint NOT NULL,
  "filename" text NOT NULL,
  "checksum_sha256" text,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_blobs_purpose_check" CHECK ("purpose" IN ('original', 'edited')),
  CONSTRAINT "document_blobs_pdf_check" CHECK ("content_type" = 'application/pdf'),
  CONSTRAINT "document_blobs_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "document_blobs_filename_check" CHECK (length(btrim("filename")) BETWEEN 1 AND 255),
  CONSTRAINT "document_blobs_checksum_check" CHECK (
    "checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$'
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "document_blobs_pathname_key" ON "document_blobs" ("storage_pathname");--> statement-breakpoint
CREATE UNIQUE INDEX "document_blobs_document_id_key" ON "document_blobs" ("document_id", "id");--> statement-breakpoint
CREATE INDEX "document_blobs_document_idx" ON "document_blobs" ("document_id", "created_at");--> statement-breakpoint

CREATE TABLE "document_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "version_number" integer NOT NULL,
  "version_kind" text NOT NULL,
  "parent_version_id" uuid REFERENCES "document_versions"("id"),
  "restored_from_version_id" uuid REFERENCES "document_versions"("id"),
  "source_blob_id" uuid NOT NULL REFERENCES "document_blobs"("id"),
  "output_blob_id" uuid NOT NULL REFERENCES "document_blobs"("id"),
  "export_mode" text NOT NULL DEFAULT 'standard',
  "editor_schema_version" integer NOT NULL DEFAULT 1,
  "editor_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "page_count" integer,
  "change_summary" text,
  "idempotency_key" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_versions_number_check" CHECK ("version_number" > 0),
  CONSTRAINT "document_versions_kind_check" CHECK ("version_kind" IN ('original', 'saved', 'restored')),
  CONSTRAINT "document_versions_export_check" CHECK ("export_mode" IN ('source', 'standard', 'secure')),
  CONSTRAINT "document_versions_editor_schema_check" CHECK ("editor_schema_version" > 0),
  CONSTRAINT "document_versions_page_count_check" CHECK ("page_count" IS NULL OR "page_count" > 0),
  CONSTRAINT "document_versions_original_check" CHECK (
    ("version_kind" = 'original' AND "version_number" = 1 AND "parent_version_id" IS NULL
      AND "restored_from_version_id" IS NULL AND "source_blob_id" = "output_blob_id"
      AND "export_mode" = 'source')
    OR "version_kind" <> 'original'
  ),
  CONSTRAINT "document_versions_restore_check" CHECK (
    ("version_kind" = 'restored' AND "restored_from_version_id" IS NOT NULL)
    OR ("version_kind" <> 'restored' AND "restored_from_version_id" IS NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "document_versions_document_number_key"
  ON "document_versions" ("document_id", "version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_id_key"
  ON "document_versions" ("document_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_idempotency_key"
  ON "document_versions" ("document_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "document_versions_document_created_idx"
  ON "document_versions" ("document_id", "created_at" DESC, "id");--> statement-breakpoint

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_parent_document_fk"
  FOREIGN KEY ("document_id", "parent_version_id")
  REFERENCES "document_versions"("document_id", "id");--> statement-breakpoint

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_restore_document_fk"
  FOREIGN KEY ("document_id", "restored_from_version_id")
  REFERENCES "document_versions"("document_id", "id");--> statement-breakpoint

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_source_blob_document_fk"
  FOREIGN KEY ("document_id", "source_blob_id")
  REFERENCES "document_blobs"("document_id", "id");--> statement-breakpoint

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_output_blob_document_fk"
  FOREIGN KEY ("document_id", "output_blob_id")
  REFERENCES "document_blobs"("document_id", "id");--> statement-breakpoint

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_original_version_fk"
  FOREIGN KEY ("id", "original_version_id")
  REFERENCES "document_versions"("document_id", "id")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_current_version_fk"
  FOREIGN KEY ("id", "current_version_id")
  REFERENCES "document_versions"("document_id", "id")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

CREATE TABLE "document_drafts" (
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "base_version_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1,
  "editor_schema_version" integer NOT NULL DEFAULT 1,
  "editor_state" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_drafts_pkey" PRIMARY KEY ("document_id", "user_id"),
  CONSTRAINT "document_drafts_version_fk" FOREIGN KEY ("document_id", "base_version_id")
    REFERENCES "document_versions"("document_id", "id"),
  CONSTRAINT "document_drafts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "document_drafts_editor_schema_check" CHECK ("editor_schema_version" > 0)
);--> statement-breakpoint

CREATE INDEX "document_drafts_user_updated_idx"
  ON "document_drafts" ("user_id", "updated_at" DESC);--> statement-breakpoint

CREATE TABLE "document_upload_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "reserved_pathname" text NOT NULL,
  "filename" text NOT NULL,
  "expected_byte_size" bigint NOT NULL,
  "base_version_id" uuid,
  "storage_pathname" text,
  "storage_etag" text,
  "uploaded_content_type" text,
  "uploaded_byte_size" bigint,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "expires_at" timestamptz NOT NULL,
  "uploaded_at" timestamptz,
  "finalized_at" timestamptz,
  "finalized_version_id" uuid REFERENCES "document_versions"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_upload_intents_purpose_check" CHECK ("purpose" IN ('original', 'version')),
  CONSTRAINT "document_upload_intents_status_check" CHECK ("status" IN ('pending', 'uploaded', 'finalized', 'expired')),
  CONSTRAINT "document_upload_intents_filename_check" CHECK (length(btrim("filename")) BETWEEN 1 AND 255),
  CONSTRAINT "document_upload_intents_size_check" CHECK ("expected_byte_size" > 0),
  CONSTRAINT "document_upload_intents_uploaded_size_check" CHECK (
    "uploaded_byte_size" IS NULL OR "uploaded_byte_size" > 0
  ),
  CONSTRAINT "document_upload_intents_base_version_fk" FOREIGN KEY ("document_id", "base_version_id")
    REFERENCES "document_versions"("document_id", "id"),
  CONSTRAINT "document_upload_intents_finalized_version_document_fk"
    FOREIGN KEY ("document_id", "finalized_version_id")
    REFERENCES "document_versions"("document_id", "id")
);--> statement-breakpoint

CREATE UNIQUE INDEX "document_upload_intents_pathname_key"
  ON "document_upload_intents" ("reserved_pathname");--> statement-breakpoint
CREATE INDEX "document_upload_intents_document_idx"
  ON "document_upload_intents" ("document_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "document_upload_intents_expiry_idx"
  ON "document_upload_intents" ("status", "expires_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_document_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a document version instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "document_blobs_immutable"
  BEFORE UPDATE OR DELETE ON "document_blobs"
  FOR EACH ROW EXECUTE FUNCTION "prevent_document_history_mutation"();--> statement-breakpoint

CREATE TRIGGER "document_versions_immutable"
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_document_history_mutation"();
