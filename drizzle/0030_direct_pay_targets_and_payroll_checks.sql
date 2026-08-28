-- Direct-pay operations: actual payroll-check facts and recurring gross targets.
--
-- Funder billed amounts remain on payroll_transactions. They are deliberately
-- not reused as payroll gross. A payroll-check row is the only source for actual
-- gross and tax/withholding display; direct give-back calculations still use the
-- whole-check NET.

CREATE TABLE "employee_payroll_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "check_number" text,
  "check_date" date,
  "period_begin" date,
  "period_end" date,
  "actual_gross" numeric(14, 4),
  "actual_net" numeric(14, 4) NOT NULL,
  "tax_withheld" numeric(14, 4),
  "source" text NOT NULL DEFAULT 'manual',
  "source_ref" text,
  "verification_status" text NOT NULL DEFAULT 'verified',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_payroll_checks_identity_check"
    CHECK (
      NULLIF(btrim("check_number"), '') IS NOT NULL
      OR "check_date" IS NOT NULL
      OR "period_begin" IS NOT NULL
      OR "period_end" IS NOT NULL
    ),
  CONSTRAINT "employee_payroll_checks_period_check"
    CHECK ("period_end" IS NULL OR "period_begin" IS NULL OR "period_end" >= "period_begin"),
  CONSTRAINT "employee_payroll_checks_gross_check"
    CHECK ("actual_gross" IS NULL OR "actual_gross" >= 0),
  CONSTRAINT "employee_payroll_checks_net_check" CHECK ("actual_net" >= 0),
  CONSTRAINT "employee_payroll_checks_tax_check"
    CHECK ("tax_withheld" IS NULL OR "tax_withheld" >= 0),
  CONSTRAINT "employee_payroll_checks_source_check"
    CHECK ("source" IN ('manual', 'import', 'sync', 'legacy_transaction')),
  CONSTRAINT "employee_payroll_checks_verification_check"
    CHECK ("verification_status" IN ('unverified', 'verified', 'void'))
);

CREATE UNIQUE INDEX "employee_payroll_checks_identity_key"
  ON "employee_payroll_checks" (
    "employee_id",
    COALESCE(NULLIF(btrim("check_number"), ''), ''),
    COALESCE("check_date", 'infinity'::date),
    COALESCE("period_begin", 'infinity'::date),
    COALESCE("period_end", 'infinity'::date)
  );
CREATE INDEX "employee_payroll_checks_employee_date_idx"
  ON "employee_payroll_checks" ("employee_id", "check_date" DESC, "period_end" DESC);

ALTER TABLE "payroll_transactions"
  ADD COLUMN "payroll_check_id" uuid REFERENCES "employee_payroll_checks"("id");
CREATE INDEX "payroll_transactions_payroll_check_idx"
  ON "payroll_transactions" ("payroll_check_id") WHERE "payroll_check_id" IS NOT NULL;

-- Preserve imported legacy check facts without silently certifying them. Rows
-- with one consistent non-negative NET for a check identity become an
-- Unverified review item and are linked to their source transactions. Only an
-- operator's later verification can make the check settlement-authoritative.
WITH "legacy_direct_checks" AS (
  SELECT t."employee_id",
         NULLIF(btrim(t."check_number"), '') AS "check_number",
         t."check_date",
         t."period_begin",
         t."period_end",
         min(t."total_net_pay") AS "actual_net"
    FROM "payroll_transactions" t
    LEFT JOIN "programs" p ON p."id" = t."program_id"
   WHERE t."employee_id" IS NOT NULL
     AND effective_payment_recipient(t."payment_recipient", p."payment_recipient") = 'employee'
     AND t."total_net_pay" IS NOT NULL
     AND t."total_net_pay" >= 0
     AND (
       NULLIF(btrim(t."check_number"), '') IS NOT NULL
       OR t."check_date" IS NOT NULL
       OR t."period_begin" IS NOT NULL
       OR t."period_end" IS NOT NULL
     )
   GROUP BY t."employee_id", NULLIF(btrim(t."check_number"), ''),
            t."check_date", t."period_begin", t."period_end"
  HAVING count(DISTINCT t."total_net_pay") = 1
)
INSERT INTO "employee_payroll_checks"
  ("employee_id", "check_number", "check_date", "period_begin", "period_end",
   "actual_net", "source", "source_ref", "verification_status",
   "notes")
SELECT legacy."employee_id", legacy."check_number", legacy."check_date",
       legacy."period_begin", legacy."period_end", legacy."actual_net",
       'legacy_transaction',
       'legacy:' || md5(concat_ws('|', legacy."employee_id"::text,
         legacy."check_number", legacy."check_date"::text,
         legacy."period_begin"::text, legacy."period_end"::text)),
       'unverified',
       'Imported from legacy transaction NET; verify before settlement use.'
  FROM "legacy_direct_checks" legacy
ON CONFLICT DO NOTHING;

