-- Canonical service-program metadata and a neutral, append-only budget ledger.
--
-- `programs` remains the one service catalog. Operational payroll, class
-- invoicing and manually-posted services all consume the same explicit
-- budget-period/authorization model without copying payroll transactions into
-- a second ledger.

ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "service_category" text DEFAULT 'direct_service' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "payment_recipient" text DEFAULT 'agency' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "consumption_source" text DEFAULT 'payroll' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "rate_scope" text DEFAULT 'per_individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "renewal_policy" text DEFAULT 'individual' NOT NULL;--> statement-breakpoint

ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_payment_recipient_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_payment_recipient_check"
  CHECK ("payment_recipient" IN ('agency', 'employee', 'external', 'not_applicable'));--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_consumption_source_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_consumption_source_check"
  CHECK ("consumption_source" IN ('payroll', 'invoice', 'manual', 'mixed'));--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_rate_scope_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_rate_scope_check"
  CHECK ("rate_scope" IN ('per_individual', 'per_group', 'flat'));--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_renewal_policy_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_renewal_policy_check"
  CHECK ("renewal_policy" IN ('individual', 'calendar', 'rolling', 'custom'));--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_required_auth_type_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_required_auth_type_check"
  CHECK ("required_auth_type" IN ('hours', 'dollars', 'both'));--> statement-breakpoint

-- Preserve the known routing semantics of the six imported programs. Defaults
-- alone would incorrectly describe self-hire as agency-paid and group rates as
-- per-person rates.
UPDATE "programs"
   SET "service_category" = 'self_hire',
       "payment_recipient" = 'employee',
       "consumption_source" = 'payroll',
       "rate_scope" = 'per_individual',
       "renewal_policy" = 'individual',
       "updated_at" = now()
 WHERE "code" IN ('SH_COM_HAB', 'SH_RESPITE');--> statement-breakpoint

UPDATE "programs"
   SET "service_category" = 'group_service',
       "payment_recipient" = 'agency',
       "consumption_source" = 'payroll',
       "rate_scope" = 'per_group',
       "renewal_policy" = 'calendar',
       "updated_at" = now()
 WHERE "code" IN ('DAY_HAB', 'SUPP_GROUP_DAY_HAB');--> statement-breakpoint

-- Classes is a service program; activities remain invoice line/SKU records.
INSERT INTO "programs" (
  "code", "name", "is_group_capable", "is_active", "one_to_one_required",
  "groups_allowed", "allow_multiple_employees", "allow_multiple_individuals",
  "allow_individual_rate_override", "self_hire_converts", "required_auth_type",
  "service_category", "payment_recipient", "consumption_source", "rate_scope",
  "renewal_policy", "notes"
)
VALUES (
  'CLASSES', 'Classes', false, true, false,
  false, false, false, false, false, 'dollars',
  'classes', 'agency', 'invoice', 'flat', 'individual',
  'Canonical program for class revenue allowances and invoice consumption.'
)
ON CONFLICT ("code") DO UPDATE SET
  "required_auth_type" = 'dollars',
  "service_category" = 'classes',
  "payment_recipient" = 'agency',
  "consumption_source" = 'invoice',
  "rate_scope" = 'flat',
  "updated_at" = now();--> statement-breakpoint

