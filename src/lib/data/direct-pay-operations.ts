import type { AccessScope } from "@/lib/auth/access";
import { agencyMonth } from "@/lib/business/agency-time";
import {
  directPayTargetProgress,
  directPayTargetWindow,
  type DirectPayTargetInterval,
  type DirectPayTargetStatus,
} from "@/lib/business/direct-pay-targets";
import type { PgLikePool } from "@/lib/import/commit";
import { dec, toHours, toMoney } from "@/lib/money";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FIRST_RELIABLE_MASSER_SETUP_MONTH = "2026-08";

/**
 * Reconstruct each Financial Setup line as it existed at the end of a selected
 * month. Strategy edits snapshot the prior row before changing it, so the
 * latest current-or-saved state before the month boundary is authoritative.
 * Months before August 2026 deliberately return no approved plan rather than
 * borrowing today's setup and rewriting historical statements.
 */
function effectiveStrategyPlansCtes(monthParameter: "$1" | "$2"): string {
  return `requested AS (
          SELECT month_start,
                 (month_start + interval '1 month')::date AS month_end_exclusive,
                 (month_start + interval '1 month' - interval '1 day')::date AS month_end
            FROM (
              SELECT make_date(
                split_part(${monthParameter}, '-', 1)::int,
                split_part(${monthParameter}, '-', 2)::int,
                1
              ) AS month_start
            ) value
        ), strategy_state_candidates AS (
          SELECT strategy.id AS strategy_id, strategy.individual_id,
                 strategy.after_all, strategy.renewal_date, strategy.status,
                 strategy.created_at,
                 strategy.updated_at AS effective_from,
                 1 AS current_state, 2147483647 AS candidate_revision
            FROM calculation_strategies strategy
          UNION ALL
          SELECT strategy.id AS strategy_id, strategy.individual_id,
                 NULLIF(revision.snapshot->>'after_all', '')::numeric AS after_all,
                 NULLIF(revision.snapshot->>'renewal_date', '')::date AS renewal_date,
                 COALESCE(NULLIF(revision.snapshot->>'status', ''), 'active') AS status,
                 strategy.created_at,
                 COALESCE(
                   NULLIF(revision.snapshot->>'updated_at', '')::timestamptz,
                   strategy.created_at
                 ) AS effective_from,
                 0 AS current_state, revision.revision AS candidate_revision
            FROM calculation_strategies strategy
            JOIN calculation_strategy_revisions revision ON revision.strategy_id = strategy.id
        ), effective_strategy_states AS (
          SELECT DISTINCT ON (candidate.strategy_id)
                 candidate.strategy_id, candidate.individual_id,
                 candidate.after_all, candidate.renewal_date, candidate.status
            FROM strategy_state_candidates candidate
            CROSS JOIN requested
           WHERE requested.month_end_exclusive >= DATE '2026-09-01'
             AND candidate.created_at < (requested.month_end_exclusive AT TIME ZONE 'America/New_York')
             AND candidate.effective_from < (requested.month_end_exclusive AT TIME ZONE 'America/New_York')
           ORDER BY candidate.strategy_id, candidate.effective_from DESC,
                    candidate.current_state DESC, candidate.candidate_revision DESC
        ), strategy_plans AS (
          SELECT state.individual_id,
                 COALESCE(sum(abs(state.after_all))
                   FILTER (WHERE state.after_all IS NOT NULL), 0) AS approved_monthly_plan,
                 count(*) FILTER (WHERE state.after_all IS NOT NULL) AS active_plans,
                 count(*) FILTER (
                   WHERE state.after_all IS NOT NULL
                     AND state.renewal_date IS NULL
                 ) AS missing_renewal_plans
            FROM effective_strategy_states state
           WHERE state.status = 'active'
           GROUP BY state.individual_id
        )`;
}

export interface DirectPayTargetFinancialRow {
  id: string;
  employeeId: string;
  employeeName: string;
  targetBasis: "gross";
  intervalUnit: DirectPayTargetInterval;
  intervalCount: number;
  grossTargetAmount: string | null;
  planningHourlyRate: string | null;
  targetHours: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "archived";
  notes: string | null;
}

export interface PlannerDirectPayTargetRow {
  id: string;
  employeeId: string;
  employeeName: string;
  intervalUnit: DirectPayTargetInterval;
  intervalCount: number;
  windowStart: string;
  windowEnd: string;
  targetHours: string;
  recordedHours: string;
  scheduledHours: string;
  coverageHours: string;
  remainingHours: string;
  status: DirectPayTargetStatus;
}

