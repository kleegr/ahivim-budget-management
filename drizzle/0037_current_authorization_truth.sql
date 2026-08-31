-- One current operational authorization per individual/program.
--
-- Explicit service authorizations are authoritative. Calculation-strategy
-- lines remain a compatibility source for production data that has not yet
-- been converted, but multiple active financial plans must never be summed as
-- though they were additional authorized hours. The established primary-plan
-- order chooses one row and source_candidate_count keeps the ambiguity visible.
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
  source text,
  source_candidate_count integer
)
LANGUAGE sql
STABLE
AS $$
  WITH explicit_rows AS (
    SELECT ba.id AS authorization_id, bp.id AS period_id,
           ba.individual_id, ba.program_id, bp.label AS period_label,
           bp.start_date, bp.end_date, ba.authorized_hours, ba.internal_rate,
           ba.revision, ba.updated_at,
           COALESCE(ba.source, 'explicit_authorization') AS source,
           1::integer AS source_candidate_count
      FROM budget_authorizations ba
      JOIN budget_periods bp ON bp.id = ba.budget_period_id
      JOIN individuals i ON i.id = ba.individual_id
      JOIN programs p ON p.id = ba.program_id
     WHERE ba.status = 'active'
       AND ba.archived_at IS NULL
       AND bp.status = 'active'
       AND bp.archived_at IS NULL
       AND i.status = 'active'
       AND i.archived_at IS NULL
       AND i.merged_into_id IS NULL
       AND p.is_active = true
       AND p.archived_at IS NULL
       AND p_as_of BETWEEN bp.start_date AND bp.end_date
  ),
  strategy_base AS (
    SELECT cs.id AS strategy_id, cs.individual_id, cs.label,
           cs.renewal_date, cs.sort_order, cs.created_at,
           i.status AS individual_status,
           csl.id AS line_id, csl.program_id, csl.authorized_hours,
           csl.rate_override, csl.rate_override_effective_from,
           csl.updated_at, p.renewal_policy,
           CASE
             WHEN p.renewal_policy = 'calendar'
               THEN make_date(EXTRACT(YEAR FROM p_as_of)::int + 1, 1, 1)
             WHEN cs.renewal_date IS NULL THEN NULL
             WHEN i.status = 'active' AND cs.renewal_date <= p_as_of
               THEN (
                 cs.renewal_date
                 + make_interval(
                     years => EXTRACT(YEAR FROM age(p_as_of, cs.renewal_date))::int + 1
                   )
               )::date
             ELSE cs.renewal_date
           END AS effective_end
      FROM calculation_strategies cs
      JOIN individuals i ON i.id = cs.individual_id
      JOIN calculation_strategy_lines csl ON csl.strategy_id = cs.id
      JOIN programs p ON p.id = csl.program_id
     WHERE cs.status = 'active'
       AND i.status = 'active'
       AND i.archived_at IS NULL
       AND i.merged_into_id IS NULL
       AND p.is_active = true
       AND p.archived_at IS NULL
  ),
  strategy_periods AS (
    SELECT sb.*,
           CASE
             WHEN sb.renewal_policy = 'calendar'
               THEN make_date(EXTRACT(YEAR FROM p_as_of)::int, 1, 1)
             ELSE (sb.effective_end - interval '1 year')::date
           END AS effective_start,
           (sb.effective_end - interval '1 day')::date AS period_end
      FROM strategy_base sb
  ),
  ranked_strategy_rows AS (
    SELECT sp.*,
           row_number() OVER (
             PARTITION BY sp.individual_id, sp.program_id
             ORDER BY sp.sort_order, sp.created_at, sp.strategy_id, sp.line_id
           ) AS source_rank,
           count(*) OVER (
             PARTITION BY sp.individual_id, sp.program_id
           )::integer AS source_candidate_count
      FROM strategy_periods sp
     WHERE p_as_of BETWEEN sp.effective_start AND sp.period_end
       AND NOT EXISTS (
         SELECT 1
           FROM explicit_rows er
          WHERE er.individual_id = sp.individual_id
            AND er.program_id = sp.program_id
       )
  ),
  strategy_rows AS (
    SELECT (
             substr(md5('authorization:' || sr.line_id::text || ':' || sr.effective_start::text), 1, 8)
             || '-' || substr(md5('authorization:' || sr.line_id::text || ':' || sr.effective_start::text), 9, 4)
             || '-' || substr(md5('authorization:' || sr.line_id::text || ':' || sr.effective_start::text), 13, 4)
             || '-' || substr(md5('authorization:' || sr.line_id::text || ':' || sr.effective_start::text), 17, 4)
             || '-' || substr(md5('authorization:' || sr.line_id::text || ':' || sr.effective_start::text), 21, 12)
           )::uuid AS authorization_id,
           (
             substr(md5('period:' || sr.line_id::text || ':' || sr.effective_start::text), 1, 8)
             || '-' || substr(md5('period:' || sr.line_id::text || ':' || sr.effective_start::text), 9, 4)
             || '-' || substr(md5('period:' || sr.line_id::text || ':' || sr.effective_start::text), 13, 4)
             || '-' || substr(md5('period:' || sr.line_id::text || ':' || sr.effective_start::text), 17, 4)
             || '-' || substr(md5('period:' || sr.line_id::text || ':' || sr.effective_start::text), 21, 12)
           )::uuid AS period_id,
           sr.individual_id, sr.program_id,
           concat(
             sr.label, ' / ', to_char(sr.effective_start, 'YYYY-MM-DD'),
             ' to ', to_char(sr.period_end, 'YYYY-MM-DD')
           ) AS period_label,
           sr.effective_start AS start_date, sr.period_end AS end_date,
           sr.authorized_hours,
           COALESCE(
             CASE
               WHEN sr.rate_override IS NOT NULL
                AND (
                  sr.rate_override_effective_from IS NULL
                  OR sr.period_end >= sr.rate_override_effective_from
                )
                 THEN sr.rate_override
             END,
             (
               SELECT prs.internal_rate
                 FROM program_rate_schedules prs
                WHERE prs.program_id = sr.program_id
                  AND prs.effective_from <= sr.period_end
                  AND (prs.effective_to IS NULL OR prs.effective_to >= sr.period_end)
                ORDER BY prs.effective_from DESC, prs.id DESC
                LIMIT 1
             ),
             0
           ) AS internal_rate,
           1 AS revision, sr.updated_at, 'calculation_strategy'::text AS source,
           sr.source_candidate_count
      FROM ranked_strategy_rows sr
     WHERE sr.source_rank = 1
  )
  SELECT er.authorization_id, er.period_id, er.individual_id, er.program_id,
         er.period_label, er.start_date, er.end_date, er.authorized_hours,
         er.internal_rate, er.revision, er.updated_at, er.source,
         er.source_candidate_count
    FROM explicit_rows er
  UNION ALL
  SELECT sr.authorization_id, sr.period_id, sr.individual_id, sr.program_id,
         sr.period_label, sr.start_date, sr.end_date, sr.authorized_hours,
         sr.internal_rate, sr.revision, sr.updated_at, sr.source,
         sr.source_candidate_count
    FROM strategy_rows sr;
