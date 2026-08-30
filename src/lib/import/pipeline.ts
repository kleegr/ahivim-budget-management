import { z } from "zod";
import { ahivimRowSchema } from "@/lib/excel/column-map";
import type { WorkbookParseResult, ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import {
  transactionNaturalKey,
  type TransactionIdentity,
} from "@/lib/business/fingerprint";
import {
  rateConfigAtDate,
  stageRows,
  type EffectiveRateConfig,
  type RateConfig,
  type StagingContext,
  type StagingResult,
} from "./stage";
import type { PgLikePool } from "./commit";
import { agencyDate } from "@/lib/business/agency-time";

/**
 * Shared plumbing between the upload route, the review page, and the commit
 * route. Upload parses + stages and persists a pending payload on
 * imported_files.sheet_summary; commit re-validates that payload, re-runs
 * staging against the *current* database state, and hands the result to
 * commitStagedImport. Staging is deterministic, so re-running it is the
 * simplest way to guarantee the committed numbers reflect the database as it
 * exists at commit time (rates or canonical people may have changed between
 * upload and commit).
 */

export const PENDING_PAYLOAD_KIND = "pending_ahivim_import_v1";

const parsedRowSchema = z.object({
  sourceRowNumber: z.number().int(),
  raw: z.record(z.string(), z.string()),
  formulas: z.record(z.string(), z.string()),
  parsed: ahivimRowSchema.nullable(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })),
});

export const pendingPayloadSchema = z.object({
  kind: z.literal(PENDING_PAYLOAD_KIND),
  originalFilename: z.string(),
  byteSize: z.number().int().positive(),
  checksumSha256: z.string().length(64),
  templateDetected: z.string(),
  mappingStrategy: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      rowCount: z.number(),
      columnCount: z.number(),
      headerRowNumber: z.number().nullable(),
      headers: z.array(z.string()),
    }),
  ),
  parseWarnings: z.array(z.string()),
  controlTotals: z.object({
    internalAmount: z.string().nullable(),
    agencyGross: z.string().nullable(),
    agencyRetention: z.string().nullable(),
    deduplicatedNetPay: z.string().nullable(),
  }),
  parsedRows: z.array(parsedRowSchema),
  stagedAt: z.string(),
  uploadedByUserId: z.string().nullable(),
});

/**
 * The schema's inferred type is looser than ParsedAhivimRow (zod cannot prove
 * every AhivimField key is present in `raw`); payloads are only ever produced
 * by buildPendingPayload from a real parse, so the narrower manual type is
 * accurate. validatePendingPayload performs the runtime check + single cast.
 */
export interface PendingPayload {
  kind: typeof PENDING_PAYLOAD_KIND;
  originalFilename: string;
  byteSize: number;
  checksumSha256: string;
  templateDetected: string;
  mappingStrategy: string;
  sheets: WorkbookParseResult["sheets"];
  parseWarnings: string[];
  controlTotals: WorkbookParseResult["controlTotals"];
  parsedRows: ParsedAhivimRow[];
  stagedAt: string;
  uploadedByUserId: string | null;
}

export function validatePendingPayload(value: unknown): PendingPayload | null {
  const result = pendingPayloadSchema.safeParse(value);
  if (!result.success) return null;
  return result.data as unknown as PendingPayload;
}

export function buildPendingPayload(args: {
  parse: WorkbookParseResult;
  originalFilename: string;
  byteSize: number;
  checksumSha256: string;
  uploadedByUserId: string | null;
}): PendingPayload {
  const { parse } = args;
  return {
    kind: PENDING_PAYLOAD_KIND,
    originalFilename: args.originalFilename,
    byteSize: args.byteSize,
    checksumSha256: args.checksumSha256,
    templateDetected: parse.templateDetected,
    mappingStrategy: parse.mappingStrategy,
    sheets: parse.sheets,
    parseWarnings: parse.warnings,
    controlTotals: parse.controlTotals,
    parsedRows: parse.ahivimRows,
    stagedAt: new Date().toISOString(),
    uploadedByUserId: args.uploadedByUserId,
  };
}

/** Slim metadata that replaces the bulky payload once a file is committed. */
export function slimSheetSummary(payload: PendingPayload): Record<string, unknown> {
  return {
    kind: "committed_ahivim_import_v1",
    templateDetected: payload.templateDetected,
    mappingStrategy: payload.mappingStrategy,
    sheets: payload.sheets,
    parseWarnings: payload.parseWarnings,
    controlTotals: payload.controlTotals,
    totalSourceRows: payload.parsedRows.length,
  };
}

