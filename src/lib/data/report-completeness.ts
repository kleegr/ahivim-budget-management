import { fullAccess } from "@/lib/auth/access";
import { agencyMonth } from "@/lib/business/agency-time";
import { dec, toHours, toMoney } from "@/lib/money";
import { getSettlementDashboard, type SettlementRow } from "@/lib/data/settlements";
import { listTransactionsForGrid, type GridTransaction } from "@/lib/data/transactions-grid";
import type { PgLikePool } from "@/lib/import/commit";
import { collectionsPayrollCheckFocusHref } from "@/lib/nav/collections-links";
import { importCorrectionsHref } from "@/lib/nav/review-actions";
import { txLink } from "@/lib/nav/tx-link";

const asDate = (value: string | undefined): string | undefined =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

const includes = (value: string | null | undefined, needle: string | undefined): boolean =>
  !needle?.trim()
  || (value ?? "").toLocaleLowerCase().includes(needle.trim().toLocaleLowerCase());

function inDateRange(value: string | null | undefined, from?: string, to?: string): boolean {
  if (from && (!value || value < from)) return false;
  if (to && (!value || value > to)) return false;
  return true;
}

export interface BillingWithoutBudgetRow {
  individualId: string;
  individualName: string;
  programId: string | null;
  programCode: string | null;
  programName: string | null;
  firstServiceDate: string | null;
  lastServiceDate: string | null;
  transactionCount: number;
  recordedHours: string;
  funderBilled: string;
  sourceHref: string;
}

/**
 * Service-date authorization coverage paired with the canonical transaction
 * projection so a later budget cannot hide an earlier uncovered bill (and an
 * expired, correctly-covered authorization is still honored).
 */
