-- A recurring service schedule owns its participants independently of its
-- materialized occurrences. This keeps the series editable even after future
-- sessions are replaced or all occurrences have moved into history.

CREATE TABLE IF NOT EXISTS "schedule_series_individuals" (
  "series_id" uuid NOT NULL,
  "individual_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "schedule_series_individuals_pk" PRIMARY KEY ("series_id", "individual_id"),
  CONSTRAINT "schedule_series_individuals_series_fk"
    FOREIGN KEY ("series_id") REFERENCES "public"."schedule_series"("id") ON DELETE cascade,
  CONSTRAINT "schedule_series_individuals_individual_fk"
    FOREIGN KEY ("individual_id") REFERENCES "public"."individuals"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "schedule_series_individuals_individual_idx"
  ON "schedule_series_individuals" ("individual_id");--> statement-breakpoint

-- Existing series previously held participants only through their generated
-- allocations. Recover the distinct roster before new edits rely on the join.
INSERT INTO "schedule_series_individuals" ("series_id", "individual_id")
SELECT DISTINCT s."series_id", a."individual_id"
  FROM "scheduled_sessions" s
  JOIN "scheduled_allocations" a ON a."scheduled_session_id" = s."id"
 WHERE s."series_id" IS NOT NULL
ON CONFLICT ("series_id", "individual_id") DO NOTHING;
