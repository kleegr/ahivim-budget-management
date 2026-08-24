import type { PgLikePool } from "@/lib/import/commit";
import { addMoney, dec, toMoney } from "@/lib/money";
import { transactionScopeClause, type AccessScope } from "@/lib/auth/access";
import { redactTransactionFields } from "@/lib/auth/money-redaction";
import { calculatePeriodElapsed, type PeriodElapsed } from "@/lib/business/utilization";
import { calculateForecast, type ForecastResult } from "@/lib/business/forecast";
import { pickEffectiveRateRow } from "@/lib/business/rate-resolver";
import { actionableRateExceptionSource } from "@/lib/data/rate-exception-scope";

/**
 * Read models for the application screens.
 *
 * Every figure here is read from the database. Nothing is defaulted to a
 * plausible-looking number: where there is no data the query returns zero rows
 * and the screen says so, and where a derived figure cannot be computed the
 * shape carries an explicit reason instead of a value.
 */

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export interface MoneyTotals {
  agencyGross: string;
  internalAmount: string;
  agencyRetention: string;
}

export interface DashboardData {
  totals: MoneyTotals;
  employeeCash: { amount: string; accounts: number; available: boolean };
  authorization: {
    available: boolean;
    authorizedHours: string;
    usedHours: string;
    remainingHours: string;
    utilizationPercent: string | null;
  };
  counts: {
    individuals: number;
    employees: number;
    transactions: number;
    serviceSessions: number;
    groupSessions: number;
    imports: number;
    reviewRows: number;
    openRateExceptions: number;
    pendingAliases: number;
  };
  recentImports: ImportListRow[];
  reconciliation: ReconciliationStatus[];
  forecast: { available: false; reason: string } | { available: true; result: ForecastResult };
}

export interface ReconciliationStatus {
  batchId: string;
  filename: string;
  committedAt: string | null;
  sourceAgencyGross: string | null;
  importedAgencyGross: string | null;
  sourceInternalAmount: string | null;
  importedInternalAmount: string | null;
  agencyDifference: string | null;
  internalDifference: string | null;
  balanced: boolean | null;
  notes: string | null;
}