-- Canonical payment routing. A valid transaction-level attribution is the most
-- specific fact; missing/unknown attribution falls back to the program rule.
CREATE OR REPLACE FUNCTION "effective_payment_recipient"(
  transaction_recipient text,
  program_recipient text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN transaction_recipient IN ('employee', 'excellent_staffing')
      THEN transaction_recipient
    WHEN transaction_recipient IS NULL OR transaction_recipient = 'unknown'
      THEN CASE
        WHEN program_recipient = 'employee' THEN 'employee'
        WHEN program_recipient = 'agency' THEN 'excellent_staffing'
        ELSE 'unknown'
      END
    ELSE 'unknown'
  END;
$$;--> statement-breakpoint

-- Payroll imports do not always populate every available date column. Service
-- consumption follows one immutable precedence rule and never falls back to
-- an ingestion timestamp: period begin, then check date, then period end.
CREATE OR REPLACE FUNCTION "canonical_service_date"(
  period_begin date,
  check_date date,
  period_end date
)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(period_begin, check_date, period_end);
$$;--> statement-breakpoint

-- Keep the legacy budget-board helper on the same service-date rule as the
-- canonical authorization view. Undated rows remain outside utilization.
CREATE OR REPLACE FUNCTION "effective_billed_hours"(
  p_individual_id uuid,
  p_program_id uuid,
  p_start_date date,
  p_end_date date,
  p_budget_rate numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    sum(
      CASE
        WHEN p.code IN ('DAY_HAB', 'SUPP_GROUP_DAY_HAB')
         AND COALESCE(p_budget_rate, 0) > 0
          THEN COALESCE(
                 t.calculated_internal_amount,
                 t.spreadsheet_internal_amount,
                 t.internal_rate_applied * t.imported_hours,
                 0
               ) / p_budget_rate
        ELSE t.imported_hours
      END
    ),
    0
  )
    FROM payroll_transactions t
    JOIN programs p ON p.id = t.program_id
   WHERE t.individual_id = p_individual_id
     AND t.program_id = p_program_id
     AND canonical_service_date(t.period_begin, t.check_date, t.period_end)
         BETWEEN p_start_date AND p_end_date;
$$;--> statement-breakpoint

-- One individual cannot have overlapping active periods for the same program.
-- This invariant belongs in PostgreSQL because Classes, merges, imports, and
-- operational APIs all write authorizations. The transaction lock closes the
-- check-then-insert race between otherwise independent periods.
CREATE OR REPLACE FUNCTION "enforce_active_authorization_non_overlap"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  period_start date;
  period_end date;
  period_status text;
  period_archived_at timestamptz;
BEGIN
  IF NEW."status" <> 'active' OR NEW."archived_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT bp."start_date", bp."end_date", bp."status", bp."archived_at"
    INTO period_start, period_end, period_status, period_archived_at
    FROM "budget_periods" bp
   WHERE bp."id" = NEW."budget_period_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF period_status <> 'active' OR period_archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('budget_authorization:' || NEW."individual_id"::text || ':' || NEW."program_id"::text, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM "budget_authorizations" existing
      JOIN "budget_periods" existing_period
        ON existing_period."id" = existing."budget_period_id"
     WHERE existing."id" <> NEW."id"
       AND existing."individual_id" = NEW."individual_id"
       AND existing."program_id" = NEW."program_id"
       AND existing."status" = 'active'
       AND existing."archived_at" IS NULL
       AND existing_period."status" = 'active'
       AND existing_period."archived_at" IS NULL
       AND daterange(existing_period."start_date", existing_period."end_date", '[]')
           && daterange(period_start, period_end, '[]')
  ) THEN
    RAISE EXCEPTION 'active program authorization periods may not overlap for one individual'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "budget_authorizations_non_overlap_guard"
  BEFORE INSERT OR UPDATE OF "budget_period_id", "individual_id", "program_id", "status", "archived_at"
  ON "budget_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "enforce_active_authorization_non_overlap"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_active_budget_period_non_overlap"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorization record;
BEGIN
  IF NEW."status" <> 'active' OR NEW."archived_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  FOR authorization IN
    SELECT ba."id", ba."program_id"
      FROM "budget_authorizations" ba
     WHERE ba."budget_period_id" = NEW."id"
       AND ba."status" = 'active'
       AND ba."archived_at" IS NULL
     ORDER BY ba."program_id"
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('budget_authorization:' || NEW."individual_id"::text || ':' || authorization."program_id"::text, 0)
    );
    IF EXISTS (
      SELECT 1
        FROM "budget_authorizations" existing
        JOIN "budget_periods" existing_period
          ON existing_period."id" = existing."budget_period_id"
       WHERE existing."id" <> authorization."id"
         AND existing."individual_id" = NEW."individual_id"
         AND existing."program_id" = authorization."program_id"
         AND existing."status" = 'active'
         AND existing."archived_at" IS NULL
         AND existing_period."status" = 'active'
         AND existing_period."archived_at" IS NULL
         AND daterange(existing_period."start_date", existing_period."end_date", '[]')
             && daterange(NEW."start_date", NEW."end_date", '[]')
    ) THEN
      RAISE EXCEPTION 'active program authorization periods may not overlap for one individual'
        USING ERRCODE = '23P01';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "budget_periods_non_overlap_guard"
  BEFORE UPDATE OF "individual_id", "start_date", "end_date", "status", "archived_at"
  ON "budget_periods"
  FOR EACH ROW EXECUTE FUNCTION "enforce_active_budget_period_non_overlap"();--> statement-breakpoint