UPDATE "payroll_transactions" t
   SET "payroll_check_id" = check_fact."id",
       "updated_at" = now()
  FROM "employee_payroll_checks" check_fact
 WHERE t."payroll_check_id" IS NULL
   AND check_fact."source" = 'legacy_transaction'
   AND check_fact."verification_status" = 'unverified'
   AND check_fact."employee_id" = t."employee_id"
   AND check_fact."check_number" IS NOT DISTINCT FROM NULLIF(btrim(t."check_number"), '')
   AND check_fact."check_date" IS NOT DISTINCT FROM t."check_date"
   AND check_fact."period_begin" IS NOT DISTINCT FROM t."period_begin"
   AND check_fact."period_end" IS NOT DISTINCT FROM t."period_end"
   AND effective_payment_recipient(
         t."payment_recipient",
         (SELECT p."payment_recipient" FROM "programs" p WHERE p."id" = t."program_id")
       ) = 'employee';

-- The prior ledger may have trusted transaction-level NET values. Force an
-- operator refresh under the verified-check rule before money can be posted.
UPDATE "settlement_ledger_state"
   SET "source_version" = "source_version" + 1,
       "dirty_since" = COALESCE("dirty_since", now()),
       "last_refresh_error" = NULL
 WHERE "singleton" = true;

-- Replace the source trigger so linking or unlinking a canonical payroll check
-- invalidates settlement derivations just like editing a repeated transaction NET.
DROP TRIGGER IF EXISTS "payroll_transactions_settlement_dirty_update" ON "payroll_transactions";
CREATE TRIGGER "payroll_transactions_settlement_dirty_update"
  BEFORE UPDATE OF
    "employee_id", "individual_id", "program_id", "check_number", "check_date",
    "period_begin", "period_end", "payment_recipient", "imported_amount",
    "imported_hours", "total_net_pay", "calculated_internal_amount",
    "spreadsheet_internal_amount", "internal_rate_applied", "payroll_check_id"
  ON "payroll_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();

CREATE TRIGGER "employee_payroll_checks_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "employee_payroll_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();

CREATE TABLE "employee_direct_pay_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "target_basis" text NOT NULL DEFAULT 'gross',
  "interval_unit" text NOT NULL DEFAULT 'week',
  "interval_count" integer NOT NULL DEFAULT 1,
  "gross_target_amount" numeric(14, 4) NOT NULL,
  "planning_hourly_rate" numeric(14, 4) NOT NULL,
  "target_hours" numeric(10, 4) GENERATED ALWAYS AS
    (round("gross_target_amount" / "planning_hourly_rate", 4)) STORED,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_direct_pay_targets_basis_check" CHECK ("target_basis" = 'gross'),
  CONSTRAINT "employee_direct_pay_targets_interval_unit_check"
    CHECK ("interval_unit" IN ('week', 'month', 'custom')),
  CONSTRAINT "employee_direct_pay_targets_interval_count_check" CHECK ("interval_count" > 0),
  CONSTRAINT "employee_direct_pay_targets_amount_check" CHECK ("gross_target_amount" > 0),
  CONSTRAINT "employee_direct_pay_targets_rate_check" CHECK ("planning_hourly_rate" > 0),
  CONSTRAINT "employee_direct_pay_targets_period_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "employee_direct_pay_targets_custom_period_check"
    CHECK ("interval_unit" <> 'custom' OR ("effective_to" IS NOT NULL AND "interval_count" = 1)),
  CONSTRAINT "employee_direct_pay_targets_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "employee_direct_pay_targets_archive_state_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "employee_direct_pay_targets_employee_effective_key"
  ON "employee_direct_pay_targets" ("employee_id", "effective_from")
  WHERE "status" = 'active';
CREATE INDEX "employee_direct_pay_targets_active_idx"
  ON "employee_direct_pay_targets" ("employee_id", "effective_from", "effective_to")
  WHERE "status" = 'active';

-- Serialize target writes per employee and reject overlapping active ranges.
-- A trigger avoids depending on btree_gist while remaining concurrency-safe.
CREATE FUNCTION "enforce_employee_direct_pay_target_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('direct-pay-target:' || NEW."employee_id"::text));
  IF NEW."status" = 'active' AND EXISTS (
    SELECT 1
      FROM "employee_direct_pay_targets" existing
     WHERE existing."employee_id" = NEW."employee_id"
       AND existing."status" = 'active'
       AND existing."id" <> NEW."id"
       AND daterange(
             existing."effective_from",
             COALESCE(existing."effective_to", 'infinity'::date),
             '[]'
           ) && daterange(
             NEW."effective_from",
             COALESCE(NEW."effective_to", 'infinity'::date),
             '[]'
           )
  ) THEN
    RAISE EXCEPTION 'active direct-pay targets for one employee cannot overlap'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "employee_direct_pay_targets_range_guard"
  BEFORE INSERT OR UPDATE OF employee_id, effective_from, effective_to, status
  ON "employee_direct_pay_targets"
  FOR EACH ROW EXECUTE FUNCTION "enforce_employee_direct_pay_target_range"();
