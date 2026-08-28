-- Agencies and portal identities are deliberately separate from the legacy
-- admin/manager/viewer login rank. A person may hold more than one portal role,
-- and agency roles are always scoped to one explicit agency membership.

CREATE TABLE "agencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "is_home_agency" boolean NOT NULL DEFAULT false,
  "contact_name" text,
  "contact_email" text,
  "contact_phone" text,
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agencies_code_check" CHECK (length(btrim("code")) > 0),
  CONSTRAINT "agencies_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "agencies_status_check" CHECK ("status" IN ('active', 'inactive', 'archived'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "agencies_code_key" ON "agencies" (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_single_home_key" ON "agencies" ("is_home_agency")
  WHERE "is_home_agency" = true;--> statement-breakpoint
CREATE INDEX "agencies_status_name_idx" ON "agencies" ("status", "name");--> statement-breakpoint

-- Global portal roles never imply agency access. Owner is installation-wide;
-- the other roles become useful only through a direct subject relationship.
CREATE TABLE "user_portal_roles" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "portal_role" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "capability_grants" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "capability_denials" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_portal_roles_pkey" PRIMARY KEY ("user_id", "portal_role"),
  CONSTRAINT "user_portal_roles_role_check"
    CHECK ("portal_role" IN ('owner', 'individual', 'parent', 'employee'))
);--> statement-breakpoint

CREATE INDEX "user_portal_roles_active_idx"
  ON "user_portal_roles" ("user_id", "is_active", "portal_role");--> statement-breakpoint

-- Agency roles are kept in their own table so a financial role at one agency
-- can never widen a scheduling-only role at another agency.
CREATE TABLE "user_agency_access" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agency_id" uuid NOT NULL REFERENCES "agencies"("id") ON DELETE CASCADE,
  "portal_role" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "capability_grants" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "capability_denials" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_agency_access_pkey" PRIMARY KEY ("user_id", "agency_id", "portal_role"),
  CONSTRAINT "user_agency_access_role_check"
    CHECK ("portal_role" IN ('agency', 'staffing_manager', 'scheduler', 'collector'))
);--> statement-breakpoint

CREATE INDEX "user_agency_access_user_idx"
  ON "user_agency_access" ("user_id", "is_active", "agency_id");--> statement-breakpoint
CREATE INDEX "user_agency_access_agency_idx"
  ON "user_agency_access" ("agency_id", "is_active", "portal_role");--> statement-breakpoint

-- Direct portal subjects. These are authorization links, not convenient
-- navigation links, and must never be expanded through billing or assignments.
CREATE TABLE "user_individual_relationships" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id") ON DELETE CASCADE,
  "relationship_type" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "capability_grants" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "capability_denials" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_individual_relationships_pkey"
    PRIMARY KEY ("user_id", "individual_id", "relationship_type"),
  CONSTRAINT "user_individual_relationships_type_check"
    CHECK ("relationship_type" IN ('self', 'parent', 'guardian', 'representative'))
);--> statement-breakpoint

CREATE INDEX "user_individual_relationships_user_idx"
  ON "user_individual_relationships" ("user_id", "is_active", "individual_id");--> statement-breakpoint
CREATE INDEX "user_individual_relationships_individual_idx"
  ON "user_individual_relationships" ("individual_id", "is_active", "user_id");--> statement-breakpoint

CREATE TABLE "user_employee_relationships" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "relationship_type" text NOT NULL DEFAULT 'self',
  "is_active" boolean NOT NULL DEFAULT true,
  "capability_grants" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "capability_denials" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_employee_relationships_pkey"
    PRIMARY KEY ("user_id", "employee_id", "relationship_type"),
  CONSTRAINT "user_employee_relationships_type_check"
    CHECK ("relationship_type" IN ('self'))
);--> statement-breakpoint

CREATE INDEX "user_employee_relationships_user_idx"
  ON "user_employee_relationships" ("user_id", "is_active", "employee_id");--> statement-breakpoint
CREATE INDEX "user_employee_relationships_employee_idx"
  ON "user_employee_relationships" ("employee_id", "is_active", "user_id");--> statement-breakpoint