CREATE TABLE "program_budget_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "budget_period_id" uuid NOT NULL REFERENCES "budget_periods"("id"),
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "program_id" uuid NOT NULL REFERENCES "programs"("id"),
  "event_type" text NOT NULL,
  "service_date" date NOT NULL,
  "hours" numeric(10, 4) DEFAULT '0' NOT NULL,
  "amount" numeric(14, 4) DEFAULT '0' NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "reverses_event_id" uuid REFERENCES "program_budget_events"("id"),
  "note" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "program_budget_events_type_check"
    CHECK ("event_type" IN ('consume', 'adjust', 'reverse')),
  CONSTRAINT "program_budget_events_value_check"
    CHECK (
      ("event_type" = 'consume' AND "hours" >= 0 AND "amount" >= 0 AND ("hours" > 0 OR "amount" > 0))
      OR ("event_type" = 'adjust' AND ("hours" <> 0 OR "amount" <> 0))
      OR ("event_type" = 'reverse' AND ("hours" <> 0 OR "amount" <> 0))
    ),
  CONSTRAINT "program_budget_events_reverse_link_check"
    CHECK (("event_type" = 'reverse') = ("reverses_event_id" IS NOT NULL)),
  CONSTRAINT "program_budget_events_source_key"
    UNIQUE ("source_type", "source_id", "event_type")
);--> statement-breakpoint

CREATE UNIQUE INDEX "program_budget_events_one_reversal_key"
  ON "program_budget_events" ("reverses_event_id")
  WHERE "reverses_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "program_budget_events_budget_idx"
  ON "program_budget_events" ("budget_period_id", "program_id", "service_date", "created_at");--> statement-breakpoint
CREATE INDEX "program_budget_events_individual_idx"
  ON "program_budget_events" ("individual_id", "service_date");--> statement-breakpoint

-- Link the existing Classes subsystem to the canonical program budget. These
-- columns stay nullable so an imported/legacy allowance can be repaired without
-- losing its invoice history; all service-created allowances populate them.
ALTER TABLE "class_budget_periods" ADD COLUMN IF NOT EXISTS "program_id" uuid REFERENCES "programs"("id");--> statement-breakpoint
ALTER TABLE "class_budget_periods" ADD COLUMN IF NOT EXISTS "budget_period_id" uuid REFERENCES "budget_periods"("id");--> statement-breakpoint
ALTER TABLE "class_budget_periods" ADD COLUMN IF NOT EXISTS "budget_authorization_id" uuid REFERENCES "budget_authorizations"("id");--> statement-breakpoint

UPDATE "class_budget_periods" cb
   SET "program_id" = p."id"
  FROM "programs" p
 WHERE p."code" = 'CLASSES'
   AND cb."program_id" IS NULL;--> statement-breakpoint

WITH inserted AS (
  INSERT INTO "budget_periods" (
    "individual_id", "label", "start_date", "end_date", "period_type",
    "renewal_date", "status", "source", "notes", "archived_at",
    "created_at", "updated_at"
  )
  SELECT cb."individual_id", cb."label", cb."start_date", cb."end_date", 'custom',
         NULL, cb."status", 'class_bridge:' || cb."id"::text, cb."notes",
         CASE WHEN cb."status" = 'closed' THEN cb."updated_at" ELSE NULL END,
         cb."created_at", cb."updated_at"
    FROM "class_budget_periods" cb
   WHERE cb."budget_period_id" IS NULL
  RETURNING "id", "source"
)
UPDATE "class_budget_periods" cb
   SET "budget_period_id" = i."id"
  FROM inserted i
 WHERE cb."budget_period_id" IS NULL
   AND i."source" = 'class_bridge:' || cb."id"::text;--> statement-breakpoint

