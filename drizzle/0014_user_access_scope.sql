-- Phase 10: per-user access control.
-- Lets an admin hand out logins that see only part of the system: certain
-- individuals and/or certain employees, with the connected set filled in
-- automatically, and an optional lock on whether transactions are visible.
--
-- Additive and data-preserving. Every existing user defaults to access_scope
-- 'full' with can_see_transactions = true, so current logins (the admin and
-- anyone already created) keep seeing everything exactly as before. Scoping only
-- applies to a user explicitly switched to 'scoped'.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "access_scope" text NOT NULL DEFAULT 'full';--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "see_all_individuals" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "see_all_employees" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_transactions" boolean NOT NULL DEFAULT true;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_individual_access" (
  "user_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_individual_access_pkey" PRIMARY KEY ("user_id","individual_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_employee_access" (
  "user_id" uuid NOT NULL,
  "employee_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_employee_access_pkey" PRIMARY KEY ("user_id","employee_id")
);--> statement-breakpoint
ALTER TABLE "user_individual_access" ADD CONSTRAINT "user_individual_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_individual_access" ADD CONSTRAINT "user_individual_access_individual_id_individuals_id_fk" FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_employee_access" ADD CONSTRAINT "user_employee_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_employee_access" ADD CONSTRAINT "user_employee_access_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_individual_access_user_idx" ON "user_individual_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_individual_access_individual_idx" ON "user_individual_access" USING btree ("individual_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_employee_access_user_idx" ON "user_employee_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_employee_access_employee_idx" ON "user_employee_access" USING btree ("employee_id");
