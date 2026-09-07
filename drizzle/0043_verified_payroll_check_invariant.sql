-- A payroll check is never verified by omission. Verified withholding is one
-- canonical derived fact: actual gross minus actual net. The corrective UPDATEs
-- are deterministic and idempotent for databases that predate this invariant.

ALTER TABLE "employee_payroll_checks"
  ALTER COLUMN "verification_status" SET DEFAULT 'unverified';--> statement-breakpoint

UPDATE "employee_payroll_checks"
   SET "verification_status" = 'unverified',
       "updated_at" = now()
 WHERE "verification_status" = 'verified'
   AND (
     "actual_gross" IS NULL
     OR "actual_gross" < "actual_net"
   );--> statement-breakpoint

UPDATE "employee_payroll_checks"
   SET "tax_withheld" = "actual_gross" - "actual_net",
       "updated_at" = now()
 WHERE "verification_status" = 'verified'
   AND "actual_gross" IS NOT NULL
   AND "actual_gross" >= "actual_net"
   AND "tax_withheld" IS DISTINCT FROM ("actual_gross" - "actual_net");--> statement-breakpoint

-- Keep the protected pre-release application rollback-compatible. That version
-- may still submit "verified" with no gross, or a separately entered tax. A
-- BEFORE trigger makes those writes safe instead of letting the new CHECK turn
-- an emergency application rollback into SQL errors: incomplete rows are kept
-- but downgraded to unverified, and complete verified rows get the one canonical
-- derived withholding value.
CREATE OR REPLACE FUNCTION normalize_verified_payroll_check_amounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."verification_status" = 'verified' THEN
    IF NEW."actual_gross" IS NULL OR NEW."actual_gross" < NEW."actual_net" THEN
      NEW."verification_status" := 'unverified';
    ELSE
      NEW."tax_withheld" := NEW."actual_gross" - NEW."actual_net";
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "employee_payroll_checks_normalize_verified_amounts"
  ON "employee_payroll_checks";--> statement-breakpoint

CREATE TRIGGER "employee_payroll_checks_normalize_verified_amounts"
BEFORE INSERT OR UPDATE OF "actual_gross", "actual_net", "tax_withheld", "verification_status"
ON "employee_payroll_checks"
FOR EACH ROW
EXECUTE FUNCTION normalize_verified_payroll_check_amounts();--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'employee_payroll_checks_verified_amounts_check'
       AND conrelid = 'employee_payroll_checks'::regclass
  ) THEN
    ALTER TABLE "employee_payroll_checks"
      ADD CONSTRAINT "employee_payroll_checks_verified_amounts_check"
      CHECK (
        "verification_status" <> 'verified'
        OR (
          "actual_gross" IS NOT NULL
          AND "actual_gross" >= "actual_net"
          AND "tax_withheld" IS NOT DISTINCT FROM ("actual_gross" - "actual_net")
        )
      ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "employee_payroll_checks"
  VALIDATE CONSTRAINT "employee_payroll_checks_verified_amounts_check";
