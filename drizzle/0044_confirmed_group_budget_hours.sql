-- Confirmed allocations carry full individual service credit. Financial row
-- allocations and unconfirmed legacy group links remain unchanged.
CREATE INDEX IF NOT EXISTS service_allocations_payroll_transaction_idx
  ON service_allocations(payroll_transaction_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION canonical_budget_transaction_hours(
  payroll_row payroll_transactions, budget_rate numeric
) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN count(*) = 1 THEN min(allocation.allocation_hours) END
       FROM service_allocations allocation
       JOIN service_sessions session ON session.id = allocation.service_session_id
      WHERE allocation.payroll_transaction_id = payroll_row.id
        AND allocation.individual_id = payroll_row.individual_id
        AND session.program_id = payroll_row.program_id
        AND session.employee_id IS NOT DISTINCT FROM payroll_row.employee_id
        AND session.group_size > 1
        AND session.group_detection_status = 'confirmed'),
    CASE WHEN (SELECT rate_scope FROM programs WHERE id = payroll_row.program_id) = 'per_group'
               AND COALESCE(budget_rate, 0) > 0
      THEN COALESCE(payroll_row.calculated_internal_amount,
                    payroll_row.spreadsheet_internal_amount,
                    payroll_row.internal_rate_applied * payroll_row.imported_hours, 0) / budget_rate
      ELSE COALESCE(payroll_row.imported_hours, 0)
    END
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION effective_billed_hours(
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
             canonical_budget_transaction_hours(payroll_row, p_budget_rate)
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

--> statement-breakpoint
CREATE OR REPLACE VIEW "program_budget_balances" AS
WITH active_authorizations AS (
  SELECT ba."id" AS "authorization_id", ba."budget_period_id", ba."individual_id",
         ba."program_id", ba."authorized_hours", ba."authorized_dollars",
         ba."internal_rate", ba."agency_rate", ba."individual_rate_override",
         ba."notes", ba."revision", bp."label" AS "period_label",
         bp."start_date", bp."end_date", bp."renewal_date", bp."period_type",
         bp."status" AS "period_status", i."display_name" AS "individual_name",
         p."code" AS "program_code", p."name" AS "program_name",
         p."required_auth_type", p."service_category", p."payment_recipient",
         p."consumption_source", p."rate_scope", p."renewal_policy",
         p."allow_individual_rate_override"
    FROM "budget_authorizations" ba
    JOIN "budget_periods" bp ON bp."id" = ba."budget_period_id"
    JOIN "individuals" i ON i."id" = ba."individual_id"
    JOIN "programs" p ON p."id" = ba."program_id"
   WHERE ba."status" = 'active'
     AND ba."archived_at" IS NULL
     AND bp."archived_at" IS NULL
),
payroll_usage AS (
  SELECT a."budget_period_id", a."program_id",
         COALESCE(sum(
           canonical_budget_transaction_hours(t, a."internal_rate")
         ), 0)::numeric(10, 4) AS "hours",
         COALESCE(sum(COALESCE(t."imported_amount", 0)), 0)::numeric(14, 4) AS "amount"
    FROM active_authorizations a
    LEFT JOIN "payroll_transactions" t
     ON a."consumption_source" IN ('payroll', 'mixed')
     AND t."individual_id" = a."individual_id"
     AND t."program_id" = a."program_id"
     AND canonical_service_date(t."period_begin", t."check_date", t."period_end")
         BETWEEN a."start_date" AND a."end_date"
   GROUP BY a."budget_period_id", a."program_id"
),
undated_payroll_usage AS (
  SELECT a."authorization_id", count(t."id")::integer AS "undated_usage_count"
    FROM active_authorizations a
    LEFT JOIN "payroll_transactions" t
      ON a."consumption_source" IN ('payroll', 'mixed')
     AND t."individual_id" = a."individual_id"
     AND t."program_id" = a."program_id"
     AND canonical_service_date(t."period_begin", t."check_date", t."period_end") IS NULL
   GROUP BY a."authorization_id"
),
event_usage AS (
  SELECT e."budget_period_id", e."program_id",
         COALESCE(sum(e."hours"), 0)::numeric(10, 4) AS "hours",
         COALESCE(sum(e."amount"), 0)::numeric(14, 4) AS "amount"
    FROM "program_budget_events" e
   GROUP BY e."budget_period_id", e."program_id"
)
SELECT a.*,
       (COALESCE(pu."hours", 0) + COALESCE(eu."hours", 0))::numeric(10, 4) AS "consumed_hours",
       (COALESCE(pu."amount", 0) + COALESCE(eu."amount", 0))::numeric(14, 4) AS "consumed_dollars",
       (a."authorized_hours" - COALESCE(pu."hours", 0) - COALESCE(eu."hours", 0))::numeric(10, 4) AS "remaining_hours",
       CASE WHEN a."authorized_dollars" IS NULL THEN NULL
            ELSE (a."authorized_dollars" - COALESCE(pu."amount", 0) - COALESCE(eu."amount", 0))::numeric(14, 4)
       END AS "remaining_dollars",
       COALESCE(upu."undated_usage_count", 0)::integer AS "undated_usage_count",
       COALESCE(upu."undated_usage_count", 0) > 0 AS "has_undated_usage"
  FROM active_authorizations a
  LEFT JOIN payroll_usage pu
    ON pu."budget_period_id" = a."budget_period_id" AND pu."program_id" = a."program_id"
  LEFT JOIN undated_payroll_usage upu
    ON upu."authorization_id" = a."authorization_id"
  LEFT JOIN event_usage eu
    ON eu."budget_period_id" = a."budget_period_id" AND eu."program_id" = a."program_id";
