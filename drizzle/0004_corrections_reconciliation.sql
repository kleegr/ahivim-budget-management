-- Phase 3: import-correction work-queue + scheduled-vs-actual reconciliation.
-- Additive only. The original imported cells (import_rows.raw_values) are NEVER
-- overwritten; corrections live in a separate column with their own audit.

-- Corrections on a staged import row. raw_values stays verbatim; corrected_values
-- is a sparse { field: newValue } patch applied at commit time. Who/when/why is
-- recorded here and in the audit log.
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "corrected_values" jsonb;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "correction_status" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "corrected_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "correction_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_corrected_by_fk"
    FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Reconciliation audit on a planned session. The MATCH itself reuses the
-- existing matched_transaction_id + reconciliation_status columns (added in
-- 0003); these record who reconciled it and why.
ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "reconciled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "reconciliation_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scheduled_sessions" ADD CONSTRAINT "scheduled_sessions_reconciled_by_fk"
    FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Speeds the reconciliation candidate lookup (individual + program + period).
CREATE INDEX IF NOT EXISTS "payroll_tx_recon_idx"
  ON "payroll_transactions" ("individual_id", "program_id", "period_begin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_sessions_match_idx"
  ON "scheduled_sessions" ("matched_transaction_id");