export async function billingWithoutBudgetReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; individual?: string; program?: string } = {},
): Promise<BillingWithoutBudgetRow[]> {
  const from = asDate(opts.from);
  const to = asDate(opts.to);
  const scope = fullAccess("reports", "manager");
  const [transactions, uncovered] = await Promise.all([
    listTransactionsForGrid(pool, scope),
    pool.query<{ id: string }>(
      `WITH activity AS (
         SELECT tx.id,
                tx.individual_id,
                tx.program_id,
                canonical_service_date(
                  tx.period_begin,
                  tx.check_date,
                  tx.period_end
                ) AS service_date
           FROM payroll_transactions tx
           JOIN individuals individual ON individual.id = tx.individual_id
           LEFT JOIN programs program ON program.id = tx.program_id
          WHERE canonical_service_date(
                  tx.period_begin,
                  tx.check_date,
                  tx.period_end
                ) IS NOT NULL
            AND ($1::date IS NULL OR canonical_service_date(
                  tx.period_begin,
                  tx.check_date,
                  tx.period_end
                ) >= $1)
            AND ($2::date IS NULL OR canonical_service_date(
                  tx.period_begin,
                  tx.check_date,
                  tx.period_end
                ) <= $2)
            AND ($3::text IS NULL OR individual.id::text = $3
                 OR individual.display_name ILIKE '%' || $3 || '%')
            AND ($4::text IS NULL OR program.code ILIKE '%' || $4 || '%'
                 OR program.name ILIKE '%' || $4 || '%'
                 OR tx.program_raw ILIKE '%' || $4 || '%')
       )
       SELECT activity.id
         FROM activity
        WHERE activity.program_id IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM program_budget_balances historical
              WHERE historical.individual_id = activity.individual_id
                AND historical.program_id = activity.program_id
                AND activity.service_date BETWEEN historical.start_date AND historical.end_date
                AND (
                  (historical.required_auth_type = 'hours' AND historical.authorized_hours > 0)
                  OR (historical.required_auth_type = 'dollars'
                    AND COALESCE(historical.authorized_dollars, 0) > 0)
                  OR (historical.required_auth_type = 'both'
                    AND historical.authorized_hours > 0
                    AND COALESCE(historical.authorized_dollars, 0) > 0)
                )
             UNION ALL
             SELECT 1
               FROM effective_budget_authorizations_at(activity.service_date) effective
               JOIN programs effective_program ON effective_program.id = effective.program_id
              WHERE effective.individual_id = activity.individual_id
                AND effective.program_id = activity.program_id
                AND effective_program.required_auth_type = 'hours'
                AND effective.authorized_hours > 0
           )`,
      [from ?? null, to ?? null, opts.individual?.trim() || null, opts.program?.trim() || null],
    ),
  ]);
  const uncoveredIds = new Set(uncovered.rows.map((row) => row.id));
  const grouped = new Map<string, {
    individualId: string;
    individualName: string;
    programId: string | null;
    programCode: string | null;
    programName: string | null;
    firstServiceDate: string | null;
    lastServiceDate: string | null;
    transactionCount: number;
    recordedHours: ReturnType<typeof dec>;
    funderBilled: ReturnType<typeof dec>;
  }>();

  for (const transaction of transactions) {
    if (!transaction.individualId || !uncoveredIds.has(transaction.id)) continue;
    const programKey = transaction.programId
      ?? `${transaction.programCode ?? ""}:${transaction.program ?? "Unassigned"}`;
    const key = `${transaction.individualId}:${programKey}`;
    const current = grouped.get(key) ?? {
      individualId: transaction.individualId,
      individualName: transaction.individual ?? "Unknown individual",
      programId: transaction.programId,
      programCode: transaction.programCode,
      programName: transaction.program,
      firstServiceDate: null,
      lastServiceDate: null,
      transactionCount: 0,
      recordedHours: dec(0),
      funderBilled: dec(0),
    };
    if (transaction.serviceDate) {
      if (!current.firstServiceDate || transaction.serviceDate < current.firstServiceDate) {
        current.firstServiceDate = transaction.serviceDate;
      }
      if (!current.lastServiceDate || transaction.serviceDate > current.lastServiceDate) {
        current.lastServiceDate = transaction.serviceDate;
      }
    }
    current.transactionCount += 1;
    current.recordedHours = current.recordedHours.plus(transaction.hours ?? 0);
    current.funderBilled = current.funderBilled.plus(transaction.gross ?? 0);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((row) => ({
      individualId: row.individualId,
      individualName: row.individualName,
      programId: row.programId,
      programCode: row.programCode,
      programName: row.programName,
      firstServiceDate: row.firstServiceDate,
      lastServiceDate: row.lastServiceDate,
      transactionCount: row.transactionCount,
      recordedHours: toHours(row.recordedHours),
      funderBilled: toMoney(row.funderBilled),
      sourceHref: txLink({
        individualId: row.individualId,
        serviceFrom: from,
        serviceTo: to,
        programCode: row.programCode,
        program: row.programCode ? null : row.programName,
      }),
    }))
    .sort((left, right) => (
      left.individualName.localeCompare(right.individualName)
      || (left.programCode ?? left.programName ?? "").localeCompare(
        right.programCode ?? right.programName ?? "",
      )
    ));
}

export async function transactionsReport(
  pool: PgLikePool,
  opts: {
    from?: string;
    to?: string;
    employee?: string;
    individual?: string;
    program?: string;
    checkNumber?: string;
  } = {},
): Promise<GridTransaction[]> {
  const from = asDate(opts.from);
  const to = asDate(opts.to);
  const rows = await listTransactionsForGrid(pool, fullAccess("reports", "manager"));
  return rows.filter((row) => (
    inDateRange(row.serviceDate, from, to)
    && includes(row.employee, opts.employee)
    && includes(row.individual, opts.individual)
    && includes(`${row.programCode ?? ""} ${row.program ?? ""}`, opts.program)
    && includes(row.checkNumber, opts.checkNumber)
  ));
}

export interface EmployeeActivityRow {
  employeeId: string;
  employeeName: string;
  firstServiceDate: string | null;
  lastServiceDate: string | null;
  transactionCount: number;
  individualCount: number;
  programCount: number;
  creditedHours: string;
  physicalHours: string;
  groupSessions: number;
  funderBilled: string;
  employeeBase: string;
  sourceHref: string;
}

/** Recorded employee activity with group-session physical time counted once. */
export async function employeeActivityReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; employee?: string; program?: string } = {},
): Promise<EmployeeActivityRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const employee = opts.employee?.trim() || null;
  const program = opts.program?.trim() || null;
  const { rows } = await pool.query<{
    employee_id: string;
    employee_name: string;
    first_service_date: string | null;
    last_service_date: string | null;
    transaction_count: string;
    individual_count: string;
    program_count: string;
    credited_hours: string;
    physical_hours: string;
    group_sessions: string;
    funder_billed: string;
    employee_base: string;
  }>(
    `WITH activity AS (
       SELECT t.*,
              canonical_service_date(t.period_begin, t.check_date, t.period_end) AS service_date
         FROM payroll_transactions t
         JOIN employees employee ON employee.id = t.employee_id
         LEFT JOIN programs program_row ON program_row.id = t.program_id
        WHERE ($1::date IS NULL OR canonical_service_date(t.period_begin, t.check_date, t.period_end) >= $1)
          AND ($2::date IS NULL OR canonical_service_date(t.period_begin, t.check_date, t.period_end) <= $2)
          AND ($3::text IS NULL OR employee.id::text = $3 OR employee.display_name ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR program_row.code ILIKE '%' || $4 || '%' OR program_row.name ILIKE '%' || $4 || '%')
     ), transaction_totals AS (
       SELECT employee_id,
              min(service_date)::text AS first_service_date,
              max(service_date)::text AS last_service_date,
              count(*)::text AS transaction_count,
              count(DISTINCT individual_id)::text AS individual_count,
              count(DISTINCT program_id)::text AS program_count,
              COALESCE(sum(imported_hours), 0)::text AS credited_hours,
              COALESCE(sum(imported_amount), 0)::text AS funder_billed,
              COALESCE(sum(COALESCE(
                calculated_internal_amount,
                spreadsheet_internal_amount,
                internal_rate_applied * imported_hours,
                0
              )), 0)::text AS employee_base
         FROM activity
        GROUP BY employee_id
     ), physical_sessions AS (
       SELECT activity.employee_id,
              COALESCE('session:' || activity.service_session_id::text, 'transaction:' || activity.id::text) AS activity_key,
              max(COALESCE(session.physical_hours, activity.imported_hours, 0)) AS physical_hours,
              bool_or(COALESCE(session.group_size > 1, false) OR activity.is_group_service) AS is_group
         FROM activity
         LEFT JOIN service_sessions session ON session.id = activity.service_session_id
        GROUP BY activity.employee_id,
                 COALESCE('session:' || activity.service_session_id::text, 'transaction:' || activity.id::text)
     ), physical_totals AS (
       SELECT employee_id,
              COALESCE(sum(physical_hours), 0)::text AS physical_hours,
              count(*) FILTER (WHERE is_group)::text AS group_sessions
         FROM physical_sessions
        GROUP BY employee_id
     )
     SELECT employee.id AS employee_id,
            employee.display_name AS employee_name,
            totals.first_service_date,
            totals.last_service_date,
            totals.transaction_count,
            totals.individual_count,
            totals.program_count,
            totals.credited_hours,
            COALESCE(physical.physical_hours, '0') AS physical_hours,
            COALESCE(physical.group_sessions, '0') AS group_sessions,
            totals.funder_billed,
            totals.employee_base
       FROM transaction_totals totals
       JOIN employees employee ON employee.id = totals.employee_id
       LEFT JOIN physical_totals physical ON physical.employee_id = totals.employee_id
      ORDER BY employee.display_name`,
    [from, to, employee, program],
  );
  return rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    firstServiceDate: row.first_service_date,
    lastServiceDate: row.last_service_date,
    transactionCount: Number(row.transaction_count),
    individualCount: Number(row.individual_count),
    programCount: Number(row.program_count),
    creditedHours: toHours(row.credited_hours),
    physicalHours: toHours(row.physical_hours),
    groupSessions: Number(row.group_sessions),
    funderBilled: toMoney(row.funder_billed),
    employeeBase: toMoney(row.employee_base),
    sourceHref: txLink({
      employeeId: row.employee_id,
      serviceFrom: from,
      serviceTo: to,
      program,
    }),
  }));
}