export interface PayrollCheckRow {
  id: string;
  employeeId: string;
  employeeName: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  actualGross: string | null;
  actualNet: string | null;
  taxWithheld: string | null;
  source: string;
  sourceRef: string | null;
  verificationStatus: "unverified" | "verified" | "void";
  notes: string | null;
  linkedTransactions: number;
  transactionIds: string[];
  updatedAt: string;
}

export interface EmployeeCollectionMonthRow {
  employeeId: string;
  employeeName: string;
  obligationsCreated: number;
  dueFromChecks: string;
  collectedThisMonth: string;
  refundedThisMonth: string;
  remainingReceivable: string;
  availableCredit: string;
}

export interface IndividualSetAsideMonthRow {
  individualId: string;
  individualName: string;
  approvedMonthlyPlan: string;
  setAsideThisMonth: string;
  remainingSetAside: string;
  activePlans: number;
  trackedPlans: number;
  missingRenewalPlans: number;
}

export interface CollectionsWorkspaceData {
  month: string;
  setupHistoryAvailable: boolean;
  employees: Array<{ id: string; name: string }>;
  employeeCollections: EmployeeCollectionMonthRow[];
  individualSetAsides: IndividualSetAsideMonthRow[];
  targets: DirectPayTargetFinancialRow[];
  payrollChecks: PayrollCheckRow[];
  visibility: {
    canSeeTargetMoney: boolean;
    canSeeTargetHours: boolean;
    canSeeCheckNet: boolean;
    canSeeTaxes: boolean;
  };
  summary: {
    dueFromChecks: string;
    collectedThisMonth: string;
    remainingReceivable: string;
    approvedMonthlySetAside: string;
    setAsideThisMonth: string;
  };
}

export interface IndividualMasserStatementData {
  individualId: string;
  individualName: string;
  setupHistoryAvailable: boolean;
  approvedMonthlyPlan: string;
  activePlans: number;
  trackedPlans: number;
  missingRenewalPlans: number;
  recordedReserve: string;
  remainingReserve: string;
  availableCredit: string;
  history: Array<{
    month: string;
    setAside: string;
    corrections: string;
    reversals: string;
  }>;
}

