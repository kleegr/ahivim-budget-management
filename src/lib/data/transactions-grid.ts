import type { PgLikePool } from "@/lib/import/commit";
import { transactionScopeClause, type AccessScope } from "@/lib/auth/access";
import { redactTransactionFields } from "@/lib/auth/money-redaction";

/**
 * Read model for the Transactions workspace (the "Ahivim" grid).
 *
 * The whole committed ledger is projected once into plain, already-serialized
 * rows and handed to the client grid, which then does all filtering, sorting
 * and subtotalling in the browser — so it feels like Excel: instant filters,
 * instant totals, no round-trips. At the workbook's scale (~3k rows) this is
 * comfortably in-memory.
 *
 * Money and hours are cast to text so decimal.js is the only thing that ever
 * does arithmetic on them; nothing here is a float. Imported source values
 * (gross, hours, rate, net pay) are projected untouched.
 *
 * Two derived columns reproduce the workbook's logic exactly:
 *   internal          = COALESCE(calculated, spreadsheet, rate × hours)
 *   agencyAdditional  = gross − internal            (workbook column R = Q − P)
 * agencyAdditional is intentionally *not* floored at zero here, so the filtered
 * total reconciles to the workbook's R total ($145,212.09). The floored
 * "agency retention" figure is a separate business concept kept on the row.
 */
