-- Structured provenance and review ledger for the legacy Calculations workbook.
-- Every source row can be retained, including rows that are intentionally not
-- imported because identity or spreadsheet structure needs human review.

CREATE TABLE IF NOT EXISTS "calculation_strategy_import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "strategy_id" uuid REFERENCES "calculation_strategies"("id") ON DELETE SET NULL,
  "individual_id" uuid REFERENCES "individuals"("id") ON DELETE SET NULL,
  "source_file_name" text NOT NULL,
  "source_sheet_name" text NOT NULL,
  "source_row_number" integer NOT NULL,
  "source_checksum_sha256" text NOT NULL,
  "source_row_hash_sha256" text NOT NULL,
  "source_individual_label" text NOT NULL,
  "strategy_label" text NOT NULL,
  "classification" text NOT NULL,
  "source_snapshot" jsonb NOT NULL,
  "reconciliation" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "applied_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "calculation_strategy_import_rows_row_check"
    CHECK ("source_row_number" > 0),
  CONSTRAINT "calculation_strategy_import_rows_classification_check"
    CHECK ("classification" IN (
      'exact', 'missing', 'different', 'ambiguous',
      'duplicate', 'historical', 'needs-review'
    ))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "calculation_strategy_import_rows_source_key"
  ON "calculation_strategy_import_rows"
    ("source_checksum_sha256", "source_sheet_name", "source_row_number");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "calculation_strategy_import_rows_strategy_idx"
  ON "calculation_strategy_import_rows" ("strategy_id", "created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "calculation_strategy_import_rows_individual_idx"
  ON "calculation_strategy_import_rows" ("individual_id", "created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "calculation_strategy_import_rows_review_idx"
  ON "calculation_strategy_import_rows" ("classification", "created_at");
