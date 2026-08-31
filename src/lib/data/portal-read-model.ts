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

export interface PortalIndividualProgramSummary {
  id: string | null;
  code: string | null;
  name: string;
  hours: PortalUsageSummary | null;
  dollars: PortalDollarUsageSummary | null;
  billedThisMonth: string | null;
  directChecksThisMonth: string | null;
  agencyPaidThisMonth: string | null;
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
  programs: PortalIndividualProgramSummary[] | null;
}

export interface PortalEmployeeDirectPaySummary {
  id: string;
  serviceDate: string;
  checkNumber: string | null;
  individualName: string;
  programCode: string | null;
  programName: string;
  hours: string | null;
  grossServiceValue: string | null;
}

export interface PortalPayrollCheckSummary {
  id: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  serviceDate: string | null;
  actualGross?: string | null;
  actualNet?: string;
  taxWithheld?: string | null;
}

export interface PortalEmployeeSummary {
  id: string;
  name: string;
  month: string;
  checkVisibility: {
    gross: boolean;
    net: boolean;
    tax: boolean;
  };
  checks: PortalPayrollCheckSummary[] | null;
  directPay: PortalEmployeeDirectPaySummary[] | null;
  giveBack: {
    month: string;
    dueThisMonth: string;
    collectedThisMonth: string;
    remaining: string;
  } | null;
}

export interface PortalAgencyIndividualSummary {
  id: string;
  name: string;
  managesBudget: boolean | null;
  billsServices: boolean | null;
  hours: PortalUsageSummary | null;
  dollars: PortalDollarUsageSummary | null;
  month: string;
  billedThisMonth: string | null;
  setAsideThisMonth: string | null;
  directChecksThisMonth: string | null;
  agencyPaidThisMonth: string | null;
  programs: PortalIndividualProgramSummary[] | null;
}