export async function getDashboardData(pool: PgLikePool): Promise<DashboardData> {
  const [totalsRes, cashRes, authRes, countsRes, aliasRes] = await Promise.all([
    pool.query<{ agency: string | null; internal: string | null }>(
      `SELECT COALESCE(sum(imported_amount), 0)::text            AS agency,
              COALESCE(sum(calculated_internal_amount), 0)::text AS internal
       FROM payroll_transactions`,
    ),
    pool.query<{ amount: string | null; accounts: string }>(
      `SELECT COALESCE(sum(employee_cash_amount), 0)::text AS amount,
              count(*)::text                               AS accounts
       FROM account_periods`,
    ),
    pool.query<{ authorized: string | null; used: string | null }>(
      `SELECT (SELECT COALESCE(sum(authorized_hours), 0)::text FROM budget_authorizations) AS authorized,
              (SELECT COALESCE(sum(allocation_hours), 0)::text FROM service_allocations)   AS used`,
    ),
    pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM individuals)::text           AS individuals,
              (SELECT count(*) FROM employees)::text             AS employees,
              (SELECT count(*) FROM payroll_transactions)::text  AS transactions,
              (SELECT count(*) FROM service_sessions)::text      AS sessions,
              -- 'detected' is the value the group detector writes for a
              -- confirmed multi-individual session; 'single' and
              -- 'needs_review' are the other two states.
              (SELECT count(*) FROM service_sessions
                 WHERE group_detection_status = 'detected')::text AS groups,
              (SELECT count(*) FROM import_batches)::text        AS imports,
              (SELECT count(*) FROM import_rows
                 WHERE status = 'needs_review')::text            AS review_rows,
              (SELECT count(*) FROM rate_exceptions x
                 WHERE x.resolution = 'open'
                   AND ${actionableRateExceptionSource("x")})::text AS rate_exceptions`,
    ),
    pool.query<{ c: string }>(
      `SELECT ((SELECT count(*) FROM individual_aliases WHERE status = 'pending')
             + (SELECT count(*) FROM employee_aliases  WHERE status = 'pending'))::text AS c`,
    ),
  ]);

  const agencyGross = toMoney(totalsRes.rows[0]?.agency ?? 0);
  const internalAmount = toMoney(totalsRes.rows[0]?.internal ?? 0);
  const accounts = Number(cashRes.rows[0]?.accounts ?? 0);
  const authorizedHours = toMoney(authRes.rows[0]?.authorized ?? 0);
  const usedHours = toMoney(authRes.rows[0]?.used ?? 0);
  const authorized = dec(authorizedHours);

  const counts = countsRes.rows[0] ?? {};
  const recentImports = await listImports(pool, 5);
  const reconciliation = await getReconciliation(pool, 5);
  const forecast = await getPortfolioForecast(pool);

  return {
    totals: {
      agencyGross,
      internalAmount,
      agencyRetention: toMoney(dec(agencyGross).minus(dec(internalAmount))),
    },
    employeeCash: {
      amount: toMoney(cashRes.rows[0]?.amount ?? 0),
      accounts,
      available: accounts > 0,
    },
    authorization: {
      available: authorized.gt(0),
      authorizedHours,
      usedHours,
      remainingHours: toMoney(authorized.minus(dec(usedHours))),
      utilizationPercent: authorized.gt(0)
        ? dec(usedHours).dividedBy(authorized).times(100).toDecimalPlaces(1).toFixed(1)
        : null,
    },
    counts: {
      individuals: Number(counts.individuals ?? 0),
      employees: Number(counts.employees ?? 0),
      transactions: Number(counts.transactions ?? 0),
      serviceSessions: Number(counts.sessions ?? 0),
      groupSessions: Number(counts.groups ?? 0),
      imports: Number(counts.imports ?? 0),
      reviewRows: Number(counts.review_rows ?? 0),
      openRateExceptions: Number(counts.rate_exceptions ?? 0),
      pendingAliases: Number(aliasRes.rows[0]?.c ?? 0),
    },
    recentImports,
    reconciliation,
    forecast,
  };
}

/**
 * A portfolio-level forecast, or an explicit reason why there is not one.
 * Never invents an exhaustion date: if the inputs are missing the caller is
 * told which input is missing.
 */
export async function getPortfolioForecast(
  pool: PgLikePool,
): Promise<{ available: false; reason: string } | { available: true; result: ForecastResult }> {
  const { rows } = await pool.query<{
    start_date: string | null;
    end_date: string | null;
    authorized: string | null;
    used: string | null;
    observations: string;
  }>(
    `SELECT min(bp.start_date)::text AS start_date,
            max(bp.end_date)::text   AS end_date,
            (SELECT COALESCE(sum(authorized_hours), 0)::text FROM budget_authorizations) AS authorized,
            (SELECT COALESCE(sum(allocation_hours), 0)::text FROM service_allocations)   AS used,
            (SELECT count(*)::text FROM payroll_transactions)                            AS observations
     FROM budget_periods bp`,
  );

  const row = rows[0];
  if (!row?.start_date || !row.end_date) {
    return {
      available: false,
      reason:
        "No budget period has been recorded yet. Import the Calculations sheet to establish " +
        "authorized hours and a period, and a projection becomes possible.",
    };
  }
  const elapsed = calculatePeriodElapsed({ startDate: row.start_date, endDate: row.end_date });
  const result = calculateForecast({
    authorizedHours: row.authorized ?? 0,
    usedHours: row.used ?? 0,
    elapsed,
    periodStartDate: row.start_date,
    observationCount: Number(row.observations ?? 0),
  });
  return { available: true, result };
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImportListRow {
  fileId: string;
  batchId: string | null;
  filename: string;
  byteSize: number;
  checksum: string;
  uploadedAt: string;
  uploadedBy: string | null;
  status: string;
  totalRows: number;
  validRows: number;
  importedRows: number;
  warningRows: number;
  errorRows: number;
  duplicateRows: number;
  committedAt: string | null;
}

const IMPORT_LIST_SQL = `
  SELECT f.id                       AS file_id,
         b.id                       AS batch_id,
         f.original_filename        AS filename,
         f.byte_size                AS byte_size,
         f.checksum_sha256          AS checksum,
         f.uploaded_at::text        AS uploaded_at,
         u.display_name             AS uploaded_by,
         COALESCE(b.status, 'pending') AS status,
         COALESCE(b.total_rows, 0)     AS total_rows,
         COALESCE(b.valid_rows, 0)     AS valid_rows,
         COALESCE(b.imported_rows, 0)  AS imported_rows,
         COALESCE(b.warning_rows, 0)   AS warning_rows,
         COALESCE(b.error_rows, 0)     AS error_rows,
         COALESCE(b.duplicate_rows, 0) AS duplicate_rows,
         b.committed_at::text          AS committed_at
  FROM imported_files f
  LEFT JOIN import_batches b ON b.imported_file_id = f.id
  LEFT JOIN users u         ON u.id = f.uploaded_by_user_id
`;

interface ImportListDbRow {
  file_id: string;
  batch_id: string | null;
  filename: string;
  byte_size: number;
  checksum: string;
  uploaded_at: string;
  uploaded_by: string | null;
  status: string;
  total_rows: number;
  valid_rows: number;
  imported_rows: number;
  warning_rows: number;
  error_rows: number;
  duplicate_rows: number;
  committed_at: string | null;
}

function toImportRow(r: ImportListDbRow): ImportListRow {
  return {
    fileId: r.file_id,
    batchId: r.batch_id,
    filename: r.filename,
    byteSize: Number(r.byte_size),
    checksum: r.checksum,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    status: r.status,
    totalRows: Number(r.total_rows),
    validRows: Number(r.valid_rows),
    importedRows: Number(r.imported_rows),
    warningRows: Number(r.warning_rows),
    errorRows: Number(r.error_rows),
    duplicateRows: Number(r.duplicate_rows),
    committedAt: r.committed_at,
  };
}

export async function listImports(pool: PgLikePool, limit = 50): Promise<ImportListRow[]> {
  const { rows } = await pool.query<ImportListDbRow>(
    `${IMPORT_LIST_SQL} ORDER BY f.uploaded_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toImportRow);
}

