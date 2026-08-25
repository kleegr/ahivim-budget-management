-- A rate date identifies one snapshot. Older builds allowed ambiguous same-day
-- duplicates, so retain the latest-created row before enforcing the invariant.
DO $$
BEGIN
  -- A zero-row DELETE still fires the statement-level settlement trigger.
  -- Execute it only when migration cleanup will actually change a rate row.
  IF EXISTS (
    SELECT 1
      FROM program_rate_schedules
     GROUP BY program_id, effective_from
    HAVING count(*) > 1
  ) THEN
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY program_id, effective_from
               ORDER BY created_at DESC, id DESC
             ) AS duplicate_rank
        FROM program_rate_schedules
    )
    DELETE FROM program_rate_schedules prs
     USING ranked r
     WHERE prs.id = r.id AND r.duplicate_rank > 1;
  END IF;
END;
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "program_rate_schedules_program_effective_key"
  ON "program_rate_schedules" ("program_id", "effective_from");--> statement-breakpoint

DROP FUNCTION IF EXISTS effective_budget_authorizations_at(date);--> statement-breakpoint
CREATE FUNCTION effective_budget_authorizations_at(p_as_of date)
RETURNS TABLE (
  authorization_id uuid,
  period_id uuid,
  individual_id uuid,
  program_id uuid,
  period_label text,
  start_date date,
  end_date date,
  authorized_hours numeric,
  internal_rate numeric,
  revision integer,
  updated_at timestamptz,
  source text
)
LANGUAGE sql
STABLE
AS $$
  WITH canonical_strategy AS (
    SELECT cs.id, cs.individual_id, cs.label, cs.renewal_date,
           cs.created_at, i.status AS individual_status
      FROM calculation_strategies cs
      JOIN individuals i ON i.id = cs.individual_id
     WHERE cs.status = 'active'
  ),
  strategy_base AS (
    SELECT cs.id AS strategy_id, cs.individual_id, cs.label,
           cs.renewal_date, cs.individual_status,
           csl.id AS line_id, csl.program_id, csl.authorized_hours,
           csl.rate_override, csl.rate_override_effective_from,
           csl.updated_at, p.code AS program_code,
           CASE
             WHEN p.code IN ('DAY_HAB', 'SUPP_GROUP_DAY_HAB')
               THEN make_date(EXTRACT(YEAR FROM p_as_of)::int + 1, 1, 1)
             WHEN cs.renewal_date IS NULL THEN NULL
             WHEN cs.individual_status = 'active' AND cs.renewal_date <= p_as_of
               THEN (
                 cs.renewal_date
                 + make_interval(
                     years => EXTRACT(YEAR FROM age(p_as_of, cs.renewal_date))::int + 1
                   )
               )::date
             ELSE cs.renewal_date
           END AS effective_end
      FROM canonical_strategy cs
      JOIN calculation_strategy_lines csl ON csl.strategy_id = cs.id
      JOIN programs p ON p.id = csl.program_id
     WHERE p.is_active IS DISTINCT FROM false
  ),
  strategy_periods AS (
    SELECT sb.*,
           CASE
             WHEN sb.program_code IN ('DAY_HAB', 'SUPP_GROUP_DAY_HAB')
               THEN make_date(EXTRACT(YEAR FROM p_as_of)::int, 1, 1)
             ELSE (sb.effective_end - interval '1 year')::date
           END AS effective_start,
           (sb.effective_end - interval '1 day')::date AS period_end
      FROM strategy_base sb
  ),
  strategy_rows AS (
    SELECT (
             substr(md5('authorization:' || sp.line_id::text || ':' || sp.effective_start::text), 1, 8)
             || '-' || substr(md5('authorization:' || sp.line_id::text || ':' || sp.effective_start::text), 9, 4)
             || '-' || substr(md5('authorization:' || sp.line_id::text || ':' || sp.effective_start::text), 13, 4)
             || '-' || substr(md5('authorization:' || sp.line_id::text || ':' || sp.effective_start::text), 17, 4)
             || '-' || substr(md5('authorization:' || sp.line_id::text || ':' || sp.effective_start::text), 21, 12)
           )::uuid AS authorization_id,
           (
             substr(md5('period:' || sp.line_id::text || ':' || sp.effective_start::text), 1, 8)
             || '-' || substr(md5('period:' || sp.line_id::text || ':' || sp.effective_start::text), 9, 4)
             || '-' || substr(md5('period:' || sp.line_id::text || ':' || sp.effective_start::text), 13, 4)
             || '-' || substr(md5('period:' || sp.line_id::text || ':' || sp.effective_start::text), 17, 4)
             || '-' || substr(md5('period:' || sp.line_id::text || ':' || sp.effective_start::text), 21, 12)
           )::uuid AS period_id,
           sp.individual_id, sp.program_id,
           concat(sp.label, ' / ', to_char(sp.effective_start, 'YYYY-MM-DD'), ' to ', to_char(sp.period_end, 'YYYY-MM-DD')) AS period_label,
           sp.effective_start AS start_date, sp.period_end AS end_date,
           sp.authorized_hours,
           COALESCE(
             CASE
               WHEN sp.rate_override IS NOT NULL
                AND (
                  sp.rate_override_effective_from IS NULL
                  OR sp.period_end >= sp.rate_override_effective_from
                )
                 THEN sp.rate_override
             END,
             (
               SELECT prs.internal_rate
                 FROM program_rate_schedules prs
                WHERE prs.program_id = sp.program_id
                   AND prs.effective_from <= sp.period_end
                   AND (prs.effective_to IS NULL OR prs.effective_to >= sp.period_end)
                ORDER BY prs.effective_from DESC, prs.id DESC
                LIMIT 1
             ),
             0
           ) AS internal_rate,
           1 AS revision, sp.updated_at, 'calculation_strategy'::text AS source
      FROM strategy_periods sp
     WHERE p_as_of BETWEEN sp.effective_start AND sp.period_end
  ),
  explicit_rows AS (
    SELECT ba.id AS authorization_id, bp.id AS period_id,
           ba.individual_id, ba.program_id, bp.label AS period_label,
           bp.start_date, bp.end_date, ba.authorized_hours, ba.internal_rate,
           ba.revision, ba.updated_at,
           COALESCE(ba.source, 'explicit_authorization') AS source
      FROM budget_authorizations ba
      JOIN budget_periods bp ON bp.id = ba.budget_period_id
     WHERE ba.status = 'active'
       AND ba.archived_at IS NULL
       AND bp.status = 'active'
       AND p_as_of BETWEEN bp.start_date AND bp.end_date
       AND NOT EXISTS (
         SELECT 1
           FROM strategy_rows sr
          WHERE sr.individual_id = ba.individual_id
            AND sr.program_id = ba.program_id
       )
  )
  SELECT * FROM strategy_rows
  UNION ALL
  SELECT * FROM explicit_rows;
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS effective_billed_hours(uuid, uuid, date, date, numeric);--> statement-breakpoint
CREATE FUNCTION effective_billed_hours(
  p_individual_id uuid,
  p_program_id uuid,
  p_start_date date,
  p_end_date date,
  p_budget_rate numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    sum(
      CASE
        WHEN p.code IN ('DAY_HAB', 'SUPP_GROUP_DAY_HAB')
         AND COALESCE(p_budget_rate, 0) > 0
          THEN COALESCE(
                 t.calculated_internal_amount,
                 t.spreadsheet_internal_amount,
                 t.internal_rate_applied * t.imported_hours,
                 0
               ) / p_budget_rate
        ELSE t.imported_hours
      END
    ),
    0
  )
    FROM payroll_transactions t
    JOIN programs p ON p.id = t.program_id
   WHERE t.individual_id = p_individual_id
     AND t.program_id = p_program_id
     AND t.period_begin BETWEEN p_start_date AND p_end_date;
$$;
