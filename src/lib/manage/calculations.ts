import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { computeCalculation, type CalculationInput, type CalculationResult } from "@/lib/business/calculation";

/**
 * Persistence for the Calculation workflow. Every saved calculation stores each
 * formula step's inputs and outputs (annual gross, monthly gross, cuts, clock
 * adjustment, final gross / net / After All) so the number can always be
 * explained. Revising supersedes the prior active calculation — history is
 * never overwritten — mirroring how authorizations revise.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export interface SaveCalculationInput extends CalculationInput {
  individualId: string;
  programId?: string | null;
  budgetPeriodId?: string | null;
  spreadsheetValue?: string | null;
  effectiveFrom?: string | null;
  notes?: string | null;
}

export interface CalculationRecord extends CalculationResult {
  id: string;
  individualId: string;
  programId: string | null;
  programCode: string | null;
  budgetPeriodId: string | null;
  months: number;
  basis: string;
  status: string;
  revision: number;
  spreadsheetValue: string | null;
  effectiveFrom: string | null;
  notes: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Run the engine without persisting — powers the live preview. */
export function previewCalculation(input: CalculationInput): CalculationResult {
  return computeCalculation(input);
}

/** Compute and save a calculation, superseding the prior active one for this individual+program. */
export async function saveCalculation(
  pool: PgLikePool,
  input: SaveCalculationInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(input.individualId)) return fail("validation", "Choose an individual.");
  if (input.programId && !isUuid(input.programId)) return fail("validation", "Invalid program.");

  const result = computeCalculation(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Supersede the current active calculation for the same (individual, program).
    const prior = await client.query<{ id: string; revision: number }>(
      `SELECT id, revision FROM budget_calculations
       WHERE individual_id = $1 AND status = 'active'
         AND (program_id IS NOT DISTINCT FROM $2)
       ORDER BY revision DESC LIMIT 1`,
      [input.individualId, input.programId ?? null],
    );
    const supersedesId = prior.rows[0]?.id ?? null;
    const revision = (prior.rows[0]?.revision ?? 0) + 1;
    if (supersedesId) {
      await client.query(`UPDATE budget_calculations SET status = 'superseded', updated_at = now() WHERE id = $1`, [supersedesId]);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO budget_calculations
        (individual_id, program_id, budget_period_id, annual_authorized_hours, annual_authorized_dollars,
         program_rate, individual_rate_override, effective_rate, months, annual_gross, monthly_gross,
         cut1_percent, cut1_amount, cut2_percent, cut2_amount, clock_adjustment, final_gross, final_net,
         after_all, agency_additional, basis, formula_version, spreadsheet_value, revision, supersedes_id,
         status, effective_from, notes, reason, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'v1',$22,$23,$24,'active',$25,$26,$27,$28)
       RETURNING id`,
      [
        input.individualId, input.programId ?? null, input.budgetPeriodId ?? null,
        input.annualAuthorizedHours ?? null, input.annualAuthorizedDollars ?? null,
        input.programRate ?? null, input.individualRateOverride ?? null, result.effectiveRate,
        Math.max(1, Math.floor(input.months ?? 12)), result.annualGross, result.monthlyGross,
        pctToFraction(input.cut1Percent), result.cut1Amount, pctToFraction(input.cut2Percent), result.cut2Amount,
        input.clockAdjustment ?? "0", result.finalGross, result.finalNet, result.afterAll, result.agencyAdditional,
        input.basis ?? "annual", input.spreadsheetValue ?? null, revision, supersedesId,
        input.effectiveFrom ?? null, input.notes ?? null, reason ?? null, actorId,
      ],
    );
    await client.query("COMMIT");
    await recordChange(pool, {
      actorId, action: "calculation_saved", entityType: "budget_calculation", entityId: rows[0]!.id,
      next: { individualId: input.individualId, programId: input.programId ?? null, revision, finalNet: result.finalNet },
      reason,
    });
    return ok({ id: rows[0]!.id });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return fail("validation", error instanceof Error ? error.message : "Could not save the calculation.");
  } finally {
    client.release();
  }
}

function pctToFraction(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const raw = String(v).trim().replace(/%$/, "");
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return (num > 1 ? num / 100 : num).toString();
}

/** Active calculations for an individual, plus the superseded history. */
export async function listCalculations(
  pool: PgLikePool,
  individualId: string,
): Promise<{ active: CalculationRow[]; history: CalculationRow[] }> {
  if (!isUuid(individualId)) return { active: [], history: [] };
  const { rows } = await pool.query<RawCalcRow>(
    `SELECT c.*, p.code AS program_code, u.display_name AS created_by
     FROM budget_calculations c
     LEFT JOIN programs p ON p.id = c.program_id
     LEFT JOIN users u ON u.id = c.created_by_user_id
     WHERE c.individual_id = $1
     ORDER BY (c.status = 'active') DESC, c.program_id NULLS FIRST, c.revision DESC`,
    [individualId],
  );
  const mapped = rows.map(toRow);
  return {
    active: mapped.filter((r) => r.status === "active"),
    history: mapped.filter((r) => r.status !== "active"),
  };
}

export interface CalculationRow {
  id: string;
  programId: string | null;
  programCode: string | null;
  status: string;
  revision: number;
  months: number;
  basis: string;
  annualGross: string | null;
  monthlyGross: string | null;
  cut1Amount: string | null;
  cut2Amount: string | null;
  clockAdjustment: string | null;
  finalGross: string | null;
  finalNet: string | null;
  afterAll: string | null;
  agencyAdditional: string | null;
  spreadsheetValue: string | null;
  effectiveFrom: string | null;
  notes: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface RawCalcRow {
  id: string; program_id: string | null; program_code: string | null; status: string; revision: number;
  months: number; basis: string; annual_gross: string | null; monthly_gross: string | null;
  cut1_amount: string | null; cut2_amount: string | null; clock_adjustment: string | null;
  final_gross: string | null; final_net: string | null; after_all: string | null; agency_additional: string | null;
  spreadsheet_value: string | null; effective_from: string | null; notes: string | null; reason: string | null;
  created_by: string | null; created_at: string;
}
function toRow(r: RawCalcRow): CalculationRow {
  return {
    id: r.id, programId: r.program_id, programCode: r.program_code, status: r.status, revision: r.revision,
    months: r.months, basis: r.basis, annualGross: r.annual_gross, monthlyGross: r.monthly_gross,
    cut1Amount: r.cut1_amount, cut2Amount: r.cut2_amount, clockAdjustment: r.clock_adjustment,
    finalGross: r.final_gross, finalNet: r.final_net, afterAll: r.after_all, agencyAdditional: r.agency_additional,
    spreadsheetValue: r.spreadsheet_value, effectiveFrom: r.effective_from, notes: r.notes, reason: r.reason,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}
