-- Preserve the business-facing account identity independently from the coarse
-- internal authorization role. Existing trusted staff have an unambiguous
-- preset; legacy viewer portal identities continue to be inferred on read.
ALTER TABLE "users"
  ADD COLUMN "account_preset" text;--> statement-breakpoint

UPDATE "users"
   SET "account_preset" = CASE
     WHEN "role" = 'admin' THEN 'owner'
     WHEN "role" = 'manager' THEN 'office_manager'
     ELSE NULL
   END
 WHERE "account_preset" IS NULL;--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_account_preset_check"
  CHECK (
    "account_preset" IS NULL
    OR "account_preset" IN (
      'owner',
      'office_manager',
      'budget_planner',
      'staffing_manager',
      'money_collector',
      'class_billing',
      'individual_parent',
      'employee',
      'agency',
      'agency_scheduler',
      'agency_staffing_manager',
      'agency_collector',
      'custom_access'
    )
  );
