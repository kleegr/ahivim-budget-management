-- Class revenue is a financial workflow for services billed directly against
-- an individual's annual class allowance. It is deliberately separate from
-- payroll, employee deals, and the hours-only planning workspace.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_see_class_financials" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_manage_class_invoices" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Existing trusted staff retain access. Viewer accounts, including the
-- dedicated budget planner, fail closed until an administrator opts them in.
UPDATE "users"
   SET "can_see_class_financials" = true,
       "can_manage_class_invoices" = true
 WHERE "role" IN ('manager', 'admin');--> statement-breakpoint

CREATE TABLE "class_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "default_unit_price" numeric(14, 4) NOT NULL DEFAULT 150,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_activities_code_check" CHECK (length(btrim("code")) > 0),
  CONSTRAINT "class_activities_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "class_activities_price_check" CHECK ("default_unit_price" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "class_activities_code_key" ON "class_activities" (lower("code"));--> statement-breakpoint
CREATE INDEX "class_activities_active_idx" ON "class_activities" ("is_active", "sort_order", "name");--> statement-breakpoint

INSERT INTO "class_activities" ("code", "name", "default_unit_price", "sort_order")
VALUES
  ('EXERCISE', 'Exercise Class', 150, 10),
  ('ART', 'Art Class', 150, 20),
  ('MUSIC', 'Music Class', 150, 30),
  ('PAINTING', 'Painting Class', 150, 40)
ON CONFLICT (lower("code")) DO NOTHING;--> statement-breakpoint

