-- Phase 4A: the Calculation workflow (cuts / monthly allocation), configurable
-- program rules, individual rate overrides, and the agency-vs-employee money
-- split. Additive and data-preserving only.

-- ---------------------------------------------------------------------------
-- Program rules. Defaults encode the known business behaviour: most programs
-- are one-to-one; groups are opt-in per program; self-hire does not convert.
-- ---------------------------------------------------------------------------
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "one_to_one_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "groups_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "max_group_size" integer;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "allow_multiple_employees" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "allow_multiple_individuals" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "allow_individual_rate_override" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "self_hire_converts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Per-hour amount the agency charges above the internal rate. NULL = derive it
-- as (agency rate - internal rate) at calculation time.
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "agency_additional_rate" numeric(14, 4);--> statement-breakpoint
-- 'hours' | 'dollars' | 'both' — what an authorization must specify.
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "required_auth_type" text DEFAULT 'hours' NOT NULL;--> statement-breakpoint

-- Back-fill the one group-capable flag that already existed onto the new rules,
-- so a program previously marked group-capable keeps behaving as a group.
UPDATE "programs" SET "groups_allowed" = true, "one_to_one_required" = false, "allow_multiple_individuals" = true
  WHERE "is_group_capable" = true;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Budget period shape: calendar-year / rolling-12-month / custom, plus renewal.
-- ---------------------------------------------------------------------------
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "period_type" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "renewal_date" date;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Individual-specific rate overrides on an authorization.
-- ---------------------------------------------------------------------------
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "agency_rate" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "individual_rate_override" numeric(14, 4);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Agency vs employee money kept separate on both actuals and plans.
-- ---------------------------------------------------------------------------
ALTER TABLE "payroll_transactions" ADD COLUMN IF NOT EXISTS "agency_additional_amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD COLUMN IF NOT EXISTS "employee_payment_amount" numeric(14, 4);--> statement-breakpoint
-- 'employee' | 'excellent_staffing' | 'unknown'
ALTER TABLE "payroll_transactions" ADD COLUMN IF NOT EXISTS "payment_recipient" text;--> statement-breakpoint

ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "expected_agency_additional" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "expected_employee_payment" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "scheduled_sessions" ADD COLUMN IF NOT EXISTS "payment_recipient" text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The Calculation workflow: annual gross -> monthly gross -> sequential cuts ->
-- clock/manual adjustment -> final gross / net / "After All". Every step is
-- stored, never just the final number. Revisions supersede, never overwrite.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "budget_calculations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL,
  "program_id" uuid,
  "budget_period_id" uuid,
  "annual_authorized_hours" numeric(10, 4),
  "annual_authorized_dollars" numeric(14, 4),
  "program_rate" numeric(14, 4),
  "individual_rate_override" numeric(14, 4),
  "effective_rate" numeric(14, 4),
  "months" integer DEFAULT 12 NOT NULL,
  "annual_gross" numeric(14, 4),
  "monthly_gross" numeric(14, 4),
  "cut1_percent" numeric(9, 6),
  "cut1_amount" numeric(14, 4),
  "cut2_percent" numeric(9, 6),
  "cut2_amount" numeric(14, 4),
  "clock_adjustment" numeric(14, 4) DEFAULT '0' NOT NULL,
  "final_gross" numeric(14, 4),
  "final_net" numeric(14, 4),
  "after_all" numeric(14, 4),
  "agency_additional" numeric(14, 4),
  "basis" text DEFAULT 'annual' NOT NULL,
  "formula_version" text DEFAULT 'v1' NOT NULL,
  "spreadsheet_value" numeric(14, 4),
  "revision" integer DEFAULT 1 NOT NULL,
  "supersedes_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "effective_from" date,
  "notes" text,
  "reason" text,
  "created_by_user_id" uuid,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budget_calculations_individual_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id"),
  CONSTRAINT "budget_calculations_program_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id"),
  CONSTRAINT "budget_calculations_period_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."budget_periods"("id"),
  CONSTRAINT "budget_calculations_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."budget_calculations"("id"),
  CONSTRAINT "budget_calculations_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_calculations_individual_idx" ON "budget_calculations" ("individual_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_calculations_program_idx" ON "budget_calculations" ("program_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Admin-editable global configuration (default cut percentages, cut order,
-- monthly division rule, default agency additional, …). Key/value so new
-- settings never need a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_by_user_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_settings_user_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id")
);--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") VALUES
  ('calculation_defaults', '{"cut1Percent":"0","cut2Percent":"0","cutOrder":"sequential","months":12,"agencyAdditionalPerHour":null}'::jsonb)
ON CONFLICT ("key") DO NOTHING;
