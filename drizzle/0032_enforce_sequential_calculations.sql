-- Individual allocation cuts always run in sequence: cut 1 applies to the
-- selected gross basis, then cut 2 applies to the remainder. Remove the old
-- configurable mode and preserve any active parallel result as a superseded
-- revision before creating its corrected sequential successor.

UPDATE "app_settings"
   SET "value" = ("value" - 'cutOrder') || '{"cutMethod":"sequential"}'::jsonb,
       "updated_at" = now()
 WHERE "key" = 'calculation_defaults';--> statement-breakpoint

UPDATE "budget_calculations" b
   SET "formula_version" = 'v1-parallel-legacy',
       "reason" = concat_ws(E'\n', NULLIF(b."reason", ''),
         'Historical parallel-cut result retained for audit; sequential cuts are now mandatory.'),
       "updated_at" = now()
 WHERE b."status" <> 'active'
   AND b."cut1_amount" IS NOT NULL
   AND b."cut2_amount" IS NOT NULL
   AND b."cut2_percent" IS NOT NULL
   AND abs(b."cut2_amount" - round(
         (CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
         * b."cut2_percent", 4
       )) <= 0.0001
   AND abs(b."cut2_amount" - round(
         ((CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
          - b."cut1_amount") * b."cut2_percent", 4
       )) > 0.0001;--> statement-breakpoint

WITH "parallel_active" AS (
  SELECT b.*,
         round(
           ((CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
            - b."cut1_amount") * b."cut2_percent",
           4
         ) AS "sequential_cut2",
         b."cut2_amount" - round(
           ((CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
            - b."cut1_amount") * b."cut2_percent",
           4
         ) AS "output_delta"
    FROM "budget_calculations" b
   WHERE b."status" = 'active'
     AND b."cut1_amount" IS NOT NULL
     AND b."cut2_amount" IS NOT NULL
     AND b."cut2_percent" IS NOT NULL
     AND abs(b."cut2_amount" - round(
           (CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
           * b."cut2_percent", 4
         )) <= 0.0001
     AND abs(b."cut2_amount" - round(
           ((CASE WHEN b."basis" = 'monthly' THEN b."monthly_gross" ELSE b."annual_gross" END)
            - b."cut1_amount") * b."cut2_percent", 4
         )) > 0.0001
), "retired" AS (
  UPDATE "budget_calculations" b
     SET "status" = 'superseded',
         "formula_version" = 'v1-parallel-legacy',
         "reason" = concat_ws(E'\n', NULLIF(b."reason", ''),
           'Superseded by the mandatory sequential-cut correction.'),
         "updated_at" = now()
    FROM "parallel_active" source
   WHERE b."id" = source."id"
  RETURNING source.*
)
INSERT INTO "budget_calculations" (
  "individual_id", "program_id", "budget_period_id",
  "annual_authorized_hours", "annual_authorized_dollars", "program_rate",
  "individual_rate_override", "effective_rate", "months", "annual_gross",
  "monthly_gross", "cut1_percent", "cut1_amount", "cut2_percent",
  "cut2_amount", "clock_adjustment", "final_gross", "final_net", "after_all",
  "agency_additional", "basis", "formula_version", "spreadsheet_value",
  "revision", "supersedes_id", "status", "effective_from", "notes", "reason",
  "created_by_user_id", "archived_at"
)
SELECT source."individual_id", source."program_id", source."budget_period_id",
       source."annual_authorized_hours", source."annual_authorized_dollars",
       source."program_rate", source."individual_rate_override", source."effective_rate",
       source."months", source."annual_gross", source."monthly_gross",
       source."cut1_percent", source."cut1_amount", source."cut2_percent",
       source."sequential_cut2", source."clock_adjustment",
       source."final_gross" + source."output_delta",
       source."final_net" + source."output_delta",
       source."after_all" + source."output_delta",
       source."agency_additional", source."basis", 'v2-sequential',
       source."spreadsheet_value", source."revision" + 1, source."id", 'active',
       source."effective_from", source."notes",
       'System correction: second cut recalculated from the remainder after the first cut.',
       source."created_by_user_id", NULL
  FROM "retired" source;