CREATE TABLE "class_budget_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "label" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "authorized_amount" numeric(14, 4) NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_budget_periods_label_check" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "class_budget_periods_range_check" CHECK ("end_date" >= "start_date"),
  CONSTRAINT "class_budget_periods_amount_check" CHECK ("authorized_amount" >= 0),
  CONSTRAINT "class_budget_periods_status_check" CHECK ("status" IN ('active', 'closed'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "class_budget_periods_exact_active_key"
  ON "class_budget_periods" ("individual_id", "start_date", "end_date")
  WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "class_budget_periods_individual_idx"
  ON "class_budget_periods" ("individual_id", "status", "start_date", "end_date");--> statement-breakpoint

CREATE TABLE "class_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_budget_period_id" uuid NOT NULL REFERENCES "class_budget_periods"("id"),
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "invoice_number" text NOT NULL,
  "invoice_date" date NOT NULL,
  "service_period_start" date NOT NULL,
  "service_period_end" date NOT NULL,
  "bill_to_name" text NOT NULL,
  "bill_to_address_line_1" text,
  "bill_to_address_line_2" text,
  "bill_to_city_state_zip" text,
  "purpose" text NOT NULL DEFAULT 'CLASSES',
  "notes" text,
  "status" text NOT NULL DEFAULT 'draft',
  "subtotal" numeric(14, 4) NOT NULL DEFAULT 0,
  "discount_total" numeric(14, 4) NOT NULL DEFAULT 0,
  "total_amount" numeric(14, 4) NOT NULL DEFAULT 0,
  "budget_authorized_snapshot" numeric(14, 4),
  "budget_consumed_before_snapshot" numeric(14, 4),
  "budget_overage_snapshot" numeric(14, 4),
  "over_budget_override_reason" text,
  "issued_by_user_id" uuid REFERENCES "users"("id"),
  "issued_at" timestamptz,
  "voided_by_user_id" uuid REFERENCES "users"("id"),
  "voided_at" timestamptz,
  "void_reason" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_invoices_number_check" CHECK (length(btrim("invoice_number")) > 0),
  CONSTRAINT "class_invoices_bill_to_check" CHECK (length(btrim("bill_to_name")) > 0),
  CONSTRAINT "class_invoices_purpose_check" CHECK (length(btrim("purpose")) > 0),
  CONSTRAINT "class_invoices_date_check" CHECK (extract(dow FROM "invoice_date") <> 6),
  CONSTRAINT "class_invoices_period_check" CHECK ("service_period_end" >= "service_period_start"),
  CONSTRAINT "class_invoices_totals_check" CHECK (
    "subtotal" >= 0 AND "discount_total" >= 0 AND "total_amount" >= 0
    AND "total_amount" = "subtotal" - "discount_total"
  ),
  CONSTRAINT "class_invoices_status_check" CHECK ("status" IN ('draft', 'issued', 'void')),
  CONSTRAINT "class_invoices_lifecycle_check" CHECK (
    ("status" = 'draft' AND "issued_at" IS NULL AND "voided_at" IS NULL)
    OR
    ("status" = 'issued' AND "issued_at" IS NOT NULL AND "issued_by_user_id" IS NOT NULL
      AND "voided_at" IS NULL AND "voided_by_user_id" IS NULL AND "void_reason" IS NULL
      AND "budget_authorized_snapshot" IS NOT NULL
      AND "budget_consumed_before_snapshot" IS NOT NULL
      AND "budget_overage_snapshot" IS NOT NULL)
    OR
    ("status" = 'void' AND "issued_at" IS NOT NULL AND "issued_by_user_id" IS NOT NULL
      AND "voided_at" IS NOT NULL AND "voided_by_user_id" IS NOT NULL
      AND length(btrim("void_reason")) > 0
      AND "budget_authorized_snapshot" IS NOT NULL
      AND "budget_consumed_before_snapshot" IS NOT NULL
      AND "budget_overage_snapshot" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "class_invoices_number_key" ON "class_invoices" (lower("invoice_number"));--> statement-breakpoint
CREATE INDEX "class_invoices_individual_idx"
  ON "class_invoices" ("individual_id", "status", "invoice_date");--> statement-breakpoint
CREATE INDEX "class_invoices_budget_idx"
  ON "class_invoices" ("class_budget_period_id", "status", "invoice_date");--> statement-breakpoint

CREATE TABLE "class_invoice_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_invoice_id" uuid NOT NULL REFERENCES "class_invoices"("id"),
  "class_activity_id" uuid REFERENCES "class_activities"("id"),
  "service_date" date NOT NULL,
  "description" text NOT NULL,
  "quantity" numeric(10, 4) NOT NULL DEFAULT 1,
  "unit_price" numeric(14, 4) NOT NULL DEFAULT 150,
  "discount_amount" numeric(14, 4) NOT NULL DEFAULT 0,
  "line_total" numeric(14, 4) NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_invoice_lines_description_check" CHECK (length(btrim("description")) > 0),
  CONSTRAINT "class_invoice_lines_saturday_check" CHECK (extract(dow FROM "service_date") <> 6),
  CONSTRAINT "class_invoice_lines_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "class_invoice_lines_price_check" CHECK ("unit_price" >= 0),
  CONSTRAINT "class_invoice_lines_discount_check" CHECK (
    "discount_amount" >= 0 AND "discount_amount" <= round("quantity" * "unit_price", 4)
  ),
  CONSTRAINT "class_invoice_lines_total_check" CHECK (
    "line_total" = round("quantity" * "unit_price" - "discount_amount", 4)
    AND "line_total" >= 0
  )
);--> statement-breakpoint

CREATE INDEX "class_invoice_lines_invoice_idx"
  ON "class_invoice_lines" ("class_invoice_id", "sort_order", "service_date");--> statement-breakpoint
CREATE INDEX "class_invoice_lines_activity_idx" ON "class_invoice_lines" ("class_activity_id");--> statement-breakpoint

-- Signed, append-only budget consumption. Issuing reserves the invoice total;
-- voiding appends the exact negative release rather than rewriting history.
CREATE TABLE "class_budget_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_budget_period_id" uuid NOT NULL REFERENCES "class_budget_periods"("id"),
  "class_invoice_id" uuid NOT NULL REFERENCES "class_invoices"("id"),
  "event_type" text NOT NULL,
  "amount" numeric(14, 4) NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_budget_ledger_event_check" CHECK ("event_type" IN ('issue', 'void')),
  CONSTRAINT "class_budget_ledger_sign_check" CHECK (
    ("event_type" = 'issue' AND "amount" > 0)
    OR ("event_type" = 'void' AND "amount" < 0)
  ),
  CONSTRAINT "class_budget_ledger_invoice_event_key" UNIQUE ("class_invoice_id", "event_type")
);--> statement-breakpoint

CREATE INDEX "class_budget_ledger_budget_idx"
  ON "class_budget_ledger" ("class_budget_period_id", "created_at");--> statement-breakpoint

CREATE VIEW "class_budget_balances" AS
SELECT b."id" AS "class_budget_period_id",
       b."individual_id",
       b."authorized_amount",
       COALESCE(sum(l."amount"), 0)::numeric(14, 4) AS "consumed_amount",
       (b."authorized_amount" - COALESCE(sum(l."amount"), 0))::numeric(14, 4) AS "remaining_amount"
  FROM "class_budget_periods" b
  LEFT JOIN "class_budget_ledger" l ON l."class_budget_period_id" = b."id"
 GROUP BY b."id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_class_invoice_budget"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  budget_individual uuid;
  budget_start date;
  budget_end date;
  budget_status text;
BEGIN
  SELECT "individual_id", "start_date", "end_date", "status"
    INTO budget_individual, budget_start, budget_end, budget_status
    FROM "class_budget_periods"
   WHERE "id" = NEW."class_budget_period_id";

  IF NOT FOUND OR budget_individual IS DISTINCT FROM NEW."individual_id" THEN
    RAISE EXCEPTION 'class invoice individual must match its budget';
  END IF;
  IF budget_status <> 'active' AND NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'new class invoices require an active budget';
  END IF;
  IF NEW."service_period_start" < budget_start OR NEW."service_period_end" > budget_end THEN
    RAISE EXCEPTION 'class invoice service period must be inside its budget period';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_invoices_budget_guard"
  BEFORE INSERT OR UPDATE OF "class_budget_period_id", "individual_id", "service_period_start", "service_period_end", "status"
  ON "class_invoices"
  FOR EACH ROW EXECUTE FUNCTION "enforce_class_invoice_budget"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_class_invoice_line"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_status text;
  period_start date;
  period_end date;
  target_invoice uuid;
  target_date date;
BEGIN
  target_invoice := CASE WHEN TG_OP = 'DELETE' THEN OLD."class_invoice_id" ELSE NEW."class_invoice_id" END;
  target_date := CASE WHEN TG_OP = 'DELETE' THEN OLD."service_date" ELSE NEW."service_date" END;

  SELECT "status", "service_period_start", "service_period_end"
    INTO invoice_status, period_start, period_end
    FROM "class_invoices"
   WHERE "id" = target_invoice
   FOR UPDATE;

  IF NOT FOUND OR invoice_status <> 'draft' THEN
    RAISE EXCEPTION 'class invoice lines are editable only while the invoice is a draft';
  END IF;
  IF TG_OP <> 'DELETE' AND (target_date < period_start OR target_date > period_end) THEN
    RAISE EXCEPTION 'class invoice service date must be inside the invoice service period';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_invoice_lines_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "class_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "enforce_class_invoice_line"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_issued_class_invoice_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'class invoices are audit records and cannot be deleted';
  END IF;

  IF OLD."status" = 'draft' THEN
    IF NEW."status" NOT IN ('draft', 'issued') THEN
      RAISE EXCEPTION 'a draft class invoice may only be edited or issued';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'issued' AND NEW."status" = 'void'
     AND (to_jsonb(NEW) - ARRAY['status', 'voided_by_user_id', 'voided_at', 'void_reason', 'updated_by_user_id', 'updated_at'])
       = (to_jsonb(OLD) - ARRAY['status', 'voided_by_user_id', 'voided_at', 'void_reason', 'updated_by_user_id', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  -- An individual merge may repoint the redundant lookup column after the
  -- invoice's allowance has moved. Financial and lifecycle fields stay frozen.
  IF OLD."status" IN ('issued', 'void')
     AND NEW."individual_id" IS DISTINCT FROM OLD."individual_id"
     AND (to_jsonb(NEW) - 'individual_id') = (to_jsonb(OLD) - 'individual_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'issued and void class invoices are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_invoices_immutable_after_issue"
  BEFORE UPDATE OR DELETE ON "class_invoices"
  FOR EACH ROW EXECUTE FUNCTION "prevent_issued_class_invoice_mutation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_class_budget_ledger_entry"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_budget uuid;
  invoice_status text;
  invoice_total numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'class budget ledger is append-only';
  END IF;

  SELECT "class_budget_period_id", "status", "total_amount"
    INTO invoice_budget, invoice_status, invoice_total
    FROM "class_invoices"
   WHERE "id" = NEW."class_invoice_id"
   FOR SHARE;

  IF NOT FOUND OR invoice_budget IS DISTINCT FROM NEW."class_budget_period_id" THEN
    RAISE EXCEPTION 'class budget ledger must match its invoice budget';
  END IF;
  IF NEW."event_type" = 'issue'
     AND (invoice_status <> 'issued' OR NEW."amount" <> invoice_total) THEN
    RAISE EXCEPTION 'class budget issue entry must match the issued invoice total';
  END IF;
  IF NEW."event_type" = 'void'
     AND (invoice_status <> 'void' OR NEW."amount" <> -invoice_total) THEN
    RAISE EXCEPTION 'class budget void entry must release the issued invoice total';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_budget_ledger_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "class_budget_ledger"
  FOR EACH ROW EXECUTE FUNCTION "enforce_class_budget_ledger_entry"();--> statement-breakpoint

-- The invoice status and its ledger entries must commit together. This is a
-- deferred constraint because the application first freezes the invoice and
-- then appends its issue/void entry within the same transaction.
CREATE OR REPLACE FUNCTION "enforce_class_invoice_ledger_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status text;
  current_total numeric;
  current_budget uuid;
  issue_count integer;
  void_count integer;
BEGIN
  SELECT "status", "total_amount", "class_budget_period_id"
    INTO current_status, current_total, current_budget
    FROM "class_invoices"
   WHERE "id" = NEW."id";

  IF current_status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (
           WHERE "event_type" = 'issue'
             AND "amount" = current_total
             AND "class_budget_period_id" = current_budget
         ),
         count(*) FILTER (
           WHERE "event_type" = 'void'
             AND "amount" = -current_total
             AND "class_budget_period_id" = current_budget
         )
    INTO issue_count, void_count
    FROM "class_budget_ledger"
   WHERE "class_invoice_id" = NEW."id";

  IF issue_count <> 1 OR (current_status = 'void' AND void_count <> 1)
     OR (current_status = 'issued' AND void_count <> 0) THEN
    RAISE EXCEPTION 'issued or void class invoice must match its append-only budget ledger';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "class_invoice_ledger_complete"
  AFTER INSERT OR UPDATE ON "class_invoices"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_class_invoice_ledger_complete"();