$$;--> statement-breakpoint

-- Scheduling and its validation paths use the same usage rules as the budget
-- read model: canonical service date, catalog rate scope, and signed manual /
-- invoice adjustments. Undated payroll rows remain a separately surfaced data
-- quality issue and do not consume a dated authorization.
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
  WITH program_rules AS (
    SELECT rate_scope, consumption_source
      FROM programs
     WHERE id = p_program_id
  ),
  payroll_usage AS (
    SELECT COALESCE(sum(
             CASE
               WHEN rules.rate_scope = 'per_group' AND COALESCE(p_budget_rate, 0) > 0
                 THEN COALESCE(
                        payroll_row.calculated_internal_amount,
                        payroll_row.spreadsheet_internal_amount,
                        payroll_row.internal_rate_applied * payroll_row.imported_hours,
                        0
                      ) / p_budget_rate
               ELSE COALESCE(payroll_row.imported_hours, 0)
             END
           ), 0) AS hours
      FROM program_rules rules
      LEFT JOIN payroll_transactions payroll_row
        ON rules.consumption_source IN ('payroll', 'mixed')
       AND payroll_row.individual_id = p_individual_id
       AND payroll_row.program_id = p_program_id
       AND canonical_service_date(
             payroll_row.period_begin, payroll_row.check_date, payroll_row.period_end
           ) BETWEEN p_start_date AND p_end_date
  ),
  event_usage AS (
    SELECT COALESCE(sum(event.hours), 0) AS hours
      FROM program_budget_events event
     WHERE event.individual_id = p_individual_id
       AND event.program_id = p_program_id
       AND event.service_date BETWEEN p_start_date AND p_end_date
  )
  SELECT COALESCE(payroll_usage.hours, 0) + COALESCE(event_usage.hours, 0)
    FROM payroll_usage
    CROSS JOIN event_usage;
$$;
