import type { PgLikePool, PgLikeResult } from "@/lib/import/commit";
import { agencyMonth } from "@/lib/business/agency-time";
import { toHours, toMoney } from "@/lib/money";
import {
  PORTAL_ROLE_LABELS,
  hasPortalCapability,
  hasPortalEmployeeCapability,
  hasPortalIndividualCapability,
  isPortalOwner,
  portalCapabilities,
  type AgencyPortalRole,
  type IndividualRelationship,
  type PortalAccessContext,
  type PortalCapability,
  type PortalRole,
} from "@/lib/auth/portal-access";

export interface PortalRoleSummary {
  key: PortalRole;
  label: string;
}

export interface PortalUsageSummary {
  authorized: string;
  used: string;
  remaining: string;
}

export interface PortalDollarUsageSummary {
  authorized: string | null;
  used: string;
  remaining: string | null;
}

export interface PortalIndividualSummary {
  id: string;
  name: string;
  relationships: IndividualRelationship[];
  hours: PortalUsageSummary | null;
  dollars: PortalDollarUsageSummary | null;
  month: string;
  billedThisMonth: string | null;
  setAsideThisMonth: string | null;
  directChecksThisMonth: string | null;
  agencyPaidThisMonth: string | null;
}

export interface PortalPayrollCheckSummary {
  id: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  actualGross?: string | null;
  actualNet?: string;
  taxWithheld?: string | null;
}

export interface PortalEmployeeSummary {
  id: string;
  name: string;
  checkVisibility: {
    gross: boolean;
    net: boolean;
    tax: boolean;
  };
  checks: PortalPayrollCheckSummary[] | null;
  giveBack: {
    month: string;
    dueThisMonth: string;
    collectedThisMonth: string;
    remaining: string;
  } | null;
}

export interface PortalAgencySummary {
  id: string;
  code: string;
  name: string;
  roles: PortalRoleSummary[];
  capabilities: PortalCapability[];
  individualCount: number | null;
  employeeCount: number | null;
  managedBudgetCount: number | null;
  billingWithoutBudgetCount: number | null;
  budgetHours: PortalUsageSummary | null;
  budgetDollars: PortalDollarUsageSummary | null;
  month: string;
  billedThisMonth: string | null;
  setAsideThisMonth: string | null;
  agencyPaidThisMonth: string | null;
  payrollGrossThisMonth: string | null;
  payrollNetThisMonth: string | null;
  giveBackRemaining: string | null;
}

export interface PortalHomeReadModel {
  month: string;
  globalRoles: PortalRoleSummary[];
  globalCapabilities: PortalCapability[];
  directProfiles: {
    individualCount: number;
    employeeCount: number;
  };
  individuals: PortalIndividualSummary[];
  employees: PortalEmployeeSummary[];
  agencies: PortalAgencySummary[];
}

interface PersonRow {
  id: string;
  name: string;
}

interface BudgetAggregateRow {
  scope_id: string;
  authorized_hours: string;
  used_hours: string;
  remaining_hours: string;
  authorized_dollars: string | null;
  used_dollars: string;
  remaining_dollars: string | null;
}

interface MoneyAggregateRow {
  scope_id: string;
  amount: string;
}

interface PayrollCheckRow {
  id: string;
  employee_id: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  actual_gross: string | null;
  actual_net: string | null;
  tax_withheld: string | null;
}

interface GiveBackRow {
  scope_id: string;
  due_this_month: string;
  collected_this_month: string;
  remaining: string;
}

interface AgencyAggregateRow {
  id: string;
  code: string;
  name: string;
  individual_count: number | string;
  employee_count: number | string;
  managed_budget_count: number | string;
  billing_without_budget_count: number | string;
}

interface AgencyFinancialRow {
  scope_id: string;
  billed_this_month: string | null;
  set_aside_this_month: string | null;
  agency_paid_this_month: string | null;
  payroll_gross_this_month: string | null;
  payroll_net_this_month: string | null;
  giveback_remaining: string | null;
}