function employeeFinancialClause(scope: AccessScope, column: string, params: unknown[]): string {
  if (scope.full || scope.allEmployees) return "";
  if (scope.grantedEmployeeIds.length === 0) return " AND FALSE";
  params.push(scope.grantedEmployeeIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

function individualFinancialClause(scope: AccessScope, column: string, params: unknown[]): string {
  if (scope.full || scope.allIndividuals) return "";
  if (scope.grantedIndividualIds.length === 0) return " AND FALSE";
  params.push(scope.grantedIndividualIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

export async function listDirectPayTargetFinancials(
  pool: PgLikePool,
  scope: AccessScope,
  includeArchived = false,
): Promise<DirectPayTargetFinancialRow[]> {
  if (!scope.canSeeEmployeeAmounts && !scope.canSeeHours) return [];
  const params: unknown[] = [];
  const scopeClause = employeeFinancialClause(scope, "t.employee_id", params);
  params.push(includeArchived);
  const { rows } = await pool.query<{
    id: string; employee_id: string; employee_name: string; target_basis: "gross";
    interval_unit: DirectPayTargetInterval; interval_count: number;
    gross_target_amount: string; planning_hourly_rate: string; target_hours: string;
    effective_from: string; effective_to: string | null; status: "active" | "archived";
    notes: string | null;
  }>(
    `SELECT t.id, t.employee_id, e.display_name AS employee_name, t.target_basis,
            t.interval_unit, t.interval_count, t.gross_target_amount::text,
            t.planning_hourly_rate::text, t.target_hours::text,
            to_char(t.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(t.effective_to, 'YYYY-MM-DD') AS effective_to,
            t.status, t.notes
       FROM employee_direct_pay_targets t
       JOIN employees e ON e.id = t.employee_id
      WHERE ($${params.length}::boolean OR t.status = 'active')${scopeClause}
      ORDER BY e.display_name, t.effective_from DESC`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    targetBasis: row.target_basis,
    intervalUnit: row.interval_unit,
    intervalCount: row.interval_count,
    grossTargetAmount: scope.canSeeEmployeeAmounts ? toMoney(row.gross_target_amount) : null,
    planningHourlyRate: scope.canSeeEmployeeAmounts ? toMoney(row.planning_hourly_rate) : null,
    targetHours: scope.canSeeHours ? toHours(row.target_hours) : null,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    notes: row.notes,
  }));
}

export async function listPlannerDirectPayTargets(
  pool: PgLikePool,
  asOf: string,
): Promise<PlannerDirectPayTargetRow[]> {
  const { rows } = await pool.query<{
    id: string; employee_id: string; employee_name: string;
    interval_unit: DirectPayTargetInterval; interval_count: number; target_hours: string;
    effective_from: string; effective_to: string | null;
  }>(
    `SELECT t.id, t.employee_id, e.display_name AS employee_name,
            t.interval_unit, t.interval_count, t.target_hours::text,
            to_char(t.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(t.effective_to, 'YYYY-MM-DD') AS effective_to
       FROM employee_direct_pay_targets t
       JOIN employees e ON e.id = t.employee_id
      WHERE t.status = 'active'
        AND t.effective_from <= $1::date
        AND (t.effective_to IS NULL OR t.effective_to >= $1::date)
      ORDER BY e.display_name`,
    [asOf],
  );
  const targets = rows.flatMap((row) => {
    const window = directPayTargetWindow({
      intervalUnit: row.interval_unit,
      intervalCount: row.interval_count,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    }, asOf);
    return window ? [{ ...row, ...window }] : [];
  });
  if (targets.length === 0) return [];

  const windows = targets.map((target) => ({
    id: target.id,
    employeeId: target.employee_id,
    startDate: target.startDate,
    endDate: target.endDate,
  }));
  const activity = await pool.query<{
    target_id: string; recorded_hours: string; scheduled_hours: string;
  }>(
    `WITH target_windows AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb)
           AS w(id uuid, "employeeId" uuid, "startDate" date, "endDate" date)
     ), latest_program_routing AS (
       SELECT DISTINCT ON (t.employee_id, t.program_id)
              t.employee_id, t.program_id, t.payment_recipient
         FROM payroll_transactions t
        WHERE t.employee_id IS NOT NULL AND t.program_id IS NOT NULL
          AND canonical_service_date(t.period_begin, t.check_date, t.period_end) IS NOT NULL
        ORDER BY t.employee_id, t.program_id,
                 canonical_service_date(t.period_begin, t.check_date, t.period_end) DESC NULLS LAST,
                 t.id DESC
     )
     SELECT w.id::text AS target_id,
            COALESCE((
              SELECT sum(t.imported_hours)
                FROM payroll_transactions t
                LEFT JOIN programs p ON p.id = t.program_id
               WHERE t.employee_id = w."employeeId"
                 AND effective_payment_recipient(
                   t.payment_recipient,
                   p.payment_recipient
                 ) = 'employee'
                 AND canonical_service_date(t.period_begin, t.check_date, t.period_end)
                     BETWEEN w."startDate" AND w."endDate"
            ), 0)::text AS recorded_hours,
            COALESCE((
              SELECT sum(s.duration_hours)
                FROM scheduled_sessions s
                JOIN programs p ON p.id = s.program_id
                LEFT JOIN latest_program_routing routing
                  ON routing.employee_id = s.employee_id AND routing.program_id = s.program_id
               WHERE s.employee_id = w."employeeId"
                 AND s.status = 'pending' AND s.matched_transaction_id IS NULL
                 AND s.session_date BETWEEN w."startDate" AND w."endDate"
                 AND effective_payment_recipient(
                   routing.payment_recipient,
                   p.payment_recipient
                 ) = 'employee'
            ), 0)::text AS scheduled_hours
       FROM target_windows w`,
    [JSON.stringify(windows)],
  );
  const byId = new Map(activity.rows.map((row) => [row.target_id, row]));
  return targets.map((target) => {
    const actual = byId.get(target.id);
    const recordedHours = toHours(actual?.recorded_hours ?? 0);
    const scheduledHours = toHours(actual?.scheduled_hours ?? 0);
    const progress = directPayTargetProgress({ targetHours: target.target_hours, recordedHours, scheduledHours });
    return {
      id: target.id,
      employeeId: target.employee_id,
      employeeName: target.employee_name,
      intervalUnit: target.interval_unit,
      intervalCount: target.interval_count,
      windowStart: target.startDate,
      windowEnd: target.endDate,
      targetHours: toHours(target.target_hours),
      recordedHours,
      scheduledHours,
      ...progress,
    };
  });
}

export async function listPayrollChecks(
  pool: PgLikePool,
  scope: AccessScope,
  limit = 100,
  payrollCheckId?: string | null,
): Promise<PayrollCheckRow[]> {
  if (!scope.canSeeCheckNet && !scope.canSeeTaxes) return [];
  const params: unknown[] = [];
  const scopeClause = employeeFinancialClause(scope, "c.employee_id", params);
  let checkClause = "";
  if (payrollCheckId && UUID.test(payrollCheckId)) {
    params.push(payrollCheckId);
    checkClause = ` AND c.id = $${params.length}::uuid`;
  }
  params.push(Math.max(1, Math.min(limit, 500)));
  const { rows } = await pool.query<{
    id: string; employee_id: string; employee_name: string; check_number: string | null;
    check_date: string | null; period_begin: string | null; period_end: string | null;
    actual_gross: string | null; actual_net: string; tax_withheld: string | null;
    source: string; source_ref: string | null; verification_status: PayrollCheckRow["verificationStatus"];
    notes: string | null; linked_transactions: string; transaction_ids: string[]; updated_at: string;
  }>(
    `SELECT c.id, c.employee_id, e.display_name AS employee_name, c.check_number,
            to_char(c.check_date, 'YYYY-MM-DD') AS check_date,
            to_char(c.period_begin, 'YYYY-MM-DD') AS period_begin,
            to_char(c.period_end, 'YYYY-MM-DD') AS period_end,
            c.actual_gross::text, c.actual_net::text, c.tax_withheld::text,
            c.source, c.source_ref, c.verification_status, c.notes,
            count(t.id)::text AS linked_transactions,
            COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), ARRAY[]::text[]) AS transaction_ids,
            c.updated_at::text
       FROM employee_payroll_checks c
       JOIN employees e ON e.id = c.employee_id
       LEFT JOIN payroll_transactions t ON t.payroll_check_id = c.id
      WHERE TRUE${scopeClause}${checkClause}
      GROUP BY c.id, e.display_name
      ORDER BY CASE c.verification_status WHEN 'unverified' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END,
               COALESCE(c.check_date, c.period_end, c.period_begin) DESC NULLS LAST,
               c.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    checkNumber: row.check_number,
    checkDate: row.check_date,
    periodBegin: row.period_begin,
    periodEnd: row.period_end,
    actualGross: scope.canSeeTaxes && row.actual_gross !== null ? toMoney(row.actual_gross) : null,
    actualNet: scope.canSeeCheckNet ? toMoney(row.actual_net) : null,
    taxWithheld: scope.canSeeTaxes && row.tax_withheld !== null ? toMoney(row.tax_withheld) : null,
    source: row.source,
    sourceRef: row.source_ref,
    verificationStatus: row.verification_status,
    notes: row.notes,
    linkedTransactions: Number(row.linked_transactions),
    transactionIds: scope.canSeeTransactions ? row.transaction_ids ?? [] : [],
    updatedAt: row.updated_at,
  }));
}

export async function getCollectionsWorkspace(
  pool: PgLikePool,
  scope: AccessScope,
  requestedMonth: string,
  options: { payrollCheckId?: string | null } = {},
): Promise<CollectionsWorkspaceData> {
  const month = MONTH.test(requestedMonth) ? requestedMonth : agencyMonth();
  const employeeParams: unknown[] = [month];
  const employeeScope = employeeFinancialClause(scope, "o.employee_id", employeeParams);
  const individualParams: unknown[] = [month];
  const individualScope = individualFinancialClause(scope, "i.id", individualParams);

  const [employeeResult, individualResult, targets, payrollChecks, employeeOptions] = await Promise.all([
    pool.query<{
      employee_id: string; employee_name: string; obligations_created: string;
      due_from_checks: string; collected_this_month: string; refunded_this_month: string;
      remaining_receivable: string; available_credit: string;
    }>(
      `WITH event_totals AS (
         SELECT settlement_obligation_id,
                COALESCE(sum(amount), 0) AS applied,
                COALESCE(sum(amount) FILTER (WHERE to_char(occurred_on, 'YYYY-MM') = $1), 0) AS applied_month
           FROM settlement_events
          GROUP BY settlement_obligation_id
       )
       SELECT o.employee_id, e.display_name AS employee_name,
              count(*) FILTER (
                WHERE o.direction = 'receivable'
                  AND to_char(canonical_service_date(o.period_begin, o.check_date, o.period_end), 'YYYY-MM') = $1
              )::text AS obligations_created,
              COALESCE(sum(o.original_amount) FILTER (
                WHERE o.direction = 'receivable'
                  AND to_char(canonical_service_date(o.period_begin, o.check_date, o.period_end), 'YYYY-MM') = $1
              ), 0)::text AS due_from_checks,
              COALESCE(sum(ev.applied_month) FILTER (WHERE o.direction = 'receivable'), 0)::text AS collected_this_month,
              COALESCE(sum(ev.applied_month) FILTER (WHERE o.direction = 'payable'), 0)::text AS refunded_this_month,
              COALESCE(sum(GREATEST(o.original_amount - COALESCE(ev.applied, 0), 0))
                FILTER (WHERE o.status = 'active' AND o.direction = 'receivable'), 0)::text AS remaining_receivable,
              COALESCE(sum(GREATEST(COALESCE(ev.applied, 0) - o.original_amount, 0))
                FILTER (WHERE o.status = 'active' AND o.direction = 'receivable'), 0)::text AS available_credit
         FROM settlement_obligations o
         JOIN employees e ON e.id = o.employee_id
         LEFT JOIN event_totals ev ON ev.settlement_obligation_id = o.id
        WHERE o.employee_id IS NOT NULL
          AND o.kind LIKE 'employee_giveback%'${employeeScope}
       GROUP BY o.employee_id, e.display_name
       HAVING COALESCE(sum(o.original_amount) FILTER (
                WHERE to_char(canonical_service_date(o.period_begin, o.check_date, o.period_end), 'YYYY-MM') = $1
              ), 0) <> 0
           OR COALESCE(sum(ev.applied_month), 0) <> 0
           OR COALESCE(sum(GREATEST(o.original_amount - COALESCE(ev.applied, 0), 0))
                FILTER (WHERE o.status = 'active' AND o.direction = 'receivable'), 0) <> 0
        ORDER BY e.display_name`,
      employeeParams,
    ),
    pool.query<{
      individual_id: string; individual_name: string; approved_monthly_plan: string;
      set_aside_this_month: string; remaining_set_aside: string; active_plans: string;
      tracked_plans: string; missing_renewal_plans: string;
    }>(
       `WITH ${effectiveStrategyPlansCtes("$1")}, plan_candidates AS (
          SELECT o.individual_id, o.calculation_strategy_id, o.period_begin, o.period_end,
                 max(o.created_at) AS latest_root_at
            FROM settlement_obligations o
            CROSS JOIN requested
           WHERE o.individual_id IS NOT NULL
             AND o.status = 'active'
             AND o.calculation_metadata->>'flow' = 'individual_plan'
             AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
             AND o.period_begin IS NOT NULL
             AND o.period_end IS NOT NULL
             AND o.period_begin <= requested.month_end
             AND o.period_end > requested.month_end
           GROUP BY o.individual_id, o.calculation_strategy_id, o.period_begin, o.period_end
        ), selected_plans AS (
          SELECT DISTINCT ON (individual_id, calculation_strategy_id)
                 individual_id, calculation_strategy_id, period_begin, period_end
            FROM plan_candidates
           ORDER BY individual_id, calculation_strategy_id DESC NULLS LAST,
                    period_begin DESC, period_end DESC, latest_root_at DESC
        ), roots AS (
          SELECT o.*,
                 COALESCE(latest.calculation_metadata->>'recalculatedDirection', o.direction) AS current_direction,
                 COALESCE(NULLIF(latest.calculation_metadata->>'recalculatedOriginalAmount', '')::numeric, o.original_amount) AS current_target
            FROM settlement_obligations o
            JOIN selected_plans selected
              ON selected.individual_id = o.individual_id
             AND selected.calculation_strategy_id IS NOT DISTINCT FROM o.calculation_strategy_id
             AND selected.period_begin = o.period_begin
             AND selected.period_end = o.period_end
            LEFT JOIN LATERAL (
             SELECT correction.calculation_metadata
               FROM settlement_obligations correction
              WHERE correction.calculation_metadata->>'adjustmentForObligationId' = o.id::text
                AND correction.status = 'active'
              ORDER BY correction.created_at DESC, correction.id DESC
              LIMIT 1
           ) latest ON true
          WHERE o.individual_id IS NOT NULL
             AND o.status = 'active'
             AND o.calculation_metadata->>'flow' = 'individual_plan'
             AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
        ), event_totals AS (
         SELECT se.individual_id,
                 COALESCE(sum(CASE
                   WHEN obligation.direction = 'reserve' THEN se.amount
                   ELSE -se.amount
                 END) FILTER (
                   WHERE to_char(se.occurred_on, 'YYYY-MM') = $1
                 ), 0) AS set_aside_month
           FROM settlement_events se
           JOIN settlement_obligations obligation ON obligation.id = se.settlement_obligation_id
           JOIN roots root
             ON COALESCE(obligation.calculation_metadata->>'adjustmentForObligationId', obligation.id::text) = root.id::text
          WHERE se.individual_id IS NOT NULL
          GROUP BY se.individual_id
       ), obligation_balances AS (
         SELECT COALESCE(o.calculation_metadata->>'adjustmentForObligationId', o.id::text) AS root_key,
                o.direction,
                o.original_amount - COALESCE(sum(se.amount), 0) AS balance
           FROM settlement_obligations o
           JOIN roots root
             ON COALESCE(o.calculation_metadata->>'adjustmentForObligationId', o.id::text) = root.id::text
           LEFT JOIN settlement_events se ON se.settlement_obligation_id = o.id
          WHERE o.status = 'active'
          GROUP BY o.id
       ), current_balances AS (
         SELECT r.individual_id, r.id,
                r.current_direction,
                sum(CASE WHEN entry.direction = 'receivable' THEN -entry.balance ELSE entry.balance END) AS signed_balance
           FROM roots r
           JOIN obligation_balances entry ON entry.root_key = r.id::text
          GROUP BY r.individual_id, r.id, r.current_direction
       ), balances AS (
         SELECT individual_id,
                COALESCE(sum(GREATEST(signed_balance, 0))
                  FILTER (WHERE current_direction = 'reserve'), 0) AS remaining
           FROM current_balances
          GROUP BY individual_id
       ), ledger_plans AS (
         SELECT individual_id,
                count(DISTINCT COALESCE(calculation_strategy_id::text, id::text)) AS tracked_plans
           FROM roots
          GROUP BY individual_id
       )
       SELECT i.id AS individual_id, i.display_name AS individual_name,
              COALESCE(plan.approved_monthly_plan, 0)::text AS approved_monthly_plan,
              COALESCE(ev.set_aside_month, 0)::text AS set_aside_this_month,
              COALESCE(b.remaining, 0)::text AS remaining_set_aside,
              COALESCE(plan.active_plans, 0)::text AS active_plans,
              COALESCE(ledger.tracked_plans, 0)::text AS tracked_plans,
              COALESCE(plan.missing_renewal_plans, 0)::text AS missing_renewal_plans
         FROM individuals i
         LEFT JOIN strategy_plans plan ON plan.individual_id = i.id
         LEFT JOIN event_totals ev ON ev.individual_id = i.id
         LEFT JOIN balances b ON b.individual_id = i.id
         LEFT JOIN ledger_plans ledger ON ledger.individual_id = i.id
        WHERE TRUE${individualScope}
          AND (COALESCE(plan.active_plans, 0) > 0
            OR COALESCE(ledger.tracked_plans, 0) > 0
            OR COALESCE(ev.set_aside_month, 0) <> 0
            OR COALESCE(b.remaining, 0) <> 0)
        ORDER BY i.display_name`,
      individualParams,
    ),
    listDirectPayTargetFinancials(pool, scope, true),
    listPayrollChecks(pool, scope, 100, options.payrollCheckId),
    (async () => {
      const params: unknown[] = [];
      const clause = employeeFinancialClause(scope, "e.id", params);
      return pool.query<{ id: string; name: string }>(
        `SELECT e.id, e.display_name AS name FROM employees e
          WHERE e.status <> 'archived'${clause} ORDER BY e.display_name`,
        params,
      );
    })(),
  ]);

  const employeeCollections = employeeResult.rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    obligationsCreated: Number(row.obligations_created),
    dueFromChecks: toMoney(row.due_from_checks),
    collectedThisMonth: toMoney(row.collected_this_month),
    refundedThisMonth: toMoney(row.refunded_this_month),
    remainingReceivable: toMoney(row.remaining_receivable),
    availableCredit: toMoney(row.available_credit),
  }));
  const individualSetAsides = individualResult.rows.map((row) => ({
    individualId: row.individual_id,
    individualName: row.individual_name,
    approvedMonthlyPlan: toMoney(row.approved_monthly_plan),
    setAsideThisMonth: toMoney(row.set_aside_this_month),
    remainingSetAside: toMoney(row.remaining_set_aside),
    activePlans: Number(row.active_plans),
    trackedPlans: Number(row.tracked_plans),
    missingRenewalPlans: Number(row.missing_renewal_plans),
  }));
  const sum = <T,>(rows: T[], pick: (row: T) => string) => toMoney(rows.reduce((total, row) => total.plus(pick(row)), dec(0)));
  return {
    month,
    setupHistoryAvailable: month >= FIRST_RELIABLE_MASSER_SETUP_MONTH,
    employees: employeeOptions.rows,
    employeeCollections,
    individualSetAsides,
    targets,
    payrollChecks,
    visibility: {
      canSeeTargetMoney: scope.canSeeEmployeeAmounts,
      canSeeTargetHours: scope.canSeeHours,
      canSeeCheckNet: scope.canSeeCheckNet,
      canSeeTaxes: scope.canSeeTaxes,
    },
    summary: {
      dueFromChecks: sum(employeeCollections, (row) => row.dueFromChecks),
      collectedThisMonth: sum(employeeCollections, (row) => row.collectedThisMonth),
      remainingReceivable: sum(employeeCollections, (row) => row.remainingReceivable),
      approvedMonthlySetAside: sum(individualSetAsides, (row) => row.approvedMonthlyPlan),
      setAsideThisMonth: sum(individualSetAsides, (row) => row.setAsideThisMonth),
    },
  };
}

/** Aggregate statement safe to show an individual or family representative. */
export async function getIndividualMasserStatement(
  pool: PgLikePool,
  scope: AccessScope,
  individualId: string,
  requestedMonth = agencyMonth(),
): Promise<IndividualMasserStatementData | null> {
  const month = MONTH.test(requestedMonth) ? requestedMonth : agencyMonth();
  const params: unknown[] = [individualId];
  const scopeClause = individualFinancialClause(scope, "i.id", params);
  const person = await pool.query<{ id: string; display_name: string }>(
    `SELECT i.id, i.display_name
       FROM individuals i
      WHERE i.id = $1${scopeClause}
      LIMIT 1`,
    params,
  );
  if (!person.rows[0]) return null;

  const [planResult, historyResult] = await Promise.all([
    pool.query<{
      approved_monthly_plan: string; active_plans: string; tracked_plans: string;
      missing_renewal_plans: string; recorded_reserve: string;
      remaining_reserve: string; available_credit: string;
    }>(
      `WITH ${effectiveStrategyPlansCtes("$2")}, strategy_plan AS (
         SELECT COALESCE(max(plan.approved_monthly_plan), 0) AS approved_monthly_plan,
                COALESCE(max(plan.active_plans), 0) AS active_plans,
                COALESCE(max(plan.missing_renewal_plans), 0) AS missing_renewal_plans
           FROM strategy_plans plan
          WHERE plan.individual_id = $1
       ), plan_candidates AS (
         SELECT o.calculation_strategy_id, o.period_begin, o.period_end,
                max(o.created_at) AS latest_root_at
           FROM settlement_obligations o
           CROSS JOIN requested
          WHERE o.individual_id = $1
            AND o.status = 'active'
            AND o.calculation_metadata->>'flow' = 'individual_plan'
            AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
            AND o.period_begin IS NOT NULL
            AND o.period_end IS NOT NULL
            AND o.period_begin <= requested.month_end
            AND o.period_end > requested.month_end
          GROUP BY o.calculation_strategy_id, o.period_begin, o.period_end
       ), selected_plans AS (
         SELECT DISTINCT ON (calculation_strategy_id)
                calculation_strategy_id, period_begin, period_end
           FROM plan_candidates
          ORDER BY calculation_strategy_id DESC NULLS LAST,
                   period_begin DESC, period_end DESC, latest_root_at DESC
       ), roots AS (
         SELECT o.*,
                COALESCE(latest.calculation_metadata->>'recalculatedDirection', o.direction) AS current_direction,
                COALESCE(NULLIF(latest.calculation_metadata->>'recalculatedOriginalAmount', '')::numeric, o.original_amount) AS current_target
           FROM settlement_obligations o
           JOIN selected_plans selected
             ON selected.calculation_strategy_id IS NOT DISTINCT FROM o.calculation_strategy_id
            AND selected.period_begin = o.period_begin
            AND selected.period_end = o.period_end
           LEFT JOIN LATERAL (
             SELECT correction.calculation_metadata
               FROM settlement_obligations correction
              WHERE correction.calculation_metadata->>'adjustmentForObligationId' = o.id::text
                AND correction.status = 'active'
              ORDER BY correction.created_at DESC, correction.id DESC
              LIMIT 1
           ) latest ON true
          WHERE o.individual_id = $1
            AND o.status = 'active'
            AND o.calculation_metadata->>'flow' = 'individual_plan'
            AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
       ), obligation_balances AS (
         SELECT COALESCE(o.calculation_metadata->>'adjustmentForObligationId', o.id::text) AS root_key,
                o.direction,
                o.original_amount - COALESCE(sum(event.amount), 0) AS balance
           FROM settlement_obligations o
           JOIN roots root
             ON COALESCE(o.calculation_metadata->>'adjustmentForObligationId', o.id::text) = root.id::text
           LEFT JOIN settlement_events event ON event.settlement_obligation_id = o.id
          WHERE o.status = 'active'
          GROUP BY o.id
       ), current_balances AS (
         SELECT root.id, root.current_direction,
                sum(CASE WHEN entry.direction = 'receivable' THEN -entry.balance ELSE entry.balance END) AS signed_balance
           FROM roots root
           JOIN obligation_balances entry ON entry.root_key = root.id::text
          GROUP BY root.id, root.current_direction
       ), ledger_plans AS (
         SELECT count(DISTINCT COALESCE(calculation_strategy_id::text, id::text)) AS tracked_plans
           FROM roots
       )
       SELECT strategy_plan.approved_monthly_plan::text AS approved_monthly_plan,
              strategy_plan.active_plans::text AS active_plans,
              strategy_plan.missing_renewal_plans::text AS missing_renewal_plans,
              COALESCE(ledger_plans.tracked_plans, 0)::text AS tracked_plans,
              COALESCE((
                 SELECT sum(CASE
                   WHEN obligation.direction = 'reserve' THEN event.amount
                   ELSE -event.amount
                 END)
                   FROM settlement_events event
                   JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
                   JOIN roots event_root
                     ON COALESCE(obligation.calculation_metadata->>'adjustmentForObligationId', obligation.id::text) = event_root.id::text
               ), 0)::text AS recorded_reserve,
              COALESCE((
                SELECT sum(GREATEST(balance.signed_balance, 0))
                  FROM current_balances balance
                 WHERE balance.current_direction = 'reserve'
              ), 0)::text AS remaining_reserve,
              COALESCE((
                SELECT sum(GREATEST(-balance.signed_balance, 0))
                  FROM current_balances balance
                 WHERE balance.current_direction = 'reserve'
               ), 0)::text AS available_credit
         FROM strategy_plan
         CROSS JOIN ledger_plans`,
      [individualId, month],
    ),
    pool.query<{ month: string; set_aside: string; corrections: string; reversals: string }>(
      `WITH requested AS (
         SELECT (month_start + interval '1 month' - interval '1 day')::date AS month_end
           FROM (
             SELECT make_date(split_part($2, '-', 1)::int, split_part($2, '-', 2)::int, 1) AS month_start
           ) value
       ), plan_candidates AS (
         SELECT obligation.calculation_strategy_id, obligation.period_begin, obligation.period_end,
                max(obligation.created_at) AS latest_root_at
           FROM settlement_obligations obligation
           CROSS JOIN requested
          WHERE obligation.individual_id = $1
            AND obligation.status = 'active'
            AND obligation.calculation_metadata->>'flow' = 'individual_plan'
            AND NOT (obligation.calculation_metadata ? 'adjustmentForObligationId')
            AND obligation.period_begin IS NOT NULL
            AND obligation.period_end IS NOT NULL
             AND obligation.period_begin <= requested.month_end
             AND obligation.period_end > requested.month_end
          GROUP BY obligation.calculation_strategy_id, obligation.period_begin, obligation.period_end
       ), selected_plans AS (
         SELECT DISTINCT ON (calculation_strategy_id)
                calculation_strategy_id, period_begin, period_end
           FROM plan_candidates
          ORDER BY calculation_strategy_id DESC NULLS LAST,
                   period_begin DESC, period_end DESC, latest_root_at DESC
       ), roots AS (
         SELECT obligation.id
           FROM settlement_obligations obligation
           JOIN selected_plans selected
             ON selected.calculation_strategy_id IS NOT DISTINCT FROM obligation.calculation_strategy_id
            AND selected.period_begin = obligation.period_begin
            AND selected.period_end = obligation.period_end
          WHERE obligation.individual_id = $1
            AND obligation.status = 'active'
            AND obligation.calculation_metadata->>'flow' = 'individual_plan'
            AND NOT (obligation.calculation_metadata ? 'adjustmentForObligationId')
       )
       SELECT to_char(date_trunc('month', event.occurred_on), 'YYYY-MM') AS month,
              COALESCE(sum(CASE
                WHEN obligation.direction = 'reserve' THEN event.amount
                ELSE -event.amount
              END), 0)::text AS set_aside,
              COALESCE(sum(abs(event.amount)) FILTER (
                WHERE event.event_type IN ('credit', 'adjustment', 'reversal')
                   OR obligation.calculation_metadata ? 'adjustmentForObligationId'
              ), 0)::text AS corrections,
              COALESCE(sum(abs(event.amount)) FILTER (WHERE event.event_type = 'reversal'), 0)::text AS reversals
         FROM settlement_events event
         JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
         JOIN roots root
           ON COALESCE(obligation.calculation_metadata->>'adjustmentForObligationId', obligation.id::text) = root.id::text
        GROUP BY date_trunc('month', event.occurred_on)
        ORDER BY date_trunc('month', event.occurred_on) DESC`,
      [individualId, month],
    ),
  ]);
  const plan = planResult.rows[0];
  return {
    individualId,
    individualName: person.rows[0].display_name,
    setupHistoryAvailable: month >= FIRST_RELIABLE_MASSER_SETUP_MONTH,
    approvedMonthlyPlan: toMoney(plan?.approved_monthly_plan ?? 0),
    activePlans: Number(plan?.active_plans ?? 0),
    trackedPlans: Number(plan?.tracked_plans ?? 0),
    missingRenewalPlans: Number(plan?.missing_renewal_plans ?? 0),
    recordedReserve: toMoney(plan?.recorded_reserve ?? 0),
    remainingReserve: toMoney(plan?.remaining_reserve ?? 0),
    availableCredit: toMoney(plan?.available_credit ?? 0),
    history: historyResult.rows.map((row) => ({
      month: row.month,
      setAside: toMoney(row.set_aside),
      corrections: toMoney(row.corrections),
      reversals: toMoney(row.reversals),
    })),
  };
}
