import type { PgLikePool } from "@/lib/import/commit";
import { agencyDate } from "@/lib/business/agency-time";
import { dec, toHours, toMoney } from "@/lib/money";
import {
  directIndividualScopeClause,
  type AccessScope,
} from "@/lib/auth/access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProgramBudgetRecord {
  authorizationId: string;
  budgetPeriodId: string;
  individualId: string;
  individualName: string;
  programId: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  periodType: string;
  periodStatus: string;
  requiredAuthType: string;
  serviceCategory: string;
  paymentRecipient: string;
  consumptionSource: string;
  rateScope: string;
  renewalPolicy: string;
  allowIndividualRateOverride: boolean;
  authorizedHours: string;
  authorizedDollars: string | null;
  /** Effective employee/internal rate for this authorization revision. */
  internalRate: string;
  /** Effective funder/agency rate for this authorization revision. */
  agencyRate: string | null;
  individualRateOverride: string | null;
  notes: string | null;
  consumedHours: string;
  consumedDollars: string;
  remainingHours: string;
  remainingDollars: string | null;
  /** Pending, unmatched schedule inside this authorization period. */
  scheduledHours: string;
  /** Authorized hours less committed transactions and pending schedule. */
  remainingAfterScheduledHours: string;
  /** Payroll rows for this individual/program with no usable service date. */
  undatedUsageCount: number;
  hasUndatedUsage: boolean;
  revision: number;
  /** Physical authorization rows can be revised; strategy fallbacks are read-only. */
  isExplicit: boolean;
  source: string;
  /** More than one means the primary financial plan won a duplicate-source tie. */
  sourceCandidateCount: number;
}

interface ProgramBudgetRow {
  authorization_id: string;
  budget_period_id: string;
  individual_id: string;
  individual_name: string;
  program_id: string;
  program_code: string;
  program_name: string;
  period_label: string;
  start_date: string;
  end_date: string;
  renewal_date: string | null;
  period_type: string;
  period_status: string;
  required_auth_type: string;
  service_category: string;
  payment_recipient: string;
  consumption_source: string;
  rate_scope: string;
  renewal_policy: string;
  allow_individual_rate_override: boolean;
  authorized_hours: string;
  authorized_dollars: string | null;
  internal_rate: string;
  agency_rate: string | null;
  individual_rate_override: string | null;
  notes: string | null;
  consumed_hours: string;
  consumed_dollars: string;
  remaining_hours: string;
  remaining_dollars: string | null;
  scheduled_hours: string;
  remaining_after_scheduled_hours: string;
  undated_usage_count: number | string;
  has_undated_usage: boolean;
  revision: number;
  is_explicit: boolean;
  authorization_source: string;
  source_candidate_count: number | string;
}

const PROGRAM_BUDGET_SELECT = `
  SELECT balance.authorization_id, balance.budget_period_id,
         balance.individual_id, balance.individual_name,
         balance.program_id, balance.program_code, balance.program_name,
         balance.period_label,
         balance.start_date::text AS start_date,
         balance.end_date::text AS end_date,
         balance.renewal_date::text AS renewal_date,
         balance.period_type, balance.period_status,
         balance.required_auth_type, balance.service_category,
         balance.payment_recipient, balance.consumption_source,
         balance.rate_scope, balance.renewal_policy,
         balance.allow_individual_rate_override,
         balance.authorized_hours::text AS authorized_hours,
         balance.authorized_dollars::text AS authorized_dollars,
         balance.internal_rate::text AS internal_rate,
         balance.agency_rate::text AS agency_rate,
         balance.individual_rate_override::text AS individual_rate_override,
         balance.notes,
         balance.consumed_hours::text AS consumed_hours,
         balance.consumed_dollars::text AS consumed_dollars,
         balance.remaining_hours::text AS remaining_hours,
         balance.remaining_dollars::text AS remaining_dollars,
         CASE WHEN balance.required_auth_type = 'dollars' THEN 0
              ELSE schedule.scheduled_hours END::text AS scheduled_hours,
         CASE WHEN balance.required_auth_type = 'dollars' THEN balance.remaining_hours
              ELSE balance.remaining_hours - schedule.scheduled_hours END::text
           AS remaining_after_scheduled_hours,
         balance.undated_usage_count,
         balance.has_undated_usage,
         balance.revision,
         true AS is_explicit,
         'explicit_authorization'::text AS authorization_source,
         1::integer AS source_candidate_count
    FROM program_budget_balances balance
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(allocation.allocation_hours), 0) AS scheduled_hours
        FROM scheduled_allocations allocation
        JOIN scheduled_sessions scheduled_session
          ON scheduled_session.id = allocation.scheduled_session_id
       WHERE allocation.individual_id = balance.individual_id
         AND scheduled_session.program_id = balance.program_id
         AND scheduled_session.status = 'pending'
         AND scheduled_session.matched_transaction_id IS NULL
         AND scheduled_session.session_date BETWEEN balance.start_date AND balance.end_date
    ) schedule`;

