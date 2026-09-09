-- New receipt identity is separate from a shared invoice association. Historical
-- references remain untouched; void originals and their payment facts remain.
ALTER TABLE agency_manual_income_entries
  ADD COLUMN payment_reference text,
  ADD COLUMN class_invoice_id uuid REFERENCES class_invoices(id),
  ADD COLUMN replaces_entry_id uuid REFERENCES agency_manual_income_entries(id),
  ADD COLUMN request_id uuid,
  ADD COLUMN request_fingerprint text;
--> statement-breakpoint
DROP INDEX agency_manual_income_entries_source_ref_key;
--> statement-breakpoint
CREATE UNIQUE INDEX agency_manual_income_entries_source_ref_key
  ON agency_manual_income_entries (source_type, lower(btrim(source_ref)))
  WHERE nullif(btrim(source_ref), '') IS NOT NULL AND payment_reference IS NULL AND status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX agency_income_payment_identity_key
  ON agency_manual_income_entries (source_type, lower(btrim(payment_reference)))
  WHERE payment_reference IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX agency_income_request_key ON agency_manual_income_entries (request_id) WHERE request_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX agency_income_replacement_key ON agency_manual_income_entries (replaces_entry_id) WHERE replaces_entry_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE class_cover_sheet_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_invoice_id uuid NOT NULL REFERENCES class_invoices(id),
  version integer NOT NULL CHECK (version >= 2),
  profile_snapshot jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_invoice_id, version)
);
