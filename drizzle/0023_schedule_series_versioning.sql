-- A future-dated recurring schedule edit creates a successor instead of
-- rewriting the current series before the change becomes effective. The
-- anchor retains every-N-day / every-N-week phase independently of the
-- successor's effective start date.

ALTER TABLE "schedule_series"
  ADD COLUMN IF NOT EXISTS "recurrence_anchor_date" date;--> statement-breakpoint

UPDATE "schedule_series"
   SET "recurrence_anchor_date" = "start_date"
 WHERE "recurrence_anchor_date" IS NULL;--> statement-breakpoint

ALTER TABLE "schedule_series"
  ALTER COLUMN "recurrence_anchor_date" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "schedule_series"
  ADD COLUMN IF NOT EXISTS "supersedes_series_id" uuid
  REFERENCES "public"."schedule_series"("id") ON DELETE set null;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_series_one_live_successor_key"
  ON "schedule_series" ("supersedes_series_id")
  WHERE "supersedes_series_id" IS NOT NULL AND "archived_at" IS NULL;--> statement-breakpoint

-- Participant membership is a set. Older direct API calls could repeat an
-- individual, so repair those rows before enforcing the invariant.
WITH duplicate_allocations AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "scheduled_session_id", "individual_id"
           ORDER BY "created_at", "id"
         ) AS duplicate_number
    FROM "scheduled_allocations"
)
DELETE FROM "scheduled_allocations"
 WHERE "id" IN (
   SELECT "id" FROM duplicate_allocations WHERE duplicate_number > 1
 );--> statement-breakpoint

UPDATE "scheduled_sessions" session
   SET "group_size" = allocation_totals.participant_count,
       "is_group" = allocation_totals.participant_count > 1,
       "expected_agency_gross" = CASE
         WHEN session."expected_rate" IS NULL THEN NULL
         ELSE session."expected_rate" * session."duration_hours" * allocation_totals.participant_count
       END,
       "expected_internal_amount" = allocation_totals.internal_amount,
       "expected_agency_additional" = CASE
         WHEN session."expected_rate" IS NULL OR allocation_totals.internal_amount IS NULL THEN NULL
         ELSE session."expected_rate" * session."duration_hours" * allocation_totals.participant_count
              - allocation_totals.internal_amount
       END
  FROM (
    SELECT "scheduled_session_id",
           count(*)::integer AS participant_count,
           CASE
             WHEN count("allocated_amount") = count(*) THEN sum("allocated_amount")
             ELSE NULL
           END AS internal_amount
      FROM "scheduled_allocations"
     GROUP BY "scheduled_session_id"
  ) allocation_totals
 WHERE session."id" = allocation_totals."scheduled_session_id";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_allocations_one_individual_key"
  ON "scheduled_allocations" ("scheduled_session_id", "individual_id");
