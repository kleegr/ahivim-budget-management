import { createHash } from "node:crypto";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { AHIVIM_HEADER_ALIASES, AHIVIM_POSITIONAL, type AhivimField } from "@/lib/excel/column-map";
import { dec } from "@/lib/money";
import { recordChange } from "@/lib/manage/audit";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";
import { fail, ok, type Result } from "@/lib/manage/errors";
import { DEFAULT_SHEET_ID, DEFAULT_SHEET_NAME, getSyncConfig } from "./config";
import { fetchSheetCsv, sheetValuesToCsv, type CsvFetcher } from "./fetch";
import { parseSheetCsv } from "./parse-csv";
import { sheetSourceIdentity, sheetSourceIdentityKey, sourceEvidenceKey } from "./identity";
import { sourceNetCheckGroup, type SourceNetEmployeeDirectory } from "./source-net-check-group";

const ACCEPT = "source_net_recovery_accepted";
const REVERSE = "source_net_recovery_reversed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rawFields = (value: Record<string, unknown>): Record<string, unknown> =>
  value.raw !== null && typeof value.raw === "object" && !Array.isArray(value.raw)
    ? value.raw as Record<string, unknown> : value;

export interface SourceNetRecoveryInput {
  action: "accept" | "undo";
  reason: string;
  operationKey: string;
  acceptanceAuditId?: string;
}
export interface SourceNetRecoveryResult {
  transactionId: string;
  acceptanceAuditId: string;
  auditId: string;
  net: string | null;
  alreadyApplied: boolean;
}
type AuditRow = { id: string; entity_id: string; metadata: Record<string, unknown> };
type Transaction = Record<string, unknown> & {
  id: string; import_row_id: string; employee_id: string | null; total_net_pay: string | null;
  pay_to_raw: string | null; raw_values: Record<string, unknown>; corrected_values: unknown;
  correction_status: string | null; original_source_row_number: number;
};

/** No rounding is permitted when projecting recovered literal source evidence. */
function exactNet(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = dec(value);
  return number.isNegative() || number.decimalPlaces() > 4 || number.gte("10000000000")
    ? null : number.toFixed(4);
}

function canonicalIdentity(transaction: Transaction) {
  return {
    checkNumber: transaction.check_number, checkDate: transaction.check_date,
    program: transaction.program_raw, individual: transaction.individual_raw,
    employee: transaction.employee_raw, periodBegin: transaction.period_begin,
    periodEnd: transaction.period_end, hours: transaction.imported_hours,
    rate: transaction.imported_rate, amount: transaction.imported_amount,
  };
}

function compatibleCheckSql(left: string, right: string): string {
  const number = (alias: string) => `NULLIF(btrim(${alias}.check_number), '')`;
  const compatibleDate = (field: string) => `(${left}.${field} IS NULL OR ${right}.${field} IS NULL OR ${left}.${field} = ${right}.${field})`;
  return `${left}.employee_id = ${right}.employee_id AND (
    (${number(left)} = ${number(right)} AND ${compatibleDate("check_date")})
    OR ((${number(left)} IS NULL OR ${number(right)} IS NULL)
      AND ${compatibleDate("check_date")} AND ${compatibleDate("period_begin")} AND ${compatibleDate("period_end")}
      AND (${left}.check_date = ${right}.check_date OR ${left}.period_begin = ${right}.period_begin OR ${left}.period_end = ${right}.period_end))
  )`;
}