export async function getImport(pool: PgLikePool, fileId: string): Promise<ImportListRow | null> {
  if (!isUuid(fileId)) return null;
  const { rows } = await pool.query<ImportListDbRow>(`${IMPORT_LIST_SQL} WHERE f.id = $1`, [fileId]);
  return rows[0] ? toImportRow(rows[0]) : null;
}

export interface ImportRowRecord {
  id: string;
  sourceRowNumber: number;
  status: string;
  sheetName: string;
  validationErrors: unknown;
  fingerprint: string | null;
  raw: Record<string, string>;
  individual: string | null;
  employee: string | null;
  program: string | null;
}

export async function listImportRows(
  pool: PgLikePool,
  batchId: string,
  options: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: ImportRowRecord[]; total: number }> {
  if (!isUuid(batchId)) return { rows: [], total: 0 };
  const limit = clampLimit(options.limit, 100);
  const offset = Math.max(0, options.offset ?? 0);
  const statusFilter = ALLOWED_ROW_STATUSES.has(options.status ?? "") ? options.status! : null;

  const { rows: countRows } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM import_rows
     WHERE import_batch_id = $1 AND ($2::text IS NULL OR status = $2)`,
    [batchId, statusFilter],
  );

  const { rows } = await pool.query<{
    id: string;
    source_row_number: number;
    status: string;
    sheet_name: string;
    validation_errors: unknown;
    transaction_fingerprint: string | null;
    raw_values: Record<string, string>;
    individual: string | null;
    employee: string | null;
    program: string | null;
  }>(
    `SELECT r.id, r.source_row_number, r.status, r.sheet_name, r.validation_errors,
            r.transaction_fingerprint, r.raw_values,
            i.display_name AS individual, e.display_name AS employee, p.name AS program
     FROM import_rows r
     LEFT JOIN individuals i ON i.id = r.resolved_individual_id
     LEFT JOIN employees   e ON e.id = r.resolved_employee_id
     LEFT JOIN programs    p ON p.id = r.resolved_program_id
     WHERE r.import_batch_id = $1 AND ($2::text IS NULL OR r.status = $2)
     ORDER BY r.source_row_number
     LIMIT $3 OFFSET $4`,
    [batchId, statusFilter, limit, offset],
  );

  return {
    total: Number(countRows[0]?.c ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      sourceRowNumber: r.source_row_number,
      status: r.status,
      sheetName: r.sheet_name,
      validationErrors: r.validation_errors,
      fingerprint: r.transaction_fingerprint,
      raw: r.raw_values ?? {},
      individual: r.individual,
      employee: r.employee,
      program: r.program,
    })),
  };
}

/**
 * Statuses as stored on import_rows. A row that staged `valid` and became a
 * transaction is recorded as `imported`; the other three carry their staging
 * status through unchanged so an unresolved row is never lost.
 */
export const ALLOWED_ROW_STATUSES = new Set(["imported", "invalid", "needs_review", "duplicate"]);

export const ROW_STATUS_LABELS: Record<string, string> = {
  imported: "Imported",
  needs_review: "Needs review",
  invalid: "Invalid",
  duplicate: "Duplicate",
};

export interface ImportWarningRecord {
  id: string;
  category: string;
  severity: string;
  message: string;
  details: unknown;
  sourceRowNumber: number | null;
  resolvedAt: string | null;
}

export async function listImportWarnings(
  pool: PgLikePool,
  batchId: string,
  limit = 200,
): Promise<ImportWarningRecord[]> {
  if (!isUuid(batchId)) return [];
  const { rows } = await pool.query<{
    id: string;
    category: string;
    severity: string;
    message: string;
    details: unknown;
    source_row_number: number | null;
    resolved_at: string | null;
  }>(
    `SELECT w.id, w.category, w.severity, w.message, w.details,
            r.source_row_number, w.resolved_at::text AS resolved_at
     FROM import_warnings w
     LEFT JOIN import_rows r ON r.id = w.import_row_id
     WHERE w.import_batch_id = $1
     ORDER BY CASE w.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
              r.source_row_number NULLS FIRST
     LIMIT $2`,
    [batchId, clampLimit(limit, 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    message: r.message,
    details: r.details,
    sourceRowNumber: r.source_row_number,
    resolvedAt: r.resolved_at,
  }));
}

export async function getReconciliation(
  pool: PgLikePool,
  limit = 20,
): Promise<ReconciliationStatus[]> {
  const { rows } = await pool.query<{
    id: string;
    filename: string;
    committed_at: string | null;
    source_agency_gross: string | null;
    imported_agency_gross: string | null;
    source_internal_amount: string | null;
    imported_internal_amount: string | null;
    reconciliation_notes: string | null;
  }>(
    `SELECT b.id, f.original_filename AS filename, b.committed_at::text AS committed_at,
            b.source_agency_gross::text, b.imported_agency_gross::text,
            b.source_internal_amount::text, b.imported_internal_amount::text,
            b.reconciliation_notes
     FROM import_batches b
     JOIN imported_files f ON f.id = b.imported_file_id
     ORDER BY b.created_at DESC
     LIMIT $1`,
    [clampLimit(limit, 100)],
  );

  return rows.map((r) => {
    const agencyDifference =
      r.source_agency_gross != null && r.imported_agency_gross != null
        ? toMoney(dec(r.imported_agency_gross).minus(dec(r.source_agency_gross)))
        : null;
    const internalDifference =
      r.source_internal_amount != null && r.imported_internal_amount != null
        ? toMoney(dec(r.imported_internal_amount).minus(dec(r.source_internal_amount)))
        : null;
    const balanced =
      agencyDifference == null && internalDifference == null
        ? null
        : dec(agencyDifference ?? 0).abs().lte("0.01") &&
          dec(internalDifference ?? 0).abs().lte("0.01");
    return {
      batchId: r.id,
      filename: r.filename,
      committedAt: r.committed_at,
      sourceAgencyGross: r.source_agency_gross,
      importedAgencyGross: r.imported_agency_gross,
      sourceInternalAmount: r.source_internal_amount,
      importedInternalAmount: r.imported_internal_amount,
      agencyDifference,
      internalDifference,
      balanced,
      notes: r.reconciliation_notes,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Employees, transactions, exceptions                                         */
/* -------------------------------------------------------------------------- */

export interface EmployeeListRow {
  id: string;
  displayName: string;
  transactionCount: number;
  physicalHours: string;
  agencyGross: string;
  individualsServed: number;
}

export async function listEmployees(pool: PgLikePool): Promise<EmployeeListRow[]> {
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    transaction_count: string;
    physical_hours: string | null;
    agency_gross: string | null;
    individuals_served: string;
  }>(
    `SELECT e.id, e.display_name,
            count(t.id)::text                                  AS transaction_count,
            COALESCE(sum(t.imported_hours), 0)::text           AS physical_hours,
            COALESCE(sum(t.imported_amount), 0)::text          AS agency_gross,
            count(DISTINCT t.individual_id)::text              AS individuals_served
     FROM employees e
     LEFT JOIN payroll_transactions t ON t.employee_id = e.id
     GROUP BY e.id, e.display_name
     ORDER BY e.display_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    transactionCount: Number(r.transaction_count),
    physicalHours: toMoney(r.physical_hours ?? 0),
    agencyGross: toMoney(r.agency_gross ?? 0),
    individualsServed: Number(r.individuals_served),
  }));
}