export type MoneyReportKind = "give-back" | "agency-to-employee" | "credits";

export interface MoneyReportRow {
  id: string;
  personType: string;
  personId: string;
  personName: string;
  item: string;
  checkNumber: string | null;
  basisDate: string | null;
  originalAmount: string;
  recordedAmount: string;
  balance: string;
  state: string;
  sourceHref: string;
}

function settlementBasisDate(row: SettlementRow): string | null {
  return row.checkDate ?? row.periodEnd ?? row.periodBegin ?? row.createdAt.slice(0, 10);
}

function settlementHref(row: SettlementRow, kind: MoneyReportKind): string {
  const payrollCheckId = typeof row.calculation.payrollCheckId === "string"
    ? row.calculation.payrollCheckId
    : null;
  if (kind === "give-back" && payrollCheckId) {
    const month = (settlementBasisDate(row) ?? `${agencyMonth()}-01`).slice(0, 7);
    return collectionsPayrollCheckFocusHref({ payrollCheckId, month });
  }
  const params = new URLSearchParams({
    [row.personType === "employee" ? "employeeId" : "individualId"]: row.personId,
    queue: kind === "give-back" ? "receivable" : kind === "agency-to-employee" ? "payable" : "credit",
  });
  return `/settlements?${params.toString()}`;
}

