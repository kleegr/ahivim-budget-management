-- Effective-dated, finance-free employee availability for the planner.
-- Weekly windows describe when an employee normally works. Dated
-- unavailability overrides those windows for a date range or part of a day.

CREATE TABLE "employee_weekly_availability" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "weekday" integer NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_weekly_availability_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
  CONSTRAINT "employee_weekly_availability_start_time_check" CHECK (
    "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT "employee_weekly_availability_end_time_check" CHECK (
    "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT "employee_weekly_availability_time_order_check" CHECK ("start_time" < "end_time"),
  CONSTRAINT "employee_weekly_availability_date_order_check" CHECK (
    "effective_to" IS NULL OR "effective_to" >= "effective_from"
  ),
  CONSTRAINT "employee_weekly_availability_archive_check" CHECK (
    ("archived_at" IS NULL AND "archived_by_user_id" IS NULL)
    OR "archived_at" IS NOT NULL
  )
);--> statement-breakpoint

CREATE INDEX "employee_weekly_availability_active_lookup_idx"
  ON "employee_weekly_availability" ("employee_id", "effective_from", "effective_to", "weekday")
  WHERE "archived_at" IS NULL;--> statement-breakpoint

CREATE TABLE "employee_unavailability" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "start_time" text,
  "end_time" text,
  "label" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_unavailability_date_order_check" CHECK ("end_date" >= "start_date"),
  CONSTRAINT "employee_unavailability_time_pair_check" CHECK (
    ("start_time" IS NULL AND "end_time" IS NULL)
    OR ("start_time" IS NOT NULL AND "end_time" IS NOT NULL)
  ),
  CONSTRAINT "employee_unavailability_start_time_check" CHECK (
    "start_time" IS NULL OR "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT "employee_unavailability_end_time_check" CHECK (
    "end_time" IS NULL OR "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT "employee_unavailability_time_order_check" CHECK (
    "start_time" IS NULL OR "start_time" < "end_time"
  ),
  CONSTRAINT "employee_unavailability_timed_single_day_check" CHECK (
    "start_time" IS NULL OR "start_date" = "end_date"
  ),
  CONSTRAINT "employee_unavailability_archive_check" CHECK (
    ("archived_at" IS NULL AND "archived_by_user_id" IS NULL)
    OR "archived_at" IS NOT NULL
  )
);--> statement-breakpoint

CREATE INDEX "employee_unavailability_active_lookup_idx"
  ON "employee_unavailability" ("employee_id", "start_date", "end_date")
  WHERE "archived_at" IS NULL;
