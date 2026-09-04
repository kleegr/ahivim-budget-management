import type { PgLikeResult } from "@/lib/import/commit";
import { agencyMonth } from "@/lib/business/agency-time";
import { toHours, toMoney } from "@/lib/money";
import type { PortalUpcomingSchedule } from "@/lib/data/portal-schedule";
import {
  PORTAL_ROLE_LABELS,
  hasPortalCapability,
  hasPortalEmployeeCapability,
  hasPortalIndividualCapability,
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
  upcomingSchedule: PortalUpcomingSchedule | null;
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
  /** Present only when net, direct-pay, and give-back visibility are all effective. */
  giveBackDue?: string;
  /** The canonical deal-engine residual for this verified direct-pay check. */
  employeeKeeps?: string;
}

export interface PortalEmployeeGiveBackActivity {
  occurredOn: string;
  label: string;
  amount: string;
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
    credit: string;
    recentActivity: PortalEmployeeGiveBackActivity[];
  } | null;
  upcomingSchedule: PortalUpcomingSchedule | null;
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
  checks: PortalPayrollCheckSummary[] | null;
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

export interface PersonRow {
  id: string;
  name: string;
}

export interface HoursAggregateFields {
  authorized_hours: string;
  used_hours: string;
  remaining_hours: string;
  program_breakdown?: unknown;
}

export interface DollarAggregateFields {
  authorized_dollars: string | null;
  used_dollars: string;
  remaining_dollars: string | null;
  program_breakdown?: unknown;
}

export interface HoursAggregateRow extends HoursAggregateFields {
  scope_id: string;
}

export interface DollarAggregateRow extends DollarAggregateFields {
  scope_id: string;
}

export interface MoneyAggregateRow {
  scope_id: string;
  amount: string;
  program_breakdown?: unknown;
}