function roleSummary(role: PortalRole): PortalRoleSummary {
  return { key: role, label: PORTAL_ROLE_LABELS[role] };
}

function empty<T>(): PgLikeResult<T> {
  return { rows: [] };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function normalizePortalMonth(value?: string | null): string {
  return typeof value === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : agencyMonth();
}

function mapByScope<T extends { scope_id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.scope_id, row]));
}

function usage(row: BudgetAggregateRow | undefined): PortalUsageSummary {
  return {
    authorized: toHours(row?.authorized_hours ?? 0),
    used: toHours(row?.used_hours ?? 0),
    remaining: toHours(row?.remaining_hours ?? 0),
  };
}

function dollarUsage(row: BudgetAggregateRow | undefined): PortalDollarUsageSummary {
  return {
    authorized: row?.authorized_dollars == null ? null : toMoney(row.authorized_dollars),
    used: toMoney(row?.used_dollars ?? 0),
    remaining: row?.remaining_dollars == null ? null : toMoney(row.remaining_dollars),
  };
}

function directIndividualIds(context: PortalAccessContext): string[] {
  return unique(
    context.individualLinks
      .filter((link) => hasPortalIndividualCapability(context, link.individualId, "people.self.read"))
      .map((link) => link.individualId),
  );
}

function directEmployeeIds(context: PortalAccessContext): string[] {
  return unique(
    context.employeeLinks
      .filter((link) => hasPortalEmployeeCapability(context, link.employeeId, "people.self.read"))
      .map((link) => link.employeeId),
  );
}

function individualIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalIndividualCapability(context, id, capability));
}

function employeeIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalEmployeeCapability(context, id, capability));
}

function agencyIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalCapability(context, capability, id));
}

async function directIndividualSummaries(
  pool: PgLikePool,
  context: PortalAccessContext,
  month: string,
): Promise<PortalIndividualSummary[]> {
  const monthStart = `${month}-01`;
  const ids = directIndividualIds(context);
  if (ids.length === 0) return [];
  const hourIds = individualIdsWith(context, ids, "hours_budgets.self.read");
  const dollarIds = individualIdsWith(context, ids, "dollar_budgets.self.read");
  const budgetIds = unique([...hourIds, ...dollarIds]);
  const billedIds = individualIdsWith(context, ids, "financials.self.billed_totals.read");
  const setAsideIds = individualIdsWith(context, ids, "financials.self.cuts_set_asides.read");
  const directCheckIds = individualIdsWith(context, ids, "financials.self.direct_checks.read");
  const agencyPaidIds = individualIdsWith(context, ids, "financials.self.agency_paid.read");

  const [peopleResult, budgetResult, billedResult, setAsideResult, directCheckResult, agencyPaidResult] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM individuals
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    budgetIds.length > 0
      ? pool.query<BudgetAggregateRow>(
          `SELECT individual_id AS scope_id,
                  COALESCE(sum(authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(consumed_hours), 0)::text AS used_hours,
                  COALESCE(sum(remaining_hours), 0)::text AS remaining_hours,
                  CASE WHEN count(authorized_dollars) > 0 THEN sum(authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(remaining_dollars) > 0 THEN sum(remaining_dollars)::text END AS remaining_dollars
             FROM program_budget_balances
            WHERE individual_id = ANY($1::uuid[])
              AND period_status = 'active'
              AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN start_date AND end_date
            GROUP BY individual_id`,
          [budgetIds],
        )
      : empty<BudgetAggregateRow>(),
    billedIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT individual_id AS scope_id, COALESCE(sum(imported_amount), 0)::text AS amount
             FROM payroll_transactions
            WHERE individual_id = ANY($1::uuid[])
              AND canonical_service_date(period_begin, check_date, period_end) IS NOT NULL
              AND date_trunc('month', canonical_service_date(period_begin, check_date, period_end))
                  = $2::date
            GROUP BY individual_id`,
          [billedIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    setAsideIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT se.individual_id AS scope_id, COALESCE(sum(se.amount), 0)::text AS amount
             FROM settlement_events se
             JOIN settlement_obligations obligation ON obligation.id = se.settlement_obligation_id
            WHERE se.individual_id = ANY($1::uuid[])
              AND obligation.direction = 'reserve'
              AND date_trunc('month', se.occurred_on) = $2::date
            GROUP BY se.individual_id`,
          [setAsideIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    directCheckIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT transaction.individual_id AS scope_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ))
                  = $2::date
            GROUP BY transaction.individual_id`,
          [directCheckIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    agencyPaidIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT transaction.individual_id AS scope_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'excellent_staffing'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ))
                  = $2::date
            GROUP BY transaction.individual_id`,
          [agencyPaidIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
  ]);

  const budgets = mapByScope(budgetResult.rows);
  const billed = mapByScope(billedResult.rows);
  const setAside = mapByScope(setAsideResult.rows);
  const directChecks = mapByScope(directCheckResult.rows);
  const agencyPaid = mapByScope(agencyPaidResult.rows);
  return peopleResult.rows.map((person) => ({
    id: person.id,
    name: person.name,
    relationships: unique(
      context.individualLinks
        .filter((link) => link.individualId === person.id)
        .map((link) => link.relationship),
    ) as IndividualRelationship[],
    hours: hourIds.includes(person.id) ? usage(budgets.get(person.id)) : null,
    dollars: dollarIds.includes(person.id) ? dollarUsage(budgets.get(person.id)) : null,
    month,
    billedThisMonth: billedIds.includes(person.id) ? toMoney(billed.get(person.id)?.amount ?? 0) : null,
    setAsideThisMonth: setAsideIds.includes(person.id) ? toMoney(setAside.get(person.id)?.amount ?? 0) : null,
    directChecksThisMonth: directCheckIds.includes(person.id) ? toMoney(directChecks.get(person.id)?.amount ?? 0) : null,
    agencyPaidThisMonth: agencyPaidIds.includes(person.id) ? toMoney(agencyPaid.get(person.id)?.amount ?? 0) : null,
  }));
}

