-- Phase 7 (performance): indexes for the pages that were slow.
-- Additive, safe, and idempotent.

-- Settings reads the 50 most recent audit entries; audit_logs has no created_at
-- index, so that ORDER BY sorted the whole (now large) table.
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" ("created_at" DESC);--> statement-breakpoint

-- Program-level aggregations (reports, Calculations analytics) group billed rows
-- by program; the existing index leads with individual_id only.
CREATE INDEX IF NOT EXISTS "payroll_tx_program_idx" ON "payroll_transactions" ("program_id");--> statement-breakpoint

-- Match-review lookups join both individuals; index the second side too.
CREATE INDEX IF NOT EXISTS "individual_match_reviews_merge_idx" ON "individual_match_reviews" ("merge_individual_id");
