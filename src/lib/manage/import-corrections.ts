import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { ahivimRowSchema, AHIVIM_POSITIONAL, type AhivimField, type AhivimRow } from "@/lib/excel/column-map";
import { normalizeAhivimDates } from "@/lib/excel/parse-workbook";
import { calculateInternalAmount, compareInternalAmounts, isAgencyPayee } from "@/lib/business/internal-rate";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import { buildGroupSignature, detectGroup, type GroupCandidateRow } from "@/lib/business/group-allocation";
import { transactionFingerprint } from "@/lib/business/fingerprint";
import { normalizePersonName } from "@/lib/business/name-matching";
import { normalizeProgramLabel } from "@/lib/business/program-normalization";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";
import { attributePayment } from "./payment-attribution";
import { acquireSettlementSourceLock } from "./settlement-freshness";
import { agencyDate } from "@/lib/business/agency-time";
import { canonicalServiceDate } from "@/lib/business/service-date";
import { closeEnough, dec, toHours, toMoney, tryDec } from "@/lib/money";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";

/**
 * Import-correction work-queue.
 *
 * A review surface over import_rows. The original source cells (raw_values) are
 * NEVER overwritten: field corrections are stored as a sparse patch in
 * corrected_values, and matching decisions live in the resolved_*_id columns.
 * Every change is audited (who / when / previous / new / reason). A held row is
 * allowed into the ledger only through `applyCorrectedImportRow`, which writes
 * the transaction, its single-person service allocation, warning resolution,
 * and batch totals in one transaction. Source cells are never overwritten.
 */

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const REVIEW_STATUSES = new Set(["needs_review", "valid", "invalid", "duplicate", "skipped", "imported"]);
const SOURCE_FIELDS = new Set<AhivimField>(Object.keys(AHIVIM_POSITIONAL) as AhivimField[]);

type ApplicationState = "ready" | "blocked" | "applied";

/** Historical corrections may use inactive people, but never archived ones. */
export function correctionPersonPickerFilter(): { includeArchived: false } {
  return { includeArchived: false };
}

export interface CorrectionRow {
  id: string;
  sourceRowNumber: number;
  sheetName: string;
  status: string;
  correctionStatus: string | null;
  raw: Record<string, unknown>;
  corrected: Record<string, unknown> | null;
  validationErrors: unknown;
  resolvedIndividualId: string | null;
  resolvedEmployeeId: string | null;
  resolvedProgramId: string | null;
  individualName: string | null;
  employeeName: string | null;
  programName: string | null;
  correctionReason: string | null;
  applicationState: ApplicationState;
  applicationMessage: string;
}

interface ParsedCorrectionSource {
  ok: true;
  row: AhivimRow;
  cells: Record<AhivimField, string>;
}

interface InvalidCorrectionSource {
  ok: false;
  message: string;
}

function sourceCells(
  rawValues: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const raw = rawValues?.raw;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : rawValues ?? {};
}

/** Build the would-be ledger row without ever modifying the stored source. */
export function parseCorrectedImportSource(
  rawValues: Record<string, unknown> | null | undefined,
  correctedValues: Record<string, unknown> | null | undefined,
): ParsedCorrectionSource | InvalidCorrectionSource {
  const merged = { ...sourceCells(rawValues), ...(correctedValues ?? {}) };
  const cells = {} as Record<AhivimField, string>;
  for (const field of SOURCE_FIELDS) {
    const value = merged[field];
    cells[field] = value == null ? "" : String(value).trim();
  }
  const normalized = { ...cells, ...normalizeAhivimDates(cells) };
  const parsed = ahivimRowSchema.safeParse(normalized);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".");
    return {
      ok: false,
      message: `${field ? `${field}: ` : ""}${first?.message ?? "The corrected source values are not valid."}`,
    };
  }
  for (const field of ["hours", "rate", "amount"] as const) {
    if (!parsed.data[field].trim() || tryDec(parsed.data[field]) === null) {
      return { ok: false, message: `${field}: enter a usable number.` };
    }
  }
  if (!dec(parsed.data.hours).greaterThan(0)) {
    return { ok: false, message: "hours: a single-person service row must be greater than zero." };
  }
  if (dec(parsed.data.rate).isNegative()) {
    return { ok: false, message: "rate: a single-person service rate cannot be negative." };
  }
  return { ok: true, row: parsed.data, cells };
}

function applicationReadiness(row: {
  status: string;
  raw_values: Record<string, unknown>;
  corrected_values: Record<string, unknown> | null;
  resolved_individual_id: string | null;
  resolved_employee_id: string | null;
  resolved_program_id: string | null;
}): { state: ApplicationState; message: string } {
  if (row.status === "imported") {
    return { state: "applied", message: "Applied to the ledger. Source history is now locked." };
  }
  if (row.status === "duplicate") {
    return { state: "blocked", message: "This row is marked as a duplicate and cannot be applied by itself." };
  }
  if (row.status === "skipped") {
    return { state: "blocked", message: "This row was explicitly skipped and remains outside the ledger." };
  }
  const missing = [
    !row.resolved_individual_id ? "individual" : null,
    !row.resolved_employee_id ? "employee" : null,
    !row.resolved_program_id ? "program" : null,
  ].filter(Boolean);
  if (missing.length) {
    return { state: "blocked", message: `Choose the ${missing.join(", ")} before applying this row.` };
  }
  const parsed = parseCorrectedImportSource(row.raw_values, row.corrected_values);
  if (!parsed.ok) return { state: "blocked", message: parsed.message };
  return {
    state: "ready",
    message: "Ready to create one ledger transaction and one single-person service allocation.",
  };
}

