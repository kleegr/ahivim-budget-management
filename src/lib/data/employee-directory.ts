import {
  canAccessPlanning,
  employeeScopeClause,
  hasDirectEmployeeAccess,
  transactionScopeClause,
  type AccessScope,
} from "@/lib/auth/access";
import type { PgLikePool } from "@/lib/import/commit";
import { toHours } from "@/lib/money";

export type EmployeeDealReadiness = "ready" | "needs_deal" | "not_needed";

export interface EmployeeDirectoryRow {
  id: string;
  displayName: string;
  externalRef: string | null;
  status: string;
  archivedAt: string | null;
  transactionCount: number;
  checkCount: number;
  billedHours: string | null;
  individualsServed: number;
  lastActivityDate: string | null;
  dealReadiness: EmployeeDealReadiness | null;
  missingDealTransactions: number | null;
  openSettlementItems: number | null;
}

export interface PlanningEmployeeDirectoryRow {
  id: string;
  displayName: string;
  status: string;
  archivedAt: string | null;
  activeAssignments: number;
  assignedIndividuals: number;
  pendingSessions: number;
  pendingHours: string;
  nextSessionDate: string | null;
  weeklyAvailabilityWindows: number;
  upcomingTimeOff: number;
}

interface PlanningEmployeeRow {
  id: string;
  display_name: string;
  status: string;
  archived_at: string | null;
  active_assignments: string;
  assigned_individuals: string;
  pending_sessions: string;
  pending_hours: string;
  next_session_date: string | null;
  weekly_availability_windows: string;
  upcoming_time_off: string;
}

/**
 * Finance-free staff roster for internal planners. This query intentionally
 * reads only employee identity, assignments, schedules, and availability.
 */
export async function listPlanningEmployeeDirectory(
  pool: PgLikePool,
  scope: AccessScope,
): Promise<PlanningEmployeeDirectoryRow[]> {
  if (!canAccessPlanning(scope)) return [];

  const params: unknown[] = [];
  const scopeClause = employeeScopeClause(scope, "employee.id", params);
  const { rows } = await pool.query<PlanningEmployeeRow>(
    `SELECT employee.id, employee.display_name, employee.status,
            employee.archived_at::text AS archived_at,
            COALESCE(assignment.active_assignments, 0)::text AS active_assignments,
            COALESCE(assignment.assigned_individuals, 0)::text AS assigned_individuals,
            COALESCE(schedule.pending_sessions, 0)::text AS pending_sessions,
            COALESCE(schedule.pending_hours, 0)::text AS pending_hours,
            schedule.next_session_date,
            COALESCE(availability.weekly_windows, 0)::text AS weekly_availability_windows,
            COALESCE(time_off.upcoming_windows, 0)::text AS upcoming_time_off
       FROM employees employee
       LEFT JOIN LATERAL (
         SELECT count(*) AS active_assignments,
                count(DISTINCT assigned.individual_id) AS assigned_individuals
           FROM assignments assigned
          WHERE assigned.employee_id = employee.id
            AND assigned.status = 'active'
            AND assigned.archived_at IS NULL
            AND (assigned.start_date IS NULL OR assigned.start_date <= CURRENT_DATE)
            AND (assigned.end_date IS NULL OR assigned.end_date >= CURRENT_DATE)
       ) assignment ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS pending_sessions,
                COALESCE(sum(session.duration_hours), 0) AS pending_hours,
                to_char(min(session.session_date), 'YYYY-MM-DD') AS next_session_date
           FROM scheduled_sessions session
          WHERE session.employee_id = employee.id
            AND session.status = 'pending'
            AND session.archived_at IS NULL
            AND session.session_date >= CURRENT_DATE
       ) schedule ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS weekly_windows
           FROM employee_weekly_availability weekly
          WHERE weekly.employee_id = employee.id
            AND weekly.archived_at IS NULL
            AND weekly.effective_from <= CURRENT_DATE
            AND (weekly.effective_to IS NULL OR weekly.effective_to >= CURRENT_DATE)
       ) availability ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS upcoming_windows
           FROM employee_unavailability unavailable
          WHERE unavailable.employee_id = employee.id
            AND unavailable.archived_at IS NULL
            AND unavailable.end_date >= CURRENT_DATE
       ) time_off ON true
      WHERE TRUE${scopeClause}
      ORDER BY (employee.status = 'archived'), lower(employee.display_name), employee.id`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    archivedAt: row.archived_at,
    activeAssignments: Number(row.active_assignments),
    assignedIndividuals: Number(row.assigned_individuals),
    pendingSessions: Number(row.pending_sessions),
    pendingHours: toHours(row.pending_hours),
    nextSessionDate: row.next_session_date,
    weeklyAvailabilityWindows: Number(row.weekly_availability_windows),
    upcomingTimeOff: Number(row.upcoming_time_off),
  }));
}

