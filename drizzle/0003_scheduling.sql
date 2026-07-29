-- Phase 2: scheduling, recurrence, and expected-billing forecast.
-- Additive only; nothing existing is altered destructively.

-- A recurring schedule template. Occurrences are generated as scheduled_sessions
-- that point back here, so a whole series can be edited or cancelled together.
CREATE TABLE IF NOT EXISTS "schedule_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid,
  "program_id" uuid,
  "service_type" text,
  "frequency" text DEFAULT 'weekly' NOT NULL,
  "interval" integer DEFAULT 1 NOT NULL,
  "weekdays" jsonb,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "start_time" text,
  "end_time" text,
  "duration_hours" numeric(10, 4) NOT NULL,
  "expected_rate" numeric(14, 4),
  "status" text DEFAULT 'active' NOT NULL,
  "notes" text,
  "created_by_user_id" uuid,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "schedule_series_employee_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id"),
  CONSTRAINT "schedule_series_program_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id"),
  CONSTRAINT "schedule_series_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
);--> statement-breakpoint

-- A planned service occurrence (one-time, or one occurrence of a series).
-- Distinct from service_sessions, which are IMPORT-derived actuals.
CREATE TABLE IF NOT EXISTS "scheduled_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "series_id" uuid,
  "employee_id" uuid,
  "program_id" uuid,
  "service_type" text,
  "session_date" date NOT NULL,
  "start_time" text,
  "end_time" text,
  "duration_hours" numeric(10, 4) NOT NULL,
  "is_group" boolean DEFAULT false NOT NULL,
  "group_size" integer DEFAULT 1 NOT NULL,
  "expected_rate" numeric(14, 4),
  "expected_agency_gross" numeric(14, 4),
  "expected_internal_amount" numeric(14, 4),
  "expected_employee_cost" numeric(14, 4),
  "status" text DEFAULT 'pending' NOT NULL,
  "override_reason" text,
  "warnings" jsonb,
  "source" text DEFAULT 'manual' NOT NULL,
  "matched_transaction_id" uuid,
  "reconciliation_status" text,
  "notes" text,
  "created_by_user_id" uuid,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_sessions_series_fk" FOREIGN KEY ("series_id") REFERENCES "public"."schedule_series"("id") ON DELETE set null,
  CONSTRAINT "scheduled_sessions_employee_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id"),
  CONSTRAINT "scheduled_sessions_program_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id"),
  CONSTRAINT "scheduled_sessions_txn_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."payroll_transactions"("id"),
  CONSTRAINT "scheduled_sessions_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_sessions_date_idx" ON "scheduled_sessions" ("session_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_sessions_employee_idx" ON "scheduled_sessions" ("employee_id", "session_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_sessions_series_idx" ON "scheduled_sessions" ("series_id");--> statement-breakpoint

-- Per-individual allocation on a planned session. On a group session every
-- individual gets the FULL hours; only the money divides. Mirrors the rule
-- already enforced for imported group sessions.
CREATE TABLE IF NOT EXISTS "scheduled_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scheduled_session_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "allocation_hours" numeric(10, 4) NOT NULL,
  "allocated_rate" numeric(14, 4),
  "allocated_amount" numeric(14, 4),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_allocations_session_fk" FOREIGN KEY ("scheduled_session_id") REFERENCES "public"."scheduled_sessions"("id") ON DELETE cascade,
  CONSTRAINT "scheduled_allocations_individual_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_allocations_session_idx" ON "scheduled_allocations" ("scheduled_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_allocations_individual_idx" ON "scheduled_allocations" ("individual_id");
