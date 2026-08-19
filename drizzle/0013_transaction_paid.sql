-- Phase 9: a "Paid" tracking column on transactions.
-- Operators keep track of what they've paid out (in the old workbook they typed
-- "paid" into a column). This adds a first-class paid flag, an optional paid-on
-- timestamp, and a free note, so rows can be marked paid one at a time or in bulk
-- and totalled by selection. Additive and data-preserving: every existing row
-- defaults to not-paid, nothing else changes.
ALTER TABLE "payroll_transactions"
  ADD COLUMN IF NOT EXISTS "is_paid" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "payroll_transactions"
  ADD COLUMN IF NOT EXISTS "paid_at" timestamptz;--> statement-breakpoint
ALTER TABLE "payroll_transactions"
  ADD COLUMN IF NOT EXISTS "paid_note" text;