export interface TransactionRow {
  id: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  individual: string | null;
  individualId: string | null;
  employee: string | null;
  employeeId: string | null;
  program: string | null;
  hours: string | null;
  rate: string | null;
  amount: string | null;
  internalAmount: string | null;
  isGroup: boolean;
  duplicateStatus: string;
  sourceFile: string | null;
  sourceRowNumber: number | null;
}

export interface TransactionFilters {
  individualId?: string;
  employeeId?: string;
  programCode?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /** When present, restricts ledger rows to this user's direct person grants. */
  scope?: AccessScope;
}

export async function listTransactions(
  pool: PgLikePool,
  filters: TransactionFilters = {},
): Promise<{ rows: TransactionRow[]; total: number; totals: MoneyTotals }> {
  const limit = clampLimit(filters.limit, 100);
  const offset = Math.max(0, filters.offset ?? 0);
  const individualId = isUuid(filters.individualId ?? "") ? filters.individualId! : null;
  const employeeId = isUuid(filters.employeeId ?? "") ? filters.employeeId! : null;
  const programCode = filters.programCode?.trim() || null;
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  // Every user-supplied value is a bound parameter; nothing is interpolated.
  const params: unknown[] = [individualId, employeeId, programCode, search];
  const scopeClause = filters.scope
    ? transactionScopeClause(filters.scope, "t.individual_id", "t.employee_id", params)
    : "";
  const where = `
    WHERE ($1::uuid IS NULL OR t.individual_id = $1)
      AND ($2::uuid IS NULL OR t.employee_id  = $2)
      AND ($3::text IS NULL OR p.code = $3)
      AND ($4::text IS NULL OR i.display_name ILIKE $4 OR e.display_name ILIKE $4
           OR t.check_number ILIKE $4 OR t.individual_raw ILIKE $4 OR t.employee_raw ILIKE $4)${scopeClause}
  `;

  const joins = `
    FROM payroll_transactions t
    LEFT JOIN individuals i ON i.id = t.individual_id
    LEFT JOIN employees   e ON e.id = t.employee_id
    LEFT JOIN programs    p ON p.id = t.program_id
  `;

  const [countRes, totalsRes, rowsRes] = await Promise.all([
    pool.query<{ c: string }>(`SELECT count(*)::text AS c ${joins} ${where}`, params),
    pool.query<{ agency: string | null; internal: string | null }>(
      `SELECT COALESCE(sum(t.imported_amount), 0)::text            AS agency,
              COALESCE(sum(t.calculated_internal_amount), 0)::text AS internal
       ${joins} ${where}`,
      params,
    ),
    pool.query<{
      id: string;
      check_number: string | null;
      check_date: string | null;
      period_begin: string | null;
      period_end: string | null;
      individual: string | null;
      individual_id: string | null;
      employee: string | null;
      employee_id: string | null;
      program: string | null;
      hours: string | null;
      rate: string | null;
      amount: string | null;
      internal_amount: string | null;
      is_group_service: boolean;
      duplicate_status: string;
      source_file: string | null;
      source_row_number: number | null;
    }>(
      `SELECT t.id, t.check_number, t.check_date::text AS check_date,
              t.period_begin::text AS period_begin, t.period_end::text AS period_end,
              COALESCE(i.display_name, t.individual_raw) AS individual,
              t.individual_id,
              COALESCE(e.display_name, t.employee_raw)   AS employee,
              t.employee_id,
              COALESCE(p.name, t.program_raw)            AS program,
              t.imported_hours::text  AS hours,
              t.imported_rate::text   AS rate,
              t.imported_amount::text AS amount,
              t.calculated_internal_amount::text AS internal_amount,
              t.is_group_service, t.duplicate_status,
              f.original_filename AS source_file, t.source_row_number
       ${joins}
       LEFT JOIN imported_files f ON f.id = t.source_file_id
       ${where}
       ORDER BY t.check_date DESC NULLS LAST, t.source_row_number NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ]);

  const agencyGross = toMoney(totalsRes.rows[0]?.agency ?? 0);
  const internalAmount = toMoney(totalsRes.rows[0]?.internal ?? 0);

  return {
    total: Number(countRes.rows[0]?.c ?? 0),
    totals: {
      agencyGross,
      internalAmount,
      agencyRetention: toMoney(dec(agencyGross).minus(dec(internalAmount))),
    },
    rows: rowsRes.rows.map((r) => redactTransactionFields({
      id: r.id,
      checkNumber: r.check_number,
      checkDate: r.check_date,
      periodBegin: r.period_begin,
      periodEnd: r.period_end,
      individual: r.individual,
      individualId: r.individual_id,
      employee: r.employee,
      employeeId: r.employee_id,
      program: r.program,
      hours: r.hours,
      rate: r.rate,
      amount: r.amount,
      internalAmount: r.internal_amount,
      isGroup: r.is_group_service,
      duplicateStatus: r.duplicate_status,
      sourceFile: r.source_file,
      sourceRowNumber: r.source_row_number,
    }, filters.scope)),
  };
}

export interface RateExceptionRow {
  id: string;
  individual: string | null;
  program: string | null;
  importedRate: string;
  expectedRate: string;
  varianceAmount: string;
  variancePercent: string;
  direction: string;
  resolution: string;
  note: string | null;
  checkNumber: string | null;
  sourceRowNumber: number | null;
}

export async function listRateExceptions(
  pool: PgLikePool,
  options: { resolution?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: RateExceptionRow[]; total: number }> {
  const limit = clampLimit(options.limit, 200);
  const offset = Math.max(0, options.offset ?? 0);
  const resolution = ["open", "accepted", "corrected"].includes(options.resolution ?? "")
    ? options.resolution!
    : null;

  const where = `WHERE ${actionableRateExceptionSource("x")}
                   AND ($1::text IS NULL OR x.resolution = $1)`;
  const [countRes, rowsRes] = await Promise.all([
    pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM rate_exceptions x ${where}`, [
      resolution,
    ]),
    pool.query<{
      id: string;
      individual: string | null;
      program: string | null;
      imported_rate: string;
      expected_rate: string;
      variance_amount: string;
      variance_percent: string;
      direction: string;
      resolution: string;
      note: string | null;
      check_number: string | null;
      source_row_number: number | null;
    }>(
      `SELECT x.id, i.display_name AS individual, p.name AS program,
              x.imported_rate::text, x.expected_rate::text,
              x.variance_amount::text, x.variance_percent::text,
              x.direction, x.resolution, x.note,
              t.check_number, t.source_row_number
       FROM rate_exceptions x
       LEFT JOIN individuals i ON i.id = x.individual_id
       LEFT JOIN programs    p ON p.id = x.program_id
       LEFT JOIN payroll_transactions t ON t.id = x.payroll_transaction_id
       ${where}
       ORDER BY abs(x.variance_percent) DESC
       LIMIT $2 OFFSET $3`,
      [resolution, limit, offset],
    ),
  ]);

  return {
    total: Number(countRes.rows[0]?.c ?? 0),
    rows: rowsRes.rows.map((r) => ({
      id: r.id,
      individual: r.individual,
      program: r.program,
      importedRate: r.imported_rate,
      expectedRate: r.expected_rate,
      varianceAmount: r.variance_amount,
      variancePercent: r.variance_percent,
      direction: r.direction,
      resolution: r.resolution,
      note: r.note,
      checkNumber: r.check_number,
      sourceRowNumber: r.source_row_number,
    })),
  };
}

