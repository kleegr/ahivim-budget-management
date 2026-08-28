-- The agency migration originally inferred budget responsibility only from
-- physical budget_authorizations. Existing hourly budgets are calculation
-- strategies (exposed as virtual authorizations), so the home agency was
-- incorrectly classified as billing-only for those individuals.
UPDATE "agency_individuals" membership
   SET "manages_budget" = (
         NOT membership."bills_services"
         OR EXISTS (
           SELECT 1
             FROM "calculation_strategies" strategy
            WHERE strategy."individual_id" = membership."individual_id"
              AND strategy."status" = 'active'
         )
         OR EXISTS (
           SELECT 1
             FROM "budget_authorizations" budget_auth
            WHERE budget_auth."individual_id" = membership."individual_id"
              AND budget_auth."status" = 'active'
              AND budget_auth."archived_at" IS NULL
         )
       ),
       "updated_at" = now()
  FROM "agencies" agency
 WHERE agency."id" = membership."agency_id"
   AND agency."is_home_agency" = true
   AND membership."is_active" = true
   -- Prepare scheduled memberships too; only ended history is excluded.
   AND (
     membership."effective_to" IS NULL
     OR membership."effective_to" >= (now() AT TIME ZONE 'America/New_York')::date
   )
   AND membership."manages_budget" IS DISTINCT FROM (
     NOT membership."bills_services"
     OR EXISTS (
       SELECT 1
         FROM "calculation_strategies" strategy
        WHERE strategy."individual_id" = membership."individual_id"
          AND strategy."status" = 'active'
     )
     OR EXISTS (
       SELECT 1
         FROM "budget_authorizations" budget_auth
        WHERE budget_auth."individual_id" = membership."individual_id"
          AND budget_auth."status" = 'active'
          AND budget_auth."archived_at" IS NULL
     )
   );--> statement-breakpoint

-- Recompute the inferred home-agency classification when a budget source is
-- activated, deactivated, archived, restored, moved, or deleted. External
-- agency responsibility remains explicit and is never inferred here.
CREATE FUNCTION "sync_home_agency_budget_managed"("target_individual_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH inferred AS (
    SELECT membership."id",
           (
             NOT membership."bills_services"
             OR EXISTS (
               SELECT 1
                 FROM "calculation_strategies" strategy
                WHERE strategy."individual_id" = membership."individual_id"
                  AND strategy."status" = 'active'
             )
             OR EXISTS (
               SELECT 1
                 FROM "budget_authorizations" budget_auth
                WHERE budget_auth."individual_id" = membership."individual_id"
                  AND budget_auth."status" = 'active'
                  AND budget_auth."archived_at" IS NULL
             )
           ) AS "manages_budget"
      FROM "agency_individuals" membership
      JOIN "agencies" agency ON agency."id" = membership."agency_id"
     WHERE agency."is_home_agency" = true
       AND membership."individual_id" = target_individual_id
       AND membership."is_active" = true
       -- A budget created before a scheduled membership starts must still sync.
       AND (
         membership."effective_to" IS NULL
         OR membership."effective_to" >= (now() AT TIME ZONE 'America/New_York')::date
       )
  )
  UPDATE "agency_individuals" membership
     SET "manages_budget" = inferred."manages_budget",
         "updated_at" = now()
    FROM inferred
   WHERE membership."id" = inferred."id"
     AND membership."manages_budget" IS DISTINCT FROM inferred."manages_budget";
END;
$$;--> statement-breakpoint

CREATE FUNCTION "sync_home_agency_budget_managed_from_source"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "sync_home_agency_budget_managed"(OLD."individual_id");
    RETURN OLD;
  END IF;

  PERFORM "sync_home_agency_budget_managed"(NEW."individual_id");
  IF TG_OP = 'UPDATE' AND OLD."individual_id" IS DISTINCT FROM NEW."individual_id" THEN
    PERFORM "sync_home_agency_budget_managed"(OLD."individual_id");
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "calculation_strategies_mark_home_budget_managed"
  AFTER INSERT OR DELETE OR UPDATE OF "status", "individual_id"
  ON "calculation_strategies"
  FOR EACH ROW EXECUTE FUNCTION "sync_home_agency_budget_managed_from_source"();--> statement-breakpoint

CREATE TRIGGER "budget_authorizations_mark_home_budget_managed"
  AFTER INSERT OR DELETE OR UPDATE OF "status", "individual_id", "archived_at"
  ON "budget_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "sync_home_agency_budget_managed_from_source"();
