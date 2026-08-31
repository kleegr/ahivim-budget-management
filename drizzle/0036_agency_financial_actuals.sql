-- Owner financial actuals: auditable other income, per-person program splits,
-- and per employee/person agency-routed compensation terms.

CREATE TABLE "individual_program_revenue_terms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "program_id" uuid NOT NULL REFERENCES "programs"("id"),
  "agency_share_percent" numeric(9, 6) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "revision" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "individual_program_revenue_terms_share_check"
    CHECK ("agency_share_percent" BETWEEN 0 AND 1),
  CONSTRAINT "individual_program_revenue_terms_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "individual_program_revenue_terms_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "individual_program_revenue_terms_status_check"
    CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "individual_program_revenue_terms_archive_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "individual_program_revenue_terms_active_key"
  ON "individual_program_revenue_terms" ("individual_id", "program_id", "effective_from")
  WHERE "status" = 'active';--> statement-breakpoint

CREATE INDEX "individual_program_revenue_terms_lookup_idx"
  ON "individual_program_revenue_terms" ("individual_id", "program_id", "effective_from", "effective_to")
  WHERE "status" = 'active';--> statement-breakpoint

CREATE TABLE "employee_individual_compensation_terms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id"),
  "employee_share_percent" numeric(9, 6) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "revision" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "archived_by_user_id" uuid REFERENCES "users"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "employee_individual_compensation_terms_share_check"
    CHECK ("employee_share_percent" BETWEEN 0 AND 1),
  CONSTRAINT "employee_individual_compensation_terms_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "employee_individual_compensation_terms_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "employee_individual_compensation_terms_status_check"
    CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "employee_individual_compensation_terms_archive_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "employee_individual_compensation_terms_active_key"
  ON "employee_individual_compensation_terms" ("employee_id", "individual_id", "effective_from")
  WHERE "status" = 'active';--> statement-breakpoint

CREATE INDEX "employee_individual_compensation_terms_lookup_idx"
  ON "employee_individual_compensation_terms" ("employee_id", "individual_id", "effective_from", "effective_to")
  WHERE "status" = 'active';--> statement-breakpoint

CREATE TRIGGER "employee_individual_compensation_terms_settlement_dirty"
  BEFORE INSERT OR UPDATE OR DELETE ON "employee_individual_compensation_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION "mark_settlement_ledger_dirty"();--> statement-breakpoint

CREATE TABLE "agency_manual_income_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_date" date NOT NULL,
  "source_type" text NOT NULL,
  "individual_id" uuid REFERENCES "individuals"("id"),
  "program_id" uuid REFERENCES "programs"("id"),
  "gross_amount" numeric(14, 4) NOT NULL,
  "agency_share_percent" numeric(9, 6) NOT NULL,
  "agency_amount" numeric(14, 4) NOT NULL,
  "individual_amount" numeric(14, 4) NOT NULL,
  "source_ref" text,
  "notes" text,
  "program_budget_event_id" uuid REFERENCES "program_budget_events"("id"),
  "program_budget_reversal_event_id" uuid REFERENCES "program_budget_events"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "void_reason" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "voided_by_user_id" uuid REFERENCES "users"("id"),
  "voided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agency_manual_income_entries_type_check"
    CHECK ("source_type" IN ('class', 'reimbursement', 'custom_program', 'other')),
  CONSTRAINT "agency_manual_income_entries_gross_check" CHECK ("gross_amount" > 0),
  CONSTRAINT "agency_manual_income_entries_share_check"
    CHECK ("agency_share_percent" BETWEEN 0 AND 1),
  CONSTRAINT "agency_manual_income_entries_amounts_check"
    CHECK ("agency_amount" >= 0 AND "individual_amount" >= 0
      AND "agency_amount" + "individual_amount" = "gross_amount"),
  CONSTRAINT "agency_manual_income_entries_custom_program_check"
    CHECK ("source_type" <> 'custom_program' OR ("individual_id" IS NOT NULL AND "program_id" IS NOT NULL)),
  CONSTRAINT "agency_manual_income_entries_status_check"
    CHECK ("status" IN ('active', 'void')),
  CONSTRAINT "agency_manual_income_entries_void_check"
    CHECK (("status" = 'active' AND "voided_at" IS NULL AND "voided_by_user_id" IS NULL AND "void_reason" IS NULL)
      OR ("status" = 'void' AND "voided_at" IS NOT NULL AND "voided_by_user_id" IS NOT NULL
        AND length(btrim("void_reason")) >= 5))
);--> statement-breakpoint

CREATE UNIQUE INDEX "agency_manual_income_entries_source_ref_key"
  ON "agency_manual_income_entries" ("source_type", lower(btrim("source_ref")))
  WHERE nullif(btrim("source_ref"), '') IS NOT NULL;--> statement-breakpoint

CREATE INDEX "agency_manual_income_entries_date_idx"
  ON "agency_manual_income_entries" ("service_date", "status");--> statement-breakpoint

CREATE INDEX "agency_manual_income_entries_person_program_idx"
  ON "agency_manual_income_entries" ("individual_id", "program_id", "service_date");