WITH inserted AS (
  INSERT INTO "budget_authorizations" (
    "budget_period_id", "individual_id", "program_id", "authorized_hours",
    "internal_rate", "authorized_dollars", "rate_basis", "revision", "status",
    "source", "notes", "created_by_user_id", "created_at", "updated_at"
  )
  SELECT cb."budget_period_id", cb."individual_id", cb."program_id", 0,
         0, cb."authorized_amount", 'dollars', 1, 'active',
         'class_bridge', cb."notes", cb."created_by_user_id", cb."created_at", cb."updated_at"
    FROM "class_budget_periods" cb
   WHERE cb."budget_period_id" IS NOT NULL
     AND cb."program_id" IS NOT NULL
     AND cb."budget_authorization_id" IS NULL
  ON CONFLICT DO NOTHING
  RETURNING "id", "budget_period_id", "program_id"
)
UPDATE "class_budget_periods" cb
   SET "budget_authorization_id" = i."id"
  FROM inserted i
 WHERE cb."budget_period_id" = i."budget_period_id"
   AND cb."program_id" = i."program_id"
   AND cb."budget_authorization_id" IS NULL;--> statement-breakpoint

-- If an earlier partial run inserted the authorization but not the link, repair
-- it from the active canonical row.
UPDATE "class_budget_periods" cb
   SET "budget_authorization_id" = ba."id"
  FROM "budget_authorizations" ba
 WHERE cb."budget_authorization_id" IS NULL
   AND ba."budget_period_id" = cb."budget_period_id"
   AND ba."program_id" = cb."program_id"
   AND ba."status" = 'active';--> statement-breakpoint

-- Preserve issued/void class history in the generic ledger before the runtime
-- guard is installed. `source_id` is the immutable class invoice id.
INSERT INTO "program_budget_events" (
  "budget_period_id", "individual_id", "program_id", "event_type",
  "service_date", "hours", "amount", "source_type", "source_id", "note",
  "created_by_user_id", "created_at"
)
SELECT cb."budget_period_id", cb."individual_id", cb."program_id", 'consume',
       ci."service_period_end", 0, l."amount", 'class_invoice', ci."id"::text,
       'Backfilled from the class invoice issue ledger.', l."created_by_user_id", l."created_at"
  FROM "class_budget_ledger" l
  JOIN "class_invoices" ci ON ci."id" = l."class_invoice_id"
  JOIN "class_budget_periods" cb ON cb."id" = l."class_budget_period_id"
 WHERE l."event_type" = 'issue'
   AND cb."budget_period_id" IS NOT NULL
   AND cb."program_id" IS NOT NULL
ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING;--> statement-breakpoint

INSERT INTO "program_budget_events" (
  "budget_period_id", "individual_id", "program_id", "event_type",
  "service_date", "hours", "amount", "source_type", "source_id",
  "reverses_event_id", "note", "created_by_user_id", "created_at"
)
SELECT cb."budget_period_id", cb."individual_id", cb."program_id", 'reverse',
       ci."service_period_end", 0, l."amount", 'class_invoice', ci."id"::text,
       original."id", 'Backfilled from the class invoice void ledger.',
       l."created_by_user_id", l."created_at"
  FROM "class_budget_ledger" l
  JOIN "class_invoices" ci ON ci."id" = l."class_invoice_id"
  JOIN "class_budget_periods" cb ON cb."id" = l."class_budget_period_id"
  JOIN "program_budget_events" original
    ON original."source_type" = 'class_invoice'
   AND original."source_id" = ci."id"::text
   AND original."event_type" = 'consume'
 WHERE l."event_type" = 'void'
   AND cb."budget_period_id" IS NOT NULL
   AND cb."program_id" IS NOT NULL
ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_program_budget_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  period_individual uuid;
  period_start date;
  period_end date;
  period_status text;
  auth_type text;
  original "program_budget_events"%ROWTYPE;