/** Reuses the canonical settlement dashboard; no payment math is repeated. */
export async function moneyOperationsReport(
  pool: PgLikePool,
  kind: MoneyReportKind,
  opts: { from?: string; to?: string; person?: string; state?: string } = {},
): Promise<MoneyReportRow[]> {
  const from = asDate(opts.from);
  const to = asDate(opts.to);
  const data = await getSettlementDashboard(pool, fullAccess("reports", "manager"));
  return data.rows
    .filter((row) => {
      if (kind === "give-back" && !(row.personType === "employee" && row.direction === "receivable")) return false;
      if (kind === "agency-to-employee" && !(row.personType === "employee" && row.direction === "payable")) return false;
      if (kind === "credits" && row.state !== "credit") return false;
      if (!includes(row.personName, opts.person)) return false;
      if (opts.state?.trim() && row.state !== opts.state) return false;
      return inDateRange(settlementBasisDate(row), from, to);
    })
    .map((row) => ({
      id: row.id,
      personType: row.personType,
      personId: row.personId,
      personName: row.personName,
      item: row.label,
      checkNumber: row.checkNumber,
      basisDate: settlementBasisDate(row),
      originalAmount: row.originalAmount,
      recordedAmount: row.appliedAmount,
      balance: row.balance,
      state: row.state,
      sourceHref: settlementHref(row, kind),
    }));
}

export interface UnverifiedCheckRow {
  id: string;
  employeeId: string;
  employeeName: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  source: string;
  sourceRef: string | null;
  linkedTransactions: number;
  createdAt: string;
  sourceHref: string;
}

