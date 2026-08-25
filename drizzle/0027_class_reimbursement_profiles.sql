-- Reusable reimbursement-cover details for class invoices. These fields are
-- individual financial records and are only exposed through the class billing
-- access boundary; they never join through employee assignments.

CREATE TABLE "class_reimbursement_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id") ON DELETE CASCADE,
  "mailing_name" text,
  "address_line_1" text,
  "address_line_2" text,
  "city_state_zip" text,
  "phone" text,
  "date_of_birth" date,
  "medicaid_id" text,
  "fiscal_intermediary" text NOT NULL DEFAULT 'Ahivim',
  "payable_to" text NOT NULL DEFAULT 'Xcellent Staffing',
  "life_plan_confirmed" boolean NOT NULL DEFAULT false,
  "budget_category" text NOT NULL DEFAULT 'Community classes',
  "form_completed_by" text,
  "relationship" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_reimbursement_profiles_individual_key" UNIQUE ("individual_id"),
  CONSTRAINT "class_reimbursement_profiles_fi_check" CHECK (length(btrim("fiscal_intermediary")) > 0),
  CONSTRAINT "class_reimbursement_profiles_payable_check" CHECK (length(btrim("payable_to")) > 0),
  CONSTRAINT "class_reimbursement_profiles_category_check" CHECK (length(btrim("budget_category")) > 0)
);--> statement-breakpoint

CREATE INDEX "class_reimbursement_profiles_individual_idx"
  ON "class_reimbursement_profiles" ("individual_id");--> statement-breakpoint

-- The first generated cover sheet freezes the sensitive reimbursement details
-- used for that invoice. Later profile edits apply only to future invoices.
CREATE TABLE "class_cover_sheet_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_invoice_id" uuid NOT NULL REFERENCES "class_invoices"("id"),
  "profile_snapshot" jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "class_cover_sheet_snapshots_invoice_key" UNIQUE ("class_invoice_id")
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_class_cover_snapshot_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'class cover sheet snapshots are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "class_cover_sheet_snapshots_immutable"
  BEFORE UPDATE OR DELETE ON "class_cover_sheet_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "prevent_class_cover_snapshot_mutation"();