BEGIN
  -- Identity merges may repoint the redundant individual lookup while every
  -- financial/source field remains byte-for-byte unchanged.
  IF TG_OP = 'UPDATE'
     AND NEW."individual_id" IS DISTINCT FROM OLD."individual_id"
     AND (to_jsonb(NEW) - 'individual_id') = (to_jsonb(OLD) - 'individual_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'program budget events are append-only';
  END IF;

  SELECT bp."individual_id", bp."start_date", bp."end_date", bp."status",
         p."required_auth_type"
    INTO period_individual, period_start, period_end, period_status, auth_type
    FROM "budget_periods" bp
    JOIN "programs" p ON p."id" = NEW."program_id"
   WHERE bp."id" = NEW."budget_period_id";

  IF NOT FOUND OR period_individual IS DISTINCT FROM NEW."individual_id" THEN
    RAISE EXCEPTION 'program budget event individual must match its budget period';
  END IF;
  IF NEW."service_date" < period_start OR NEW."service_date" > period_end THEN
    RAISE EXCEPTION 'program budget event service date must be inside its budget period';
  END IF;

  IF NEW."event_type" = 'reverse' THEN
    SELECT * INTO original
      FROM "program_budget_events"
     WHERE "id" = NEW."reverses_event_id"
     FOR SHARE;
    IF NOT FOUND OR original."event_type" = 'reverse'
       OR original."budget_period_id" IS DISTINCT FROM NEW."budget_period_id"
       OR original."individual_id" IS DISTINCT FROM NEW."individual_id"
       OR original."program_id" IS DISTINCT FROM NEW."program_id"
       OR original."service_date" IS DISTINCT FROM NEW."service_date"
       OR original."source_type" IS DISTINCT FROM NEW."source_type"
       OR original."source_id" IS DISTINCT FROM NEW."source_id"
       OR NEW."hours" <> -original."hours"
       OR NEW."amount" <> -original."amount" THEN
      RAISE EXCEPTION 'program budget reversal must exactly negate its source event';
    END IF;
  ELSE
    IF period_status <> 'active' THEN
      RAISE EXCEPTION 'new program budget consumption requires an active budget period';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "budget_authorizations" ba
       WHERE ba."budget_period_id" = NEW."budget_period_id"
         AND ba."program_id" = NEW."program_id"
         AND ba."status" = 'active'
    ) THEN
      RAISE EXCEPTION 'program budget event requires an active authorization';
    END IF;
  END IF;

  IF auth_type = 'hours' AND NEW."hours" = 0 THEN
    RAISE EXCEPTION 'this program requires an hours value';
  ELSIF auth_type = 'dollars' AND NEW."amount" = 0 THEN
    RAISE EXCEPTION 'this program requires a dollar value';
  ELSIF auth_type = 'both' AND (NEW."hours" = 0 OR NEW."amount" = 0) THEN
    RAISE EXCEPTION 'this program requires both hours and dollars';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "program_budget_events_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "program_budget_events"
  FOR EACH ROW EXECUTE FUNCTION "enforce_program_budget_event"();--> statement-breakpoint

-- Keep the canonical person link aligned when the individual merge workflow
-- repoints a legacy class allowance.
CREATE OR REPLACE FUNCTION "sync_class_budget_program_person"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."budget_period_id" IS NOT NULL THEN
    UPDATE "budget_periods"
       SET "individual_id" = NEW."individual_id", "updated_at" = now()
     WHERE "id" = NEW."budget_period_id";
    UPDATE "budget_authorizations"
       SET "individual_id" = NEW."individual_id", "updated_at" = now()
     WHERE "budget_period_id" = NEW."budget_period_id"
       AND "program_id" = NEW."program_id";
    UPDATE "program_budget_events"
       SET "individual_id" = NEW."individual_id"
     WHERE "budget_period_id" = NEW."budget_period_id"
       AND "program_id" = NEW."program_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_budget_program_person_sync"
  AFTER UPDATE OF "individual_id" ON "class_budget_periods"
  FOR EACH ROW
  WHEN (OLD."individual_id" IS DISTINCT FROM NEW."individual_id")
  EXECUTE FUNCTION "sync_class_budget_program_person"();--> statement-breakpoint