export interface PendingAliasRow {
  id: string;
  kind: "individual" | "employee";
  alias: string;
  sourceText: string;
  targetName: string;
  status: string;
}

export async function listPendingAliases(pool: PgLikePool): Promise<PendingAliasRow[]> {
  const { rows } = await pool.query<{
    id: string;
    kind: string;
    alias: string;
    source_text: string;
    target_name: string;
    status: string;
  }>(
    `SELECT a.id, 'individual' AS kind, a.normalized_alias AS alias, a.source_text,
            i.display_name AS target_name, a.status
     FROM individual_aliases a JOIN individuals i ON i.id = a.individual_id
     WHERE a.status = 'pending'
     UNION ALL
     SELECT a.id, 'employee' AS kind, a.normalized_alias AS alias, a.source_text,
            e.display_name AS target_name, a.status
     FROM employee_aliases a JOIN employees e ON e.id = a.employee_id
     WHERE a.status = 'pending'
     ORDER BY alias`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "employee" ? "employee" : "individual",
    alias: r.alias,
    sourceText: r.source_text,
    targetName: r.target_name,
    status: r.status,
  }));
}

export interface ProgramRow {
  id: string;
  code: string;
  name: string;
  isGroupCapable: boolean;
  isActive: boolean;
  agencyRate: string | null;
  internalRate: string | null;
  effectiveFrom: string | null;
  aliasCount: number;
}