/** All other mapped source values must still describe the immutable original row. */
function unchangedSource(original: Record<string, unknown>, current: Record<string, unknown>, currentRaw: Record<string, string>): boolean {
  const header: string[] = [], row: string[] = [];
  for (const [field, column] of Object.entries(AHIVIM_POSITIONAL)) {
    header[column - 1] = AHIVIM_HEADER_ALIASES[field as AhivimField][0]!;
    row[column - 1] = String(original[field] ?? "");
  }
  // Reuse the original import's date/accounting normalization, without altering
  // its immutable raw text or inferring a numeric NET from a displayed date.
  const parsed = parseSheetCsv(sheetValuesToCsv([[], header, row])).ahivimRows[0]?.parsed;
  if (!parsed) return false;
  const numeric = new Set(["hours", "rate", "amount", "calculatedInternalAmount"]);
  return Object.entries(parsed).every(([key, previous]) => {
    if (key === "totalNetPay" || key === "paid") return true;
    const next = current[key];
    if (numeric.has(key) && text(previous) !== "" && text(next) !== "") {
      try { return dec(String(previous)).eq(String(next)); } catch { return false; }
    }
    if (text(previous) === "" && text(original[key]) !== "") return text(original[key]) === text(currentRaw[key]);
    return text(previous) === text(next);
  });
}

/**
 * Include the whole employee/check identity, directly linked checks, and all
 * historical obligation descendants. A reversal remains posted history.
 * The source advisory lock is held before these reads and all row locks.
 */
async function groupHasPostedMoney(client: PgLikeClient, transactionId: string, net: string): Promise<boolean> {
  const { rows } = await client.query<{ blocked: boolean }>(`
    WITH RECURSIVE target AS (SELECT * FROM payroll_transactions WHERE id = $1),
    source_group AS (
      SELECT * FROM target
      UNION
      SELECT p.* FROM payroll_transactions p JOIN source_group g
        ON (${compatibleCheckSql("p", "g")}) OR (g.payroll_check_id IS NOT NULL AND p.payroll_check_id = g.payroll_check_id)
    ), checks AS (
      SELECT c.id, c.verification_status FROM employee_payroll_checks c
       WHERE c.id IN (SELECT payroll_check_id FROM source_group)
          OR EXISTS (SELECT 1 FROM source_group g WHERE ${compatibleCheckSql("c", "g")})
    ), affected AS (
      SELECT o.id FROM settlement_obligations o WHERE
        EXISTS (SELECT 1 FROM settlement_obligation_transactions l
          WHERE l.settlement_obligation_id = o.id AND l.payroll_transaction_id IN (SELECT id FROM source_group))
        OR EXISTS (SELECT 1 FROM source_group g
          WHERE COALESCE(o.calculation_metadata->'sourceTransactionIds', '[]'::jsonb) ? g.id::text)
        OR o.calculation_metadata->>'payrollCheckId' IN (SELECT id::text FROM checks)
        OR (o.employee_id IN (SELECT employee_id FROM source_group)
          AND NOT EXISTS (SELECT 1 FROM settlement_obligation_transactions l
            JOIN payroll_transactions p ON p.id = l.payroll_transaction_id
            WHERE l.settlement_obligation_id = o.id AND p.employee_id = o.employee_id)
          AND NOT EXISTS (SELECT 1 FROM payroll_transactions p WHERE p.employee_id = o.employee_id
            AND COALESCE(o.calculation_metadata->'sourceTransactionIds', '[]'::jsonb) ? p.id::text)
          AND NOT EXISTS (SELECT 1 FROM employee_payroll_checks c WHERE c.employee_id = o.employee_id
            AND c.id::text = o.calculation_metadata->>'payrollCheckId'))
      UNION
      SELECT o.id FROM settlement_obligations o JOIN affected a
        ON o.calculation_metadata->>'adjustmentForObligationId' = a.id::text
    )
    SELECT EXISTS (SELECT 1 FROM checks WHERE verification_status <> 'unverified')
      OR EXISTS (SELECT 1 FROM source_group WHERE total_net_pay IS NOT NULL AND total_net_pay <> $2::numeric)
      OR EXISTS (SELECT 1 FROM settlement_events e WHERE e.settlement_obligation_id IN (SELECT id FROM affected)
        OR (e.settlement_obligation_id IS NULL AND e.employee_id IN (SELECT employee_id FROM source_group)))
      AS blocked`, [transactionId, net]);
  return rows[0]?.blocked !== false;
}

