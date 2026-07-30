-- Phase 6: connect people split across the two workbook tabs. The Calculations
-- and Ahivim tabs spell some names differently (Markowitz/Markovitz,
-- Fleishman/Fleischman, Duestch/Deutsch), so the seed created a few duplicate
-- `individuals` rows. This adds a review queue for uncertain matches and an
-- audit pointer for merges. Additive and data-preserving.

-- A survivor pointer: when an individual is merged into another, it is archived
-- and points at the row it was folded into (for audit + "merged" display).
ALTER TABLE "individuals" ADD COLUMN IF NOT EXISTS "merged_into_id" uuid REFERENCES "individuals"("id");--> statement-breakpoint

-- Uncertain match candidates awaiting a human decision. Confident matches are
-- merged automatically and never appear here; rejected pairs are remembered so
-- they are not re-suggested.
CREATE TABLE IF NOT EXISTS "individual_match_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "keep_individual_id" uuid NOT NULL REFERENCES "individuals"("id") ON DELETE CASCADE,
  "merge_individual_id" uuid NOT NULL REFERENCES "individuals"("id") ON DELETE CASCADE,
  "score" numeric(6, 4) NOT NULL DEFAULT 0,
  "reason" text,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by_user_id" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "individual_match_reviews_pair_unique" UNIQUE ("keep_individual_id", "merge_individual_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "individual_match_reviews_status_idx"
  ON "individual_match_reviews" ("status");