export async function listPrograms(pool: PgLikePool): Promise<ProgramRow[]> {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    is_group_capable: boolean;
    is_active: boolean;
    alias_count: string;
    as_of: string;
  }>(
    `SELECT p.id, p.code, p.name, p.is_group_capable, p.is_active,
            (SELECT count(*)::text FROM program_aliases a WHERE a.program_id = p.id) AS alias_count,
            CURRENT_DATE::text AS as_of
     FROM programs p
     ORDER BY p.code`,
  );

  const { rows: schedules } = await pool.query<{
    program_id: string;
    agency_rate: string | null;
    internal_rate: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT program_id, agency_rate::text AS agency_rate, internal_rate::text AS internal_rate,
            effective_from::text AS effective_from, effective_to::text AS effective_to
     FROM program_rate_schedules`,
  );
  const byProgram = new Map<string, typeof schedules>();
  for (const s of schedules) {
    const list = byProgram.get(s.program_id) ?? [];
    list.push(s);
    byProgram.set(s.program_id, list);
  }

  return rows.map((r) => {
    // The one effective-dated resolver picks the row in force on CURRENT_DATE.
    const chosen = pickEffectiveRateRow(
      (byProgram.get(r.id) ?? []).map((s) => ({
        effectiveFrom: s.effective_from,
        effectiveTo: s.effective_to,
        agencyRate: s.agency_rate,
        internalRate: s.internal_rate,
      })),
      r.as_of,
    );
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      isGroupCapable: r.is_group_capable,
      isActive: r.is_active,
      agencyRate: chosen ? chosen.agencyRate ?? null : null,
      internalRate: chosen ? chosen.internalRate : null,
      effectiveFrom: chosen ? chosen.effectiveFrom : null,
      aliasCount: Number(r.alias_count),
    };
  });
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string | null;
  actor: string | null;
  createdAt: string;
  metadata: unknown;
}

export async function listAudit(pool: PgLikePool, limit = 50): Promise<AuditRow[]> {
  const { rows } = await pool.query<{
    id: string;
    action: string;
    entity_type: string | null;
    actor: string | null;
    created_at: string;
    metadata: unknown;
  }>(
    `SELECT a.id, a.action, a.entity_type, u.display_name AS actor,
            a.created_at::text AS created_at, a.metadata
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC
     LIMIT $1`,
    [clampLimit(limit, 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entity_type,
    actor: r.actor,
    createdAt: r.created_at,
    metadata: r.metadata,
  }));
}

/* -------------------------------------------------------------------------- */

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value as number)), 500);
}

export { addMoney, type PeriodElapsed };