function toProgramBudget(row: ProgramBudgetRow): ProgramBudgetRecord {
  return {
    authorizationId: row.authorization_id,
    budgetPeriodId: row.budget_period_id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
    periodLabel: row.period_label,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    periodType: row.period_type,
    periodStatus: row.period_status,
    requiredAuthType: row.required_auth_type,
    serviceCategory: row.service_category,
    paymentRecipient: row.payment_recipient,
    consumptionSource: row.consumption_source,
    rateScope: row.rate_scope,
    renewalPolicy: row.renewal_policy,
    allowIndividualRateOverride: row.allow_individual_rate_override,
    authorizedHours: toHours(row.authorized_hours),
    authorizedDollars: row.authorized_dollars === null ? null : toMoney(row.authorized_dollars),
    internalRate: toMoney(row.internal_rate),
    agencyRate: row.agency_rate === null ? null : toMoney(row.agency_rate),
    individualRateOverride: row.individual_rate_override === null
      ? null
      : toMoney(row.individual_rate_override),
    notes: row.notes,
    consumedHours: toHours(row.consumed_hours),
    consumedDollars: toMoney(row.consumed_dollars),
    remainingHours: toHours(row.remaining_hours),
    remainingDollars: row.remaining_dollars === null ? null : toMoney(row.remaining_dollars),
    scheduledHours: toHours(row.scheduled_hours),
    remainingAfterScheduledHours: toHours(row.remaining_after_scheduled_hours),
    undatedUsageCount: Number(row.undated_usage_count),
    hasUndatedUsage: row.has_undated_usage,
    revision: row.revision,
    isExplicit: row.is_explicit !== false,
    source: row.authorization_source ?? "explicit_authorization",
    sourceCandidateCount: Number(row.source_candidate_count ?? 1),
  };
}

export interface ProgramBudgetFilters {
  individualId?: string | null;
  programId?: string | null;
  status?: "active" | "closed" | null;
  asOf?: string | null;
  scope?: AccessScope;
}

export interface CurrentProgramBudgetFilters {
  asOf: string;
  individualId?: string | null;
  programId?: string | null;
  scope?: AccessScope;
}

/**
 * Current operational authorizations shared with Scheduling.
 *
 * Explicit service authorizations win. Until legacy data is converted, the
 * database selector supplies one primary calculation-strategy line per
 * person/program and reports how many source candidates existed. That prevents
 * duplicate financial plans from inflating authorized hours.
 */