interface EmployeeBaseRow {
  id: string;
  display_name: string;
  external_ref: string | null;
  status: string;
  archived_at: string | null;
}

interface ActivityRow {
  employee_id: string;
  transaction_count: string;
  check_count: string;
  billed_hours: string;
  individuals_served: string;
  last_activity_date: string | null;
}

interface DealRow {
  employee_id: string;
  has_current_deal: boolean;
  applicable_transactions: string;
  missing_deal_transactions: string;
}

interface SettlementRow {
  employee_id: string;
  open_items: string;
}

/**
 * One operational row per visible employee. Activity follows transaction scope;
 * deal and settlement signals are read only for employees granted directly.
 */
export async function listEmployeeDirectory(
  pool: PgLikePool,
  scope: AccessScope,
): Promise<EmployeeDirectoryRow[]> {
  const employeeParams: unknown[] = [];
  const employeeClause = employeeScopeClause(scope, "e.id", employeeParams);
  const { rows: employees } = await pool.query<EmployeeBaseRow>(
    `SELECT e.id, e.display_name, e.external_ref, e.status,
            e.archived_at::text AS archived_at
       FROM employees e
      WHERE TRUE${employeeClause}
      ORDER BY (e.status = 'archived'), e.display_name`,
    employeeParams,
  );

  if (employees.length === 0) return [];

  const employeeIds = employees.map((employee) => employee.id);
  const directEmployeeIds = employees
    .filter((employee) => hasDirectEmployeeAccess(scope, employee.id))
    .map((employee) => employee.id);

  const activityParams: unknown[] = [employeeIds];
  const activityScope = transactionScopeClause(
    scope,
    "t.individual_id",
    "t.employee_id",
    activityParams,
  );

  const activityPromise = pool.query<ActivityRow>(
    `SELECT t.employee_id,
            count(*)::text AS transaction_count,
            (count(DISTINCT concat_ws('|',
              COALESCE(NULLIF(btrim(t.check_number), ''), 'no-check'),
              COALESCE(t.check_date::text, ''),
              COALESCE(t.period_begin::text, ''),
              COALESCE(t.period_end::text, '')
            )) FILTER (
              WHERE NULLIF(btrim(t.check_number), '') IS NOT NULL
                 OR t.check_date IS NOT NULL
                 OR t.period_begin IS NOT NULL
                 OR t.period_end IS NOT NULL
            ))::text AS check_count,
            ${scope.canSeeHours
              ? "COALESCE(sum(t.imported_hours), 0)::text"
              : "'0'::text"} AS billed_hours,
            (count(DISTINCT t.individual_id) FILTER (WHERE t.individual_id IS NOT NULL))::text
              AS individuals_served,
            to_char(max(canonical_service_date(
              t.period_begin, t.check_date, t.period_end
            )), 'YYYY-MM-DD')
              AS last_activity_date
       FROM payroll_transactions t
      WHERE t.employee_id = ANY($1::uuid[])${activityScope}
      GROUP BY t.employee_id`,
    activityParams,
  );

  const dealPromise = (scope.canSeeEmployeeDeals && directEmployeeIds.length > 0)
    ? (() => {
        const params: unknown[] = [directEmployeeIds];
        const transactionScope = transactionScopeClause(
          scope,
          "t.individual_id",
          "t.employee_id",
          params,
        );
        return pool.query<DealRow>(
          `WITH permitted_employees AS (
             SELECT unnest($1::uuid[]) AS employee_id
           )
           SELECT pe.employee_id,
                  EXISTS (
                    SELECT 1
                      FROM employee_deals current_deal
                     WHERE current_deal.employee_id = pe.employee_id
                       AND current_deal.status = 'active'
                       AND current_deal.effective_from <= CURRENT_DATE
                       AND (current_deal.effective_to IS NULL OR current_deal.effective_to >= CURRENT_DATE)
                  ) AS has_current_deal,
                  (count(t.id) FILTER (
                    WHERE effective_payment_recipient(
                      t.payment_recipient, p.payment_recipient
                    ) IN ('employee', 'excellent_staffing')
                  ))::text AS applicable_transactions,
                  (count(t.id) FILTER (
                    WHERE effective_payment_recipient(
                      t.payment_recipient, p.payment_recipient
                    ) IN ('employee', 'excellent_staffing')
                      AND NOT EXISTS (
                        SELECT 1
                          FROM employee_deals effective_deal
                         WHERE effective_deal.employee_id = pe.employee_id
                           AND effective_deal.status = 'active'
                           AND effective_deal.effective_from <= canonical_service_date(
                             t.period_begin, t.check_date, t.period_end
                           )
                           AND (
                             effective_deal.effective_to IS NULL
                             OR effective_deal.effective_to >= canonical_service_date(
                               t.period_begin, t.check_date, t.period_end
                             )
                           )
                      )
                  ))::text AS missing_deal_transactions
             FROM permitted_employees pe
             LEFT JOIN payroll_transactions t
               ON t.employee_id = pe.employee_id${transactionScope}
             LEFT JOIN programs p ON p.id = t.program_id
            GROUP BY pe.employee_id`,
          params,
        );
      })()
    : Promise.resolve({ rows: [] as DealRow[] });

  const settlementPromise = (scope.canSeeSettlements && directEmployeeIds.length > 0)
    ? pool.query<SettlementRow>(
        `WITH balances AS (
           SELECT o.employee_id, o.id,
                  o.original_amount - COALESCE(sum(event.amount), 0) AS balance
             FROM settlement_obligations o
             LEFT JOIN settlement_events event
               ON event.settlement_obligation_id = o.id
            WHERE o.employee_id = ANY($1::uuid[])
              AND o.status = 'active'
            GROUP BY o.employee_id, o.id
         )
         SELECT employee_id,
                (count(*) FILTER (WHERE balance > 0))::text AS open_items
           FROM balances
          GROUP BY employee_id`,
        [directEmployeeIds],
      )
    : Promise.resolve({ rows: [] as SettlementRow[] });

  const [activityResult, dealResult, settlementResult] = await Promise.all([
    activityPromise,
    dealPromise,
    settlementPromise,
  ]);

  const activityByEmployee = new Map(
    activityResult.rows.map((row) => [row.employee_id, row]),
  );
  const dealsByEmployee = new Map(dealResult.rows.map((row) => [row.employee_id, row]));
  const settlementsByEmployee = new Map(
    settlementResult.rows.map((row) => [row.employee_id, row]),
  );

  return employees.map((employee) => {
    const activity = activityByEmployee.get(employee.id);
    const deal = dealsByEmployee.get(employee.id);
    const settlement = settlementsByEmployee.get(employee.id);
    const hasDirectAccess = hasDirectEmployeeAccess(scope, employee.id);
    const applicableTransactions = Number(deal?.applicable_transactions ?? 0);
    const missingDealTransactions = deal
      ? Number(deal.missing_deal_transactions)
      : null;
    let dealReadiness: EmployeeDealReadiness | null = null;
    if (deal) {
      dealReadiness = Number(deal.missing_deal_transactions) > 0
        ? "needs_deal"
        : deal.has_current_deal || applicableTransactions > 0
          ? "ready"
          : "not_needed";
    }

    return {
      id: employee.id,
      displayName: employee.display_name,
      externalRef: employee.external_ref,
      status: employee.status,
      archivedAt: employee.archived_at,
      transactionCount: Number(activity?.transaction_count ?? 0),
      checkCount: Number(activity?.check_count ?? 0),
      billedHours: scope.canSeeHours ? toHours(activity?.billed_hours ?? 0) : null,
      individualsServed: Number(activity?.individuals_served ?? 0),
      lastActivityDate: activity?.last_activity_date ?? null,
      dealReadiness,
      missingDealTransactions,
      openSettlementItems: scope.canSeeSettlements && hasDirectAccess
        ? Number(settlement?.open_items ?? 0)
        : null,
    };
  });
}
