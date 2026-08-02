import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours } from "@/lib/money";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import { attributePayment } from "@/lib/manage/payment-attribution";
import { recordChange } from "@/lib/manage/audit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { parseSheetCsv } from "./parse-csv";
import { fetchSheetCsv, type CsvFetcher } from "./fetch";
import { getSyncConfig, type SheetSyncConfig } from "./config";

/**
 * SYNC CONFLICT RESOLUTION
 * ========================
 *
 * A "changed" or "missing" conflict is resolved by an explicit human action —
 * the daily sync never rewrites or deletes a production transaction on its own.
 *
 *   apply    (changed) : pull the sheet's CURRENT value for this identity into
 *                        the existing transaction, in place, fully audited.
 *                        REFUSED when the transaction carries an audited manual
 *                        correction, so a curated figure is never clobbered.
 *   dismiss           : keep the transaction as-is and close the conflict.
 *
 * Applying updates the same transaction row (no second, competing record is
 * created), so every downstream total stays correct with no change to any
 * existing aggregate query. The previous figures are captured in the audit log.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

interface ConflictRow {
  id: string;
  type: string;
  status: string;
  audited: boolean;
  natural_key: string;
  payroll_transaction_id: string | null;
}

async function loadConflict(pool: PgLikePool, id: string): Promise<ConflictRow | null> {
  const { rows } = await pool.query<ConflictRow>(
    `SELECT id, type, status, audited, natural_key, payroll_transaction_id
       FROM sheet_sync_conflicts WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ResolveOptions {
  fetcher?: CsvFetcher;
  config?: SheetSyncConfig;
}

/** Apply the sheet's current value for a changed row into its existing transaction. */
export async function applyChangedConflict(
  pool: PgLikePool,
  conflictId: string,
  actorId: string | null,
  opts: ResolveOptions = {},
): Promise<Result<{ transactionId: string }>> {
  if (!isUuid(conflictId)) return fail("not_found", "That conflict no longer exists.");
  const conflict = await loadConflict(pool, conflictId);
  if (!conflict) return fail("not_found", "That conflict no longer exists.");
  if (conflict.status !== "open") return fail("conflict", "That conflict has already been resolved.");
  if (conflict.type !== "changed") return fail("validation", "Only a changed row can be applied.");
  if (!conflict.payroll_transaction_id) return fail("not_found", "The transaction for this conflict is missing.");
  const txnId = conflict.payroll_transaction_id;

  // Re-check audited state at apply time — never overwrite a curated correction.
  const { rows: auditedRows } = await pool.query<{ audited: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM payroll_transactions t JOIN import_rows r ON r.id = t.import_row_id
         WHERE t.id = $1 AND ( r.correction_status = 'corrected' OR r.corrected_values IS NOT NULL )
     ) AS audited`,
    [txnId],
  );
  if (auditedRows[0]?.audited) {
    return fail(
      "immutable",
      "This transaction has an audited manual correction. It cannot be overwritten by the sheet. " +
        "Resolve the correction first, or dismiss this conflict.",
    );
  }

  // Pull the CURRENT sheet and stage it, then locate this identity's row.
  const config = opts.config ?? (await getSyncConfig(pool));
  const fetcher: CsvFetcher = opts.fetcher ?? fetchSheetCsv;
  const csv = await fetcher(config);
  const parse = parseSheetCsv(csv);
  const staging = await stageAgainstDatabase(pool, parse.ahivimRows, {
    agencyGross: parse.controlTotals.agencyGross,
    internalAmount: parse.controlTotals.internalAmount,
  });

  const matches = staging.rows.filter((r) => r.naturalKey === conflict.natural_key && r.status !== "invalid");
  if (matches.length === 0) {
    // The change reverted or the row was removed; nothing to apply.
    await closeConflict(pool, conflictId, "dismissed", "source_reverted", actorId,
      "The changed value is no longer in the sheet; nothing was applied.");
    return fail("conflict", "The changed value is no longer in the sheet, so there is nothing to apply. The conflict was closed.");
  }
  if (matches.length > 1) {
    return fail("conflict", "The sheet now has more than one row for this identity; resolve it manually to avoid guessing.");
  }
  const staged = matches[0]!;
  const parsed = parse.ahivimRows.find((r) => r.sourceRowNumber === staged.sourceRowNumber)?.parsed;
  if (!parsed) return fail("validation", "The sheet row could not be read for applying.");

  // Snapshot the previous figures for the audit trail.
  const { rows: beforeRows } = await pool.query<{
    imported_hours: string | null; imported_rate: string | null; imported_amount: string | null;
    calculated_internal_amount: string | null; transaction_fingerprint: string; pay_to_raw: string | null;
    employee_raw: string | null; employee_id: string | null;
  }>(
    `SELECT imported_hours::text, imported_rate::text, imported_amount::text,
            calculated_internal_amount::text, transaction_fingerprint, pay_to_raw, employee_raw, employee_id
       FROM payroll_transactions WHERE id = $1`,
    [txnId],
  );
  const before = beforeRows[0];
  if (!before) return fail("not_found", "That transaction no longer exists.");

  // Update the SAME transaction in place with the sheet's current figures.
  await pool.query(
    `UPDATE payroll_transactions
        SET imported_hours = $2, imported_rate = $3, imported_amount = $4,
            total_net_pay = $5, spreadsheet_internal_amount = $6, calculated_internal_amount = $7,
            internal_amount_mismatch = $8, transaction_fingerprint = $9, duplicate_status = 'new',
            sync_review_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [
      txnId,
      toHours(parsed.hours),
      toMoney(parsed.rate),
      toMoney(parsed.amount),
      parsed.totalNetPay ? toMoney(parsed.totalNetPay) : null,
      staged.spreadsheetInternalAmount,
      staged.calculatedInternalAmount,
      staged.internalAmountMismatch,
      staged.fingerprint,
    ],
  );

  // Re-derive the three attribution columns for this row from the same inputs the pipeline uses.
  const employeeName = before.employee_id
    ? (await pool.query<{ n: string | null }>(`SELECT display_name AS n FROM employees WHERE id = $1`, [before.employee_id])).rows[0]?.n ?? before.employee_raw
    : before.employee_raw;
  const attribution = attributePayment({
    payToRaw: before.pay_to_raw,
    employeeName,
    importedAmount: toMoney(parsed.amount),
    internalAmount: staged.calculatedInternalAmount ?? staged.spreadsheetInternalAmount,
  });
  await pool.query(
    `UPDATE payroll_transactions
        SET payment_recipient = $2, employee_payment_amount = $3, agency_additional_amount = $4, updated_at = now()
      WHERE id = $1`,
    [txnId, attribution.recipient, attribution.employeePayment, attribution.agencyAdditional],
  );

  // Re-point the tracking row to the new fingerprint and mark it active.
  await pool.query(
    `UPDATE sheet_sync_rows
        SET fingerprint = $2, state = 'active', last_seen_at = now(), updated_at = now()
      WHERE payroll_transaction_id = $1`,
    [txnId, staged.fingerprint],
  );

  await closeConflict(pool, conflictId, "applied", "applied", actorId, "The sheet's current value was applied to the transaction.");

  await recordChange(pool, {
    actorId,
    action: "sheet_sync_change_applied",
    entityType: "payroll_transaction",
    entityId: txnId,
    previous: {
      hours: before.imported_hours, rate: before.imported_rate, amount: before.imported_amount,
      internal: before.calculated_internal_amount, fingerprint: before.transaction_fingerprint,
    },
    next: {
      hours: toHours(parsed.hours), rate: toMoney(parsed.rate), amount: toMoney(parsed.amount),
      internal: staged.calculatedInternalAmount, fingerprint: staged.fingerprint,
    },
    reason: `Applied from Google Sheet sync (conflict ${conflictId}).`,
  });

  return ok({ transactionId: txnId });
}