export async function listCurrentProgramBudgets(
  pool: PgLikePool,
  filters: CurrentProgramBudgetFilters,
): Promise<ProgramBudgetRecord[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.asOf)) return [];
  const params: unknown[] = [filters.asOf];
  const where: string[] = [
    "individual.status = 'active'",
    "individual.archived_at IS NULL",
    "individual.merged_into_id IS NULL",
    "program.is_active = true",
    "program.archived_at IS NULL",
  ];
  if (filters.individualId) {
    if (!UUID.test(filters.individualId)) return [];
    params.push(filters.individualId);
    where.push(`effective.individual_id = $${params.length}`);
  }
  if (filters.programId) {
    if (!UUID.test(filters.programId)) return [];
    params.push(filters.programId);
    where.push(`effective.program_id = $${params.length}`);
  }
  const directScope = filters.scope
    ? directIndividualScopeClause(filters.scope, "effective.individual_id", params)
    : "";

  const { rows } = await pool.query<ProgramBudgetRow>(
    `WITH current_authorizations AS (
       SELECT * FROM effective_budget_authorizations_at($1::date)
     )
     SELECT effective.authorization_id,
            effective.period_id AS budget_period_id,
            effective.individual_id,
            COALESCE(individual.display_name, individual.normalized_name) AS individual_name,
            effective.program_id, program.code AS program_code, program.name AS program_name,
            effective.period_label,
            effective.start_date::text AS start_date,
            effective.end_date::text AS end_date,
            CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.renewal_date
                 ELSE effective.end_date + 1 END::text AS renewal_date,
            COALESCE(
              explicit_balance.period_type,
              CASE WHEN program.renewal_policy = 'calendar' THEN 'calendar' ELSE 'rolling' END
            ) AS period_type,
            'active'::text AS period_status,
            program.required_auth_type, program.service_category,
            program.payment_recipient, program.consumption_source,
            program.rate_scope, program.renewal_policy,
            program.allow_individual_rate_override,
            effective.authorized_hours::text AS authorized_hours,
            explicit_balance.authorized_dollars::text AS authorized_dollars,
            effective.internal_rate::text AS internal_rate,
            COALESCE(explicit_balance.agency_rate, catalog_rate.agency_rate)::text AS agency_rate,
            explicit_balance.individual_rate_override::text AS individual_rate_override,
            explicit_balance.notes,
            CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.consumed_hours ELSE effective_usage.hours END::text AS consumed_hours,
            CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.consumed_dollars ELSE payroll_usage.amount END::text AS consumed_dollars,
            (effective.authorized_hours - CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.consumed_hours ELSE effective_usage.hours END)::text AS remaining_hours,
            explicit_balance.remaining_dollars::text AS remaining_dollars,
            CASE WHEN program.required_auth_type = 'dollars' THEN 0
                 ELSE schedule.scheduled_hours END::text AS scheduled_hours,
            CASE WHEN program.required_auth_type = 'dollars' THEN effective.authorized_hours
                  ELSE effective.authorized_hours
                    - CASE WHEN explicit_balance.authorization_id IS NOT NULL
                           THEN explicit_balance.consumed_hours ELSE effective_usage.hours END
                    - schedule.scheduled_hours END::text AS remaining_after_scheduled_hours,
            CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.undated_usage_count ELSE undated_usage.row_count END AS undated_usage_count,
            CASE WHEN explicit_balance.authorization_id IS NOT NULL
                 THEN explicit_balance.has_undated_usage ELSE undated_usage.row_count > 0 END AS has_undated_usage,
            effective.revision,
            explicit_balance.authorization_id IS NOT NULL AS is_explicit,
            effective.source AS authorization_source,
            effective.source_candidate_count
       FROM current_authorizations effective
       JOIN individuals individual ON individual.id = effective.individual_id
       JOIN programs program ON program.id = effective.program_id
       LEFT JOIN program_budget_balances explicit_balance
         ON explicit_balance.authorization_id = effective.authorization_id
        AND explicit_balance.budget_period_id = effective.period_id
       LEFT JOIN LATERAL (
         SELECT schedule_rate.agency_rate
           FROM program_rate_schedules schedule_rate
          WHERE schedule_rate.program_id = effective.program_id
            AND schedule_rate.effective_from <= effective.end_date
            AND (schedule_rate.effective_to IS NULL OR schedule_rate.effective_to >= effective.end_date)
          ORDER BY schedule_rate.effective_from DESC, schedule_rate.id DESC
          LIMIT 1
       ) catalog_rate ON true
       CROSS JOIN LATERAL (
         SELECT effective_billed_hours(
                  effective.individual_id,
                  effective.program_id,
                  effective.start_date,
                  effective.end_date,
                  effective.internal_rate
                ) AS hours
       ) effective_usage
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(COALESCE(payroll_row.imported_amount, 0)), 0) AS amount
           FROM payroll_transactions payroll_row
          WHERE program.consumption_source IN ('payroll', 'mixed')
            AND payroll_row.individual_id = effective.individual_id
            AND payroll_row.program_id = effective.program_id
            AND canonical_service_date(
                  payroll_row.period_begin, payroll_row.check_date, payroll_row.period_end
                ) BETWEEN effective.start_date AND effective.end_date
       ) payroll_usage
       CROSS JOIN LATERAL (
         SELECT count(payroll_row.id)::integer AS row_count
           FROM payroll_transactions payroll_row
          WHERE program.consumption_source IN ('payroll', 'mixed')
            AND payroll_row.individual_id = effective.individual_id
            AND payroll_row.program_id = effective.program_id
            AND canonical_service_date(
                  payroll_row.period_begin, payroll_row.check_date, payroll_row.period_end
                ) IS NULL
       ) undated_usage
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(allocation.allocation_hours), 0) AS scheduled_hours
           FROM scheduled_allocations allocation
           JOIN scheduled_sessions scheduled_session
             ON scheduled_session.id = allocation.scheduled_session_id
          WHERE allocation.individual_id = effective.individual_id
            AND scheduled_session.program_id = effective.program_id
            AND scheduled_session.status = 'pending'
            AND scheduled_session.matched_transaction_id IS NULL
            AND scheduled_session.session_date BETWEEN effective.start_date AND effective.end_date
       ) schedule
      WHERE ${where.join(" AND ")}${directScope}
      ORDER BY effective.end_date, individual_name, program.name, effective.period_id`,
    params,
  );
  return rows.map(toProgramBudget);
}

