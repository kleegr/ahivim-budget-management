import {
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
            to_char(max(COALESCE(t.check_date, t.period_end, t.period_begin)), 'YYYY-MM-DD')
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
                    WHERE t.payment_recipient IN ('employee', 'excellent_staffing')
                  ))::text AS applicable_transactions,
                  (count(t.id) FILTER (
                    WHERE t.payment_recipient IN ('employee', 'excellent_staffing')
                      AND NOT EXISTS (
                        SELECT 1
                          FROM employee_deals effective_deal
                         WHERE effective_deal.employee_id = pe.employee_id
                           AND effective_deal.status = 'active'
                           AND effective_deal.effective_from <= COALESCE(
                             t.check_date,
                             t.period_end,
                             t.period_begin,
                             t.created_at::date
                           )
                           AND (
                             effective_deal.effective_to IS NULL
                             OR effective_deal.effective_to >= COALESCE(
                               t.check_date,
                               t.period_end,
                               t.period_begin,
                               t.created_at::date
                             )
                           )
                      )
                  ))::text AS missing_deal_transactions
             FROM permitted_employees pe
             LEFT JOIN payroll_transactions t
               ON t.employee_id = pe.employee_id${transactionScope}
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
