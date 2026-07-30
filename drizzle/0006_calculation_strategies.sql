-- Phase 5: calculation strategies (the "Calculations" workbook tab as a data
-- model). A canonical individual has one or more *strategies* — the workbook's
-- "Fradel Ostreicher 1" / "Fradel Ostreicher 2" rows are two strategies for the
-- ONE individual "Fradel Ostreicher", never duplicate people. Each strategy owns
-- its own programs/hours, cuts, adjustments, renewal date, account and final
-- "After All" figure. Additive and data-preserving only.

-- ---------------------------------------------------------------------------
-- A strategy: one budget line for one individual. Renewal-date-only — the
-- 12-month budget period is derived (start = renewal − 12 months, end =
-- renewal), never entered by hand. month_divisor is normally 12; it exists so
-- a documented exception (e.g. a 7-month partial period) is explicit and
-- flagged, not silently normalised. Cuts are stored as fractions (0.24 = 24%),
-- matching budget_calculations. after_all is the manually-set final figure
-- (the workbook's "After All" column is not a formula).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "calculation_strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "label" text DEFAULT '1' NOT NULL,
  "renewal_date" date,
  "month_divisor" numeric(6, 3) DEFAULT 12 NOT NULL,
  "cut1_percent" numeric(9, 6) DEFAULT 0 NOT NULL,
  "cut2_percent" numeric(9, 6) DEFAULT 0 NOT NULL,
  "clock_adjustment" numeric(14, 4) DEFAULT 0 NOT NULL,
  "other_adjustment" numeric(14, 4) DEFAULT 0 NOT NULL,
  "after_all" numeric(14, 4),
  "account" text,
  "status" text DEFAULT 'active' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "notes" text,
  "created_by_user_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "calc_strategies_individual_idx"
  ON "calculation_strategies" ("individual_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Per-program hours for a strategy. Program columns in the workspace are
-- generated from the configured programs, so hours live in a child row keyed by
-- program rather than fixed columns. The internal rate is NOT stored here — it
-- is read from program_rate_schedules (effective-dated) so rates stay
-- configurable and are never hardcoded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "calculation_strategy_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "strategy_id" uuid NOT NULL REFERENCES "calculation_strategies"("id") ON DELETE CASCADE,
  "program_id" uuid NOT NULL REFERENCES "programs"("id"),
  "authorized_hours" numeric(10, 4) DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "calc_strategy_lines_unique" UNIQUE ("strategy_id", "program_id")
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Change history. Every save first snapshots the PRIOR strategy + its lines as
-- JSON here, so edits are non-destructive: history is queryable and a prior
-- state can be restored (undo/supersede) rather than overwritten.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "calculation_strategy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "strategy_id" uuid NOT NULL REFERENCES "calculation_strategies"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "reason" text,
  "created_by_user_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "calc_strategy_revisions_strategy_idx"
  ON "calculation_strategy_revisions" ("strategy_id");
