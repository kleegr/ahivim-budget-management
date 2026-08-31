import { agencyDate } from "@/lib/business/agency-time";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toMoney } from "@/lib/money";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

export type ManualIncomeSource = "class" | "reimbursement" | "custom_program" | "other";

export interface ProgramRevenueTerm {
  id: string;
  individualId: string;
  individualName: string;
  programId: string;
  programCode: string;
  programName: string;
  agencySharePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
  authorizedDollars: string | null;
  remainingDollars: string | null;
}

export interface EmployeeIndividualCompensationTerm {
  id: string;
  employeeId: string;
  employeeName: string;
  individualId: string;
  individualName: string;
  employeeSharePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
}

export interface ManualIncomeEntry {
  id: string;
  serviceDate: string;
  sourceType: ManualIncomeSource;
  individualId: string | null;
  individualName: string | null;
  programId: string | null;
  programCode: string | null;
  programName: string | null;
  grossAmount: string;
  agencySharePercent: string;
  agencyAmount: string;
  individualAmount: string;
  sourceRef: string | null;
  notes: string | null;
  status: "active" | "void";
  voidReason: string | null;
  programBudgetEventId: string | null;
  createdAt: string;
}

interface ProgramTermRow {
  id: string;
  individual_id: string;
  individual_name: string;
  program_id: string;
  program_code: string;
  program_name: string;
  agency_share_percent: string;
  effective_from: string;
  effective_to: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
  authorized_dollars: string | null;
  remaining_dollars: string | null;
}

interface CompensationTermRow {
  id: string;
  employee_id: string;
  employee_name: string;
  individual_id: string;
  individual_name: string;
  employee_share_percent: string;
  effective_from: string;
  effective_to: string | null;
  revision: number;
  status: "active" | "archived";
  notes: string | null;
}

interface ManualIncomeRow {
  id: string;
  service_date: string;
  source_type: ManualIncomeSource;
  individual_id: string | null;
  individual_name: string | null;
  program_id: string | null;
  program_code: string | null;
  program_name: string | null;
  gross_amount: string;
  agency_share_percent: string;
  agency_amount: string;
  individual_amount: string;
  source_ref: string | null;
  notes: string | null;
  status: "active" | "void";
  void_reason: string | null;
  program_budget_event_id: string | null;
  created_at: string;
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function previousDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

export function percentInputToFraction(value: unknown): string {
  const raw = String(value ?? "").trim().replace("%", "");
  if (!raw) return "0.000000";
  const parsed = dec(raw);
  const fraction = parsed.abs().greaterThan(1) ? parsed.dividedBy(100) : parsed;
  if (fraction.isNegative() || fraction.greaterThan(1)) {
    throw new RangeError("Percentage must be between 0% and 100%.");
  }
  return fraction.toDecimalPlaces(6).toFixed(6);
}

export function calculateRevenueSplit(
  grossAmount: string,
  agencyShareFraction: string,
): { grossAmount: string; agencyAmount: string; individualAmount: string } {
  const gross = dec(grossAmount);
  const share = dec(agencyShareFraction);
  if (!gross.isFinite() || !gross.greaterThan(0)) {
    throw new RangeError("Income amount must be greater than zero.");
  }
  if (!share.isFinite() || share.isNegative() || share.greaterThan(1)) {
    throw new RangeError("Agency share must be between 0% and 100%.");
  }
  const normalizedGross = toMoney(gross);
  const agencyAmount = toMoney(dec(normalizedGross).times(share));
  return {
    grossAmount: normalizedGross,
    agencyAmount,
    individualAmount: toMoney(dec(normalizedGross).minus(agencyAmount)),
  };
}

function checkedFraction(value: unknown, label: string): Result<string> {
  try {
    return ok(percentInputToFraction(value));
  } catch {
    return fail("validation", `${label} must be between 0% and 100%.`);
  }
}

function checkedMoney(value: unknown): Result<string> {
  try {
    const amount = dec(String(value ?? ""));
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      return fail("validation", "Income amount must be greater than zero.");
    }
    return ok(toMoney(amount));
  } catch {
    return fail("validation", "Enter a valid income amount.");
  }
}