export interface CorrectionQueueFilter {
  status?: string;
  search?: string;
  rowId?: string;
  limit?: number;
  offset?: number;
  needingAttention?: boolean;
}

/** Rows in a batch, newest issues first. `needingAttention` limits to the ones a human still has to resolve. */
export async function listCorrectionQueue(
  pool: PgLikePool,
  batchId: string,
  filter: CorrectionQueueFilter = {},
): Promise<{ rows: CorrectionRow[]; total: number }> {
  if (!isUuid(batchId)) return { rows: [], total: 0 };
  const status = REVIEW_STATUSES.has(filter.status ?? "") ? filter.status! : null;
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);
  const offset = Math.max(0, filter.offset ?? 0);
  const attention = filter.needingAttention ?? false;
  const rowId = filter.rowId && isUuid(filter.rowId) ? filter.rowId : null;

  const where = `WHERE r.import_batch_id = $1
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.raw_values::text ILIKE $3)
       AND ($4::boolean IS NOT TRUE OR r.status IN ('needs_review','invalid'))
       AND ($5::uuid IS NULL OR r.id = $5)`;

  const { rows: countRows } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM import_rows r ${where}`,
    [batchId, status, search, attention, rowId],
  );

  const { rows } = await pool.query<{
    id: string; source_row_number: number; sheet_name: string; status: string;
    correction_status: string | null; raw_values: Record<string, unknown>;
    corrected_values: Record<string, unknown> | null; validation_errors: unknown;
    resolved_individual_id: string | null; resolved_employee_id: string | null; resolved_program_id: string | null;
    individual_name: string | null; employee_name: string | null; program_name: string | null;
    correction_reason: string | null;
  }>(
    `SELECT r.id, r.source_row_number, r.sheet_name, r.status, r.correction_status,
            r.raw_values, r.corrected_values, r.validation_errors,
            r.resolved_individual_id, r.resolved_employee_id, r.resolved_program_id,
            i.display_name AS individual_name, e.display_name AS employee_name, p.name AS program_name,
            r.correction_reason
     FROM import_rows r
     LEFT JOIN individuals i ON i.id = r.resolved_individual_id
     LEFT JOIN employees e ON e.id = r.resolved_employee_id
     LEFT JOIN programs p ON p.id = r.resolved_program_id
     ${where}
     ORDER BY (r.status IN ('needs_review','invalid')) DESC, r.source_row_number
     LIMIT $6 OFFSET $7`,
    [batchId, status, search, attention, rowId, limit, offset],
  );

  return {
    total: Number(countRows[0]?.c ?? 0),
    rows: rows.map((r) => {
      const readiness = applicationReadiness(r);
      return {
        id: r.id,
        sourceRowNumber: r.source_row_number,
        sheetName: r.sheet_name,
        status: r.status,
        correctionStatus: r.correction_status,
        raw: r.raw_values ?? {},
        corrected: r.corrected_values,
        validationErrors: r.validation_errors,
        resolvedIndividualId: r.resolved_individual_id,
        resolvedEmployeeId: r.resolved_employee_id,
        resolvedProgramId: r.resolved_program_id,
        individualName: r.individual_name,
        employeeName: r.employee_name,
        programName: r.program_name,
        correctionReason: r.correction_reason,
        applicationState: readiness.state,
        applicationMessage: readiness.message,
      };
    }),
  };
}

type PgQueryable = Pick<PgLikePool, "query">;

async function getRow(db: PgQueryable, rowId: string, lock = false) {
  const { rows } = await db.query<{
    id: string; status: string; corrected_values: Record<string, unknown> | null;
    resolved_individual_id: string | null; resolved_employee_id: string | null; resolved_program_id: string | null;
    transaction_id: string | null;
  }>(
    `SELECT r.id, r.status, r.corrected_values, r.resolved_individual_id,
            r.resolved_employee_id, r.resolved_program_id,
            (SELECT t.id FROM payroll_transactions t WHERE t.import_row_id = r.id LIMIT 1) AS transaction_id
       FROM import_rows r WHERE r.id = $1${lock ? " FOR UPDATE" : ""}`,
    [rowId],
  );
  return rows[0] ?? null;
}

function ensureHeldRow(row: Awaited<ReturnType<typeof getRow>>): Result<null> {
  if (!row) return fail("not_found", "That row no longer exists.");
  if (row.transaction_id || row.status === "imported") {
    return fail(
      "immutable",
      "This source row is already in the ledger. Source corrections cannot edit an existing transaction.",
    );
  }
  return ok(null);
}

/** Store a { field: value } correction patch. raw_values is left untouched. */
export async function correctRowFields(
  pool: PgLikePool,
  rowId: string,
  patch: Record<string, unknown>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (typeof k === "string" && k.trim()) cleaned[k.trim()] = v;
  }
  if (Object.keys(cleaned).length === 0) return fail("validation", "Provide at least one field to correct.");
  const unknownFields = Object.keys(cleaned).filter((field) => !SOURCE_FIELDS.has(field as AhivimField));
  if (unknownFields.length) {
    return fail("validation", `Choose a supported source field. Unknown: ${unknownFields.join(", ")}.`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await getRow(client, rowId, true);
    const editable = ensureHeldRow(before);
    if (!editable.ok) {
      await client.query("ROLLBACK");
      return editable;
    }

    const merged = { ...(before.corrected_values ?? {}), ...cleaned };
    const saved = await client.query<{ corrected_values: Record<string, unknown> }>(
      `UPDATE import_rows
         SET corrected_values = COALESCE(corrected_values, '{}'::jsonb) || $2::jsonb,
             correction_status = 'corrected', corrected_by_user_id = $3,
             corrected_at = now(), correction_reason = $4, updated_at = now()
       WHERE id = $1 AND status <> 'imported'
         AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)
       RETURNING corrected_values`,
      [rowId, JSON.stringify(cleaned), actorId, reason ?? null],
    );
    if (!saved.rowCount) {
      await client.query("ROLLBACK");
      return fail("immutable", "This source row entered the ledger before the correction was saved. Its source history was not changed.");
    }
    await recordChange(client, {
      actorId, action: "import_row_corrected", entityType: "import_row", entityId: rowId,
      previous: { corrected: before.corrected_values ?? null },
      next: { corrected: saved.rows[0]?.corrected_values ?? merged }, reason,
    });
    await client.query("COMMIT");
    return ok({ id: rowId });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original database error. */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Clear all field corrections on a row (matching decisions are left as-is). */
export async function resetRowCorrection(
  pool: PgLikePool,
  rowId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await getRow(client, rowId, true);
    const editable = ensureHeldRow(before);
    if (!editable.ok) {
      await client.query("ROLLBACK");
      return editable;
    }
    const reset = await client.query(
      `UPDATE import_rows
         SET corrected_values = NULL, correction_status = NULL,
             corrected_by_user_id = $2, corrected_at = now(), correction_reason = $3, updated_at = now()
       WHERE id = $1 AND status <> 'imported'
         AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)`,
      [rowId, actorId, reason ?? null],
    );
    if (!reset.rowCount) {
      await client.query("ROLLBACK");
      return fail("immutable", "This source row entered the ledger before the reset was saved. Its source history was not changed.");
    }
    await recordChange(client, {
      actorId, action: "import_row_correction_reset", entityType: "import_row", entityId: rowId,
      previous: { corrected: before.corrected_values ?? null }, reason,
    });
    await client.query("COMMIT");
    return ok({ id: rowId });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original database error. */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Set / change the canonical match for a row. Pass null to clear a field. */
export async function resolveRowMatch(
  pool: PgLikePool,
  rowId: string,
  match: { individualId?: string | null; employeeId?: string | null; programId?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const setInd = match.individualId !== undefined;
  const setEmp = match.employeeId !== undefined;
  const setProg = match.programId !== undefined;
  for (const [flag, val, label] of [
    [setInd, match.individualId, "individual"],
    [setEmp, match.employeeId, "employee"],
    [setProg, match.programId, "program"],
  ] as const) {
    if (flag && val != null && !isUuid(val)) return fail("validation", `Choose a valid ${label}.`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await getRow(client, rowId, true);
    const editable = ensureHeldRow(before);
    if (!editable.ok) {
      await client.query("ROLLBACK");
      return editable;
    }
    const resolved = await client.query(
      `UPDATE import_rows SET
         resolved_individual_id = CASE WHEN $2 THEN $3::uuid ELSE resolved_individual_id END,
         resolved_employee_id   = CASE WHEN $4 THEN $5::uuid ELSE resolved_employee_id END,
         resolved_program_id    = CASE WHEN $6 THEN $7::uuid ELSE resolved_program_id END,
         updated_at = now()
       WHERE id = $1 AND status <> 'imported'
         AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)`,
      [
        rowId,
        setInd, match.individualId ?? null,
        setEmp, match.employeeId ?? null,
        setProg, match.programId ?? null,
      ],
    );
    if (!resolved.rowCount) {
      await client.query("ROLLBACK");
      return fail("immutable", "This source row entered the ledger before the match was saved. Its source history was not changed.");
    }
    await recordChange(client, {
      actorId, action: "import_row_rematched", entityType: "import_row", entityId: rowId,
      previous: {
        individualId: before.resolved_individual_id,
        employeeId: before.resolved_employee_id,
        programId: before.resolved_program_id,
      },
      next: match, reason,
    });
    await client.query("COMMIT");
    return ok({ id: rowId });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original database error. */ }
    throw error;
  } finally {
    client.release();
  }
}

interface ApplyRowRecord {
  id: string;
  import_batch_id: string;
  batch_status: string;
  source_file_id: string;
  source_row_number: number;
  status: string;
  raw_values: Record<string, unknown>;
  corrected_values: Record<string, unknown> | null;
  resolved_individual_id: string | null;
  resolved_employee_id: string | null;
  resolved_program_id: string | null;
  individual_name: string | null;
  individual_key: string | null;
  individual_status: string | null;
  employee_name: string | null;
  employee_key: string | null;
  employee_status: string | null;
  program_code: string | null;
  program_name: string | null;
  program_active: boolean | null;
}

interface ApplyCorrectedRowOptions {
  rememberProgramAlias?: boolean;
  reason?: string | null;
}

export interface AppliedCorrectedRow {
  rowId: string;
  transactionId: string;
  serviceSessionId: string;
  alreadyApplied: boolean;
  rateExceptionId: string | null;
}

async function rejectApply(
  client: PgLikeClient,
  code: "not_found" | "conflict" | "validation" | "immutable",
  message: string,
): Promise<Result<AppliedCorrectedRow>> {
  await client.query("ROLLBACK");
  return fail(code, message);
}

function groupCandidate(
  importRowId: string,
  sourceRowNumber: number,
  row: AhivimRow,
  employeeKey: string,
  programKey: string,
  individualKey: string,
  expectedBaseRates: string[] = [],
): GroupCandidateRow {
  return {
    importRowId,
    sourceRowNumber,
    individualKey,
    employeeKey,
    programKey,
    checkNumber: row.checkNumber || null,
    checkDate: row.checkDate || null,
    periodBegin: row.periodBegin || null,
    periodEnd: row.periodEnd || null,
    hours: row.hours,
    rate: row.rate,
    amount: row.amount,
    expectedBaseRates,
  };
}

/**
 * Apply one previously-held source row to the financial ledger.
 *
 * The source row lock is the idempotency boundary. A concurrent retry sees the
 * transaction created by the first request and returns its id without writing
 * a second transaction. Group-shaped and natural-key duplicate rows are
 * deliberately refused; this operation is only for a genuine one-person row.
 */
export async function applyCorrectedImportRow(
  pool: PgLikePool,
  rowId: string,
  actorId: string | null,
  options: ApplyCorrectedRowOptions = {},
): Promise<Result<AppliedCorrectedRow>> {
  if (!isUuid(rowId)) return fail("not_found", "That source row no longer exists.");
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    // This must precede every source-row lock: settlement refresh/actions take
    // the same advisory lock before touching their own rows.
    await acquireSettlementSourceLock(client);

    const locked = await client.query<ApplyRowRecord>(
      `SELECT r.id, r.import_batch_id, b.status AS batch_status,
              b.imported_file_id AS source_file_id, r.source_row_number,
              r.status, r.raw_values, r.corrected_values,
              r.resolved_individual_id, r.resolved_employee_id, r.resolved_program_id,
              i.display_name AS individual_name, i.normalized_name AS individual_key,
              i.status AS individual_status,
              e.display_name AS employee_name, e.normalized_name AS employee_key,
              e.status AS employee_status,
              p.code AS program_code, p.name AS program_name, p.is_active AS program_active
         FROM import_rows r
         JOIN import_batches b ON b.id = r.import_batch_id
         LEFT JOIN individuals i ON i.id = r.resolved_individual_id
         LEFT JOIN employees e ON e.id = r.resolved_employee_id
         LEFT JOIN programs p ON p.id = r.resolved_program_id
        WHERE r.id = $1
        FOR UPDATE OF r`,
      [rowId],
    );
    const source = locked.rows[0];
    if (!source) {
      finished = true;
      return rejectApply(client, "not_found", "That source row no longer exists.");
    }

    const existing = await client.query<{
      id: string;
      service_session_id: string | null;
      has_allocation: boolean;
    }>(
      `SELECT t.id, t.service_session_id,
              EXISTS (
                SELECT 1 FROM service_allocations a
                 WHERE a.payroll_transaction_id = t.id
              ) AS has_allocation
         FROM payroll_transactions t
        WHERE t.import_row_id = $1
        LIMIT 1`,
      [rowId],
    );
    if (existing.rows[0]) {
      if (
        source.status !== "imported"
        || !existing.rows[0].service_session_id
        || !existing.rows[0].has_allocation
      ) {
        finished = true;
        return rejectApply(
          client,
          "conflict",
          "A ledger transaction already points to this source row, but its source status or service allocation is incomplete. Nothing was changed; an administrator must review it.",
        );
      }
      await client.query("COMMIT");
      finished = true;
      return ok({
        rowId,
        transactionId: existing.rows[0].id,
        serviceSessionId: existing.rows[0].service_session_id,
        alreadyApplied: true,
        rateExceptionId: null,
      });
    }
    if (source.batch_status !== "committed") {
      finished = true;
      return rejectApply(client, "conflict", "Commit this import before applying a corrected row.");
    }
    if (source.status === "duplicate") {
      finished = true;
      return rejectApply(
        client,
        "conflict",
        "This source row is marked as a duplicate. It must stay in review and cannot be applied alone.",
      );
    }
    if (source.status === "imported") {
      finished = true;
      return rejectApply(
        client,
        "immutable",
        "This row says it was imported but has no linked ledger transaction. Keep it in review for an administrator.",
      );
    }
    if (source.status === "skipped") {
      finished = true;
      return rejectApply(client, "conflict", "This source row was explicitly skipped and cannot be applied.");
    }
    if (!source.resolved_individual_id || !source.individual_name || !source.individual_key) {
      finished = true;
      return rejectApply(client, "validation", "Choose an active individual before applying this row.");
    }
    if (!source.resolved_employee_id || !source.employee_name || !source.employee_key) {
      finished = true;
      return rejectApply(client, "validation", "Choose an active employee before applying this row.");
    }
    if (!source.resolved_program_id || !source.program_code || !source.program_name) {
      finished = true;
      return rejectApply(client, "validation", "Choose an active program before applying this row.");
    }
    if (source.individual_status === "archived" || source.employee_status === "archived" || !source.program_active) {
      finished = true;
      return rejectApply(
        client,
        "validation",
        "The selected people must not be archived, and the selected program must be active.",
      );
    }

    const parsed = parseCorrectedImportSource(source.raw_values, source.corrected_values);
    if (!parsed.ok) {
      finished = true;
      return rejectApply(client, "validation", `The source row is not ready: ${parsed.message}`);
    }
    const row = parsed.row;

    const serviceDate = canonicalServiceDate(row);
    // Normal workbook staging resolves its rate catalog as of the agency's
    // current business date. When a source row has none of the three immutable
    // service-date facts, use that same rate-only fallback; the transaction's
    // dates remain null, so utilization never invents an ingestion date.
    const rateDate = serviceDate ?? agencyDate();
    const rateResult = await client.query<{
      agency_rate: string | null;
      internal_rate: string;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT agency_rate::text, internal_rate::text,
              effective_from::text, effective_to::text
         FROM program_rate_schedules
        WHERE program_id = $1`,
      [source.resolved_program_id],
    );
    const configuredRate = resolveEffectiveRate(
      rateResult.rows.map((rate) => ({
        agencyRate: rate.agency_rate,
        internalRate: rate.internal_rate,
        effectiveFrom: rate.effective_from,
        effectiveTo: rate.effective_to,
      })),
      rateDate,
    );
    if (isAgencyPayee(row.payTo) && !configuredRate) {
      finished = true;
      return rejectApply(
        client,
        "validation",
        `No rate schedule is in force for ${source.program_name} on ${rateDate}. Add the rate before applying this row.`,
      );
    }

    const targetGroup = groupCandidate(
      rowId,
      source.source_row_number,
      row,
      source.resolved_employee_id,
      source.resolved_program_id,
      source.resolved_individual_id,
      configuredRate
        ? [configuredRate.internalRate, ...(configuredRate.agencyRate ? [configuredRate.agencyRate] : [])]
        : [],
    );
    const targetSignature = buildGroupSignature(targetGroup);
    const targetShapeSignature = buildGroupSignature({
      ...targetGroup,
      employeeKey: "same-employee",
      programKey: "same-program",
    });
    const siblings = await client.query<{
      id: string;
      source_row_number: number;
      raw_values: Record<string, unknown>;
      corrected_values: Record<string, unknown> | null;
      resolved_individual_id: string | null;
      resolved_employee_id: string | null;
      resolved_program_id: string | null;
    }>(
      `SELECT id, source_row_number, raw_values, corrected_values,
              resolved_individual_id, resolved_employee_id, resolved_program_id
         FROM import_rows
        WHERE import_batch_id = $1 AND id <> $2`,
      [source.import_batch_id, rowId],
    );
    for (const sibling of siblings.rows) {
      const siblingParsed = parseCorrectedImportSource(sibling.raw_values, sibling.corrected_values);
      if (!siblingParsed.ok) continue;
      const candidate = groupCandidate(
        sibling.id,
        sibling.source_row_number,
        siblingParsed.row,
        sibling.resolved_employee_id ?? normalizePersonName(siblingParsed.row.employee),
        sibling.resolved_program_id ?? normalizeProgramLabel(siblingParsed.row.programDescription),
        sibling.resolved_individual_id ?? normalizePersonName(siblingParsed.row.individual),
      );
      const canonicalSignatureMatches = buildGroupSignature(candidate) === targetSignature;
      const shapeSignatureMatches = buildGroupSignature({
        ...candidate,
        employeeKey: "same-employee",
        programKey: "same-program",
      }) === targetShapeSignature;
      if (!canonicalSignatureMatches && !shapeSignatureMatches) continue;

      const knownEmployeeConflict = sibling.resolved_employee_id !== null
        && sibling.resolved_employee_id !== source.resolved_employee_id;
      const knownProgramConflict = sibling.resolved_program_id !== null
        && sibling.resolved_program_id !== source.resolved_program_id;
      if (knownEmployeeConflict || knownProgramConflict) continue;

      if (!sibling.resolved_employee_id || !sibling.resolved_program_id) {
        finished = true;
        return rejectApply(
          client,
          "conflict",
          "Another unresolved source row has the same check, period, hours, and rate. Resolve its employee and program first so these rows can be ruled in or out as one group session.",
        );
      }
      const sameIndividual = candidate.individualKey === targetGroup.individualKey;
      finished = true;
      return rejectApply(
        client,
        "conflict",
        sameIndividual
          ? "Another source row has the same transaction identity. Keep this row in review until the duplicate is confirmed."
          : "Other source rows share this employee, program, check, period, hours, and rate. They may be one group session, so this row cannot be applied alone. Resolve the rows together in Group review.",
      );
    }

    const fingerprint = transactionFingerprint({
      checkNumber: row.checkNumber || null,
      checkDate: row.checkDate || null,
      employeeKey: source.employee_key,
      individualKey: source.individual_key,
      programKey: source.program_code,
      periodBegin: row.periodBegin || null,
      periodEnd: row.periodEnd || null,
      hours: row.hours,
      rate: row.rate,
      amount: row.amount,
    });
    const duplicate = await client.query<{ id: string }>(
      `SELECT t.id
         FROM payroll_transactions t
        WHERE t.transaction_fingerprint = $1
           OR (
             t.individual_id = $2 AND t.employee_id = $3 AND t.program_id = $4
             AND NULLIF(btrim(t.check_number), '') IS NOT DISTINCT FROM NULLIF(btrim($5), '')
             AND t.check_date IS NOT DISTINCT FROM $6::date
             AND t.period_begin IS NOT DISTINCT FROM $7::date
             AND t.period_end IS NOT DISTINCT FROM $8::date
           )
        LIMIT 1`,
      [
        fingerprint,
        source.resolved_individual_id,
        source.resolved_employee_id,
        source.resolved_program_id,
        row.checkNumber || null,
        row.checkDate || null,
        row.periodBegin || null,
        row.periodEnd || null,
      ],
    );
    if (duplicate.rows[0]) {
      finished = true;
      return rejectApply(
        client,
        "conflict",
        "A ledger transaction already has this person, employee, program, check, and pay period. Keep this row in review as a possible duplicate.",
      );
    }

    const aliasText = row.programDescription.trim();
    const normalizedAlias = normalizeProgramLabel(aliasText);
    let aliasCreated = false;
    if (options.rememberProgramAlias && normalizedAlias) {
      const priorAlias = await client.query<{ program_id: string }>(
        `SELECT program_id FROM program_aliases WHERE normalized_alias = $1 FOR UPDATE`,
        [normalizedAlias],
      );
      if (priorAlias.rows[0] && priorAlias.rows[0].program_id !== source.resolved_program_id) {
        finished = true;
        return rejectApply(
          client,
          "conflict",
          "That program spelling is already approved for a different program. The row remains in review.",
        );
      }
      aliasCreated = !priorAlias.rows[0];
    }

    const internal = calculateInternalAmount({
      payTo: row.payTo,
      importedAmount: row.amount,
      agencyRate: configuredRate?.agencyRate ?? null,
      internalRate: configuredRate?.internalRate ?? null,
      hours: row.hours,
      rowRate: row.rate,
    });
    const spreadsheetInternal = row.calculatedInternalAmount
      ? toMoney(row.calculatedInternalAmount)
      : null;
    const comparison = compareInternalAmounts(spreadsheetInternal, internal.internalAmount);
    const attribution = attributePayment({
      payToRaw: row.payTo,
      employeeName: source.employee_name,
      importedAmount: row.amount,
      internalAmount: internal.internalAmount,
    });
    const single = detectGroup([targetGroup]);

    const session = await client.query<{ id: string }>(
      `INSERT INTO service_sessions
         (import_batch_id, employee_id, program_id, check_number, period_begin, period_end,
          physical_hours, group_size, combined_rate, combined_amount, base_individual_rate,
          group_detection_status, detection_rule, detection_signature, confidence,
          validation_result, warning_reason, source_row_refs)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,1,$8,$9,$8,
               'single',$10,$11,$12,$13::jsonb,NULL,$14::jsonb)
       RETURNING id`,
      [
        source.import_batch_id,
        source.resolved_employee_id,
        source.resolved_program_id,
        row.checkNumber || null,
        row.periodBegin || null,
        row.periodEnd || null,
        toHours(row.hours),
        toMoney(row.rate),
        single.combinedAmount,
        single.detectionRule,
        single.signature,
        single.confidence,
        JSON.stringify(single.validation),
        JSON.stringify([source.source_row_number]),
      ],
    );
    const serviceSessionId = session.rows[0].id;

    const payrollCheck = await client.query<{ id: string }>(
      `SELECT id
         FROM employee_payroll_checks
        WHERE employee_id = $1 AND verification_status <> 'void'
          AND NULLIF(btrim(check_number), '') IS NOT DISTINCT FROM NULLIF(btrim($2), '')
          AND check_date IS NOT DISTINCT FROM $3::date
          AND period_begin IS NOT DISTINCT FROM $4::date
          AND period_end IS NOT DISTINCT FROM $5::date
        ORDER BY (verification_status = 'verified') DESC, updated_at DESC
        LIMIT 1`,
      [
        source.resolved_employee_id,
        row.checkNumber || null,
        row.checkDate || null,
        row.periodBegin || null,
        row.periodEnd || null,
      ],
    );

    const transaction = await client.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          pay_to_raw, check_number, check_date, period_begin, period_end,
          individual_id, employee_id, program_id, payroll_check_id,
          individual_raw, employee_raw, program_raw,
          imported_hours, imported_rate, imported_amount, total_net_pay,
          spreadsheet_internal_amount, calculated_internal_amount,
          internal_rate_applied, agency_rate_applied, internal_amount_mismatch,
          agency_additional_amount, employee_payment_amount, payment_recipient,
          transaction_fingerprint, duplicate_status, is_group_service, service_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9::date,
               $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,'new',false,$30)
       RETURNING id`,
      [
        source.import_batch_id,
        rowId,
        source.source_file_id,
        source.source_row_number,
        row.payTo || null,
        row.checkNumber || null,
        row.checkDate || null,
        row.periodBegin || null,
        row.periodEnd || null,
        source.resolved_individual_id,
        source.resolved_employee_id,
        source.resolved_program_id,
        payrollCheck.rows[0]?.id ?? null,
        row.individual,
        row.employee || null,
        row.programDescription,
        toHours(row.hours),
        toMoney(row.rate),
        toMoney(row.amount),
        row.totalNetPay ? toMoney(row.totalNetPay) : null,
        spreadsheetInternal,
        internal.internalAmount,
        configuredRate ? toMoney(configuredRate.internalRate) : null,
        configuredRate?.agencyRate ? toMoney(configuredRate.agencyRate) : null,
        !comparison.matches,
        attribution.agencyAdditional,
        attribution.employeePayment,
        attribution.recipient,
        fingerprint,
        serviceSessionId,
      ],
    );
    const transactionId = transaction.rows[0].id;
    const allocation = single.allocations[0];
    await client.query(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, payroll_transaction_id,
          allocation_hours, allocated_rate, allocated_amount, rounding_adjustment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        serviceSessionId,
        source.resolved_individual_id,
        transactionId,
        allocation.allocationHours,
        allocation.allocatedRate,
        allocation.allocatedAmount,
        allocation.roundingAdjustment,
      ],
    );

    let rateExceptionId: string | null = null;
    if (configuredRate) {
      const onInternal = closeEnough(row.rate, configuredRate.internalRate, "0.005");
      const onAgency = configuredRate.agencyRate !== null
        && closeEnough(row.rate, configuredRate.agencyRate, "0.005");
      if (!onInternal && !onAgency) {
        const evaluated = evaluateRateException({
          importedRate: row.rate,
          expectedRate: configuredRate.internalRate,
        });
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO rate_exceptions
             (import_batch_id, payroll_transaction_id, individual_id, program_id,
              imported_rate, expected_rate, variance_amount, variance_percent, direction, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            source.import_batch_id,
            transactionId,
            source.resolved_individual_id,
            source.resolved_program_id,
            evaluated.importedRate,
            evaluated.expectedRate,
            evaluated.varianceAmount,
            evaluated.variancePercent,
            evaluated.direction === "match" ? "higher" : evaluated.direction,
            evaluated.summary,
          ],
        );
        rateExceptionId = inserted.rows[0].id;
      }
    }

    if (options.rememberProgramAlias && normalizedAlias) {
      await client.query(
        `INSERT INTO program_aliases (program_id, normalized_alias, source_text, status)
         VALUES ($1,$2,$3,'approved')
         ON CONFLICT (normalized_alias) DO UPDATE
           SET source_text = EXCLUDED.source_text, status = 'approved', updated_at = now()
         WHERE program_aliases.program_id = EXCLUDED.program_id`,
        [source.resolved_program_id, normalizedAlias, aliasText],
      );
      if (aliasCreated) {
        await recordChange(client, {
          actorId,
          action: "program_alias.approved_from_import",
          entityType: "program",
          entityId: source.resolved_program_id,
          next: { normalizedAlias, sourceText: aliasText, programCode: source.program_code },
          reason: options.reason,
        });
      }
    }

    await client.query(
      `UPDATE import_rows
          SET status = 'imported', validation_errors = NULL,
              transaction_fingerprint = $2, correction_status = 'applied',
              corrected_by_user_id = $3, corrected_at = now(),
              correction_reason = $4, updated_at = now()
        WHERE id = $1`,
      [rowId, fingerprint, actorId, options.reason ?? null],
    );
    await client.query(
      `UPDATE import_warnings
          SET resolved_at = now(), resolved_by_user_id = $2, updated_at = now()
        WHERE import_row_id = $1 AND resolved_at IS NULL`,
      [rowId, actorId],
    );
    await client.query(
      `WITH refreshed AS (
         SELECT b.id,
                (SELECT count(*)::int FROM import_rows r WHERE r.import_batch_id = b.id AND r.status = 'imported') AS valid_rows,
                (SELECT count(*)::int FROM payroll_transactions t WHERE t.import_batch_id = b.id) AS imported_rows,
                (SELECT count(*)::int FROM import_rows r WHERE r.import_batch_id = b.id AND r.status <> 'imported') AS skipped_rows,
                (SELECT count(*)::int FROM import_rows r WHERE r.import_batch_id = b.id AND r.status = 'duplicate') AS duplicate_rows,
                (SELECT count(DISTINCT w.import_row_id)::int FROM import_warnings w WHERE w.import_batch_id = b.id) AS warning_rows,
                (SELECT count(*)::int FROM import_rows r WHERE r.import_batch_id = b.id AND r.status = 'invalid') AS error_rows,
                (SELECT COALESCE(sum(t.imported_amount), 0) FROM payroll_transactions t WHERE t.import_batch_id = b.id) AS imported_agency,
                (SELECT COALESCE(sum(t.calculated_internal_amount), 0) FROM payroll_transactions t WHERE t.import_batch_id = b.id) AS imported_internal,
                duplicate_totals.agency AS duplicate_agency,
                duplicate_totals.internal AS duplicate_internal,
                b.source_agency_gross, b.source_internal_amount, b.reconciliation_notes
           FROM import_batches b
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum(existing.imported_amount), 0) AS agency,
                    COALESCE(sum(existing.calculated_internal_amount), 0) AS internal
               FROM import_rows duplicate_row
               JOIN LATERAL (
                 SELECT t.imported_amount, t.calculated_internal_amount
                   FROM payroll_transactions t
                  WHERE t.transaction_fingerprint = duplicate_row.transaction_fingerprint
                    AND t.import_batch_id IS DISTINCT FROM b.id
                  ORDER BY t.created_at, t.id
                  LIMIT 1
               ) existing ON true
              WHERE duplicate_row.import_batch_id = b.id
                AND duplicate_row.status = 'duplicate'
           ) duplicate_totals ON true
          WHERE b.id = $1
       )
       UPDATE import_batches b
          SET valid_rows = refreshed.valid_rows,
              imported_rows = refreshed.imported_rows,
              skipped_rows = refreshed.skipped_rows,
              duplicate_rows = refreshed.duplicate_rows,
              warning_rows = refreshed.warning_rows,
              error_rows = refreshed.error_rows,
              imported_agency_gross = refreshed.imported_agency,
              imported_internal_amount = refreshed.imported_internal,
              reconciliation_notes = CASE
                WHEN refreshed.source_agency_gross IS NULL
                 AND refreshed.source_internal_amount IS NULL
                  THEN 'No workbook control totals were supplied, so no reconciliation was performed. Totals are the application''s own sums only.'
                WHEN (refreshed.source_agency_gross IS NULL
                       OR abs(refreshed.imported_agency - refreshed.source_agency_gross) <= 0.05)
                 AND (refreshed.source_internal_amount IS NULL
                       OR abs(refreshed.imported_internal - refreshed.source_internal_amount) <= 0.05)
                  THEN 'Application totals agree with the workbook control totals.'
                WHEN refreshed.duplicate_rows > 0
                 AND (refreshed.source_agency_gross IS NULL
                      OR abs(refreshed.imported_agency + refreshed.duplicate_agency - refreshed.source_agency_gross) <= 0.05)
                 AND (refreshed.source_internal_amount IS NULL
                      OR abs(refreshed.imported_internal + refreshed.duplicate_internal - refreshed.source_internal_amount) <= 0.05)
                  THEN 'The workbook''s control totals are fully accounted for: rows imported now plus '
                       || refreshed.duplicate_rows::text
                       || CASE WHEN refreshed.duplicate_rows = 1 THEN ' row' ELSE ' rows' END
                       || ' that already exist in the ledger from a prior import together match the workbook. '
                       || 'The duplicate rows were not re-imported, so no transactions were double-counted.'
                ELSE 'Application totals DO NOT agree with the workbook control totals. Investigate before relying on this import.'
              END,
              updated_at = now()
         FROM refreshed
        WHERE b.id = refreshed.id`,
      [source.import_batch_id],
    );
    await recordChange(client, {
      actorId,
      action: "import_row.applied",
      entityType: "import_row",
      entityId: rowId,
      previous: { status: source.status, resolved: false },
      next: {
        status: "imported",
        transactionId,
        serviceSessionId,
        individualId: source.resolved_individual_id,
        employeeId: source.resolved_employee_id,
        programId: source.resolved_program_id,
        hours: toHours(row.hours),
        rate: toMoney(row.rate),
        amount: toMoney(row.amount),
        calculatedInternalAmount: internal.internalAmount,
        paymentRecipient: attribution.recipient,
        rateExceptionId,
      },
      reason: options.reason,
      extra: { rawSourcePreserved: true },
    });
    await recordChange(client, {
      actorId,
      action: "payment_attributed",
      entityType: "payroll_transaction",
      entityId: transactionId,
      next: attribution,
      reason: "Applied corrected import row",
    });

    await client.query("COMMIT");
    finished = true;
    return ok({ rowId, transactionId, serviceSessionId, alreadyApplied: false, rateExceptionId });
  } catch (error) {
    if (!finished) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Change a diagnostic review label. Only Apply corrected row can mark a row imported. */
export async function setRowReviewStatus(
  pool: PgLikePool,
  rowId: string,
  status: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  if (!["needs_review", "invalid", "duplicate"].includes(status)) {
    return fail(
      "validation",
      "A review label cannot place a row into the ledger. Use Apply corrected row after resolving it.",
    );
  }
  const before = await getRow(pool, rowId);
  const editable = ensureHeldRow(before);
  if (!editable.ok) return editable;
  const changed = await pool.query(
    `UPDATE import_rows SET status = $2, updated_at = now()
      WHERE id = $1 AND status <> 'imported'
        AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)`,
    [rowId, status],
  );
  if (!changed.rowCount) {
    return fail("immutable", "This source row entered the ledger before the review label was saved. Its source history was not changed.");
  }
  await recordChange(pool, {
    actorId, action: "import_row_status", entityType: "import_row", entityId: rowId,
    previous: { status: before.status }, next: { status }, reason,
  });
  return ok({ id: rowId });
}

/** Bulk: set the same review status on many rows in a batch. */
export async function bulkSetStatus(
  pool: PgLikePool,
  batchId: string,
  rowIds: string[],
  status: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ updated: number }>> {
  if (!isUuid(batchId)) return fail("not_found", "That batch no longer exists.");
  if (!["needs_review", "invalid", "duplicate"].includes(status)) {
    return fail(
      "validation",
      "A review label cannot place rows into the ledger. Apply corrected rows individually.",
    );
  }
  const ids = (rowIds ?? []).filter(isUuid);
  if (ids.length === 0) return fail("validation", "Select at least one row.");
  const { rowCount } = await pool.query(
    `UPDATE import_rows SET status = $3, updated_at = now()
     WHERE import_batch_id = $1 AND id = ANY($2::uuid[])
       AND status <> 'imported'
       AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)`,
    [batchId, ids, status],
  );
  await recordChange(pool, {
    actorId, action: "import_rows_bulk_status", entityType: "import_batch", entityId: batchId,
    next: { status, rows: rowCount ?? 0 }, reason,
  });
  return ok({ updated: rowCount ?? 0 });
}

/** Bulk: resolve the same program on many rows in a batch. */
export async function bulkResolveProgram(
  pool: PgLikePool,
  batchId: string,
  rowIds: string[],
  programId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ updated: number }>> {
  if (!isUuid(batchId)) return fail("not_found", "That batch no longer exists.");
  if (!isUuid(programId)) return fail("validation", "Choose a program.");
  const ids = (rowIds ?? []).filter(isUuid);
  if (ids.length === 0) return fail("validation", "Select at least one row.");
  const prog = await pool.query(`SELECT id FROM programs WHERE id = $1`, [programId]);
  if (!prog.rows[0]) return fail("not_found", "That program no longer exists.");
  const { rowCount } = await pool.query(
    `UPDATE import_rows SET resolved_program_id = $3, updated_at = now()
     WHERE import_batch_id = $1 AND id = ANY($2::uuid[])
       AND status <> 'imported'
       AND NOT EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.import_row_id = import_rows.id)`,
    [batchId, ids, programId],
  );
  await recordChange(pool, {
    actorId, action: "import_rows_bulk_program", entityType: "import_batch", entityId: batchId,
    next: { programId, rows: rowCount ?? 0 }, reason,
  });
  return ok({ updated: rowCount ?? 0 });
}