-- People belong to agencies explicitly. Each row is one effective interval;
-- is_active means valid/non-void, while current status is derived from dates.
-- Budget responsibility and billing remain separate first-class facts.
CREATE TABLE "agency_individuals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agency_id" uuid NOT NULL REFERENCES "agencies"("id") ON DELETE CASCADE,
  "individual_id" uuid NOT NULL REFERENCES "individuals"("id") ON DELETE CASCADE,
  "manages_budget" boolean NOT NULL DEFAULT false,
  "bills_services" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "effective_from" date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date),
  "effective_to" date,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agency_individuals_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "agency_individuals_purpose_check"
    CHECK ("manages_budget" OR "bills_services")
);--> statement-breakpoint

CREATE INDEX "agency_individuals_agency_idx"
  ON "agency_individuals" ("agency_id", "is_active", "individual_id", "effective_from", "effective_to");--> statement-breakpoint
CREATE INDEX "agency_individuals_individual_idx"
  ON "agency_individuals" ("individual_id", "is_active", "agency_id", "effective_from", "effective_to");--> statement-breakpoint
CREATE INDEX "agency_individuals_budget_idx"
  ON "agency_individuals" ("agency_id", "manages_budget", "bills_services")
  WHERE "is_active" = true;--> statement-breakpoint

CREATE TABLE "agency_employees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agency_id" uuid NOT NULL REFERENCES "agencies"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "is_active" boolean NOT NULL DEFAULT true,
  "effective_from" date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date),
  "effective_to" date,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agency_employees_range_check"
    CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);--> statement-breakpoint

CREATE INDEX "agency_employees_agency_idx"
  ON "agency_employees" ("agency_id", "is_active", "employee_id", "effective_from", "effective_to");--> statement-breakpoint
CREATE INDEX "agency_employees_employee_idx"
  ON "agency_employees" ("employee_id", "is_active", "agency_id", "effective_from", "effective_to");--> statement-breakpoint

-- Valid membership intervals are immutable history once closed. These guards
-- serialize each agency/person timeline and reject overlapping valid periods,
-- including concurrent first inserts where row locks alone cannot help.
CREATE FUNCTION "guard_agency_individual_membership_overlap"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD."agency_id", OLD."individual_id") IS DISTINCT FROM
       (NEW."agency_id", NEW."individual_id") THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'agency_individuals:' || OLD."agency_id"::text || ':' || OLD."individual_id"::text,
        0
      ));
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'agency_individuals:' || NEW."agency_id"::text || ':' || NEW."individual_id"::text,
    0
  ));

  IF NEW."is_active" AND EXISTS (
    SELECT 1
      FROM "agency_individuals" existing
     WHERE existing."agency_id" = NEW."agency_id"
       AND existing."individual_id" = NEW."individual_id"
       AND existing."is_active" = true
       AND existing."id" <> NEW."id"
       AND daterange(existing."effective_from", existing."effective_to", '[]')
           && daterange(NEW."effective_from", NEW."effective_to", '[]')
  ) THEN
    RAISE EXCEPTION 'Agency/individual membership periods cannot overlap'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "agency_individuals_non_overlap_guard"
  BEFORE INSERT OR UPDATE OF "agency_id", "individual_id", "is_active", "effective_from", "effective_to"
  ON "agency_individuals"
  FOR EACH ROW EXECUTE FUNCTION "guard_agency_individual_membership_overlap"();--> statement-breakpoint

CREATE FUNCTION "guard_agency_employee_membership_overlap"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD."agency_id", OLD."employee_id") IS DISTINCT FROM
       (NEW."agency_id", NEW."employee_id") THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'agency_employees:' || OLD."agency_id"::text || ':' || OLD."employee_id"::text,
        0
      ));
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'agency_employees:' || NEW."agency_id"::text || ':' || NEW."employee_id"::text,
    0
  ));

  IF NEW."is_active" AND EXISTS (
    SELECT 1
      FROM "agency_employees" existing
     WHERE existing."agency_id" = NEW."agency_id"
       AND existing."employee_id" = NEW."employee_id"
       AND existing."is_active" = true
       AND existing."id" <> NEW."id"
       AND daterange(existing."effective_from", existing."effective_to", '[]')
           && daterange(NEW."effective_from", NEW."effective_to", '[]')
  ) THEN
    RAISE EXCEPTION 'Agency/employee membership periods cannot overlap'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "agency_employees_non_overlap_guard"
  BEFORE INSERT OR UPDATE OF "agency_id", "employee_id", "is_active", "effective_from", "effective_to"
  ON "agency_employees"
  FOR EACH ROW EXECUTE FUNCTION "guard_agency_employee_membership_overlap"();--> statement-breakpoint