export interface PortalAgencyEmployeeSummary {
  id: string;
  name: string;
  month: string;
  payrollGrossThisMonth: string | null;
  payrollNetThisMonth: string | null;
  giveBack: {
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
  individuals: PortalAgencyIndividualSummary[] | null;
  employees: PortalAgencyEmployeeSummary[] | null;
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

interface HoursAggregateFields {
  authorized_hours: string;
  used_hours: string;
  remaining_hours: string;
  program_breakdown?: unknown;
}

interface DollarAggregateFields {
  authorized_dollars: string | null;
  used_dollars: string;
  remaining_dollars: string | null;
  program_breakdown?: unknown;
}

interface HoursAggregateRow extends HoursAggregateFields {
  scope_id: string;
}

interface DollarAggregateRow extends DollarAggregateFields {
  scope_id: string;
}

interface MoneyAggregateRow {
  scope_id: string;
  amount: string;
  program_breakdown?: unknown;
}

interface EmployeeDirectPayRow {
  id: string;
  employee_id: string;
  service_date: string;
  check_number: string | null;
  individual_name: string;
  program_code: string | null;
  program_name: string;
  hours: string | null;
  gross_service_value: string | null;
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

interface AgencyIndividualMemberRow {
  agency_id: string;
  person_id: string;
  name: string;
  manages_budget: boolean;
  bills_services: boolean;
}

interface AgencyEmployeeMemberRow {
  agency_id: string;
  person_id: string;
  name: string;
}

interface AgencyPersonHoursRow extends HoursAggregateFields {
  agency_id: string;
  person_id: string;
}

interface AgencyPersonDollarRow extends DollarAggregateFields {
  agency_id: string;
  person_id: string;
}

interface AgencyPersonMoneyRow {
  agency_id: string;
  person_id: string;
  amount: string;
  program_breakdown?: unknown;
}

interface AgencyEmployeeCheckRow {
  agency_id: string;
  person_id: string;
  gross: string | null;
  net: string;
}

interface AgencyEmployeeGiveBackRow {
  agency_id: string;
  person_id: string;
  due_this_month: string;
  collected_this_month: string;
  remaining: string;
}

const DIRECT_PORTAL_HOURS_SCOPE = `SELECT unnest($1::uuid[]) AS individual_id`;

const AGENCY_PORTAL_HOURS_SCOPE = `SELECT DISTINCT membership.individual_id
  FROM agency_individuals membership
 WHERE membership.agency_id = ANY($1::uuid[])
   AND membership.is_active = true
   AND membership.manages_budget = true
   AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
   AND (membership.effective_to IS NULL
     OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)`;

function effectivePortalHoursCte(scopeSql: string): string {
  return `portal_scope AS (
  ${scopeSql}
),
physical_authorization_base AS (
  SELECT physical_auth.id AS authorization_id,
         physical_auth.individual_id,
         physical_auth.program_id,
         physical_auth.budget_period_id,
         period.start_date,
         period.end_date,
         COALESCE(physical_auth.authorized_hours, 0) AS authorized_hours,
         physical_auth.internal_rate,
         program.consumption_source,
         program.rate_scope
    FROM budget_authorizations physical_auth
    JOIN portal_scope scope ON scope.individual_id = physical_auth.individual_id
    JOIN budget_periods period ON period.id = physical_auth.budget_period_id
    JOIN programs program ON program.id = physical_auth.program_id
   WHERE physical_auth.status = 'active'
     AND physical_auth.archived_at IS NULL
     AND period.status = 'active'
     AND period.archived_at IS NULL
     AND (now() AT TIME ZONE 'America/New_York')::date
         BETWEEN period.start_date AND period.end_date
),
physical_payroll_usage AS (
  SELECT physical.authorization_id,
         COALESCE(sum(
           CASE
             WHEN physical.rate_scope = 'per_group'
              AND COALESCE(physical.internal_rate, 0) > 0
               THEN COALESCE(
                      payroll.calculated_internal_amount,
                      payroll.spreadsheet_internal_amount,
                      payroll.internal_rate_applied * payroll.imported_hours,
                      0
                    ) / physical.internal_rate
             ELSE COALESCE(payroll.imported_hours, 0)
           END
         ), 0)::numeric(10, 4) AS used_hours
    FROM physical_authorization_base physical
    LEFT JOIN payroll_transactions payroll
      ON physical.consumption_source IN ('payroll', 'mixed')
     AND payroll.individual_id = physical.individual_id
     AND payroll.program_id = physical.program_id
     AND canonical_service_date(
           payroll.period_begin, payroll.check_date, payroll.period_end
         ) BETWEEN physical.start_date AND physical.end_date
   GROUP BY physical.authorization_id
),
physical_event_usage AS (
  SELECT physical.authorization_id,
         COALESCE(sum(event.hours), 0)::numeric(10, 4) AS used_hours
    FROM physical_authorization_base physical
    LEFT JOIN program_budget_events event
      ON event.budget_period_id = physical.budget_period_id
     AND event.individual_id = physical.individual_id
     AND event.program_id = physical.program_id
   GROUP BY physical.authorization_id
),
physical_authorizations AS (
  SELECT physical.authorization_id,
         physical.individual_id,
         physical.program_id,
         physical.authorized_hours,
         (
           COALESCE(payroll.used_hours, 0) + COALESCE(event.used_hours, 0)
         )::numeric(10, 4) AS used_hours
    FROM physical_authorization_base physical
    LEFT JOIN physical_payroll_usage payroll
      ON payroll.authorization_id = physical.authorization_id
    LEFT JOIN physical_event_usage event
      ON event.authorization_id = physical.authorization_id
),
synthetic_authorizations AS (
  SELECT budget_auth.authorization_id,
         budget_auth.individual_id,
         budget_auth.program_id,
         budget_auth.start_date,
         budget_auth.end_date,
         budget_auth.updated_at,
         COALESCE(budget_auth.authorized_hours, 0) AS authorized_hours,
         budget_auth.internal_rate,
         program.consumption_source,
         program.rate_scope
    FROM effective_budget_authorizations_at(
           (now() AT TIME ZONE 'America/New_York')::date
         ) budget_auth
    JOIN portal_scope scope ON scope.individual_id = budget_auth.individual_id
    JOIN programs program ON program.id = budget_auth.program_id
   WHERE budget_auth.source = 'calculation_strategy'
     AND NOT EXISTS (
       SELECT 1
         FROM physical_authorizations physical
        WHERE physical.individual_id = budget_auth.individual_id
          AND physical.program_id = budget_auth.program_id
     )
),
synthetic_transaction_matches AS (
  SELECT synthetic.individual_id,
         synthetic.program_id,
         payroll.id AS transaction_id,
         synthetic.internal_rate,
         synthetic.rate_scope,
         payroll.imported_hours,
         payroll.calculated_internal_amount,
         payroll.spreadsheet_internal_amount,
         payroll.internal_rate_applied,
         row_number() OVER (
           PARTITION BY payroll.id
           ORDER BY synthetic.start_date DESC,
                    synthetic.updated_at DESC,
                    synthetic.authorization_id DESC
         ) AS match_rank
    FROM synthetic_authorizations synthetic
    JOIN payroll_transactions payroll
      ON payroll.individual_id = synthetic.individual_id
     AND payroll.program_id = synthetic.program_id
     AND canonical_service_date(
           payroll.period_begin, payroll.check_date, payroll.period_end
         ) BETWEEN synthetic.start_date AND synthetic.end_date
   WHERE synthetic.consumption_source IN ('payroll', 'mixed')
),
synthetic_transaction_usage AS (
  SELECT individual_id,
         program_id,
         transaction_id,
         CASE
           WHEN rate_scope = 'per_group'
            AND COALESCE(internal_rate, 0) > 0
             THEN COALESCE(
                    calculated_internal_amount,
                    spreadsheet_internal_amount,
                    internal_rate_applied * imported_hours,
                    0
                  ) / internal_rate
           ELSE COALESCE(imported_hours, 0)
         END AS used_hours
    FROM synthetic_transaction_matches
   WHERE match_rank = 1
),
synthetic_usage AS (
  SELECT individual_id,
         program_id,
         COALESCE(sum(used_hours), 0) AS used_hours
    FROM synthetic_transaction_usage
   GROUP BY individual_id, program_id
),
effective_hours AS (
  SELECT physical.individual_id,
         physical.program_id,
         physical.authorized_hours,
         physical.used_hours
    FROM physical_authorizations physical
  UNION ALL
  SELECT synthetic.individual_id,
         synthetic.program_id,
         COALESCE(sum(synthetic.authorized_hours), 0) AS authorized_hours,
         COALESCE(usage.used_hours, 0) AS used_hours
    FROM synthetic_authorizations synthetic
    LEFT JOIN synthetic_usage usage
      ON usage.individual_id = synthetic.individual_id
     AND usage.program_id = synthetic.program_id
   GROUP BY synthetic.individual_id, synthetic.program_id, usage.used_hours
)`;
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

function agencyPersonKey(agencyId: string, personId: string): string {
  return `${agencyId}:${personId}`;
}

function mapByAgencyPerson<T extends { agency_id: string; person_id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [agencyPersonKey(row.agency_id, row.person_id), row]));
}

function usage(row: HoursAggregateFields | undefined): PortalUsageSummary {
  return {
    authorized: toHours(row?.authorized_hours ?? 0),
    used: toHours(row?.used_hours ?? 0),
    remaining: toHours(row?.remaining_hours ?? 0),
  };
}

function dollarUsage(row: DollarAggregateFields | undefined): PortalDollarUsageSummary {
  return {
    authorized: row?.authorized_dollars == null ? null : toMoney(row.authorized_dollars),
    used: toMoney(row?.used_dollars ?? 0),
    remaining: row?.remaining_dollars == null ? null : toMoney(row.remaining_dollars),
  };
}

interface ProgramBreakdownRow {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  authorized?: unknown;
  used?: unknown;
  remaining?: unknown;
  amount?: unknown;
}

function programBreakdown(value: unknown): ProgramBreakdownRow[] {
  if (typeof value === "string") {
    try {
      return programBreakdown(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is ProgramBreakdownRow => item !== null && typeof item === "object")
    : [];
}

function programKey(row: ProgramBreakdownRow): string {
  if (typeof row.id === "string" && row.id) return `id:${row.id}`;
  if (typeof row.code === "string" && row.code) return `code:${row.code}`;
  return `name:${String(row.name ?? "Unassigned program").trim().toLowerCase()}`;
}

function programIdentity(row: ProgramBreakdownRow): Pick<PortalIndividualProgramSummary, "id" | "code" | "name"> {
  return {
    id: typeof row.id === "string" && row.id ? row.id : null,
    code: typeof row.code === "string" && row.code ? row.code : null,
    name: typeof row.name === "string" && row.name.trim() ? row.name : "Unassigned program",
  };
}

function mergeProgramBreakdowns({
  hours,
  dollars,
  billed,
  directChecks,
  agencyPaid,
}: {
  hours?: unknown;
  dollars?: unknown;
  billed?: unknown;
  directChecks?: unknown;
  agencyPaid?: unknown;
}): PortalIndividualProgramSummary[] {
  const programs = new Map<string, PortalIndividualProgramSummary>();
  const get = (row: ProgramBreakdownRow) => {
    const key = programKey(row);
    const existing = programs.get(key);
    if (existing) return existing;
    const created: PortalIndividualProgramSummary = {
      ...programIdentity(row),
      hours: null,
      dollars: null,
      billedThisMonth: null,
      directChecksThisMonth: null,
      agencyPaidThisMonth: null,
    };
    programs.set(key, created);
    return created;
  };

  for (const row of programBreakdown(hours)) {
    get(row).hours = usage({
      authorized_hours: String(row.authorized ?? 0),
      used_hours: String(row.used ?? 0),
      remaining_hours: String(row.remaining ?? 0),
    });
  }
  for (const row of programBreakdown(dollars)) {
    get(row).dollars = dollarUsage({
      authorized_dollars: row.authorized == null ? null : String(row.authorized),
      used_dollars: String(row.used ?? 0),
      remaining_dollars: row.remaining == null ? null : String(row.remaining),
    });
  }
  for (const row of programBreakdown(billed)) get(row).billedThisMonth = toMoney(String(row.amount ?? 0));
  for (const row of programBreakdown(directChecks)) get(row).directChecksThisMonth = toMoney(String(row.amount ?? 0));
  for (const row of programBreakdown(agencyPaid)) get(row).agencyPaidThisMonth = toMoney(String(row.amount ?? 0));

  return [...programs.values()].sort((left, right) => left.name.localeCompare(right.name));
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
  const billedIds = individualIdsWith(context, ids, "financials.self.billed_totals.read");
  const setAsideIds = individualIdsWith(context, ids, "financials.self.cuts_set_asides.read");
  const directCheckIds = individualIdsWith(context, ids, "financials.self.direct_checks.read");
  const agencyPaidIds = individualIdsWith(context, ids, "financials.self.agency_paid.read");

  const [
    peopleResult,
    hourBudgetResult,
    dollarBudgetResult,
    billedResult,
    setAsideResult,
    directCheckResult,
    agencyPaidResult,
  ] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM individuals
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    hourIds.length > 0
      ? pool.query<HoursAggregateRow>(
          `WITH ${effectivePortalHoursCte(DIRECT_PORTAL_HOURS_SCOPE)}
           SELECT effective_hours.individual_id AS scope_id,
                  COALESCE(sum(effective_hours.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(effective_hours.used_hours), 0)::text AS used_hours,
                  COALESCE(sum(
                    effective_hours.authorized_hours - effective_hours.used_hours
                  ), 0)::text AS remaining_hours,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_hours::text,
                      'used', program_totals.used_hours::text,
                      'remaining', program_totals.remaining_hours::text
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               COALESCE(sum(detail.authorized_hours), 0) AS authorized_hours,
                               COALESCE(sum(detail.used_hours), 0) AS used_hours,
                               COALESCE(sum(detail.authorized_hours - detail.used_hours), 0) AS remaining_hours
                          FROM effective_hours detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = effective_hours.individual_id
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM effective_hours
            WHERE effective_hours.individual_id = ANY($1::uuid[])
            GROUP BY effective_hours.individual_id`,
          [hourIds],
        )
      : empty<HoursAggregateRow>(),
    dollarIds.length > 0
      ? pool.query<DollarAggregateRow>(
          `SELECT individual_id AS scope_id,
                  CASE WHEN count(authorized_dollars) > 0
                    THEN sum(authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(remaining_dollars) > 0
                    THEN sum(remaining_dollars)::text END AS remaining_dollars,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_dollars,
                      'used', program_totals.used_dollars,
                      'remaining', program_totals.remaining_dollars
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               CASE WHEN count(detail.authorized_dollars) > 0
                                 THEN sum(detail.authorized_dollars)::text END AS authorized_dollars,
                               COALESCE(sum(detail.consumed_dollars), 0)::text AS used_dollars,
                               CASE WHEN count(detail.remaining_dollars) > 0
                                 THEN sum(detail.remaining_dollars)::text END AS remaining_dollars
                          FROM program_budget_balances detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = program_budget_balances.individual_id
                           AND detail.period_status = 'active'
                           AND (now() AT TIME ZONE 'America/New_York')::date
                               BETWEEN detail.start_date AND detail.end_date
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM program_budget_balances
            WHERE individual_id = ANY($1::uuid[])
              AND period_status = 'active'
              AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN start_date AND end_date
            GROUP BY individual_id`,
          [dollarIds],
        )
      : empty<DollarAggregateRow>(),
    billedIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT individual_id AS scope_id, COALESCE(sum(imported_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code,
                               COALESCE(program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.imported_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = payroll_transactions.individual_id
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY program.id, program.code,
                                  COALESCE(program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
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
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'employee'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
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
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'excellent_staffing'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
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

  const hourBudgets = mapByScope(hourBudgetResult.rows);
  const dollarBudgets = mapByScope(dollarBudgetResult.rows);
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
    hours: hourIds.includes(person.id) ? usage(hourBudgets.get(person.id)) : null,
    dollars: dollarIds.includes(person.id) ? dollarUsage(dollarBudgets.get(person.id)) : null,
    month,
    billedThisMonth: billedIds.includes(person.id) ? toMoney(billed.get(person.id)?.amount ?? 0) : null,
    setAsideThisMonth: setAsideIds.includes(person.id) ? toMoney(setAside.get(person.id)?.amount ?? 0) : null,
    directChecksThisMonth: directCheckIds.includes(person.id) ? toMoney(directChecks.get(person.id)?.amount ?? 0) : null,
    agencyPaidThisMonth: agencyPaidIds.includes(person.id) ? toMoney(agencyPaid.get(person.id)?.amount ?? 0) : null,
    programs: [hourIds, dollarIds, billedIds, directCheckIds, agencyPaidIds].some((allowed) => allowed.includes(person.id))
      ? mergeProgramBreakdowns({
          hours: hourBudgets.get(person.id)?.program_breakdown,
          dollars: dollarBudgets.get(person.id)?.program_breakdown,
          billed: billed.get(person.id)?.program_breakdown,
          directChecks: directChecks.get(person.id)?.program_breakdown,
          agencyPaid: agencyPaid.get(person.id)?.program_breakdown,
        })
      : null,
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
  const directPayIds = employeeIdsWith(context, ids, "employee_pay.self.read");
  const giveBackIds = employeeIdsWith(context, ids, "employee_giveback.self.read");

  const [peopleResult, checksResult, directPayResult, giveBackResult] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM employees
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    checkIds.length > 0
      ? pool.query<PayrollCheckRow>(
          `SELECT c.id, c.employee_id, c.check_number,
                  to_char(check_date, 'YYYY-MM-DD') AS check_date,
                  to_char(period_begin, 'YYYY-MM-DD') AS period_begin,
                  to_char(period_end, 'YYYY-MM-DD') AS period_end,
                  CASE WHEN c.employee_id = ANY($2::uuid[]) THEN c.actual_gross::text END AS actual_gross,
                  CASE WHEN c.employee_id = ANY($3::uuid[]) THEN c.actual_net::text END AS actual_net,
                  CASE WHEN c.employee_id = ANY($4::uuid[]) THEN c.tax_withheld::text END AS tax_withheld
             FROM employee_payroll_checks c
            WHERE c.employee_id = ANY($1::uuid[])
              AND c.verification_status = 'verified'
              AND canonical_service_date(c.period_begin, c.check_date, c.period_end) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    c.period_begin, c.check_date, c.period_end
                  )) = $5::date
            ORDER BY canonical_service_date(c.period_begin, c.check_date, c.period_end) DESC,
                     c.updated_at DESC`,
          [checkIds, grossIds, netIds, taxIds, monthStart],
        )
      : empty<PayrollCheckRow>(),
    directPayIds.length > 0
      ? pool.query<EmployeeDirectPayRow>(
          `SELECT transaction.id, transaction.employee_id,
                  to_char(canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ), 'YYYY-MM-DD') AS service_date,
                  COALESCE(checks.check_number, transaction.check_number) AS check_number,
                  COALESCE(individual.display_name, transaction.individual_raw, 'Unknown individual') AS individual_name,
                  program.code AS program_code,
                  COALESCE(program.name, transaction.program_raw, 'Unassigned program') AS program_name,
                  transaction.imported_hours::text AS hours,
                  transaction.employee_payment_amount::text AS gross_service_value
             FROM payroll_transactions transaction
             JOIN employee_payroll_checks checks
               ON checks.id = transaction.payroll_check_id
              AND checks.employee_id = transaction.employee_id
              AND checks.verification_status = 'verified'
             LEFT JOIN individuals individual ON individual.id = transaction.individual_id
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.employee_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            ORDER BY canonical_service_date(
                       transaction.period_begin, transaction.check_date, transaction.period_end
                     ) DESC,
                     checks.check_number,
                     individual_name,
                     program_name`,
          [directPayIds, monthStart],
        )
      : empty<EmployeeDirectPayRow>(),
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
                      AND o.status = 'active'
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
      serviceDate: row.period_begin ?? row.check_date ?? row.period_end,
    };
    if (grossIds.includes(row.employee_id)) item.actualGross = row.actual_gross === null ? null : toMoney(row.actual_gross);
    if (netIds.includes(row.employee_id) && row.actual_net !== null) item.actualNet = toMoney(row.actual_net);
    if (taxIds.includes(row.employee_id)) item.taxWithheld = row.tax_withheld === null ? null : toMoney(row.tax_withheld);
    checks.set(row.employee_id, [...(checks.get(row.employee_id) ?? []), item]);
  }
  const directPay = new Map<string, PortalEmployeeDirectPaySummary[]>();
  for (const row of directPayResult.rows) {
    const item: PortalEmployeeDirectPaySummary = {
      id: row.id,
      serviceDate: row.service_date,
      checkNumber: row.check_number,
      individualName: row.individual_name,
      programCode: row.program_code,
      programName: row.program_name,
      hours: row.hours === null ? null : toHours(row.hours),
      grossServiceValue: row.gross_service_value === null ? null : toMoney(row.gross_service_value),
    };
    directPay.set(row.employee_id, [...(directPay.get(row.employee_id) ?? []), item]);
  }
  const giveBack = mapByScope(giveBackResult.rows);
  return peopleResult.rows.map((person) => {
    const collection = giveBack.get(person.id);
    return {
      id: person.id,
      name: person.name,
      month,
      checkVisibility: {
        gross: grossIds.includes(person.id),
        net: netIds.includes(person.id),
        tax: taxIds.includes(person.id),
      },
      checks: checkIds.includes(person.id) ? checks.get(person.id) ?? [] : null,
      directPay: directPayIds.includes(person.id) ? directPay.get(person.id) ?? [] : null,
      giveBack: giveBackIds.includes(person.id) ? {
        month,
        dueThisMonth: toMoney(collection?.due_this_month ?? 0),
        collectedThisMonth: toMoney(collection?.collected_this_month ?? 0),
        remaining: toMoney(collection?.remaining ?? 0),
      } : null,
    };
  });
}

async function agencyMemberSummaries(
  pool: PgLikePool,
  month: string,
  peopleAgencyIds: readonly string[],
  hourAgencyIds: readonly string[],
  dollarAgencyIds: readonly string[],
  billedAgencyIds: readonly string[],
  setAsideAgencyIds: readonly string[],
  directCheckAgencyIds: readonly string[],
  agencyPaidAgencyIds: readonly string[],
  giveBackAgencyIds: readonly string[],
): Promise<{
  individuals: Map<string, PortalAgencyIndividualSummary[]>;
  employees: Map<string, PortalAgencyEmployeeSummary[]>;
}> {
  const monthStart = `${month}-01`;
  const peopleIds = new Set(peopleAgencyIds);
  const memberHours = hourAgencyIds.filter((id) => peopleIds.has(id));
  const memberDollars = dollarAgencyIds.filter((id) => peopleIds.has(id));
  const memberBilled = billedAgencyIds.filter((id) => peopleIds.has(id));
  const memberSetAside = setAsideAgencyIds.filter((id) => peopleIds.has(id));
  const memberDirectChecks = directCheckAgencyIds.filter((id) => peopleIds.has(id));
  const memberAgencyPaid = agencyPaidAgencyIds.filter((id) => peopleIds.has(id));
  const memberGiveBack = giveBackAgencyIds.filter((id) => peopleIds.has(id));

  const [
    individualResult,
    employeeResult,
    hoursBudgetResult,
    dollarBudgetResult,
    billedResult,
    setAsideResult,
    directCheckResult,
    agencyPaidResult,
    employeeCheckResult,
    employeeGiveBackResult,
  ] = await Promise.all([
    peopleAgencyIds.length > 0
      ? pool.query<AgencyIndividualMemberRow>(
          `WITH ranked_memberships AS (
             SELECT membership.agency_id,
                    membership.individual_id AS person_id,
                    individual.display_name AS name,
                    membership.manages_budget,
                    membership.bills_services,
                    row_number() OVER (
                      PARTITION BY membership.agency_id, membership.individual_id
                      ORDER BY membership.effective_from DESC,
                               membership.updated_at DESC,
                               membership.id DESC
                    ) AS responsibility_rank
               FROM agency_individuals membership
               JOIN individuals individual ON individual.id = membership.individual_id
              WHERE membership.agency_id = ANY($1::uuid[])
                AND membership.is_active = true
                AND membership.effective_from < ($2::date + interval '1 month')
                AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
           )
           SELECT agency_id, person_id, name, manages_budget, bills_services
             FROM ranked_memberships
            WHERE responsibility_rank = 1
            ORDER BY agency_id, name`,
          [peopleAgencyIds, monthStart],
        )
      : empty<AgencyIndividualMemberRow>(),
    peopleAgencyIds.length > 0
      ? pool.query<AgencyEmployeeMemberRow>(
          `SELECT membership.agency_id,
                  membership.employee_id AS person_id,
                  employee.display_name AS name
             FROM agency_employees membership
             JOIN employees employee ON employee.id = membership.employee_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND (
                (
                  membership.effective_from < ($2::date + interval '1 month')
                  AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
                )
                OR (
                  membership.agency_id = ANY($3::uuid[])
                  AND EXISTS (
                    SELECT 1
                      FROM settlement_obligations obligation
                     WHERE obligation.employee_id = membership.employee_id
                       AND obligation.status = 'active'
                       AND obligation.direction = 'receivable'
                       AND obligation.kind LIKE 'employee_giveback%'
                       AND canonical_service_date(
                             obligation.period_begin, obligation.check_date, obligation.period_end
                           ) BETWEEN membership.effective_from
                               AND COALESCE(membership.effective_to, 'infinity'::date)
                  )
                )
              )
            GROUP BY membership.agency_id, membership.employee_id, employee.display_name
            ORDER BY membership.agency_id, employee.display_name`,
          [peopleAgencyIds, monthStart, memberGiveBack],
        )
      : empty<AgencyEmployeeMemberRow>(),
    memberHours.length > 0
      ? pool.query<AgencyPersonHoursRow>(
          `WITH ${effectivePortalHoursCte(AGENCY_PORTAL_HOURS_SCOPE)}
           SELECT membership.agency_id,
                  membership.individual_id AS person_id,
                  COALESCE(sum(effective_hours.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(effective_hours.used_hours), 0)::text AS used_hours,
                  COALESCE(sum(
                    effective_hours.authorized_hours - effective_hours.used_hours
                  ), 0)::text AS remaining_hours,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_hours::text,
                      'used', program_totals.used_hours::text,
                      'remaining', program_totals.remaining_hours::text
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               COALESCE(sum(detail.authorized_hours), 0) AS authorized_hours,
                               COALESCE(sum(detail.used_hours), 0) AS used_hours,
                               COALESCE(sum(detail.authorized_hours - detail.used_hours), 0) AS remaining_hours
                          FROM effective_hours detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = membership.individual_id
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM agency_individuals membership
             LEFT JOIN effective_hours
               ON effective_hours.individual_id = membership.individual_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id, membership.individual_id`,
          [memberHours],
        )
      : empty<AgencyPersonHoursRow>(),
    memberDollars.length > 0
      ? pool.query<AgencyPersonDollarRow>(
          `SELECT membership.agency_id,
                  membership.individual_id AS person_id,
                  CASE WHEN count(balance.authorized_dollars) > 0
                    THEN sum(balance.authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(balance.consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(balance.remaining_dollars) > 0
                    THEN sum(balance.remaining_dollars)::text END AS remaining_dollars,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_dollars,
                      'used', program_totals.used_dollars,
                      'remaining', program_totals.remaining_dollars
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               CASE WHEN count(detail.authorized_dollars) > 0
                                 THEN sum(detail.authorized_dollars)::text END AS authorized_dollars,
                               COALESCE(sum(detail.consumed_dollars), 0)::text AS used_dollars,
                               CASE WHEN count(detail.remaining_dollars) > 0
                                 THEN sum(detail.remaining_dollars)::text END AS remaining_dollars
                          FROM program_budget_balances detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = membership.individual_id
                           AND detail.period_status = 'active'
                           AND (now() AT TIME ZONE 'America/New_York')::date
                               BETWEEN detail.start_date AND detail.end_date
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
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
            GROUP BY membership.agency_id, membership.individual_id`,
          [memberDollars],
        )
      : empty<AgencyPersonDollarRow>(),
    memberBilled.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
                  COALESCE(sum(transaction.imported_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.imported_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberBilled, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberSetAside.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  event.individual_id AS person_id,
                  COALESCE(sum(event.amount), 0)::text AS amount
             FROM settlement_events event
             JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
             JOIN agency_individuals membership
               ON membership.individual_id = event.individual_id
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND event.occurred_on BETWEEN membership.effective_from
                  AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND obligation.direction = 'reserve'
              AND date_trunc('month', event.occurred_on) = $2::date
            GROUP BY membership.agency_id, event.individual_id`,
          [memberSetAside, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberDirectChecks.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'employee'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberDirectChecks, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberAgencyPaid.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'excellent_staffing'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'excellent_staffing'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberAgencyPaid, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberDirectChecks.length > 0
      ? pool.query<AgencyEmployeeCheckRow>(
          `SELECT membership.agency_id,
                  checks.employee_id AS person_id,
                  CASE
                    WHEN count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0 THEN NULL
                    ELSE COALESCE(sum(checks.actual_gross), 0)::text
                  END AS gross,
                  COALESCE(sum(checks.actual_net), 0)::text AS net
             FROM employee_payroll_checks checks
             JOIN agency_employees membership
               ON membership.employee_id = checks.employee_id
              AND membership.is_active = true
              AND canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND checks.verification_status = 'verified'
              AND canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, checks.employee_id`,
          [memberDirectChecks, monthStart],
        )
      : empty<AgencyEmployeeCheckRow>(),
    memberGiveBack.length > 0
      ? pool.query<AgencyEmployeeGiveBackRow>(
          `WITH event_totals AS (
             SELECT settlement_obligation_id,
                    COALESCE(sum(amount), 0) AS applied,
                    COALESCE(sum(amount) FILTER (
                      WHERE date_trunc('month', occurred_on) = $2::date
                    ), 0) AS applied_month
               FROM settlement_events
              GROUP BY settlement_obligation_id
           )
           SELECT membership.agency_id,
                  obligation.employee_id AS person_id,
                  COALESCE(sum(obligation.original_amount) FILTER (
                    WHERE obligation.status = 'active'
                      AND canonical_service_date(
                            obligation.period_begin, obligation.check_date, obligation.period_end
                          ) IS NOT NULL
                      AND date_trunc('month', canonical_service_date(
                            obligation.period_begin, obligation.check_date, obligation.period_end
                          )) = $2::date
                  ), 0)::text AS due_this_month,
                  COALESCE(sum(events.applied_month), 0)::text AS collected_this_month,
                  COALESCE(sum(GREATEST(
                    obligation.original_amount - COALESCE(events.applied, 0), 0
                  )) FILTER (WHERE obligation.status = 'active'), 0)::text AS remaining
             FROM settlement_obligations obligation
             JOIN agency_employees membership
               ON membership.employee_id = obligation.employee_id
              AND membership.is_active = true
              AND canonical_service_date(
                    obligation.period_begin, obligation.check_date, obligation.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
             LEFT JOIN event_totals events ON events.settlement_obligation_id = obligation.id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND obligation.direction = 'receivable'
              AND obligation.kind LIKE 'employee_giveback%'
            GROUP BY membership.agency_id, obligation.employee_id`,
          [memberGiveBack, monthStart],
        )
      : empty<AgencyEmployeeGiveBackRow>(),
  ]);

  const hourBudgets = mapByAgencyPerson(hoursBudgetResult.rows);
  const dollarBudgets = mapByAgencyPerson(dollarBudgetResult.rows);
  const billed = mapByAgencyPerson(billedResult.rows);
  const setAside = mapByAgencyPerson(setAsideResult.rows);
  const directChecks = mapByAgencyPerson(directCheckResult.rows);
  const agencyPaid = mapByAgencyPerson(agencyPaidResult.rows);
  const employeeChecks = mapByAgencyPerson(employeeCheckResult.rows);
  const employeeGiveBack = mapByAgencyPerson(employeeGiveBackResult.rows);
  const individuals = new Map<string, PortalAgencyIndividualSummary[]>();
  const employees = new Map<string, PortalAgencyEmployeeSummary[]>();

  for (const person of individualResult.rows) {
    const key = agencyPersonKey(person.agency_id, person.person_id);
    const canReadHours = memberHours.includes(person.agency_id);
    const canReadDollars = memberDollars.includes(person.agency_id);
    const summary: PortalAgencyIndividualSummary = {
      id: person.person_id,
      name: person.name,
      managesBudget: canReadHours || canReadDollars ? person.manages_budget : null,
      billsServices: canReadHours || canReadDollars ? person.bills_services : null,
      hours: canReadHours && person.manages_budget
        ? usage(hourBudgets.get(key))
        : null,
      dollars: canReadDollars && person.manages_budget
        ? dollarUsage(dollarBudgets.get(key))
        : null,
      month,
      billedThisMonth: memberBilled.includes(person.agency_id)
        ? toMoney(billed.get(key)?.amount ?? 0)
        : null,
      setAsideThisMonth: memberSetAside.includes(person.agency_id)
        ? toMoney(setAside.get(key)?.amount ?? 0)
        : null,
      directChecksThisMonth: memberDirectChecks.includes(person.agency_id)
        ? toMoney(directChecks.get(key)?.amount ?? 0)
        : null,
      agencyPaidThisMonth: memberAgencyPaid.includes(person.agency_id)
        ? toMoney(agencyPaid.get(key)?.amount ?? 0)
        : null,
      programs: (
        (person.manages_budget && (canReadHours || canReadDollars))
        || memberBilled.includes(person.agency_id)
        || memberDirectChecks.includes(person.agency_id)
        || memberAgencyPaid.includes(person.agency_id)
      )
        ? mergeProgramBreakdowns({
            hours: canReadHours && person.manages_budget
              ? hourBudgets.get(key)?.program_breakdown
              : undefined,
            dollars: canReadDollars && person.manages_budget
              ? dollarBudgets.get(key)?.program_breakdown
              : undefined,
            billed: memberBilled.includes(person.agency_id)
              ? billed.get(key)?.program_breakdown
              : undefined,
            directChecks: memberDirectChecks.includes(person.agency_id)
              ? directChecks.get(key)?.program_breakdown
              : undefined,
            agencyPaid: memberAgencyPaid.includes(person.agency_id)
              ? agencyPaid.get(key)?.program_breakdown
              : undefined,
          })
        : null,
    };
    individuals.set(person.agency_id, [...(individuals.get(person.agency_id) ?? []), summary]);
  }

  for (const person of employeeResult.rows) {
    const key = agencyPersonKey(person.agency_id, person.person_id);
    const checks = employeeChecks.get(key);
    const giveBack = employeeGiveBack.get(key);
    const summary: PortalAgencyEmployeeSummary = {
      id: person.person_id,
      name: person.name,
      month,
      payrollGrossThisMonth: memberDirectChecks.includes(person.agency_id)
        ? checks?.gross === null
          ? null
          : toMoney(checks?.gross ?? 0)
        : null,
      payrollNetThisMonth: memberDirectChecks.includes(person.agency_id)
        ? toMoney(checks?.net ?? 0)
        : null,
      giveBack: memberGiveBack.includes(person.agency_id) ? {
        dueThisMonth: toMoney(giveBack?.due_this_month ?? 0),
        collectedThisMonth: toMoney(giveBack?.collected_this_month ?? 0),
        remaining: toMoney(giveBack?.remaining ?? 0),
      } : null,
    };
    employees.set(person.agency_id, [...(employees.get(person.agency_id) ?? []), summary]);
  }

  return { individuals, employees };
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
                  COALESCE(ai.managed_budget_count, 0)::int AS managed_budget_count,
                  COALESCE(ai.billing_without_budget_count, 0)::int AS billing_without_budget_count
             FROM agencies a
             LEFT JOIN LATERAL (
               SELECT COUNT(*) FILTER (WHERE manages_budget) AS managed_budget_count,
                      COUNT(*) FILTER (WHERE bills_services AND NOT manages_budget) AS billing_without_budget_count
                 FROM agency_individuals
                WHERE agency_id = a.id AND is_active = true
                  AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
                  AND (effective_to IS NULL
                    OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
             ) ai ON true
            WHERE a.status = 'active'
              AND ($1::boolean = true OR a.id = ANY($2::uuid[]))
            ORDER BY a.is_home_agency DESC, a.name`,
          [ownerCanReadAgencies, scopedAgencyIds],
        )
      : empty<AgencyAggregateRow>(),
  ]);

  const agencyIds = agencyResult.rows.map((row) => row.id);
  const peopleAgencyIds = agencyIdsWith(context, agencyIds, "people.agency.read");
  const hourAgencyIds = agencyIdsWith(context, agencyIds, "hours_budgets.agency.read");
  const dollarAgencyIds = agencyIdsWith(context, agencyIds, "dollar_budgets.agency.read");
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

  const [agencyHoursResult, agencyDollarsResult, agencyFinancialResult, agencyMembers] = await Promise.all([
    hourAgencyIds.length > 0
      ? pool.query<HoursAggregateRow>(
          `WITH ${effectivePortalHoursCte(AGENCY_PORTAL_HOURS_SCOPE)}
           SELECT membership.agency_id AS scope_id,
                  COALESCE(sum(effective_hours.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(effective_hours.used_hours), 0)::text AS used_hours,
                  COALESCE(sum(
                    effective_hours.authorized_hours - effective_hours.used_hours
                  ), 0)::text AS remaining_hours
             FROM agency_individuals membership
             LEFT JOIN effective_hours
               ON effective_hours.individual_id = membership.individual_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id`,
          [hourAgencyIds],
        )
      : empty<HoursAggregateRow>(),
    dollarAgencyIds.length > 0
      ? pool.query<DollarAggregateRow>(
          `SELECT membership.agency_id AS scope_id,
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
          [dollarAgencyIds],
        )
      : empty<DollarAggregateRow>(),
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
                  CASE WHEN requested.agency_id = ANY($5::uuid[]) THEN (
                    SELECT CASE
                             WHEN count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0 THEN NULL
                             ELSE COALESCE(sum(checks.actual_gross), 0)::text
                           END
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
                  ) END AS payroll_gross_this_month,
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
    agencyMemberSummaries(
      pool,
      month,
      peopleAgencyIds,
      hourAgencyIds,
      dollarAgencyIds,
      billedAgencyIds,
      setAsideAgencyIds,
      checkAgencyIds,
      agencyPaidAgencyIds,
      giveBackAgencyIds,
    ),
  ]);

  const agencyHours = mapByScope(agencyHoursResult.rows);
  const agencyDollars = mapByScope(agencyDollarsResult.rows);
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
    const agencyIndividuals = canReadPeople ? agencyMembers.individuals.get(row.id) ?? [] : null;
    const agencyEmployees = canReadPeople ? agencyMembers.employees.get(row.id) ?? [] : null;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      roles: unique(roles).map((role) => roleSummary(role as PortalRole)),
      capabilities: portalCapabilities(context, row.id),
      individualCount: agencyIndividuals?.length ?? null,
      employeeCount: agencyEmployees?.length ?? null,
      managedBudgetCount: canReadHours ? Number(row.managed_budget_count) : null,
      billingWithoutBudgetCount: canReadHours ? Number(row.billing_without_budget_count) : null,
      budgetHours: canReadHours ? usage(agencyHours.get(row.id)) : null,
      budgetDollars: canReadDollars ? dollarUsage(agencyDollars.get(row.id)) : null,
      month,
      billedThisMonth: billedAgencyIds.includes(row.id) ? toMoney(financial?.billed_this_month ?? 0) : null,
      setAsideThisMonth: setAsideAgencyIds.includes(row.id) ? toMoney(financial?.set_aside_this_month ?? 0) : null,
      agencyPaidThisMonth: agencyPaidAgencyIds.includes(row.id) ? toMoney(financial?.agency_paid_this_month ?? 0) : null,
      payrollGrossThisMonth: checkAgencyIds.includes(row.id)
        ? financial?.payroll_gross_this_month === null
          ? null
          : toMoney(financial?.payroll_gross_this_month ?? 0)
        : null,
      payrollNetThisMonth: checkAgencyIds.includes(row.id) ? toMoney(financial?.payroll_net_this_month ?? 0) : null,
      giveBackRemaining: giveBackAgencyIds.includes(row.id) ? toMoney(financial?.giveback_remaining ?? 0) : null,
      individuals: agencyIndividuals,
      employees: agencyEmployees,
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