async function directEmployeeSummaries(
  pool: PgLikePool,
  context: PortalAccessContext,
  month: string,
): Promise<PortalEmployeeSummary[]> {
  const monthStart = `${month}-01`;
  const ids = directEmployeeIds(context);
  if (ids.length === 0) return [];
  const grossIds = employeeIdsWith(context, ids, "employee_checks.self.gross.read");
  const netIds = employeeIdsWith(context, ids, "employee_checks.self.net.read");
  const taxIds = employeeIdsWith(context, ids, "employee_checks.self.tax.read");
  const checkIds = unique([...grossIds, ...netIds, ...taxIds]);
  const giveBackIds = employeeIdsWith(context, ids, "employee_giveback.self.read");

  const [peopleResult, checksResult, giveBackResult] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM employees
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    checkIds.length > 0
      ? pool.query<PayrollCheckRow>(
          `SELECT id, employee_id, check_number,
                  to_char(check_date, 'YYYY-MM-DD') AS check_date,
                  to_char(period_begin, 'YYYY-MM-DD') AS period_begin,
                  to_char(period_end, 'YYYY-MM-DD') AS period_end,
                  CASE WHEN employee_id = ANY($2::uuid[]) THEN actual_gross::text END AS actual_gross,
                  CASE WHEN employee_id = ANY($3::uuid[]) THEN actual_net::text END AS actual_net,
                  CASE WHEN employee_id = ANY($4::uuid[]) THEN tax_withheld::text END AS tax_withheld
             FROM (
               SELECT c.*, row_number() OVER (
                 PARTITION BY c.employee_id
                  ORDER BY canonical_service_date(c.period_begin, c.check_date, c.period_end) DESC,
                           c.updated_at DESC
               ) AS portal_row
                 FROM employee_payroll_checks c
                 WHERE c.employee_id = ANY($1::uuid[])
                   AND c.verification_status = 'verified'
                   AND canonical_service_date(c.period_begin, c.check_date, c.period_end) IS NOT NULL
             ) checks
            WHERE portal_row <= 12
            ORDER BY canonical_service_date(period_begin, check_date, period_end) DESC`,
          [checkIds, grossIds, netIds, taxIds],
        )
      : empty<PayrollCheckRow>(),
    giveBackIds.length > 0
      ? pool.query<GiveBackRow>(
          `WITH event_totals AS (
             SELECT settlement_obligation_id,
                    COALESCE(sum(amount), 0) AS applied,
                    COALESCE(sum(amount) FILTER (
                      WHERE date_trunc('month', occurred_on) = $2::date
                    ), 0) AS applied_month
               FROM settlement_events
              GROUP BY settlement_obligation_id
           )
           SELECT o.employee_id AS scope_id,
                  COALESCE(sum(o.original_amount) FILTER (
                    WHERE o.direction = 'receivable'
                      AND canonical_service_date(o.period_begin, o.check_date, o.period_end) IS NOT NULL
                      AND date_trunc('month', canonical_service_date(
                            o.period_begin, o.check_date, o.period_end
                          ))
                          = $2::date
                  ), 0)::text AS due_this_month,
                  COALESCE(sum(events.applied_month) FILTER (WHERE o.direction = 'receivable'), 0)::text AS collected_this_month,
                  COALESCE(sum(GREATEST(o.original_amount - COALESCE(events.applied, 0), 0)) FILTER (
                    WHERE o.status = 'active' AND o.direction = 'receivable'
                  ), 0)::text AS remaining
             FROM settlement_obligations o
             LEFT JOIN event_totals events ON events.settlement_obligation_id = o.id
            WHERE o.employee_id = ANY($1::uuid[]) AND o.kind LIKE 'employee_giveback%'
            GROUP BY o.employee_id`,
          [giveBackIds, monthStart],
        )
      : empty<GiveBackRow>(),
  ]);

  const checks = new Map<string, PortalPayrollCheckSummary[]>();
  for (const row of checksResult.rows) {
    const item: PortalPayrollCheckSummary = {
      id: row.id,
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
    };
    if (grossIds.includes(row.employee_id)) item.actualGross = row.actual_gross === null ? null : toMoney(row.actual_gross);
    if (netIds.includes(row.employee_id) && row.actual_net !== null) item.actualNet = toMoney(row.actual_net);
    if (taxIds.includes(row.employee_id)) item.taxWithheld = row.tax_withheld === null ? null : toMoney(row.tax_withheld);
    checks.set(row.employee_id, [...(checks.get(row.employee_id) ?? []), item]);
  }
  const giveBack = mapByScope(giveBackResult.rows);
  return peopleResult.rows.map((person) => {
    const collection = giveBack.get(person.id);
    return {
      id: person.id,
      name: person.name,
      checkVisibility: {
        gross: grossIds.includes(person.id),
        net: netIds.includes(person.id),
        tax: taxIds.includes(person.id),
      },
      checks: checkIds.includes(person.id) ? checks.get(person.id) ?? [] : null,
      giveBack: giveBackIds.includes(person.id) ? {
        month,
        dueThisMonth: toMoney(collection?.due_this_month ?? 0),
        collectedThisMonth: toMoney(collection?.collected_this_month ?? 0),
        remaining: toMoney(collection?.remaining ?? 0),
      } : null,
    };
  });
}