export async function listProgramBudgets(
  pool: PgLikePool,
  filters: ProgramBudgetFilters = {},
): Promise<ProgramBudgetRecord[]> {
  const params: unknown[] = [];
  const where: string[] = ["TRUE"];
  if (filters.individualId) {
    if (!UUID.test(filters.individualId)) return [];
    params.push(filters.individualId);
    where.push(`balance.individual_id = $${params.length}`);
  }
  if (filters.programId) {
    if (!UUID.test(filters.programId)) return [];
    params.push(filters.programId);
    where.push(`balance.program_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`balance.period_status = $${params.length}`);
  }
  if (filters.asOf && /^\d{4}-\d{2}-\d{2}$/.test(filters.asOf)) {
    params.push(filters.asOf);
    where.push(`$${params.length}::date BETWEEN balance.start_date AND balance.end_date`);
  }
  const directScope = filters.scope
    ? directIndividualScopeClause(filters.scope, "balance.individual_id", params)
    : "";

  const { rows } = await pool.query<ProgramBudgetRow>(
    `${PROGRAM_BUDGET_SELECT}
      WHERE ${where.join(" AND ")}${directScope}
      ORDER BY balance.end_date, balance.individual_name, balance.program_name,
               balance.budget_period_id`,
    params,
  );
  return rows.map(toProgramBudget);
}

export async function getProgramBudget(
  pool: PgLikePool,
  budgetPeriodId: string,
  programId: string,
): Promise<ProgramBudgetRecord | null> {
  if (!UUID.test(budgetPeriodId) || !UUID.test(programId)) return null;
  const { rows } = await pool.query<ProgramBudgetRow>(
    `${PROGRAM_BUDGET_SELECT}
      WHERE balance.budget_period_id = $1 AND balance.program_id = $2`,
    [budgetPeriodId, programId],
  );
  return rows[0] ? toProgramBudget(rows[0]) : null;
}

export interface ProgramBudgetMonthRecord {
  month: string;
  usedHours: string;
  scheduledHours: string;
  cumulativeUsedHours: string;
  cumulativeScheduledHours: string;
  remainingHours: string;
  remainingAfterScheduledHours: string;
  expectedUsedHours: string | null;
  paceVarianceHours: string | null;
}

interface ProgramBudgetMonthRow {
  month_start: string;
  effective_start: string;
  effective_end: string;
  authorized_hours: string;
  used_hours: string;
  scheduled_hours: string;
}

function inclusiveDays(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
}

/** Canonical month-by-month transaction usage and unmatched schedule forecast. */
export async function listProgramBudgetMonthlyHistory(
  pool: PgLikePool,
  budgetPeriodId: string,
  programId: string,
  asOf: Date = new Date(),
): Promise<ProgramBudgetMonthRecord[]> {
  if (!UUID.test(budgetPeriodId) || !UUID.test(programId)) return [];
  const today = agencyDate(asOf);
  const { rows } = await pool.query<ProgramBudgetMonthRow>(
    `WITH account AS (
       SELECT balance.budget_period_id, balance.individual_id, balance.program_id,
              balance.start_date, balance.end_date, balance.authorized_hours,
              balance.internal_rate, balance.consumption_source, balance.rate_scope
         FROM program_budget_balances balance
        WHERE balance.budget_period_id = $1 AND balance.program_id = $2
       UNION ALL
       SELECT effective.period_id, effective.individual_id, effective.program_id,
              effective.start_date, effective.end_date, effective.authorized_hours,
              effective.internal_rate, program.consumption_source, program.rate_scope
         FROM effective_budget_authorizations_at($3::date) effective
         JOIN programs program ON program.id = effective.program_id
        WHERE effective.period_id = $1 AND effective.program_id = $2
          AND NOT EXISTS (
            SELECT 1
              FROM program_budget_balances balance
             WHERE balance.budget_period_id = $1 AND balance.program_id = $2
          )
     ), months AS (
       SELECT month_start::date AS month_start,
              greatest(month_start::date, account.start_date) AS effective_start,
              least((month_start + interval '1 month - 1 day')::date, account.end_date) AS effective_end
         FROM account
         CROSS JOIN LATERAL generate_series(
           date_trunc('month', account.start_date)::date,
           date_trunc('month', account.end_date)::date,
           interval '1 month'
         ) AS generated(month_start)
     ), payroll AS (
       SELECT date_trunc('month', canonical_service_date(
                payroll_row.period_begin, payroll_row.check_date, payroll_row.period_end
              ))::date AS month_start,
              COALESCE(sum(
                CASE
                  WHEN account.rate_scope = 'per_group' AND COALESCE(account.internal_rate, 0) > 0
                    THEN COALESCE(
                           payroll_row.calculated_internal_amount,
                           payroll_row.spreadsheet_internal_amount,
                           payroll_row.internal_rate_applied * payroll_row.imported_hours,
                           0
                         ) / account.internal_rate
                  ELSE COALESCE(payroll_row.imported_hours, 0)
                END
              ), 0) AS used_hours
         FROM account
         JOIN payroll_transactions payroll_row
           ON account.consumption_source IN ('payroll', 'mixed')
          AND payroll_row.individual_id = account.individual_id
          AND payroll_row.program_id = account.program_id
          AND canonical_service_date(
                payroll_row.period_begin, payroll_row.check_date, payroll_row.period_end
              ) BETWEEN account.start_date AND account.end_date
        GROUP BY 1
     ), events AS (
       SELECT date_trunc('month', event.service_date)::date AS month_start,
              COALESCE(sum(event.hours), 0) AS used_hours
         FROM account
         JOIN program_budget_events event
           ON event.budget_period_id = account.budget_period_id
          AND event.program_id = account.program_id
        GROUP BY 1
     ), schedule AS (
       SELECT date_trunc('month', scheduled_session.session_date)::date AS month_start,
              COALESCE(sum(allocation.allocation_hours), 0) AS scheduled_hours
         FROM account
         JOIN scheduled_allocations allocation
           ON allocation.individual_id = account.individual_id
         JOIN scheduled_sessions scheduled_session
           ON scheduled_session.id = allocation.scheduled_session_id
          AND scheduled_session.program_id = account.program_id
          AND scheduled_session.status = 'pending'
          AND scheduled_session.matched_transaction_id IS NULL
          AND scheduled_session.session_date BETWEEN account.start_date AND account.end_date
        GROUP BY 1
     )
     SELECT months.month_start::text AS month_start,
            months.effective_start::text AS effective_start,
            months.effective_end::text AS effective_end,
            account.authorized_hours::text AS authorized_hours,
            (COALESCE(payroll.used_hours, 0) + COALESCE(events.used_hours, 0))::text AS used_hours,
            COALESCE(schedule.scheduled_hours, 0)::text AS scheduled_hours
       FROM account
       JOIN months ON true
       LEFT JOIN payroll ON payroll.month_start = months.month_start
       LEFT JOIN events ON events.month_start = months.month_start
       LEFT JOIN schedule ON schedule.month_start = months.month_start
      ORDER BY months.month_start`,
    [budgetPeriodId, programId, today],
  );

  let cumulativeUsed = dec(0);
  let cumulativeScheduled = dec(0);
  return rows.map((row) => {
    const authorized = dec(row.authorized_hours);
    cumulativeUsed = cumulativeUsed.plus(row.used_hours);
    cumulativeScheduled = cumulativeScheduled.plus(row.scheduled_hours);
    const remaining = authorized.minus(cumulativeUsed);
    const remainingAfterScheduled = remaining.minus(cumulativeScheduled);
    const periodStart = rows[0]?.effective_start ?? row.effective_start;
    const periodEnd = rows.at(-1)?.effective_end ?? row.effective_end;
    const cutoff = today < row.effective_end ? today : row.effective_end;
    const expected = cutoff < row.effective_start
      ? null
      : authorized.times(inclusiveDays(periodStart, cutoff)).dividedBy(inclusiveDays(periodStart, periodEnd));
    return {
      month: row.month_start.slice(0, 7),
      usedHours: toHours(row.used_hours),
      scheduledHours: toHours(row.scheduled_hours),
      cumulativeUsedHours: toHours(cumulativeUsed),
      cumulativeScheduledHours: toHours(cumulativeScheduled),
      remainingHours: toHours(remaining),
      remainingAfterScheduledHours: toHours(remainingAfterScheduled),
      expectedUsedHours: expected === null ? null : toHours(expected),
      paceVarianceHours: expected === null ? null : toHours(cumulativeUsed.minus(expected)),
    };
  });
}

export interface ProgramBudgetEventRecord {
  id: string;
  budgetPeriodId: string;
  individualId: string;
  programId: string;
  eventType: "consume" | "adjust" | "reverse";
  serviceDate: string;
  hours: string;
  amount: string;
  sourceType: string;
  sourceId: string;
  reversesEventId: string | null;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

interface ProgramBudgetEventRow {
  id: string;
  budget_period_id: string;
  individual_id: string;
  program_id: string;
  event_type: "consume" | "adjust" | "reverse";
  service_date: string;
  hours: string;
  amount: string;
  source_type: string;
  source_id: string;
  reverses_event_id: string | null;
  note: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

function toEvent(row: ProgramBudgetEventRow): ProgramBudgetEventRecord {
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    individualId: row.individual_id,
    programId: row.program_id,
    eventType: row.event_type,
    serviceDate: row.service_date,
    hours: toHours(row.hours),
    amount: toMoney(row.amount),
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversesEventId: row.reverses_event_id,
    note: row.note,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

export async function getProgramBudgetEvent(
  pool: PgLikePool,
  id: string,
): Promise<ProgramBudgetEventRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<ProgramBudgetEventRow>(
    `SELECT id, budget_period_id, individual_id, program_id, event_type,
            service_date::text AS service_date, hours::text AS hours,
            amount::text AS amount, source_type, source_id, reverses_event_id,
            note, created_by_user_id, created_at::text AS created_at
       FROM program_budget_events WHERE id = $1`,
    [id],
  );
  return rows[0] ? toEvent(rows[0]) : null;
}

export async function listProgramBudgetEvents(
  pool: PgLikePool,
  budgetPeriodId: string,
  programId: string,
): Promise<ProgramBudgetEventRecord[]> {
  if (!UUID.test(budgetPeriodId) || !UUID.test(programId)) return [];
  const { rows } = await pool.query<ProgramBudgetEventRow>(
    `SELECT id, budget_period_id, individual_id, program_id, event_type,
            service_date::text AS service_date, hours::text AS hours,
            amount::text AS amount, source_type, source_id, reverses_event_id,
            note, created_by_user_id, created_at::text AS created_at
       FROM program_budget_events
      WHERE budget_period_id = $1 AND program_id = $2
      ORDER BY service_date DESC, created_at DESC, id DESC`,
    [budgetPeriodId, programId],
  );
  return rows.map(toEvent);
}