export async function unverifiedChecksReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; employee?: string; source?: string } = {},
): Promise<UnverifiedCheckRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const employee = opts.employee?.trim() || null;
  const source = opts.source?.trim() || null;
  const { rows } = await pool.query<{
    id: string;
    employee_id: string;
    employee_name: string;
    check_number: string | null;
    check_date: string | null;
    period_begin: string | null;
    period_end: string | null;
    source: string;
    source_ref: string | null;
    linked_transactions: string;
    created_at: string;
  }>(
    `SELECT check_fact.id,
            check_fact.employee_id,
            employee.display_name AS employee_name,
            check_fact.check_number,
            check_fact.check_date::text,
            check_fact.period_begin::text,
            check_fact.period_end::text,
            check_fact.source,
            check_fact.source_ref,
            count(tx.id)::text AS linked_transactions,
            check_fact.created_at::text
       FROM employee_payroll_checks check_fact
       JOIN employees employee ON employee.id = check_fact.employee_id
       LEFT JOIN payroll_transactions tx ON tx.payroll_check_id = check_fact.id
      WHERE check_fact.verification_status = 'unverified'
        AND ($1::date IS NULL OR COALESCE(check_fact.check_date, check_fact.period_end, check_fact.period_begin, check_fact.created_at::date) >= $1)
        AND ($2::date IS NULL OR COALESCE(check_fact.check_date, check_fact.period_end, check_fact.period_begin, check_fact.created_at::date) <= $2)
        AND ($3::text IS NULL OR employee.id::text = $3 OR employee.display_name ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR check_fact.source ILIKE '%' || $4 || '%' OR check_fact.source_ref ILIKE '%' || $4 || '%')
      GROUP BY check_fact.id, employee.display_name
      ORDER BY COALESCE(check_fact.check_date, check_fact.period_end, check_fact.period_begin, check_fact.created_at::date) DESC,
               employee.display_name`,
    [from, to, employee, source],
  );
  return rows.map((row) => {
    const month = (row.check_date ?? row.period_end ?? row.period_begin ?? row.created_at.slice(0, 10)).slice(0, 7);
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      source: row.source,
      sourceRef: row.source_ref,
      linkedTransactions: Number(row.linked_transactions),
      createdAt: row.created_at,
      sourceHref: collectionsPayrollCheckFocusHref({ payrollCheckId: row.id, month }),
    };
  });
}

export interface ImportConflictRow {
  id: string;
  type: string;
  status: string;
  individualName: string | null;
  employeeName: string | null;
  programName: string | null;
  detail: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  sourceHref: string;
}

export async function importConflictsReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; status?: string; type?: string } = {},
): Promise<ImportConflictRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const status = opts.status === "open" || opts.status === "resolved" ? opts.status : null;
  const type = opts.type === "changed" || opts.type === "missing" ? opts.type : null;
  const { rows } = await pool.query<{
    id: string;
    type: string;
    status: string;
    individual_name: string | null;
    employee_name: string | null;
    program_name: string | null;
    detail: string | null;
    resolution: string | null;
    resolution_note: string | null;
    resolved_by: string | null;
    created_at: string;
    resolved_at: string | null;
    payroll_transaction_id: string | null;
    import_row_id: string | null;
    source_file_id: string | null;
  }>(
    `SELECT conflict.id,
            conflict.type,
            conflict.status,
            individual.display_name AS individual_name,
            employee.display_name AS employee_name,
            program.name AS program_name,
            conflict.detail,
            conflict.resolution,
            conflict.resolution_note,
            resolver.display_name AS resolved_by,
            conflict.created_at::text,
            conflict.resolved_at::text,
            conflict.payroll_transaction_id,
            import_row.id AS import_row_id,
            imported_file.id AS source_file_id
       FROM sheet_sync_conflicts conflict
       LEFT JOIN payroll_transactions tx ON tx.id = conflict.payroll_transaction_id
       LEFT JOIN individuals individual ON individual.id = tx.individual_id
       LEFT JOIN employees employee ON employee.id = tx.employee_id
       LEFT JOIN programs program ON program.id = tx.program_id
       LEFT JOIN users resolver ON resolver.id = conflict.resolved_by_user_id
       LEFT JOIN sheet_sync_runs run ON run.id = conflict.run_id
       LEFT JOIN import_batches import_batch ON import_batch.id = run.import_batch_id
       LEFT JOIN imported_files imported_file ON imported_file.id = import_batch.imported_file_id
       LEFT JOIN sheet_sync_rows sync_row ON sync_row.id = conflict.sync_row_id
       LEFT JOIN import_rows import_row ON import_row.import_batch_id = import_batch.id
                                        AND import_row.source_row_number = COALESCE(
                                          sync_row.source_row_number,
                                          CASE WHEN (conflict.incoming->>'sourceRowNumber') ~ '^\d+$'
                                            THEN (conflict.incoming->>'sourceRowNumber')::int END
                                        )
      WHERE ($1::date IS NULL OR conflict.created_at::date >= $1)
        AND ($2::date IS NULL OR conflict.created_at::date <= $2)
        AND ($3::text IS NULL
          OR ($3 = 'open' AND conflict.status = 'open')
          OR ($3 = 'resolved' AND conflict.status <> 'open'))
        AND ($4::text IS NULL OR conflict.type = $4)
      ORDER BY CASE WHEN conflict.status = 'open' THEN 0 ELSE 1 END,
               conflict.created_at DESC`,
    [from, to, status, type],
  );
  return rows.map((row) => {
    const sourceHref = row.payroll_transaction_id
      ? txLink({ transactionId: row.payroll_transaction_id })
      : row.source_file_id && row.import_row_id
        ? importCorrectionsHref(row.source_file_id, row.import_row_id)
        : "/sync#sync-conflicts";
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      individualName: row.individual_name,
      employeeName: row.employee_name,
      programName: row.program_name,
      detail: row.detail,
      resolution: row.resolution,
      resolutionNote: row.resolution_note,
      resolvedBy: row.resolved_by,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      sourceHref,
    };
  });
}

