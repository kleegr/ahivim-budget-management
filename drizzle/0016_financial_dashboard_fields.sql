-- Phase 12: fields for the financial dashboard.
-- Per-individual side notes on the dashboard (a phone number and a free-form
-- category/account tag, like the sheet's phone + A/C/G columns), and a
-- per-employee payout cut (a percentage taken from what is paid to that
-- employee, paid to him separately). All additive and data-preserving;
-- individuals.notes and employees.notes already exist.
ALTER TABLE "individuals"
  ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "individuals"
  ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "payout_cut_percent" numeric(9, 6) NOT NULL DEFAULT 0;