/**
 * Portal DTOs are built only from direct subject relationships and explicit
 * agency memberships. No transaction/assignment connected-set expansion is
 * used, and every financial category is queried and returned only when its
 * exact subject- or agency-scoped capability is effective.
 */
export async function getPortalHomeReadModel(
  pool: PgLikePool,
  context: PortalAccessContext,
  requestedMonth?: string | null,
): Promise<PortalHomeReadModel> {
  const month = normalizePortalMonth(requestedMonth);
  const monthStart = `${month}-01`;
  const scopedAgencyIds = unique(
    context.agencyAccess
      .filter((access) => hasPortalCapability(context, "agencies.read", access.agencyId))
      .map((access) => access.agencyId),
  );
  const ownerCanReadAgencies = isPortalOwner(context) && hasPortalCapability(context, "agencies.read");

  const [individuals, employees, agencyResult] = await Promise.all([
    directIndividualSummaries(pool, context, month),
    directEmployeeSummaries(pool, context, month),
    ownerCanReadAgencies || scopedAgencyIds.length > 0
      ? pool.query<AgencyAggregateRow>(
          `SELECT a.id, a.code, a.name,
                  COALESCE(ai.individual_count, 0)::int AS individual_count,
                  COALESCE(ae.employee_count, 0)::int AS employee_count,
                  COALESCE(ai.managed_budget_count, 0)::int AS managed_budget_count,
                  COALESCE(ai.billing_without_budget_count, 0)::int AS billing_without_budget_count
             FROM agencies a
             LEFT JOIN LATERAL (
               SELECT COUNT(*) AS individual_count,
                      COUNT(*) FILTER (WHERE manages_budget) AS managed_budget_count,
                      COUNT(*) FILTER (WHERE bills_services AND NOT manages_budget) AS billing_without_budget_count
                 FROM agency_individuals
                WHERE agency_id = a.id AND is_active = true
                  AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
                  AND (effective_to IS NULL
                    OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
             ) ai ON true
             LEFT JOIN LATERAL (
               SELECT COUNT(*) AS employee_count
                 FROM agency_employees
                WHERE agency_id = a.id AND is_active = true
                  AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
                  AND (effective_to IS NULL
                    OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
             ) ae ON true
            WHERE a.status = 'active'
              AND ($1::boolean = true OR a.id = ANY($2::uuid[]))
            ORDER BY a.is_home_agency DESC, a.name`,
          [ownerCanReadAgencies, scopedAgencyIds],
        )
      : empty<AgencyAggregateRow>(),
  ]);

  const agencyIds = agencyResult.rows.map((row) => row.id);
  const hourAgencyIds = agencyIdsWith(context, agencyIds, "hours_budgets.agency.read");
  const dollarAgencyIds = agencyIdsWith(context, agencyIds, "dollar_budgets.agency.read");
  const budgetAgencyIds = unique([...hourAgencyIds, ...dollarAgencyIds]);
  const billedAgencyIds = agencyIdsWith(context, agencyIds, "financials.agency.billed_totals.read");
  const setAsideAgencyIds = agencyIdsWith(context, agencyIds, "financials.agency.cuts_set_asides.read");
  const agencyPaidAgencyIds = agencyIdsWith(context, agencyIds, "financials.agency.agency_paid.read");
  const checkAgencyIds = agencyIdsWith(context, agencyIds, "financials.agency.direct_checks.read");
  const giveBackAgencyIds = agencyIdsWith(context, agencyIds, "settlements.agency.read");
  const financialAgencyIds = unique([
    ...billedAgencyIds,
    ...setAsideAgencyIds,
    ...agencyPaidAgencyIds,
    ...checkAgencyIds,
    ...giveBackAgencyIds,
  ]);

  const [agencyBudgetResult, agencyFinancialResult] = await Promise.all([
    budgetAgencyIds.length > 0
      ? pool.query<BudgetAggregateRow>(
          `SELECT membership.agency_id AS scope_id,
                  COALESCE(sum(balance.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(balance.consumed_hours), 0)::text AS used_hours,
                  COALESCE(sum(balance.remaining_hours), 0)::text AS remaining_hours,
                  CASE WHEN count(balance.authorized_dollars) > 0 THEN sum(balance.authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(balance.consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(balance.remaining_dollars) > 0 THEN sum(balance.remaining_dollars)::text END AS remaining_dollars
             FROM agency_individuals membership
             LEFT JOIN program_budget_balances balance
               ON balance.individual_id = membership.individual_id
              AND balance.period_status = 'active'
              AND (now() AT TIME ZONE 'America/New_York')::date
                  BETWEEN balance.start_date AND balance.end_date
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id`,
          [budgetAgencyIds],
        )
      : empty<BudgetAggregateRow>(),
    financialAgencyIds.length > 0
      ? pool.query<AgencyFinancialRow>(
          `SELECT requested.agency_id AS scope_id,
                  CASE WHEN requested.agency_id = ANY($2::uuid[]) THEN COALESCE((
                    SELECT sum(transaction.imported_amount)
                      FROM payroll_transactions transaction
                     WHERE canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           )) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = transaction.individual_id
                            AND membership.is_active = true
                            AND membership.bills_services = true
                            AND membership.effective_from <= canonical_service_date(
                                  transaction.period_begin, transaction.check_date, transaction.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(transaction.period_begin, transaction.check_date,
                                    transaction.period_end))
                       )
                  ), 0)::text END AS billed_this_month,
                  CASE WHEN requested.agency_id = ANY($3::uuid[]) THEN COALESCE((
                    SELECT sum(event.amount)
                      FROM settlement_events event
                      JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
                     WHERE obligation.direction = 'reserve'
                       AND date_trunc('month', event.occurred_on) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = event.individual_id
                            AND membership.is_active = true
                            AND membership.manages_budget = true
                            AND membership.effective_from <= event.occurred_on
                            AND (membership.effective_to IS NULL OR membership.effective_to >= event.occurred_on)
                       )
                  ), 0)::text END AS set_aside_this_month,
                  CASE WHEN requested.agency_id = ANY($4::uuid[]) THEN COALESCE((
                    SELECT sum(transaction.employee_payment_amount)
                      FROM payroll_transactions transaction
                      LEFT JOIN programs transaction_program
                        ON transaction_program.id = transaction.program_id
                     WHERE effective_payment_recipient(
                             transaction.payment_recipient, transaction_program.payment_recipient
                           ) = 'excellent_staffing'
                       AND canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           )) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = transaction.individual_id
                            AND membership.is_active = true
                            AND membership.bills_services = true
                            AND membership.effective_from <= canonical_service_date(
                                  transaction.period_begin, transaction.check_date, transaction.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(transaction.period_begin, transaction.check_date,
                                    transaction.period_end))
                       )
                  ), 0)::text END AS agency_paid_this_month,
                  CASE WHEN requested.agency_id = ANY($5::uuid[]) THEN COALESCE((
                    SELECT sum(checks.actual_gross)
                      FROM employee_payroll_checks checks
                     WHERE checks.verification_status = 'verified'
                       AND canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ))
                           = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = checks.employee_id
                            AND membership.is_active = true
                            AND membership.effective_from <= canonical_service_date(
                                  checks.period_begin, checks.check_date, checks.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(checks.period_begin, checks.check_date,
                                    checks.period_end))
                       )
                  ), 0)::text END AS payroll_gross_this_month,
                  CASE WHEN requested.agency_id = ANY($5::uuid[]) THEN COALESCE((
                    SELECT sum(checks.actual_net)
                      FROM employee_payroll_checks checks
                     WHERE checks.verification_status = 'verified'
                       AND canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ))
                           = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = checks.employee_id
                            AND membership.is_active = true
                            AND membership.effective_from <= canonical_service_date(
                                  checks.period_begin, checks.check_date, checks.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(checks.period_begin, checks.check_date,
                                    checks.period_end))
                       )
                  ), 0)::text END AS payroll_net_this_month,
                  CASE WHEN requested.agency_id = ANY($6::uuid[]) THEN COALESCE((
                    SELECT sum(GREATEST(obligation.original_amount - COALESCE(events.applied, 0), 0))
                      FROM settlement_obligations obligation
                      LEFT JOIN LATERAL (
                        SELECT COALESCE(sum(event.amount), 0) AS applied
                          FROM settlement_events event WHERE event.settlement_obligation_id = obligation.id
                      ) events ON true
                     WHERE obligation.status = 'active'
                       AND obligation.direction = 'receivable' AND obligation.kind LIKE 'employee_giveback%'
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = obligation.employee_id
                            AND membership.is_active = true
                            AND canonical_service_date(
                                  obligation.period_begin, obligation.check_date, obligation.period_end
                                ) IS NOT NULL
                            AND membership.effective_from <= canonical_service_date(
                                  obligation.period_begin, obligation.check_date, obligation.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(obligation.period_begin, obligation.check_date,
                                    obligation.period_end))
                       )
                  ), 0)::text END AS giveback_remaining
             FROM unnest($1::uuid[]) AS requested(agency_id)`,
          [
            financialAgencyIds,
            billedAgencyIds,
            setAsideAgencyIds,
            agencyPaidAgencyIds,
            checkAgencyIds,
            giveBackAgencyIds,
            monthStart,
          ],
        )
      : empty<AgencyFinancialRow>(),
  ]);

  const agencyBudgets = mapByScope(agencyBudgetResult.rows);
  const agencyFinancials = mapByScope(agencyFinancialResult.rows);
  const agencies = agencyResult.rows.map((row): PortalAgencySummary => {
    const accessRoles = context.agencyAccess
      .filter((access) => access.agencyId === row.id)
      .map((access) => access.role);
    const roles: PortalRole[] = isPortalOwner(context) ? ["owner", ...accessRoles] : accessRoles;
    const canReadPeople = hasPortalCapability(context, "people.agency.read", row.id);
    const canReadHours = hourAgencyIds.includes(row.id);
    const canReadDollars = dollarAgencyIds.includes(row.id);
    const financial = agencyFinancials.get(row.id);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      roles: unique(roles).map((role) => roleSummary(role as PortalRole)),
      capabilities: portalCapabilities(context, row.id),
      individualCount: canReadPeople ? Number(row.individual_count) : null,
      employeeCount: canReadPeople ? Number(row.employee_count) : null,
      managedBudgetCount: canReadHours ? Number(row.managed_budget_count) : null,
      billingWithoutBudgetCount: canReadHours ? Number(row.billing_without_budget_count) : null,
      budgetHours: canReadHours ? usage(agencyBudgets.get(row.id)) : null,
      budgetDollars: canReadDollars ? dollarUsage(agencyBudgets.get(row.id)) : null,
      month,
      billedThisMonth: billedAgencyIds.includes(row.id) ? toMoney(financial?.billed_this_month ?? 0) : null,
      setAsideThisMonth: setAsideAgencyIds.includes(row.id) ? toMoney(financial?.set_aside_this_month ?? 0) : null,
      agencyPaidThisMonth: agencyPaidAgencyIds.includes(row.id) ? toMoney(financial?.agency_paid_this_month ?? 0) : null,
      payrollGrossThisMonth: checkAgencyIds.includes(row.id) ? toMoney(financial?.payroll_gross_this_month ?? 0) : null,
      payrollNetThisMonth: checkAgencyIds.includes(row.id) ? toMoney(financial?.payroll_net_this_month ?? 0) : null,
      giveBackRemaining: giveBackAgencyIds.includes(row.id) ? toMoney(financial?.giveback_remaining ?? 0) : null,
    };
  });

  return {
    month,
    globalRoles: context.globalRoles.map((assignment) => roleSummary(assignment.role)),
    globalCapabilities: portalCapabilities(context),
    directProfiles: { individualCount: individuals.length, employeeCount: employees.length },
    individuals,
    employees,
    agencies,
  };
}

export function agencyRoles(readModel: PortalHomeReadModel): AgencyPortalRole[] {
  return unique(
    readModel.agencies.flatMap((agency) =>
      agency.roles
        .map((role) => role.key)
        .filter((role): role is AgencyPortalRole =>
          role === "agency" || role === "staffing_manager" || role === "scheduler" || role === "collector",
        ),
    ),
  ) as AgencyPortalRole[];
}