/** Load everything staging needs to resolve names, rates and duplicates. */
export async function loadStagingContext(
  pool: PgLikePool,
  workbookTotals?: { agencyGross?: string; internalAmount?: string },
): Promise<StagingContext> {
  const rateFallbackDate = agencyDate();
  const rateSchedules = await pool.query<{
    code: string;
    agency_rate: string | null;
    internal_rate: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT p.code,
            s.agency_rate::text AS agency_rate,
            s.internal_rate::text AS internal_rate,
            s.effective_from::text AS effective_from,
            s.effective_to::text AS effective_to
       FROM programs p
       JOIN program_rate_schedules s ON s.program_id = p.id`,
  );
  const rateSchedulesByProgram: Record<string, EffectiveRateConfig[]> = {};
  for (const row of rateSchedules.rows) {
    const entries = rateSchedulesByProgram[row.code] ?? [];
    entries.push({
      agencyRate: row.agency_rate,
      internalRate: row.internal_rate,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    });
    rateSchedulesByProgram[row.code] = entries;
  }
  const ratesByProgram: Record<string, RateConfig> = {};
  for (const [code, schedule] of Object.entries(rateSchedulesByProgram)) {
    const current = rateConfigAtDate(schedule, rateFallbackDate);
    if (current) ratesByProgram[code] = current;
  }

  const programAliases = await pool.query<{
    normalized_alias: string;
    code: string;
  }>(
    `SELECT a.normalized_alias, p.code
       FROM program_aliases a
       JOIN programs p ON p.id = a.program_id
      WHERE a.status = 'approved' AND p.is_active = true`,
  );

  const individuals = await pool.query<{
    id: string;
    normalized_name: string;
    display_name: string;
  }>(`SELECT id, normalized_name, display_name FROM individuals`);
  const individualAliases = await pool.query<{
    normalized_alias: string;
    individual_id: string;
    status: string;
  }>(`SELECT normalized_alias, individual_id, status FROM individual_aliases`);
  const employees = await pool.query<{
    id: string;
    normalized_name: string;
    display_name: string;
  }>(`SELECT id, normalized_name, display_name FROM employees`);
  const employeeAliases = await pool.query<{
    normalized_alias: string;
    employee_id: string;
    status: string;
  }>(`SELECT normalized_alias, employee_id, status FROM employee_aliases`);

  const committed = await pool.query<{
    check_number: string | null;
    check_date: string | null;
    employee_key: string | null;
    individual_key: string | null;
    program_code: string | null;
    period_begin: string | null;
    period_end: string | null;
    hours: string;
    rate: string;
    amount: string;
    transaction_fingerprint: string;
  }>(`
    SELECT t.check_number,
           t.check_date::text  AS check_date,
           e.normalized_name   AS employee_key,
           i.normalized_name   AS individual_key,
           p.code              AS program_code,
           t.period_begin::text AS period_begin,
           t.period_end::text   AS period_end,
           t.imported_hours::text AS hours,
           t.imported_rate::text  AS rate,
           t.imported_amount::text AS amount,
           t.transaction_fingerprint
    FROM payroll_transactions t
    LEFT JOIN programs p    ON p.id = t.program_id
    LEFT JOIN individuals i ON i.id = t.individual_id
    LEFT JOIN employees e   ON e.id = t.employee_id
  `);

  const knownFingerprints = new Set<string>();
  const knownNaturalKeys = new Set<string>();
  for (const row of committed.rows) {
    knownFingerprints.add(row.transaction_fingerprint);
    const identity: TransactionIdentity = {
      checkNumber: row.check_number,
      checkDate: row.check_date,
      employeeKey: row.employee_key,
      individualKey: row.individual_key ?? "",
      programKey: row.program_code,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      hours: row.hours,
      rate: row.rate,
      amount: row.amount,
    };
    knownNaturalKeys.add(transactionNaturalKey(identity));
  }

  return {
    ratesByProgram,
    rateSchedulesByProgram,
    rateFallbackDate,
    programAliases: Object.fromEntries(
      programAliases.rows.map((row) => [row.normalized_alias, row.code]),
    ),
    individuals: individuals.rows.map((r) => ({
      id: r.id,
      normalizedName: r.normalized_name,
      displayName: r.display_name,
    })),
    individualAliases: individualAliases.rows.map((r) => ({
      normalizedAlias: r.normalized_alias,
      targetId: r.individual_id,
      status: (r.status === "approved" ? "approved" : "pending") as "approved" | "pending",
    })),
    employees: employees.rows.map((r) => ({
      id: r.id,
      normalizedName: r.normalized_name,
      displayName: r.display_name,
    })),
    employeeAliases: employeeAliases.rows.map((r) => ({
      normalizedAlias: r.normalized_alias,
      targetId: r.employee_id,
      status: (r.status === "approved" ? "approved" : "pending") as "approved" | "pending",
    })),
    knownFingerprints,
    knownNaturalKeys,
    workbookTotals,
  };
}

/** Parse result → staging result against the current database state. */
export async function stageAgainstDatabase(
  pool: PgLikePool,
  parsedRows: ParsedAhivimRow[],
  controlTotals: { agencyGross: string | null; internalAmount: string | null },
): Promise<StagingResult> {
  const context = await loadStagingContext(pool, {
    agencyGross: controlTotals.agencyGross ?? undefined,
    internalAmount: controlTotals.internalAmount ?? undefined,
  });
  return stageRows(parsedRows, context);
}
