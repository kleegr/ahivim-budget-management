import type { PgLikePool } from "@/lib/import/commit";
import { toHours, toMoney } from "@/lib/money";

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
  /** Payroll rows for this individual/program with no usable service date. */
  undatedUsageCount: number;
  hasUndatedUsage: boolean;
  revision: number;
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
  undated_usage_count: number | string;
  has_undated_usage: boolean;
  revision: number;
}

const PROGRAM_BUDGET_SELECT = `
  SELECT authorization_id, budget_period_id, individual_id, individual_name,
         program_id, program_code, program_name, period_label,
         start_date::text AS start_date, end_date::text AS end_date,
         renewal_date::text AS renewal_date, period_type, period_status,
         required_auth_type, service_category, payment_recipient,
         consumption_source, rate_scope, renewal_policy,
         allow_individual_rate_override,
         authorized_hours::text AS authorized_hours,
         authorized_dollars::text AS authorized_dollars,
         internal_rate::text AS internal_rate,
         agency_rate::text AS agency_rate,
         individual_rate_override::text AS individual_rate_override,
         notes,
         consumed_hours::text AS consumed_hours,
         consumed_dollars::text AS consumed_dollars,
         remaining_hours::text AS remaining_hours,
         remaining_dollars::text AS remaining_dollars,
         undated_usage_count,
         has_undated_usage,
         revision
    FROM program_budget_balances`;

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
    undatedUsageCount: Number(row.undated_usage_count),
    hasUndatedUsage: row.has_undated_usage,
    revision: row.revision,
  };
}

export interface ProgramBudgetFilters {
  individualId?: string | null;
  programId?: string | null;
  status?: "active" | "closed" | null;
  asOf?: string | null;
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
    where.push(`individual_id = $${params.length}`);
  }
  if (filters.programId) {
    if (!UUID.test(filters.programId)) return [];
    params.push(filters.programId);
    where.push(`program_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`period_status = $${params.length}`);
  }
  if (filters.asOf && /^\d{4}-\d{2}-\d{2}$/.test(filters.asOf)) {
    params.push(filters.asOf);
    where.push(`$${params.length}::date BETWEEN start_date AND end_date`);
  }

  const { rows } = await pool.query<ProgramBudgetRow>(
    `${PROGRAM_BUDGET_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY end_date, individual_name, program_name, budget_period_id`,
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
      WHERE budget_period_id = $1 AND program_id = $2`,
    [budgetPeriodId, programId],
  );
  return rows[0] ? toProgramBudget(rows[0]) : null;
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