async function inTransaction<T>(pool: PgLikePool, run: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function mapProgramTerm(row: ProgramTermRow): ProgramRevenueTerm {
  return {
    id: row.id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
    agencySharePercent: row.agency_share_percent,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    revision: row.revision,
    status: row.status,
    notes: row.notes,
    authorizedDollars: row.authorized_dollars === null ? null : toMoney(row.authorized_dollars),
    remainingDollars: row.remaining_dollars === null ? null : toMoney(row.remaining_dollars),
  };
}

function mapCompensationTerm(row: CompensationTermRow): EmployeeIndividualCompensationTerm {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    individualId: row.individual_id,
    individualName: row.individual_name,
    employeeSharePercent: row.employee_share_percent,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    revision: row.revision,
    status: row.status,
    notes: row.notes,
  };
}

function mapManualIncome(row: ManualIncomeRow): ManualIncomeEntry {
  return {
    id: row.id,
    serviceDate: row.service_date,
    sourceType: row.source_type,
    individualId: row.individual_id,
    individualName: row.individual_name,
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
    grossAmount: toMoney(row.gross_amount),
    agencySharePercent: row.agency_share_percent,
    agencyAmount: toMoney(row.agency_amount),
    individualAmount: toMoney(row.individual_amount),
    sourceRef: row.source_ref,
    notes: row.notes,
    status: row.status,
    voidReason: row.void_reason,
    programBudgetEventId: row.program_budget_event_id,
    createdAt: row.created_at,
  };
}

const PROGRAM_TERM_SELECT = `
  SELECT term.id, term.individual_id,
         COALESCE(individual.display_name, individual.normalized_name) AS individual_name,
         term.program_id, program.code AS program_code, program.name AS program_name,
         term.agency_share_percent::text, term.effective_from::text,
         term.effective_to::text, term.revision, term.status, term.notes,
         budget.authorized_dollars::text AS authorized_dollars,
         budget.remaining_dollars::text AS remaining_dollars
    FROM individual_program_revenue_terms term
    JOIN individuals individual ON individual.id = term.individual_id
    JOIN programs program ON program.id = term.program_id
    LEFT JOIN LATERAL (
      SELECT balance.authorized_dollars, balance.remaining_dollars
        FROM program_budget_balances balance
       WHERE balance.individual_id = term.individual_id
         AND balance.program_id = term.program_id
         AND timezone('America/New_York', now())::date BETWEEN balance.start_date AND balance.end_date
       ORDER BY balance.start_date DESC
       LIMIT 1
    ) budget ON true`;

const COMPENSATION_TERM_SELECT = `
  SELECT term.id, term.employee_id,
         COALESCE(employee.display_name, employee.normalized_name) AS employee_name,
         term.individual_id,
         COALESCE(individual.display_name, individual.normalized_name) AS individual_name,
         term.employee_share_percent::text, term.effective_from::text,
         term.effective_to::text, term.revision, term.status, term.notes
    FROM employee_individual_compensation_terms term
    JOIN employees employee ON employee.id = term.employee_id
    JOIN individuals individual ON individual.id = term.individual_id`;

const MANUAL_INCOME_SELECT = `
  SELECT entry.id, entry.service_date::text, entry.source_type,
         entry.individual_id,
         CASE WHEN individual.id IS NULL THEN NULL
              ELSE COALESCE(individual.display_name, individual.normalized_name) END AS individual_name,
         entry.program_id, program.code AS program_code, program.name AS program_name,
         entry.gross_amount::text, entry.agency_share_percent::text,
         entry.agency_amount::text, entry.individual_amount::text,
         entry.source_ref, entry.notes, entry.status, entry.void_reason,
         entry.program_budget_event_id, entry.created_at::text
    FROM agency_manual_income_entries entry
    LEFT JOIN individuals individual ON individual.id = entry.individual_id
    LEFT JOIN programs program ON program.id = entry.program_id`;

