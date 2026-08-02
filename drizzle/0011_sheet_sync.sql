-- Google Sheet sync: the sheet is the permanent source of truth for
-- Transactions. These tables record each sync run, track every distinct source
-- row we have ever seen (so change/missing detection is possible), and hold the
-- review queue for changed or vanished source rows. Nothing here deletes or
-- overwrites a production transaction; the sync engine reuses the existing
-- import pipeline for the actual writes.

CREATE TABLE "sheet_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "snapshot_sha256" text,
  "source_rows" integer DEFAULT 0 NOT NULL,
  "rows_added" integer DEFAULT 0 NOT NULL,
  "rows_updated" integer DEFAULT 0 NOT NULL,
  "rows_skipped" integer DEFAULT 0 NOT NULL,
  "rows_flagged" integer DEFAULT 0 NOT NULL,
  "rows_failed" integer DEFAULT 0 NOT NULL,
  "import_batch_id" uuid,
  "reconciliation" jsonb,
  "error_message" text,
  "triggered_by_user_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_sync_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "natural_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "source_row_number" integer,
  "payroll_transaction_id" uuid,
  "identity" jsonb,
  "state" text DEFAULT 'active' NOT NULL,
  "first_seen_run_id" uuid,
  "last_seen_run_id" uuid,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_sync_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid,
  "sync_row_id" uuid,
  "payroll_transaction_id" uuid,
  "type" text NOT NULL,
  "audited" boolean DEFAULT false NOT NULL,
  "natural_key" text NOT NULL,
  "previous" jsonb,
  "incoming" jsonb,
  "detail" text,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolution_note" text,
  "resolved_by_user_id" uuid,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_sync_runs" ADD CONSTRAINT "sheet_sync_runs_batch_fk" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sheet_sync_runs" ADD CONSTRAINT "sheet_sync_runs_user_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sheet_sync_rows" ADD CONSTRAINT "sheet_sync_rows_txn_fk" FOREIGN KEY ("payroll_transaction_id") REFERENCES "payroll_transactions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sheet_sync_conflicts" ADD CONSTRAINT "sheet_sync_conflicts_run_fk" FOREIGN KEY ("run_id") REFERENCES "sheet_sync_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sheet_sync_conflicts" ADD CONSTRAINT "sheet_sync_conflicts_row_fk" FOREIGN KEY ("sync_row_id") REFERENCES "sheet_sync_rows"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sheet_sync_conflicts" ADD CONSTRAINT "sheet_sync_conflicts_txn_fk" FOREIGN KEY ("payroll_transaction_id") REFERENCES "payroll_transactions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- A soft, informational flag surfaced in the UI. It is NEVER used to exclude a
-- transaction from any total: a flagged row is still a real transaction until a
-- human decides. So no existing aggregate query needs to change.
ALTER TABLE "payroll_transactions" ADD COLUMN "sync_review_reason" text;
--> statement-breakpoint
-- One tracking row per sheet-origin transaction. Two legitimate line items can
-- share a natural key, so the transaction is the unique key, not the natural key.
CREATE UNIQUE INDEX "sheet_sync_rows_txn_uidx" ON "sheet_sync_rows" USING btree ("payroll_transaction_id");
--> statement-breakpoint
CREATE INDEX "sheet_sync_rows_natural_key_idx" ON "sheet_sync_rows" USING btree ("natural_key");
--> statement-breakpoint
CREATE INDEX "sheet_sync_rows_fingerprint_idx" ON "sheet_sync_rows" USING btree ("fingerprint");
--> statement-breakpoint
CREATE INDEX "sheet_sync_rows_state_idx" ON "sheet_sync_rows" USING btree ("state");
--> statement-breakpoint
CREATE INDEX "sheet_sync_conflicts_status_idx" ON "sheet_sync_conflicts" USING btree ("status","type");
--> statement-breakpoint
CREATE INDEX "sheet_sync_runs_started_idx" ON "sheet_sync_runs" USING btree ("started_at" DESC);