export interface MergeHistoryRow {
  auditId: string;
  mergedAt: string;
  actor: string | null;
  kind: "individual" | "employee";
  survivorId: string;
  survivorName: string | null;
  foldedId: string | null;
  foldedName: string | null;
  repointed: string;
  reason: string | null;
  sourceHref: string;
}

export async function mergeHistoryReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; kind?: string } = {},
): Promise<MergeHistoryRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const kind = opts.kind === "individual" || opts.kind === "employee" ? opts.kind : null;
  const { rows } = await pool.query<{
    audit_id: string;
    merged_at: string;
    actor: string | null;
    kind: "individual" | "employee";
    survivor_id: string;
    survivor_name: string | null;
    folded_id: string | null;
    folded_name: string | null;
    repointed: string;
    reason: string | null;
  }>(
    `SELECT audit.id AS audit_id,
            audit.created_at::text AS merged_at,
            actor.display_name AS actor,
            audit.entity_type AS kind,
            audit.entity_id::text AS survivor_id,
            CASE audit.entity_type
              WHEN 'individual' THEN survivor_individual.display_name
              WHEN 'employee' THEN survivor_employee.display_name
            END AS survivor_name,
            audit.metadata->>'mergedId' AS folded_id,
            audit.metadata->>'mergedName' AS folded_name,
            COALESCE(audit.metadata->'repointed', '{}'::jsonb)::text AS repointed,
            audit.reason
       FROM audit_logs audit
       LEFT JOIN users actor ON actor.id = audit.user_id
       LEFT JOIN individuals survivor_individual
         ON audit.entity_type = 'individual' AND survivor_individual.id = audit.entity_id
       LEFT JOIN employees survivor_employee
         ON audit.entity_type = 'employee' AND survivor_employee.id = audit.entity_id
      WHERE audit.action IN ('individuals_merged', 'employees_merged')
        AND ($1::date IS NULL OR audit.created_at::date >= $1)
        AND ($2::date IS NULL OR audit.created_at::date <= $2)
        AND ($3::text IS NULL OR audit.entity_type = $3)
      ORDER BY audit.created_at DESC`,
    [from, to, kind],
  );
  return rows.map((row) => ({
    auditId: row.audit_id,
    mergedAt: row.merged_at,
    actor: row.actor,
    kind: row.kind,
    survivorId: row.survivor_id,
    survivorName: row.survivor_name,
    foldedId: row.folded_id,
    foldedName: row.folded_name,
    repointed: row.repointed,
    reason: row.reason,
    sourceHref: row.kind === "individual"
      ? `/individuals/${encodeURIComponent(row.survivor_id)}`
      : `/employees/${encodeURIComponent(row.survivor_id)}`,
  }));
}

export function transactionSourceHref(row: GridTransaction): string {
  return txLink({ transactionId: row.id });
}

export function transactionEmployeeBase(row: GridTransaction): string | null {
  return row.internalAmount == null ? null : toMoney(row.internalAmount);
}