export async function listProgramRevenueTerms(
  db: Queryable,
  filters: { individualId?: string | null; includeArchived?: boolean } = {},
): Promise<ProgramRevenueTerm[]> {
  const params: unknown[] = [];
  const where = [filters.includeArchived ? "TRUE" : "term.status = 'active'"];
  if (filters.individualId) {
    if (!UUID.test(filters.individualId)) return [];
    params.push(filters.individualId);
    where.push(`term.individual_id = $${params.length}`);
  }
  const { rows } = await db.query<ProgramTermRow>(
    `${PROGRAM_TERM_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY individual_name, program_name, term.effective_from DESC`,
    params,
  );
  return rows.map(mapProgramTerm);
}

export async function listEmployeeIndividualCompensationTerms(
  db: Queryable,
  filters: { employeeId?: string | null; includeArchived?: boolean } = {},
): Promise<EmployeeIndividualCompensationTerm[]> {
  const params: unknown[] = [];
  const where = [filters.includeArchived ? "TRUE" : "term.status = 'active'"];
  if (filters.employeeId) {
    if (!UUID.test(filters.employeeId)) return [];
    params.push(filters.employeeId);
    where.push(`term.employee_id = $${params.length}`);
  }
  const { rows } = await db.query<CompensationTermRow>(
    `${COMPENSATION_TERM_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY employee_name, individual_name, term.effective_from DESC`,
    params,
  );
  return rows.map(mapCompensationTerm);
}

export async function listManualIncomeEntries(
  db: Queryable,
  filters: { from?: string | null; to?: string | null; includeVoided?: boolean } = {},
): Promise<ManualIncomeEntry[]> {
  const params: unknown[] = [];
  const where = [filters.includeVoided ? "TRUE" : "entry.status = 'active'"];
  if (filters.from && validDate(filters.from)) {
    params.push(filters.from);
    where.push(`entry.service_date >= $${params.length}::date`);
  }
  if (filters.to && validDate(filters.to)) {
    params.push(filters.to);
    where.push(`entry.service_date <= $${params.length}::date`);
  }
  const { rows } = await db.query<ManualIncomeRow>(
    `${MANUAL_INCOME_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY entry.service_date DESC, entry.created_at DESC, entry.id DESC`,
    params,
  );
  return rows.map(mapManualIncome);
}

interface EffectiveTermRow {
  id: string;
  agency_share_percent: string;
}

interface IncomeBudgetRow {
  authorization_id: string;
  budget_period_id: string;
  required_auth_type: string;
  consumption_source: string;
  authorized_dollars: string | null;
  consumed_dollars: string;
}

