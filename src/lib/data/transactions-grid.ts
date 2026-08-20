import type { PgLikePool } from "@/lib/import/commit";
import { transactionScopeClause, type AccessScope } from "@/lib/auth/access";

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
  payTo: string | null; // pay_to_raw — the payment recipient as printed on the check
  checkDate: string | null; // YYYY-MM-DD
  checkNumber: string | null;
  hours: string | null;
  rate: string | null;
  gross: string | null; // imported_amount, untouched
  totalNetPay: string | null; // per-check net; repeated on every row of a check
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
  matchStatus: string | null; // duplicate_status: new | possible | confirmed
  isGroup: boolean; // group status
  serviceSessionId: string | null; // reconciliation link (matched scheduled session)
  isPaid: boolean; // operator-tracked payout status
  paidAt: string | null; // when it was marked paid (YYYY-MM-DD)
  paidNote: string | null; // optional free note kept with the paid flag
}

export async function listTransactionsForGrid(pool: PgLikePool, scope?: AccessScope): Promise<GridTransaction[]> {
  // A scoped user only ever sees transactions for the individuals they may view.
  const params: unknown[] = [];
  const scopeClause = scope ? transactionScopeClause(scope, "t.individual_id", params) : "";
  const { rows } = await pool.query<{
    id: string;
    pay_to: string | null;
    check_date: string | null;
    check_number: string | null;
    hours: string | null;
    rate: string | null;
    gross: string | null;
    total_net_pay: string | null;
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
    match_status: string | null;
    is_group: boolean;
    service_session_id: string | null;
    is_paid: boolean;
    paid_at: string | null;
    paid_note: string | null;
  }>(`
    SELECT
      t.id,
      t.pay_to_raw                                            AS pay_to,
      to_char(t.check_date,  'YYYY-MM-DD')                    AS check_date,
      t.check_number,
      t.imported_hours::text                                  AS hours,
      t.imported_rate::text                                   AS rate,
      t.imported_amount::text                                 AS gross,
      t.total_net_pay::text                                   AS total_net_pay,
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
      t.source_file_id,
      t.duplicate_status                                      AS match_status,
      t.is_group_service                                      AS is_group,
      t.service_session_id,
      t.is_paid,
      to_char(t.paid_at, 'YYYY-MM-DD')                        AS paid_at,
      t.paid_note
    FROM payroll_transactions t
    LEFT JOIN individuals i ON i.id = t.individual_id
    LEFT JOIN employees   e ON e.id = t.employee_id
    LEFT JOIN programs    p ON p.id = t.program_id
    WHERE TRUE${scopeClause}
    ORDER BY t.check_date DESC NULLS LAST, t.check_number, t.source_row_number NULLS LAST
  `, params);

  return rows.map((r) => ({
    id: r.id,
    payTo: r.pay_to,
    checkDate: r.check_date,
    checkNumber: r.check_number,
    hours: r.hours,
    rate: r.rate,
    gross: r.gross,
    totalNetPay: r.total_net_pay,
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
    matchStatus: r.match_status,
    isGroup: r.is_group,
    serviceSessionId: r.service_session_id,
    isPaid: r.is_paid,
    paidAt: r.paid_at,
    paidNote: r.paid_note,
  }));
}
