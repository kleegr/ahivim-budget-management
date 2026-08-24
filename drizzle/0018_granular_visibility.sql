-- Phase 14: composable per-user visibility controls.
--
-- `can_see_money` remains the compatibility/master guard. Existing transaction
-- permissions follow its current value, preserving full-money and hours-only
-- viewers exactly. Budgets and hours remain available as before. The newly
-- introduced employee-deal and settlement surfaces start private for viewers.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_hours" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_billed_amounts" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_employee_amounts" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_agency_spread" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_check_net" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_taxes" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_budgets" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_employee_deals" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_settlements" boolean NOT NULL DEFAULT false;--> statement-breakpoint

UPDATE "users"
   SET "can_see_hours" = true,
       "can_see_billed_amounts" = "can_see_money",
       "can_see_employee_amounts" = "can_see_money",
       "can_see_agency_spread" = "can_see_money",
       "can_see_check_net" = "can_see_money",
       "can_see_taxes" = "can_see_money",
       "can_see_budgets" = true,
       "can_see_employee_deals" = CASE WHEN "role" = 'viewer' THEN false ELSE true END,
       "can_see_settlements" = CASE WHEN "role" = 'viewer' THEN false ELSE true END;