export interface GridTransaction {
  id: string;
  serviceDate?: string | null; // canonical activity date: period begin, then check date, then period end
  payTo: string | null; // pay_to_raw — the payment recipient as printed on the check
  checkDate: string | null; // YYYY-MM-DD
  checkNumber: string | null;
  hours: string | null;
  rate: string | null; // imported funder rate
  employeeRate?: string | null; // effective internal/employee rate applied
  gross: string | null; // imported_amount, untouched
  totalNetPay: string | null; // per-check net; repeated on every row of a check
  verifiedCheckGross?: string | null; // canonical linked payroll-check fact; null until verified
  verifiedCheckNet?: string | null; // canonical linked payroll-check fact; null until verified
  withholding?: string | null; // canonical linked payroll-check fact; null until verified
  verificationStatus?: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  program: string | null;
  programCode: string | null;
  programId: string | null;
  individual: string | null;
  individualId: string | null;
  employee: string | null;
  employeeId: string | null;
  internalAmount: string | null; // internal / employee amount
  agencyAdditional: string | null; // gross − internal (workbook parity, may be negative per row)
  paymentRecipient: string | null; // employee | excellent_staffing | unknown
  importBatchId: string | null;
  importRowId: string | null;
  sourceFileId: string | null;
  /** Human-readable origin retained for exact source evidence. */
  sourceName?: string | null;
  sourceSheet?: string | null;
  sourceRowNumber?: number | null;
  hasOpenRateReview?: boolean;
  matchStatus: string | null; // duplicate_status: new | possible | confirmed
  isGroup: boolean; // group status
  serviceSessionId: string | null; // reconciliation link (matched scheduled session)
  groupDetectionStatus: string | null; // single | detected | needs_review | confirmed
  isPaid: boolean; // operator-tracked payout status
  paidAt: string | null; // when it was marked paid (YYYY-MM-DD)
  paidNote: string | null; // optional free note kept with the paid flag
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listTransactionsForGrid(
  pool: PgLikePool,
  scope?: AccessScope,
  opts?: {
    employeeId?: string;
    transactionId?: string;
    transactionIds?: string[];
    /** IDs already resolved from a bounded, access-scoped server-side source. */
    allowLargeTransactionSelection?: boolean;
  },
): Promise<GridTransaction[]> {
  const requestedIds = [...new Set([
    ...(opts?.transactionId ? [opts.transactionId] : []),
    ...(opts?.transactionIds ?? []),
  ])];
  const selectionLimit = opts?.allowLargeTransactionSelection ? 10_000 : 200;
  if (requestedIds.length > selectionLimit || requestedIds.some((id) => !UUID_PATTERN.test(id))) return [];
  // Ledger access follows direct grants, not the wider connected-navigation sets.
  const params: unknown[] = [];
  const scopeClause = scope
    ? transactionScopeClause(scope, "t.individual_id", "t.employee_id", params)
    : "";
  let employeeClause = "";
  if (opts?.employeeId && UUID_PATTERN.test(opts.employeeId)) {
    params.push(opts.employeeId);
    employeeClause = ` AND t.employee_id = $${params.length}`;
  }
  let transactionClause = "";
  if (requestedIds.length > 0) {
    params.push(requestedIds);
    transactionClause = ` AND t.id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query<{
    id: string;
    service_date: string | null;
    pay_to: string | null;
    check_date: string | null;
    check_number: string | null;
    hours: string | null;
    rate: string | null;
    employee_rate: string | null;
    gross: string | null;
    total_net_pay: string | null;
    verified_check_gross: string | null;
    verified_check_net: string | null;
    withholding: string | null;
    verification_status: string | null;
    period_begin: string | null;
    period_end: string | null;
    program: string | null;
    program_code: string | null;
    program_id: string | null;
    individual: string | null;
    individual_id: string | null;
    employee: string | null;
    employee_id: string | null;
    internal_amount: string | null;
    agency_additional: string | null;
    payment_recipient: string | null;
    import_batch_id: string | null;
    import_row_id: string | null;
    source_file_id: string | null;
    source_name: string | null;
    source_sheet: string | null;
    source_row_number: number | null;
    has_open_rate_review: boolean;
    match_status: string | null;
    is_group: boolean;
    service_session_id: string | null;
    group_detection_status: string | null;
    is_paid: boolean;
    paid_at: string | null;
    paid_note: string | null;
  }>(`
    SELECT
      t.id,
      to_char(canonical_service_date(t.period_begin, t.check_date, t.period_end), 'YYYY-MM-DD') AS service_date,
      t.pay_to_raw                                            AS pay_to,
      to_char(t.check_date,  'YYYY-MM-DD')                    AS check_date,
      t.check_number,
      t.imported_hours::text                                  AS hours,
      t.imported_rate::text                                   AS rate,
      t.internal_rate_applied::text                           AS employee_rate,
      t.imported_amount::text                                 AS gross,
      t.total_net_pay::text                                   AS total_net_pay,
      (CASE WHEN pc.verification_status = 'verified'
             THEN pc.actual_gross END)::text                  AS verified_check_gross,
      (CASE WHEN pc.verification_status = 'verified'
             THEN pc.actual_net END)::text                    AS verified_check_net,
      (CASE WHEN pc.verification_status = 'verified'
             THEN pc.tax_withheld END)::text                  AS withholding,
      pc.verification_status                                  AS verification_status,
      to_char(t.period_begin, 'YYYY-MM-DD')                   AS period_begin,
      to_char(t.period_end,   'YYYY-MM-DD')                   AS period_end,
      COALESCE(p.name, t.program_raw)                         AS program,
      p.code                                                  AS program_code,
      t.program_id,
      COALESCE(i.display_name, t.individual_raw)              AS individual,
      t.individual_id,
      COALESCE(e.display_name, t.employee_raw)                AS employee,
      t.employee_id,
      COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
               t.internal_rate_applied * t.imported_hours)::text AS internal_amount,
      (t.imported_amount
         - COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
                    t.internal_rate_applied * t.imported_hours, 0))::text AS agency_additional,
      t.payment_recipient,
      t.import_batch_id,
      t.import_row_id,
      COALESCE(t.source_file_id, b.imported_file_id)           AS source_file_id,
      f.original_filename                                     AS source_name,
      ir.sheet_name                                           AS source_sheet,
      COALESCE(t.source_row_number, ir.source_row_number)      AS source_row_number,
      EXISTS (
        SELECT 1
          FROM rate_exceptions rx
         WHERE rx.payroll_transaction_id = t.id
           AND rx.resolution = 'open'
      )                                                       AS has_open_rate_review,
      t.duplicate_status                                      AS match_status,
      t.is_group_service                                      AS is_group,
      t.service_session_id,
      ss.group_detection_status,
      t.is_paid,
      to_char(t.paid_at, 'YYYY-MM-DD')                        AS paid_at,
      t.paid_note
    FROM payroll_transactions t
    LEFT JOIN individuals i ON i.id = t.individual_id
    LEFT JOIN employees   e ON e.id = t.employee_id
    LEFT JOIN programs    p ON p.id = t.program_id
    LEFT JOIN employee_payroll_checks pc
      ON pc.id = t.payroll_check_id
     AND pc.employee_id = t.employee_id
    LEFT JOIN import_batches b ON b.id = t.import_batch_id
    LEFT JOIN imported_files f ON f.id = COALESCE(t.source_file_id, b.imported_file_id)
    LEFT JOIN import_rows ir ON ir.id = t.import_row_id
    LEFT JOIN service_sessions ss ON ss.id = t.service_session_id
    WHERE TRUE${scopeClause}${employeeClause}${transactionClause}
    ORDER BY t.check_date DESC NULLS LAST, t.check_number, t.source_row_number NULLS LAST
  `, params);

  return rows.map((r) => {
    const rowScope = scope && !(
      scope.full
      || scope.allEmployees
      || (r.employee_id !== null && scope.grantedEmployeeIds.includes(r.employee_id))
    )
      ? { ...scope, canSeeCheckNet: false, canSeeTaxes: false }
      : scope;
    return redactTransactionFields({
    id: r.id,
    serviceDate: r.service_date,
    payTo: r.pay_to,
    checkDate: r.check_date,
    checkNumber: r.check_number,
    hours: r.hours,
    rate: r.rate,
    employeeRate: r.employee_rate,
    gross: r.gross,
    totalNetPay: r.total_net_pay,
    verifiedCheckGross: r.verified_check_gross,
    verifiedCheckNet: r.verified_check_net,
    withholding: r.withholding,
    verificationStatus: r.verification_status,
    periodBegin: r.period_begin,
    periodEnd: r.period_end,
    program: r.program,
    programCode: r.program_code,
    programId: r.program_id,
    individual: r.individual,
    individualId: r.individual_id,
    employee: r.employee,
    employeeId: r.employee_id,
    internalAmount: r.internal_amount,
    agencyAdditional: r.agency_additional,
    paymentRecipient: r.payment_recipient,
    importBatchId: r.import_batch_id,
    importRowId: r.import_row_id,
    sourceFileId: r.source_file_id,
    sourceName: r.source_name,
    sourceSheet: r.source_sheet,
    sourceRowNumber: r.source_row_number,
    hasOpenRateReview: r.has_open_rate_review,
    matchStatus: r.match_status,
    isGroup: r.is_group,
    serviceSessionId: r.service_session_id,
    groupDetectionStatus: r.group_detection_status,
    isPaid: r.is_paid,
    paidAt: r.paid_at,
      paidNote: r.paid_note,
    }, rowScope);
  });
}
