-- Phase 1: make the operational records editable.
--
-- Additive only. Every statement is guarded so a re-run is a no-op, and no
-- existing column, row, or financial value is dropped or rewritten. Soft-state
-- columns (status / archived_at) default to preserving the current meaning of
-- every existing row (everything is 'active', nothing archived).

-- Individuals: legal / preferred names, lifecycle status, soft archive.
ALTER TABLE "individuals" ADD COLUMN IF NOT EXISTS "legal_name" text;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN IF NOT EXISTS "preferred_name" text;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "individuals" SET "legal_name" = "display_name" WHERE "legal_name" IS NULL;--> statement-breakpoint

-- Employees: lifecycle status, notes, soft archive.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

-- Programs: soft archive + notes (is_active already exists).
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

-- Rate schedules: who set it, soft archive (effective-dating already preserves history).
ALTER TABLE "program_rate_schedules" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "program_rate_schedules" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

-- Budget periods: lifecycle status, source, soft archive.
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

-- Authorizations: full revision history. A change never overwrites; it creates
-- a new row that supersedes the old one, and the old row is kept as history.
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "authorized_dollars" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "rate_basis" text;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_authorizations" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
-- The old rule allowed exactly one authorization per (period, program). With
-- revisions that must become one ACTIVE authorization per (period, program):
-- superseded revisions share the same key and must not collide.
DROP INDEX IF EXISTS "budget_auth_period_program_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_auth_active_period_program_key"
  ON "budget_authorizations" ("budget_period_id", "program_id")
  WHERE "status" = 'active';--> statement-breakpoint

-- Assignments: which employee may serve which individual, for which program,
-- over which dates, up to how many hours.
CREATE TABLE IF NOT EXISTS "assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "program_id" uuid,
  "start_date" date,
  "end_date" date,
  "allowed_hours" numeric(10, 4),
  "status" text DEFAULT 'active' NOT NULL,
  "notes" text,
  "created_by_user_id" uuid,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade,
  CONSTRAINT "assignments_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade,
  CONSTRAINT "assignments_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id"),
  CONSTRAINT "assignments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_employee_idx" ON "assignments" ("employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_individual_idx" ON "assignments" ("individual_id");--> statement-breakpoint

-- Audit: a first-class reason for every change (previous/new stay in metadata).
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint

-- Alias management metadata.
ALTER TABLE "individual_aliases" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "individual_aliases" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "individual_aliases" ADD COLUMN IF NOT EXISTS "rows_affected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "individual_aliases" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD COLUMN IF NOT EXISTS "rows_affected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_aliases" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