export interface EmployeeDirectPayRow {
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

export interface PayrollCheckRow {
  id: string;
  employee_id: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  actual_gross: string | null;
  actual_net: string | null;
  tax_withheld: string | null;
  direct_rule: "keep_all" | "giveback_percent" | "giveback_all" | null;
  direct_percent: string | null;
}

export interface GiveBackRow {
  scope_id: string;
  due_this_month: string;
  collected_this_month: string;
  remaining: string;
  credit?: string;
  recent_activity?: unknown;
}

export interface GiveBackActivityValue {
  occurredOn?: unknown;
  eventType?: unknown;
  amount?: unknown;
}

export interface AgencyAggregateRow {
  id: string;
  code: string;
  name: string;
  managed_budget_count: number | string;
  billing_without_budget_count: number | string;
}

export interface AgencyRosterCountRow {
  scope_id: string;
  individual_count: number | string;
  employee_count: number | string;
}

export interface PortalHomeReadModelOptions {
  /** Restrict agency reads at the database boundary, including owner reads. */
  agencyIds?: readonly string[];
  /** Directory rows need aggregate hours and billing, not full member ledgers. */
  agencySummaryOnly?: boolean;
}

export interface AgencyFinancialRow {
  scope_id: string;
  billed_this_month: string | null;
  set_aside_this_month: string | null;
  agency_paid_this_month: string | null;
  payroll_gross_this_month: string | null;
  payroll_net_this_month: string | null;
  giveback_remaining: string | null;
}

export interface AgencyIndividualMemberRow {
  agency_id: string;
  person_id: string;
  name: string;
  manages_budget: boolean;
  bills_services: boolean;
}

export interface AgencyEmployeeMemberRow {
  agency_id: string;
  person_id: string;
  name: string;
}

export interface AgencyPersonHoursRow extends HoursAggregateFields {
  agency_id: string;
  person_id: string;
}

export interface AgencyPersonDollarRow extends DollarAggregateFields {
  agency_id: string;
  person_id: string;
}

export interface AgencyPersonMoneyRow {
  agency_id: string;
  person_id: string;
  amount: string;
  program_breakdown?: unknown;
}

export interface AgencyEmployeeCheckRow {
  agency_id: string;
  person_id: string;
  gross: string | null;
  net: string;
  checks: unknown;
}

export interface AgencyEmployeeGiveBackRow {
  agency_id: string;
  person_id: string;
  due_this_month: string;
  collected_this_month: string;
  remaining: string;
}

export const DIRECT_PORTAL_HOURS_SCOPE = `SELECT unnest($1::uuid[]) AS individual_id`;

export const AGENCY_PORTAL_HOURS_SCOPE = `SELECT DISTINCT membership.individual_id
  FROM agency_individuals membership
 WHERE membership.agency_id = ANY($1::uuid[])
   AND membership.is_active = true
   AND membership.manages_budget = true
   AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
   AND (membership.effective_to IS NULL
     OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)`;

export function effectivePortalHoursCte(scopeSql: string): string {
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

// Whole-check amounts are agency-safe only with one employee agency or a
// complete set of linked service rows that all resolve to the requesting agency.
export function agencyPayrollCheckVisibilitySql(checkAlias: string, agencyIdSql: string): string {
  const checkServiceDate = `canonical_service_date(
    ${checkAlias}.period_begin, ${checkAlias}.check_date, ${checkAlias}.period_end
  )`;
  const sourceServiceDate = `canonical_service_date(
    source_transaction.period_begin,
    source_transaction.check_date,
    source_transaction.period_end
  )`;
  return `(
    (
      SELECT count(DISTINCT candidate_membership.agency_id)
        FROM agency_employees candidate_membership
       WHERE candidate_membership.employee_id = ${checkAlias}.employee_id
         AND candidate_membership.is_active = true
         AND ${checkServiceDate} BETWEEN candidate_membership.effective_from
             AND COALESCE(candidate_membership.effective_to, 'infinity'::date)
    ) = 1
    OR (
      SELECT count(*) > 0
         AND bool_and(
           attribution.agency_count = 1
           AND attribution.requested_agency_count = 1
         )
        FROM LATERAL (
          SELECT source_transaction.id,
                 count(DISTINCT source_agency.agency_id) AS agency_count,
                 count(DISTINCT source_agency.agency_id) FILTER (
                   WHERE source_agency.agency_id = ${agencyIdSql}
                 ) AS requested_agency_count
            FROM payroll_transactions source_transaction
            LEFT JOIN agency_individuals source_agency
              ON source_agency.individual_id = source_transaction.individual_id
             AND source_agency.is_active = true
             AND source_agency.bills_services = true
             AND ${sourceServiceDate} BETWEEN source_agency.effective_from
                 AND COALESCE(source_agency.effective_to, 'infinity'::date)
           WHERE source_transaction.payroll_check_id = ${checkAlias}.id
           GROUP BY source_transaction.id
        ) attribution
    )
  )`;
}

// Give-back obligations are whole-check balances. When an employee belongs to
// multiple agencies, every source transaction must resolve to one agency and it
// must be the agency requesting the balance.
export function agencyGiveBackVisibilitySql(obligationAlias: string, agencyIdSql: string): string {
  const obligationServiceDate = `canonical_service_date(
    ${obligationAlias}.period_begin, ${obligationAlias}.check_date, ${obligationAlias}.period_end
  )`;
  const sourceServiceDate = `canonical_service_date(
    source_transaction.period_begin,
    source_transaction.check_date,
    source_transaction.period_end
  )`;
  return `(
    (
      SELECT count(DISTINCT candidate_membership.agency_id)
        FROM agency_employees candidate_membership
       WHERE candidate_membership.employee_id = ${obligationAlias}.employee_id
         AND candidate_membership.is_active = true
         AND ${obligationServiceDate} BETWEEN candidate_membership.effective_from
             AND COALESCE(candidate_membership.effective_to, 'infinity'::date)
    ) = 1
    OR (
      SELECT count(*) > 0
         AND bool_and(
           attribution.agency_count = 1
           AND attribution.requested_agency_count = 1
         )
        FROM LATERAL (
          SELECT source_id.value,
                 source_transaction.id,
                 count(DISTINCT source_agency.agency_id) AS agency_count,
                 count(DISTINCT source_agency.agency_id) FILTER (
                   WHERE source_agency.agency_id = ${agencyIdSql}
                 ) AS requested_agency_count
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(${obligationAlias}.calculation_metadata->'sourceTransactionIds') = 'array'
                  THEN ${obligationAlias}.calculation_metadata->'sourceTransactionIds'
                ELSE '[]'::jsonb
              END
            ) source_id(value)
            LEFT JOIN payroll_transactions source_transaction
              ON source_transaction.id = CASE
                WHEN source_id.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  THEN source_id.value::uuid
                ELSE NULL
              END
            LEFT JOIN agency_individuals source_agency
              ON source_agency.individual_id = source_transaction.individual_id
             AND source_agency.is_active = true
             AND source_agency.bills_services = true
             AND ${sourceServiceDate} BETWEEN source_agency.effective_from
                 AND COALESCE(source_agency.effective_to, 'infinity'::date)
           GROUP BY source_id.value, source_transaction.id
        ) attribution
    )
  )`;
}

export function roleSummary(role: PortalRole): PortalRoleSummary {
  return { key: role, label: PORTAL_ROLE_LABELS[role] };
}

export function empty<T>(): PgLikeResult<T> {
  return { rows: [] };
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function normalizePortalMonth(value?: string | null): string {
  return typeof value === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : agencyMonth();
}

export function mapByScope<T extends { scope_id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.scope_id, row]));
}

