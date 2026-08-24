-- A deferred trigger validates that every settlement event still belongs to
-- the same person as its obligation. The original function accessed columns
-- that do not exist on both trigger tables, which PostgreSQL surfaced only at
-- COMMIT. Read the trigger row as JSON so each table can safely supply its own
-- obligation identity.

CREATE OR REPLACE FUNCTION "validate_settlement_obligation_event_person"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obligation_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'settlement_events' THEN
    obligation_id := NULLIF(to_jsonb(NEW)->>'settlement_obligation_id', '')::uuid;
  ELSE
    obligation_id := NULLIF(to_jsonb(NEW)->>'id', '')::uuid;
  END IF;

  IF obligation_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM "settlement_events" e
      JOIN "settlement_obligations" o ON o."id" = e."settlement_obligation_id"
     WHERE o."id" = obligation_id
       AND (
         e."employee_id" IS DISTINCT FROM o."employee_id"
         OR e."individual_id" IS DISTINCT FROM o."individual_id"
       )
  ) THEN
    RAISE EXCEPTION 'settlement obligation and event person must match at commit';
  END IF;
  RETURN NULL;
END;
$$;