-- Preserve the current single-agency installation as explicit memberships.
-- Existing authorizations identify who Ahivim currently manages a budget for.
INSERT INTO "agencies" ("code", "name", "is_home_agency")
VALUES ('AHIVIM', 'Ahivim', true)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "agency_individuals"
  ("agency_id", "individual_id", "manages_budget", "bills_services", "is_active",
   "effective_from", "effective_to")
SELECT
  a."id",
  i."id",
  EXISTS (
    SELECT 1 FROM "budget_authorizations" ba WHERE ba."individual_id" = i."id"
  ),
  true,
  true,
  CASE WHEN i."status" IN ('discharged', 'archived')
    THEN LEAST(COALESCE(history."first_fact_on",
                        (i."created_at" AT TIME ZONE 'America/New_York')::date),
               (now() AT TIME ZONE 'America/New_York')::date - 1)
    ELSE COALESCE(history."first_fact_on",
                  (i."created_at" AT TIME ZONE 'America/New_York')::date)
  END,
  CASE WHEN i."status" IN ('discharged', 'archived')
    THEN (now() AT TIME ZONE 'America/New_York')::date - 1 END
FROM "agencies" a
CROSS JOIN "individuals" i
LEFT JOIN LATERAL (
  SELECT min(fact."fact_on") AS "first_fact_on"
    FROM (
      SELECT canonical_service_date(t."period_begin", t."check_date", t."period_end") AS "fact_on"
        FROM "payroll_transactions" t WHERE t."individual_id" = i."id"
      UNION ALL
      SELECT bp."start_date"
        FROM "budget_periods" bp WHERE bp."individual_id" = i."id"
      UNION ALL
      SELECT cb."start_date"
        FROM "class_budget_periods" cb WHERE cb."individual_id" = i."id"
      UNION ALL
      SELECT session."session_date"
        FROM "scheduled_allocations" allocation
        JOIN "scheduled_sessions" session ON session."id" = allocation."scheduled_session_id"
       WHERE allocation."individual_id" = i."id"
      UNION ALL
      SELECT canonical_service_date(obligation."period_begin", obligation."check_date",
                                    obligation."period_end")
        FROM "settlement_obligations" obligation WHERE obligation."individual_id" = i."id"
    ) fact
) history ON true
WHERE lower(a."code") = 'ahivim'
;--> statement-breakpoint

INSERT INTO "agency_employees"
  ("agency_id", "employee_id", "is_active", "effective_from", "effective_to")
SELECT a."id", e."id", true,
       CASE WHEN e."status" <> 'active'
         THEN LEAST(COALESCE(history."first_fact_on",
                             (e."created_at" AT TIME ZONE 'America/New_York')::date),
                    (now() AT TIME ZONE 'America/New_York')::date - 1)
         ELSE COALESCE(history."first_fact_on",
                       (e."created_at" AT TIME ZONE 'America/New_York')::date)
       END,
       CASE WHEN e."status" <> 'active'
         THEN (now() AT TIME ZONE 'America/New_York')::date - 1 END
FROM "agencies" a
CROSS JOIN "employees" e
LEFT JOIN LATERAL (
  SELECT min(fact."fact_on") AS "first_fact_on"
    FROM (
      SELECT canonical_service_date(t."period_begin", t."check_date", t."period_end") AS "fact_on"
        FROM "payroll_transactions" t WHERE t."employee_id" = e."id"
      UNION ALL
      SELECT session."session_date"
        FROM "scheduled_sessions" session WHERE session."employee_id" = e."id"
      UNION ALL
      SELECT deal."effective_from"
        FROM "employee_deals" deal WHERE deal."employee_id" = e."id"
      UNION ALL
      SELECT canonical_service_date(obligation."period_begin", obligation."check_date",
                                    obligation."period_end")
        FROM "settlement_obligations" obligation WHERE obligation."employee_id" = e."id"
    ) fact
) history ON true
WHERE lower(a."code") = 'ahivim'
;--> statement-breakpoint

-- Legacy administrators remain installation owners after portal permissions
-- become authoritative. No broader portal role is inferred for other users.
INSERT INTO "user_portal_roles"
  ("user_id", "portal_role", "created_by_user_id", "updated_by_user_id")
SELECT u."id", 'owner', u."id", u."id"
FROM "users" u
WHERE u."role" = 'admin' AND u."is_active" = true
ON CONFLICT DO NOTHING;