/**
 * Dedicated repair of a date-formatted numeric source NET previously imported
 * as NULL. The original import row is immutable. Only the NET projection and
 * review state change; acceptance and reversal are separate append-only audits.
 * This intentionally never verifies a check or refreshes/creates money events.
 */
export async function recoverSourceNet(
  pool: PgLikePool, conflictId: string, input: SourceNetRecoveryInput, actorId: string | null,
  options: { fetcher?: CsvFetcher } = {},
): Promise<Result<SourceNetRecoveryResult>> {
  if (!UUID.test(conflictId) || !UUID.test(input.operationKey)
    || (input.action !== "accept" && input.action !== "undo")
    || (input.action === "undo" && !UUID.test(input.acceptanceAuditId ?? ""))) {
    return fail("validation", "A valid review, action, and retry key are required.");
  }
  const reason = input.reason?.trim();
  if (!reason || reason.length > 2000) return fail("validation", "Explain this source repair in 1–2000 characters.");
  const requestHash = hash({ conflictId, action: input.action, reason, actorId, acceptanceAuditId: input.acceptanceAuditId ?? null });
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN");
    // Same order as inbound sync: Sheet serialization before financial sources.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["ahivim:sheet-sync:canonical-ledger:v1"]);
    await acquireSettlementSourceLock(client);
    const scopedPool: PgLikePool = { query: (sql, params) => client.query(sql, params), connect: async () => { throw new Error("Nested source repair connection"); } };
    const result = await (async (): Promise<Result<SourceNetRecoveryResult>> => {
      const prior = (await client.query<AuditRow>(`SELECT id, entity_id, metadata FROM audit_logs
        WHERE action IN ($1, $2) AND metadata->>'operationKey' = $3`, [ACCEPT, REVERSE, input.operationKey])).rows;
      if (prior.length) {
        const event = prior[0]!;
        if (prior.length !== 1 || event.metadata.requestHash !== requestHash) return fail("conflict", "This retry key belongs to a different request.");
        return ok({ transactionId: event.entity_id, acceptanceAuditId: String(event.metadata.acceptanceAuditId ?? event.id),
          auditId: event.id, net: event.metadata.resultNet as string | null, alreadyApplied: true });
      }
      const conflict = (await client.query<{
        id: string; type: string; status: string; audited: boolean; payroll_transaction_id: string | null;
        previous: Record<string, unknown>; incoming: Record<string, unknown>; snapshot_sha256: string | null;
      }>(`SELECT c.*, r.snapshot_sha256 FROM sheet_sync_conflicts c
          LEFT JOIN sheet_sync_runs r ON r.id = c.run_id WHERE c.id = $1 FOR UPDATE OF c`, [conflictId])).rows[0];
      if (!conflict?.payroll_transaction_id) return fail("not_found", "This source review has no recorded transaction.");
      if (conflict.type !== "changed" || conflict.previous?.sourceEvidenceConflict !== "routing_or_net"
        || conflict.previous.totalNetPay !== null || conflict.audited) {
        return fail("immutable", "Only an unresolved parser recovery from unknown NET can use this action.");
      }
      const transaction = (await client.query<Transaction>(`SELECT p.*,
          to_char(p.check_date, 'YYYY-MM-DD') AS check_date,
          to_char(p.period_begin, 'YYYY-MM-DD') AS period_begin,
          to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
          i.raw_values, i.corrected_values, i.correction_status,
          i.source_row_number AS original_source_row_number
        FROM payroll_transactions p JOIN import_rows i ON i.id = p.import_row_id
        WHERE p.id = $1 FOR UPDATE OF p, i`, [conflict.payroll_transaction_id])).rows[0];
      if (!transaction) return fail("not_found", "The immutable original source row is unavailable.");
      if (transaction.corrected_values !== null || transaction.correction_status === "corrected"
        || !/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(String(rawFields(transaction.raw_values).totalNetPay ?? "").trim())) {
        return fail("immutable", "This action requires the unchanged original date-formatted NET source; other changes need review.");
      }
      const active = (await client.query<AuditRow>(`SELECT a.id, a.entity_id, a.metadata FROM audit_logs a
        WHERE a.action = $1 AND a.entity_type = 'payroll_transaction' AND a.entity_id = $2
          AND NOT EXISTS (SELECT 1 FROM audit_logs r WHERE r.action = $3 AND r.metadata->>'acceptanceAuditId' = a.id::text)`,
      [ACCEPT, transaction.id, REVERSE])).rows;
      let acceptance: AuditRow | undefined;
      if (input.action === "accept") {
        if (conflict.status !== "open" || transaction.total_net_pay !== null || active.length) {
          return fail("conflict", "This NET recovery has already changed. Refresh the review.");
        }
      } else {
        acceptance = active[0];
        if (active.length !== 1 || acceptance?.id !== input.acceptanceAuditId
          || acceptance.metadata.conflictId !== conflictId || conflict.status !== "applied"
          || transaction.total_net_pay !== acceptance.metadata.acceptedNet
          || acceptance.metadata.canonicalIdentityHash !== hash(canonicalIdentity(transaction))
          || acceptance.metadata.originalSourceHash !== hash(transaction.raw_values)) {
          return fail("conflict", "Only the latest unreversed recovery, with its accepted NET still intact, can be undone.");
        }
      }
      const otherReview = (await client.query(`SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open' AND id <> $2`, [transaction.id, conflictId])).rows;
      if (otherReview.length) return fail("conflict", "Resolve the other source changes before this NET recovery.");
      const net = exactNet(conflict.incoming.totalNetPay);
      if (net === null) return fail("validation", "The recovered NET must be a non-negative exact amount with no more than four decimal places.");
      if (await groupHasPostedMoney(client, transaction.id, net)) return fail("immutable", "This check group has verification, conflicting NET, or posted settlement history. Its NET requires financial correction review.");
      const config = await getSyncConfig(scopedPool);
      if (config.sheetId !== DEFAULT_SHEET_ID || config.sheetName !== DEFAULT_SHEET_NAME) {
        return fail("conflict", "This repair requires the designated read-only Ahivim source.");
      }
      const source = parseSheetCsv(await (options.fetcher ?? fetchSheetCsv)(config));
      if (!conflict.snapshot_sha256 || source.snapshotSha256 !== conflict.snapshot_sha256
        || (acceptance && acceptance.metadata.sourceHash !== source.snapshotSha256)) {
        return fail("conflict", "The source has changed since this review. Run inbound sync and review the current evidence.");
      }
      const identity = sheetSourceIdentityKey(canonicalIdentity(transaction));
      const matches = source.ahivimRows.filter(row => sheetSourceIdentityKey({ ...sheetSourceIdentity(row) }) === identity);
      const sourceKey = sourceEvidenceKey({ payTo: transaction.pay_to_raw, totalNetPay: net });
      const variants = Array.isArray(conflict.incoming.sourceEvidenceKeys) ? conflict.incoming.sourceEvidenceKeys : [];
      if (!identity || net === null || !matches.length || variants.length !== 1 || variants[0] !== sourceKey
        || text(conflict.incoming.payTo) !== text(transaction.pay_to_raw)
        || (acceptance && acceptance.metadata.acceptedNet !== net)
        || matches.some(row => !row.parsed || exactNet(row.parsed.totalNetPay) !== net
          || text(row.parsed.payTo) !== text(transaction.pay_to_raw)
          || !unchangedSource(rawFields(transaction.raw_values), row.parsed, row.raw))) {
        return fail("conflict", "Current source routing, NET, or another source value does not match this recovery. Nothing was changed.");
      }
      // Read canonical people and approved/pending aliases in one snapshot,
      // using the same exact matcher and precedence as transaction import.
      const directory = (await client.query<SourceNetEmployeeDirectory>(`SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'normalizedName', normalized_name,
          'displayName', display_name, 'status', status)), '[]'::jsonb) FROM employees) AS employees,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('normalizedAlias', normalized_alias,
          'targetId', employee_id, 'status', status)), '[]'::jsonb) FROM employee_aliases) AS aliases,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('mergedId', metadata->>'mergedId',
          'survivorId', entity_id, 'mergedName', metadata->>'mergedName')), '[]'::jsonb)
          FROM audit_logs WHERE action = 'employees_merged' AND entity_type = 'employee') AS merges`)).rows[0];
      if (!directory) return fail("conflict", "Employee matching is unavailable. Review the source check group first.");
      const checkGroup = sourceNetCheckGroup(source.ahivimRows, canonicalIdentity(transaction), transaction.employee_id, directory);
      // Undo also requires a certifiable group: a newly conflicting identity
      // could refer to another employee's verified check or posted history.
      if (checkGroup.unresolved) return fail("conflict", "The source check group has unresolved or conflicting employee names. Review employee identity before accepting or undoing this repair. Nothing was changed.");
      if (source.ahivimRows.some(row => checkGroup.rowNumbers.has(row.sourceRowNumber)
        && (!row.parsed || exactNet(row.parsed.totalNetPay) !== net))) {
        return fail("conflict", "The source check group contains different or unknown NET evidence. Review the whole check first.");
      }
      const resultNet = input.action === "accept" ? net : null;
      // Validation above precedes every write. Errors below roll back projection,
      // review status and audit together. Original source/check/Paid rows stay intact.
      await client.query("UPDATE payroll_transactions SET total_net_pay = $2 WHERE id = $1", [transaction.id, resultNet]);
      if (input.action === "accept") {
        await client.query(`UPDATE sheet_sync_conflicts SET status = 'applied', resolution = 'source_net_recovery',
          resolution_note = $2, resolved_by_user_id = $3, resolved_at = now(), updated_at = now() WHERE id = $1`,
        [conflictId, reason, actorId]);
      } else {
        await client.query(`UPDATE sheet_sync_conflicts SET status = 'open', resolution = NULL,
          resolution_note = NULL, resolved_by_user_id = NULL, resolved_at = NULL, updated_at = now() WHERE id = $1`, [conflictId]);
      }
      await recordChange(client, {
        actorId, action: input.action === "accept" ? ACCEPT : REVERSE, entityType: "payroll_transaction", entityId: transaction.id,
        reason, previous: { totalNetPay: transaction.total_net_pay }, next: { totalNetPay: resultNet },
        extra: { operationKey: input.operationKey, requestHash, conflictId, acceptedNet: net, resultNet,
          ...(acceptance ? { acceptanceAuditId: acceptance.id } : {}),
          sourceHash: source.snapshotSha256, sourceRowNumbers: matches.map(row => row.sourceRowNumber),
          sourceColumn: source.columnMap.totalNetPay, originalImportRowId: transaction.import_row_id,
          originalSourceRowNumber: transaction.original_source_row_number, originalSourceHash: hash(transaction.raw_values),
          canonicalIdentityHash: hash(canonicalIdentity(transaction)),
          reviewedPrevious: conflict.previous, reviewedIncoming: conflict.incoming,
        },
      });
      const event = (await client.query<{ id: string }>(`SELECT id FROM audit_logs
        WHERE action = $1 AND metadata->>'operationKey' = $2`, [input.action === "accept" ? ACCEPT : REVERSE, input.operationKey])).rows[0];
      if (!event) throw new Error("The source repair audit was not saved.");
      return ok({ transactionId: transaction.id, acceptanceAuditId: acceptance?.id ?? event.id, auditId: event.id, net: resultNet, alreadyApplied: false });
    })();
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { rollbackFailed = true; }
    throw error;
  } finally { client.release(rollbackFailed || undefined); }
}