-- Payroll remains authoritative for payroll-backed programs; invoice/manual
-- programs use the neutral event ledger. Adjustments are always included.
CREATE VIEW "program_budget_balances" AS
WITH active_authorizations AS (
  SELECT ba."id" AS "authorization_id", ba."budget_period_id", ba."individual_id",
         ba."program_id", ba."authorized_hours", ba."authorized_dollars",
         ba."internal_rate", ba."agency_rate", ba."individual_rate_override",
         ba."notes", ba."revision", bp."label" AS "period_label",
         bp."start_date", bp."end_date", bp."renewal_date", bp."period_type",
         bp."status" AS "period_status", i."display_name" AS "individual_name",
         p."code" AS "program_code", p."name" AS "program_name",
         p."required_auth_type", p."service_category", p."payment_recipient",
         p."consumption_source", p."rate_scope", p."renewal_policy",
         p."allow_individual_rate_override"
    FROM "budget_authorizations" ba
    JOIN "budget_periods" bp ON bp."id" = ba."budget_period_id"
    JOIN "individuals" i ON i."id" = ba."individual_id"
    JOIN "programs" p ON p."id" = ba."program_id"
   WHERE ba."status" = 'active'
     AND ba."archived_at" IS NULL
     AND bp."archived_at" IS NULL
),
payroll_usage AS (
  SELECT a."budget_period_id", a."program_id",
         COALESCE(sum(
           CASE
             WHEN a."rate_scope" = 'per_group' AND COALESCE(a."internal_rate", 0) > 0
               THEN COALESCE(
                      t."calculated_internal_amount",
                      t."spreadsheet_internal_amount",
                      t."internal_rate_applied" * t."imported_hours",
                      0
                    ) / a."internal_rate"
             ELSE COALESCE(t."imported_hours", 0)
           END
         ), 0)::numeric(10, 4) AS "hours",
         COALESCE(sum(COALESCE(t."imported_amount", 0)), 0)::numeric(14, 4) AS "amount"
    FROM active_authorizations a
    LEFT JOIN "payroll_transactions" t
     ON a."consumption_source" IN ('payroll', 'mixed')
     AND t."individual_id" = a."individual_id"
     AND t."program_id" = a."program_id"
     AND canonical_service_date(t."period_begin", t."check_date", t."period_end")
         BETWEEN a."start_date" AND a."end_date"
   GROUP BY a."budget_period_id", a."program_id"
),
undated_payroll_usage AS (
  SELECT a."authorization_id", count(t."id")::integer AS "undated_usage_count"
    FROM active_authorizations a
    LEFT JOIN "payroll_transactions" t
      ON a."consumption_source" IN ('payroll', 'mixed')
     AND t."individual_id" = a."individual_id"
     AND t."program_id" = a."program_id"
     AND canonical_service_date(t."period_begin", t."check_date", t."period_end") IS NULL
   GROUP BY a."authorization_id"
),
event_usage AS (
  SELECT e."budget_period_id", e."program_id",
         COALESCE(sum(e."hours"), 0)::numeric(10, 4) AS "hours",
         COALESCE(sum(e."amount"), 0)::numeric(14, 4) AS "amount"
    FROM "program_budget_events" e
   GROUP BY e."budget_period_id", e."program_id"
)
SELECT a.*,
       (COALESCE(pu."hours", 0) + COALESCE(eu."hours", 0))::numeric(10, 4) AS "consumed_hours",
       (COALESCE(pu."amount", 0) + COALESCE(eu."amount", 0))::numeric(14, 4) AS "consumed_dollars",
       (a."authorized_hours" - COALESCE(pu."hours", 0) - COALESCE(eu."hours", 0))::numeric(10, 4) AS "remaining_hours",
       CASE WHEN a."authorized_dollars" IS NULL THEN NULL
            ELSE (a."authorized_dollars" - COALESCE(pu."amount", 0) - COALESCE(eu."amount", 0))::numeric(14, 4)
       END AS "remaining_dollars",
       COALESCE(upu."undated_usage_count", 0)::integer AS "undated_usage_count",
       COALESCE(upu."undated_usage_count", 0) > 0 AS "has_undated_usage"
  FROM active_authorizations a
  LEFT JOIN payroll_usage pu
    ON pu."budget_period_id" = a."budget_period_id" AND pu."program_id" = a."program_id"
  LEFT JOIN undated_payroll_usage upu
    ON upu."authorization_id" = a."authorization_id"
  LEFT JOIN event_usage eu
    ON eu."budget_period_id" = a."budget_period_id" AND eu."program_id" = a."program_id";