async function effectiveProgramTerm(
  db: Queryable,
  individualId: string,
  programId: string,
  asOf: string,
): Promise<EffectiveTermRow | null> {
  const { rows } = await db.query<EffectiveTermRow>(
    `SELECT id, agency_share_percent::text
       FROM individual_program_revenue_terms
      WHERE individual_id = $1 AND program_id = $2 AND status = 'active'
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [individualId, programId, asOf],
  );
  return rows[0] ?? null;
}

export interface SaveProgramRevenueTermInput {
  individualId: string;
  programId: string;
  agencySharePercent: unknown;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
  reason: string;
}

export async function saveProgramRevenueTerm(
  pool: PgLikePool,
  input: SaveProgramRevenueTermInput,
  actorId: string,
): Promise<Result<ProgramRevenueTerm>> {
  if (!UUID.test(input.individualId) || !UUID.test(input.programId)) {
    return fail("validation", "Choose an individual and a program.");
  }
  const share = checkedFraction(input.agencySharePercent, "Agency share");
  if (!share.ok) return share;
  const requestedEnd = input.effectiveTo?.trim() || null;
  if (!validDate(input.effectiveFrom) || (requestedEnd && !validDate(requestedEnd))) {
    return fail("validation", "Enter valid effective dates.");
  }
  if (requestedEnd && requestedEnd < input.effectiveFrom) {
    return fail("validation", "The ending date cannot be before the starting date.");
  }
  const reason = input.reason.trim();
  if (reason.length < 5) return fail("validation", "Give a short reason for this split.");

  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`agency-program-split:${input.individualId}:${input.programId}`],
    );
    const entities = await client.query<{ individual_exists: boolean; program_exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM individuals WHERE id = $1 AND status <> 'archived') AS individual_exists,
              EXISTS(SELECT 1 FROM programs WHERE id = $2 AND is_active) AS program_exists`,
      [input.individualId, input.programId],
    );
    if (!entities.rows[0]?.individual_exists || !entities.rows[0]?.program_exists) {
      return fail("not_found", "That individual or program is no longer active.");
    }
    const existing = await client.query<{
      id: string; effective_from: string; effective_to: string | null;
      agency_share_percent: string; revision: number; notes: string | null;
    }>(
      `SELECT id, effective_from::text, effective_to::text,
              agency_share_percent::text, revision, notes
         FROM individual_program_revenue_terms
        WHERE individual_id = $1 AND program_id = $2 AND status = 'active'
        ORDER BY effective_from FOR UPDATE`,
      [input.individualId, input.programId],
    );
    const same = existing.rows.find((row) => row.effective_from === input.effectiveFrom);
    const successor = existing.rows.find((row) => row.effective_from > input.effectiveFrom);
    const effectiveTo = requestedEnd ?? (successor ? previousDay(successor.effective_from) : null);
    if (successor && effectiveTo && effectiveTo >= successor.effective_from) {
      return fail("conflict", `This split overlaps the one beginning ${successor.effective_from}.`);
    }
    if (same) {
      const conflict = existing.rows.find((row) => row.id !== same.id
        && row.effective_from <= (effectiveTo ?? "9999-12-31")
        && (row.effective_to ?? "9999-12-31") >= input.effectiveFrom);
      if (conflict) return fail("conflict", `This split overlaps the one beginning ${conflict.effective_from}.`);
      await client.query(
        `UPDATE individual_program_revenue_terms
            SET agency_share_percent = $2, effective_to = $3::date, notes = $4,
                revision = revision + 1, updated_by_user_id = $5, updated_at = now()
          WHERE id = $1`,
        [same.id, share.data, effectiveTo, input.notes?.trim() || null, actorId],
      );
      await recordChange(client, {
        actorId,
        action: "program_revenue_split.updated",
        entityType: "individual_program_revenue_term",
        entityId: same.id,
        previous: same,
        next: { agencySharePercent: share.data, effectiveTo, notes: input.notes?.trim() || null },
        reason,
      });
      const updated = await client.query<ProgramTermRow>(
        `${PROGRAM_TERM_SELECT} WHERE term.id = $1`,
        [same.id],
      );
      return ok(mapProgramTerm(updated.rows[0]!));
    }

    const predecessor = [...existing.rows].reverse().find((row) => row.effective_from < input.effectiveFrom
      && (row.effective_to === null || row.effective_to >= input.effectiveFrom));
    if (predecessor) {
      const closedAt = previousDay(input.effectiveFrom);
      await client.query(
        `UPDATE individual_program_revenue_terms
            SET effective_to = $2::date, revision = revision + 1,
                updated_by_user_id = $3, updated_at = now()
          WHERE id = $1`,
        [predecessor.id, closedAt, actorId],
      );
      await recordChange(client, {
        actorId,
        action: "program_revenue_split.closed",
        entityType: "individual_program_revenue_term",
        entityId: predecessor.id,
        previous: predecessor,
        next: { effectiveTo: closedAt },
        reason,
      });
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO individual_program_revenue_terms
         (individual_id, program_id, agency_share_percent, effective_from, effective_to,
          notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $7)
       RETURNING id`,
      [input.individualId, input.programId, share.data, input.effectiveFrom, effectiveTo, input.notes?.trim() || null, actorId],
    );
    const id = inserted.rows[0]!.id;
    await recordChange(client, {
      actorId,
      action: "program_revenue_split.created",
      entityType: "individual_program_revenue_term",
      entityId: id,
      next: { ...input, agencySharePercent: share.data, effectiveTo },
      reason,
    });
    const created = await client.query<ProgramTermRow>(`${PROGRAM_TERM_SELECT} WHERE term.id = $1`, [id]);
    return ok(mapProgramTerm(created.rows[0]!));
  });
}

export interface SaveEmployeeIndividualCompensationInput {
  employeeId: string;
  individualId: string;
  employeeSharePercent: unknown;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
  reason: string;
}

export async function saveEmployeeIndividualCompensationTerm(
  pool: PgLikePool,
  input: SaveEmployeeIndividualCompensationInput,
  actorId: string,
): Promise<Result<EmployeeIndividualCompensationTerm>> {
  if (!UUID.test(input.employeeId) || !UUID.test(input.individualId)) {
    return fail("validation", "Choose an employee and an individual.");
  }
  const share = checkedFraction(input.employeeSharePercent, "Employee share");
  if (!share.ok) return share;
  const requestedEnd = input.effectiveTo?.trim() || null;
  if (!validDate(input.effectiveFrom) || (requestedEnd && !validDate(requestedEnd))) {
    return fail("validation", "Enter valid effective dates.");
  }
  if (requestedEnd && requestedEnd < input.effectiveFrom) {
    return fail("validation", "The ending date cannot be before the starting date.");
  }
  const reason = input.reason.trim();
  if (reason.length < 5) return fail("validation", "Give a short reason for this pay rule.");

  return inTransaction(pool, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`employee-individual-pay:${input.employeeId}:${input.individualId}`],
    );
    const entities = await client.query<{ employee_exists: boolean; individual_exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM employees WHERE id = $1 AND status <> 'archived') AS employee_exists,
              EXISTS(SELECT 1 FROM individuals WHERE id = $2 AND status <> 'archived') AS individual_exists`,
      [input.employeeId, input.individualId],
    );
    if (!entities.rows[0]?.employee_exists || !entities.rows[0]?.individual_exists) {
      return fail("not_found", "That employee or individual is no longer active.");
    }
    const existing = await client.query<{
      id: string; effective_from: string; effective_to: string | null;
      employee_share_percent: string; revision: number; notes: string | null;
    }>(
      `SELECT id, effective_from::text, effective_to::text,
              employee_share_percent::text, revision, notes
         FROM employee_individual_compensation_terms
        WHERE employee_id = $1 AND individual_id = $2 AND status = 'active'
        ORDER BY effective_from FOR UPDATE`,
      [input.employeeId, input.individualId],
    );
    const same = existing.rows.find((row) => row.effective_from === input.effectiveFrom);
    const successor = existing.rows.find((row) => row.effective_from > input.effectiveFrom);
    const effectiveTo = requestedEnd ?? (successor ? previousDay(successor.effective_from) : null);
    if (successor && effectiveTo && effectiveTo >= successor.effective_from) {
      return fail("conflict", `This pay rule overlaps the one beginning ${successor.effective_from}.`);
    }
    if (same) {
      const conflict = existing.rows.find((row) => row.id !== same.id
        && row.effective_from <= (effectiveTo ?? "9999-12-31")
        && (row.effective_to ?? "9999-12-31") >= input.effectiveFrom);
      if (conflict) return fail("conflict", `This pay rule overlaps the one beginning ${conflict.effective_from}.`);
      await client.query(
        `UPDATE employee_individual_compensation_terms
            SET employee_share_percent = $2, effective_to = $3::date, notes = $4,
                revision = revision + 1, updated_by_user_id = $5, updated_at = now()
          WHERE id = $1`,
        [same.id, share.data, effectiveTo, input.notes?.trim() || null, actorId],
      );
      await recordChange(client, {
        actorId,
        action: "employee_individual_pay.updated",
        entityType: "employee_individual_compensation_term",
        entityId: same.id,
        previous: same,
        next: { employeeSharePercent: share.data, effectiveTo, notes: input.notes?.trim() || null },
        reason,
      });
      const updated = await client.query<CompensationTermRow>(
        `${COMPENSATION_TERM_SELECT} WHERE term.id = $1`,
        [same.id],
      );
      return ok(mapCompensationTerm(updated.rows[0]!));
    }

    const predecessor = [...existing.rows].reverse().find((row) => row.effective_from < input.effectiveFrom
      && (row.effective_to === null || row.effective_to >= input.effectiveFrom));
    if (predecessor) {
      const closedAt = previousDay(input.effectiveFrom);
      await client.query(
        `UPDATE employee_individual_compensation_terms
            SET effective_to = $2::date, revision = revision + 1,
                updated_by_user_id = $3, updated_at = now()
          WHERE id = $1`,
        [predecessor.id, closedAt, actorId],
      );
      await recordChange(client, {
        actorId,
        action: "employee_individual_pay.closed",
        entityType: "employee_individual_compensation_term",
        entityId: predecessor.id,
        previous: predecessor,
        next: { effectiveTo: closedAt },
        reason,
      });
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO employee_individual_compensation_terms
         (employee_id, individual_id, employee_share_percent, effective_from, effective_to,
          notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $7)
       RETURNING id`,
      [input.employeeId, input.individualId, share.data, input.effectiveFrom, effectiveTo, input.notes?.trim() || null, actorId],
    );
    const id = inserted.rows[0]!.id;
    await recordChange(client, {
      actorId,
      action: "employee_individual_pay.created",
      entityType: "employee_individual_compensation_term",
      entityId: id,
      next: { ...input, employeeSharePercent: share.data, effectiveTo },
      reason,
    });
    const created = await client.query<CompensationTermRow>(`${COMPENSATION_TERM_SELECT} WHERE term.id = $1`, [id]);
    return ok(mapCompensationTerm(created.rows[0]!));
  });
}

export interface CreateManualIncomeInput {
  serviceDate: string;
  sourceType: ManualIncomeSource;
  individualId?: string | null;
  programId?: string | null;
  grossAmount: unknown;
  agencySharePercent?: unknown;
  sourceRef?: string | null;
  notes?: string | null;
  overBudgetOverrideReason?: string | null;
}

export async function createManualIncomeEntry(
  pool: PgLikePool,
  input: CreateManualIncomeInput,
  actorId: string,
): Promise<Result<ManualIncomeEntry>> {
  if (!validDate(input.serviceDate)) return fail("validation", "Enter a valid income date.");
  if (!(new Set<ManualIncomeSource>(["class", "reimbursement", "custom_program", "other"])).has(input.sourceType)) {
    return fail("validation", "Choose a valid income type.");
  }
  const gross = checkedMoney(input.grossAmount);
  if (!gross.ok) return gross;
  const individualId = input.individualId?.trim() || null;
  const programId = input.programId?.trim() || null;
  if ((individualId && !UUID.test(individualId)) || (programId && !UUID.test(programId))) {
    return fail("validation", "Choose a valid individual and program.");
  }
  if (input.sourceType === "custom_program" && (!individualId || !programId)) {
    return fail("validation", "Custom program income needs an individual and program.");
  }
  const sourceRef = input.sourceRef?.trim() || null;

  return inTransaction(pool, async (client) => {
    if (sourceRef) {
      const duplicate = await client.query<{ id: string }>(
        `SELECT id FROM agency_manual_income_entries
          WHERE source_type = $1 AND lower(btrim(source_ref)) = lower(btrim($2))
          LIMIT 1`,
        [input.sourceType, sourceRef],
      );
      if (duplicate.rows[0]) return fail("conflict", "That reference is already recorded.");
      if (input.sourceType === "class") {
        const invoice = await client.query<{ id: string }>(
          `SELECT id FROM class_invoices
            WHERE lower(invoice_number) = lower($1) AND status = 'issued' LIMIT 1`,
          [sourceRef],
        );
        if (invoice.rows[0]) {
          return fail("conflict", "That issued class invoice is already included automatically.");
        }
      }
    }

    if (individualId || programId) {
      const entity = await client.query<{ individual_exists: boolean; program_exists: boolean }>(
        `SELECT $1::uuid IS NULL OR EXISTS(
                  SELECT 1 FROM individuals WHERE id = $1 AND status <> 'archived'
                ) AS individual_exists,
                $2::uuid IS NULL OR EXISTS(
                  SELECT 1 FROM programs WHERE id = $2 AND is_active
                ) AS program_exists`,
        [individualId, programId],
      );
      if (!entity.rows[0]?.individual_exists || !entity.rows[0]?.program_exists) {
        return fail("not_found", "That individual or program is no longer active.");
      }
    }

    const term = individualId && programId
      ? await effectiveProgramTerm(client, individualId, programId, input.serviceDate)
      : null;
    if (input.sourceType === "custom_program" && !term) {
      return fail("conflict", "Set this individual's program split before recording the income.");
    }
    const requestedShare = input.agencySharePercent === undefined
      ? ok("1.000000")
      : checkedFraction(input.agencySharePercent, "Agency share");
    if (!requestedShare.ok) return requestedShare;
    const agencyShare = term?.agency_share_percent ?? requestedShare.data;
    const split = calculateRevenueSplit(gross.data, agencyShare);
    const agencyAmount = split.agencyAmount;
    const individualAmount = split.individualAmount;

    let budget: IncomeBudgetRow | null = null;
    if (individualId && programId) {
      const current = await client.query<IncomeBudgetRow>(
        `SELECT authorization_id, budget_period_id, required_auth_type,
                consumption_source, authorized_dollars::text, consumed_dollars::text
           FROM program_budget_balances
          WHERE individual_id = $1 AND program_id = $2
            AND $3::date BETWEEN start_date AND end_date
            AND period_status = 'active'
          ORDER BY start_date DESC
          LIMIT 1`,
        [individualId, programId, input.serviceDate],
      );
      budget = current.rows[0] ?? null;
      if (budget) {
        await client.query(`SELECT id FROM budget_authorizations WHERE id = $1 FOR UPDATE`, [budget.authorization_id]);
      }
    }
    if (input.sourceType === "custom_program"
        && (!budget || budget.authorized_dollars === null || budget.required_auth_type === "hours")) {
      return fail("conflict", "Add an active dollar budget for this individual and program first.");
    }
    const shouldPostBudget = budget !== null && budget.consumption_source !== "payroll";
    if (budget && shouldPostBudget && budget.authorized_dollars !== null) {
      const projected = dec(budget.consumed_dollars).plus(gross.data);
      if (projected.greaterThan(budget.authorized_dollars)
          && (input.overBudgetOverrideReason?.trim().length ?? 0) < 5) {
        return fail("conflict", "This income exceeds the authorized program budget. Add an override reason to continue.");
      }
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agency_manual_income_entries
         (service_date, source_type, individual_id, program_id, gross_amount,
          agency_share_percent, agency_amount, individual_amount, source_ref,
          notes, created_by_user_id)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.serviceDate,
        input.sourceType,
        individualId,
        programId,
        gross.data,
        agencyShare,
        agencyAmount,
        individualAmount,
        sourceRef,
        input.notes?.trim() || null,
        actorId,
      ],
    );
    const id = inserted.rows[0]!.id;
    let budgetEventId: string | null = null;
    if (shouldPostBudget && budget && individualId && programId) {
      const event = await client.query<{ id: string }>(
        `INSERT INTO program_budget_events
           (budget_period_id, individual_id, program_id, event_type, service_date,
            hours, amount, source_type, source_id, note, created_by_user_id)
         VALUES ($1, $2, $3, 'consume', $4::date, 0, $5,
                 'agency_manual_income', $6, $7, $8)
         RETURNING id`,
        [
          budget.budget_period_id,
          individualId,
          programId,
          input.serviceDate,
          gross.data,
          id,
          input.overBudgetOverrideReason?.trim() || input.notes?.trim() || "Recorded other income.",
          actorId,
        ],
      );
      budgetEventId = event.rows[0]!.id;
      await client.query(
        `UPDATE agency_manual_income_entries
            SET program_budget_event_id = $2, updated_at = now()
          WHERE id = $1`,
        [id, budgetEventId],
      );
    }
    await recordChange(client, {
      actorId,
      action: "agency_income.created",
      entityType: "agency_manual_income_entry",
      entityId: id,
      next: {
        serviceDate: input.serviceDate,
        sourceType: input.sourceType,
        individualId,
        programId,
        grossAmount: gross.data,
        agencySharePercent: agencyShare,
        agencyAmount,
        individualAmount,
        sourceRef,
        budgetEventId,
      },
      reason: input.notes?.trim() || input.overBudgetOverrideReason?.trim() || null,
    });
    const created = await client.query<ManualIncomeRow>(`${MANUAL_INCOME_SELECT} WHERE entry.id = $1`, [id]);
    return ok(mapManualIncome(created.rows[0]!));
  });
}

export async function voidManualIncomeEntry(
  pool: PgLikePool,
  id: string,
  actorId: string,
  reason: string,
): Promise<Result<ManualIncomeEntry>> {
  if (!UUID.test(id)) return fail("not_found", "That income entry no longer exists.");
  const finalReason = reason.trim();
  if (finalReason.length < 5) return fail("validation", "Give a reason for voiding this income.");
  return inTransaction(pool, async (client) => {
    const locked = await client.query<{
      id: string; status: "active" | "void"; program_budget_event_id: string | null;
    }>(
      `SELECT id, status, program_budget_event_id
         FROM agency_manual_income_entries WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const entry = locked.rows[0];
    if (!entry) return fail("not_found", "That income entry no longer exists.");
    if (entry.status === "void") {
      const existing = await client.query<ManualIncomeRow>(`${MANUAL_INCOME_SELECT} WHERE entry.id = $1`, [id]);
      return ok(mapManualIncome(existing.rows[0]!));
    }

    let reversalId: string | null = null;
    if (entry.program_budget_event_id) {
      const source = await client.query<{
        budget_period_id: string; individual_id: string; program_id: string;
        service_date: string; hours: string; amount: string;
      }>(
        `SELECT budget_period_id, individual_id, program_id, service_date::text,
                hours::text, amount::text
           FROM program_budget_events WHERE id = $1 FOR UPDATE`,
        [entry.program_budget_event_id],
      );
      const event = source.rows[0];
      if (!event) throw new Error("The linked program budget event is missing.");
      const reversal = await client.query<{ id: string }>(
        `INSERT INTO program_budget_events
           (budget_period_id, individual_id, program_id, event_type, service_date,
            hours, amount, source_type, source_id, reverses_event_id, note,
            created_by_user_id)
         VALUES ($1, $2, $3, 'reverse', $4::date, $5, $6,
                 'agency_manual_income', $7, $8, $9, $10)
         RETURNING id`,
        [
          event.budget_period_id,
          event.individual_id,
          event.program_id,
          event.service_date,
          dec(event.hours).negated().toString(),
          toMoney(dec(event.amount).negated()),
          id,
          entry.program_budget_event_id,
          finalReason,
          actorId,
        ],
      );
      reversalId = reversal.rows[0]!.id;
    }
    await client.query(
      `UPDATE agency_manual_income_entries
          SET status = 'void', void_reason = $2, voided_by_user_id = $3,
              voided_at = now(), program_budget_reversal_event_id = $4,
              updated_at = now()
        WHERE id = $1`,
      [id, finalReason, actorId, reversalId],
    );
    await recordChange(client, {
      actorId,
      action: "agency_income.voided",
      entityType: "agency_manual_income_entry",
      entityId: id,
      previous: { status: "active", programBudgetEventId: entry.program_budget_event_id },
      next: { status: "void", reversalId },
      reason: finalReason,
    });
    const updated = await client.query<ManualIncomeRow>(`${MANUAL_INCOME_SELECT} WHERE entry.id = $1`, [id]);
    return ok(mapManualIncome(updated.rows[0]!));
  });
}

export function defaultAgencyFinancialDate(): string {
  return agencyDate();
}