export function agencyPersonKey(agencyId: string, personId: string): string {
  return `${agencyId}:${personId}`;
}

export function mapByAgencyPerson<T extends { agency_id: string; person_id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [agencyPersonKey(row.agency_id, row.person_id), row]));
}

export function usage(row: HoursAggregateFields | undefined): PortalUsageSummary {
  return {
    authorized: toHours(row?.authorized_hours ?? 0),
    used: toHours(row?.used_hours ?? 0),
    remaining: toHours(row?.remaining_hours ?? 0),
  };
}

export function dollarUsage(row: DollarAggregateFields | undefined): PortalDollarUsageSummary {
  return {
    authorized: row?.authorized_dollars == null ? null : toMoney(row.authorized_dollars),
    used: toMoney(row?.used_dollars ?? 0),
    remaining: row?.remaining_dollars == null ? null : toMoney(row.remaining_dollars),
  };
}

export interface ProgramBreakdownRow {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  authorized?: unknown;
  used?: unknown;
  remaining?: unknown;
  amount?: unknown;
}

export function programBreakdown(value: unknown): ProgramBreakdownRow[] {
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

export interface AgencyCheckValue {
  id?: unknown;
  checkNumber?: unknown;
  checkDate?: unknown;
  periodBegin?: unknown;
  periodEnd?: unknown;
  serviceDate?: unknown;
  actualGross?: unknown;
  actualNet?: unknown;
}

export function agencyPayrollChecks(value: unknown): PortalPayrollCheckSummary[] {
  if (typeof value === "string") {
    try {
      return agencyPayrollChecks(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const check = candidate as AgencyCheckValue;
    if (typeof check.id !== "string" || typeof check.actualNet !== "string") return [];
    return [{
      id: check.id,
      checkNumber: typeof check.checkNumber === "string" ? check.checkNumber : null,
      checkDate: typeof check.checkDate === "string" ? check.checkDate : null,
      periodBegin: typeof check.periodBegin === "string" ? check.periodBegin : null,
      periodEnd: typeof check.periodEnd === "string" ? check.periodEnd : null,
      serviceDate: typeof check.serviceDate === "string" ? check.serviceDate : null,
      actualGross: typeof check.actualGross === "string" ? toMoney(check.actualGross) : null,
      actualNet: toMoney(check.actualNet),
    }];
  });
}

export function giveBackActivityLabel(value: unknown): string {
  if (value === "payment") return "Payment recorded";
  if (value === "credit") return "Credit applied";
  if (value === "reversal") return "Reversal";
  if (value === "adjustment") return "Adjustment";
  return "Balance updated";
}

export function employeeGiveBackActivity(value: unknown): PortalEmployeeGiveBackActivity[] {
  if (typeof value === "string") {
    try {
      return employeeGiveBackActivity(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const activity = candidate as GiveBackActivityValue;
    if (typeof activity.occurredOn !== "string" || typeof activity.amount !== "string") return [];
    return [{
      occurredOn: activity.occurredOn,
      label: giveBackActivityLabel(activity.eventType),
      amount: toMoney(activity.amount),
    }];
  });
}

export function programKey(row: ProgramBreakdownRow): string {
  if (typeof row.id === "string" && row.id) return `id:${row.id}`;
  if (typeof row.code === "string" && row.code) return `code:${row.code}`;
  return `name:${String(row.name ?? "Unassigned program").trim().toLowerCase()}`;
}

export function programIdentity(row: ProgramBreakdownRow): Pick<PortalIndividualProgramSummary, "id" | "code" | "name"> {
  return {
    id: typeof row.id === "string" && row.id ? row.id : null,
    code: typeof row.code === "string" && row.code ? row.code : null,
    name: typeof row.name === "string" && row.name.trim() ? row.name : "Unassigned program",
  };
}

export function mergeProgramBreakdowns({
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

export function directIndividualIds(context: PortalAccessContext): string[] {
  return unique(
    context.individualLinks
      .filter((link) => hasPortalIndividualCapability(context, link.individualId, "people.self.read"))
      .map((link) => link.individualId),
  );
}

export function directEmployeeIds(context: PortalAccessContext): string[] {
  return unique(
    context.employeeLinks
      .filter((link) => hasPortalEmployeeCapability(context, link.employeeId, "people.self.read"))
      .map((link) => link.employeeId),
  );
}

export function individualIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalIndividualCapability(context, id, capability));
}

export function employeeIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalEmployeeCapability(context, id, capability));
}

export function agencyIdsWith(
  context: PortalAccessContext,
  ids: readonly string[],
  capability: PortalCapability,
): string[] {
  return ids.filter((id) => hasPortalCapability(context, capability, id));
}