/** Keep the existing transaction and close a conflict (changed or missing). */
export async function dismissConflict(
  pool: PgLikePool,
  conflictId: string,
  actorId: string | null,
  note?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(conflictId)) return fail("not_found", "That conflict no longer exists.");
  const conflict = await loadConflict(pool, conflictId);
  if (!conflict) return fail("not_found", "That conflict no longer exists.");
  if (conflict.status !== "open") return fail("conflict", "That conflict has already been resolved.");

  await closeConflict(pool, conflictId, "dismissed", "dismissed", actorId, note ?? null);

  // Clear the soft flag on the transaction; the record itself is untouched.
  if (conflict.payroll_transaction_id) {
    await pool.query(
      `UPDATE payroll_transactions SET sync_review_reason = NULL, updated_at = now() WHERE id = $1`,
      [conflict.payroll_transaction_id],
    );
    // A dismissed missing conflict returns the tracking row to active so it is
    // not repeatedly re-flagged; a dismissed change simply leaves it active.
    await pool.query(
      `UPDATE sheet_sync_rows SET state = 'active', updated_at = now() WHERE payroll_transaction_id = $1`,
      [conflict.payroll_transaction_id],
    );
  }
  await recordChange(pool, {
    actorId,
    action: "sheet_sync_conflict_dismissed",
    entityType: "sheet_sync_conflict",
    entityId: conflictId,
    extra: { type: conflict.type },
  });
  return ok({ id: conflictId });
}

async function closeConflict(
  pool: PgLikePool,
  id: string,
  status: string,
  resolution: string,
  actorId: string | null,
  note: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE sheet_sync_conflicts
        SET status = $2, resolution = $3, resolution_note = $4, resolved_by_user_id = $5,
            resolved_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, status, resolution, note, actorId],
  );
}
