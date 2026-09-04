import { settlementBalance, settlementState, type SettlementDirection, type SettlementState } from "@/lib/business/settlement-ledger";
import type { PgLikePool } from "@/lib/import/commit";
import { dec, toMoney } from "@/lib/money";
import type { AccessScope } from "@/lib/auth/access";
import { calculatePeriodElapsed, classifyUtilization } from "@/lib/business/utilization";
import {
  getSettlementLedgerFreshness,
  type SettlementLedgerFreshness,
} from "@/lib/manage/settlement-freshness";

type Queryable = Pick<PgLikePool, "query">;

export interface SettlementRow {
  id: string;
  kind: string;
  label: string;
  direction: SettlementDirection;
  directionLabel: string;
  personType: "employee" | "individual";
  personId: string;
  personName: string;
  originalAmount: string;
  appliedAmount: string;
  balance: string;
  state: SettlementState;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  transactionCount: number;
  eventCount: number;
  lastActionAt: string | null;
  calculation: Record<string, unknown>;
  voidReason: string | null;
  createdAt: string;
}

export interface SettlementEventRow {
  id: string;
  obligationId: string | null;
  obligationLabel: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  batchAction: string | null;
  pairedObligationId: string | null;
  pairedObligationLabel: string | null;
  pairedCheckNumber: string | null;
  pairedCheckDate: string | null;
  pairedPeriodBegin: string | null;
  pairedPeriodEnd: string | null;
  personType: "employee" | "individual";
  personId: string;
  personName: string;
  eventType: string;
  amount: string;
  occurredOn: string;
  reference: string | null;
  note: string | null;
  actorName: string | null;
  reversalOfEventId: string | null;
  reversedByEventId: string | null;
  createdAt: string;
}

export interface SettlementSummary {
  openCount: number;
  partialCount: number;
  settledCount: number;
  creditCount: number;
  voidCount: number;
  agencyOwes: string;
  employeesOwe: string;
  reservesToSetAside: string;
  credits: string;
  originalTotal: string;
  appliedTotal: string;
}

export interface MissingEmployeeDeal {
  employeeId: string;
  employeeName: string;
  transactionCount: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
}

export interface DirectCheckIssue {
  sourceId: string;
  transactionIds: string[];
  employeeId: string;
  employeeName: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  transactionCount: number;
  issue:
    | "missing_check_identity"
    | "missing_net"
    | "conflicting_net"
    | "conflicting_check_date"
    | "missing_base"
    | "unknown_recipient";
}

export interface SettlementDashboardData {
  rows: SettlementRow[];
  events: SettlementEventRow[];
  summary: SettlementSummary;
  missingDeals: MissingEmployeeDeal[];
  checkIssues: DirectCheckIssue[];
  freshness: SettlementLedgerFreshness;
}

interface ObligationRow {
  id: string;
  kind: string;
  direction: SettlementDirection;
  employee_id: string | null;
  individual_id: string | null;
  employee_name: string | null;
  individual_name: string | null;
  original_amount: string;
  applied_amount: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  calculation_metadata: Record<string, unknown> | string | null;
  status: "active" | "void";
  void_reason: string | null;
  transaction_count: string;
  event_count: string;
  last_action_at: string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  employee_payout: "Pay employee",
  employee_payout_adjustment: "Payout correction",
  employee_giveback: "Employee give-back",
  employee_giveback_refund: "Refund employee",
  individual_cut_1: "First cut set-aside",
  individual_cut_2: "Second cut set-aside",
  individual_clock: "Clock adjustment",
  individual_other: "Other adjustment",
  individual_masser: "Approved final reserve",
};

function kindLabel(kind: string): string {
  const base = kind.replace(/_(increase|credit|correction)$/, "");
  const label = KIND_LABELS[base] ?? base.replaceAll("_", " ");
  if (kind.endsWith("_increase")) return `${label} increase`;
  if (kind.endsWith("_credit")) return `${label} credit`;
  if (kind.endsWith("_correction")) return `${label} correction`;
  return label;
}

function directionLabel(direction: SettlementDirection): string {
  if (direction === "payable") return "Agency pays";
  if (direction === "receivable") return "Agency receives";
  return "Set aside";
}

function metadata(value: ObligationRow["calculation_metadata"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function withLiveIndividualPace(
  value: Record<string, unknown>,
  periodBegin: string | null,
  periodEnd: string | null,
  asOf = new Date(),
): Record<string, unknown> {
  if (value.flow !== "individual_plan" || !periodBegin || !periodEnd) return value;
  try {
    const elapsed = calculatePeriodElapsed(
      { startDate: periodBegin, endDate: periodEnd },
      asOf,
    );
    const planned = dec(String(value.plannedHours ?? "0"));
    const actual = dec(String(value.actualHours ?? "0"));
    return {
      ...value,
      timeElapsedPercent: elapsed.timeElapsedPercent,
      paceStatus: planned.greaterThan(0)
        ? classifyUtilization(actual.dividedBy(planned), elapsed)
        : "not_started",
    };
  } catch {
    return value;
  }
}

function calculationForClient(
  value: ObligationRow["calculation_metadata"],
  periodBegin: string | null,
  periodEnd: string | null,
  scope?: AccessScope,
): Record<string, unknown> {
  const source = withLiveIndividualPace(metadata(value), periodBegin, periodEnd);
  if (scope) {
    const flow = typeof source.flow === "string" ? source.flow : null;
    if ((flow === "direct_employee" || flow === "agency_routed") && !scope.canSeeEmployeeDeals) return {};
    if (flow === "individual_plan" && !scope.canSeeBudgets) return {};
  }
  const keys = [
    "flow", "dealRevision", "directRule", "directPercent", "agencyCutPercent",
    "checkNet", "checkGross", "taxWithheldDisplayOnly", "totalDeductionsDisplayOnly",
    "payrollCheckId", "payrollVerificationStatus", "employeeKeeps", "employeeOwesAgency",
    "billedAmount", "baseAmount", "agencySpread", "agencyCut", "employeePayable", "agencyKeepsTotal",
    "reconciles", "netValueCount", "targetLabel", "strategyLabel", "strategyRevisionCount", "account", "formula",
    "monthlyAmount", "yearlyGross", "plannedHours", "actualHours", "actualInternal",
    "utilizationPercent", "timeElapsedPercent", "paceStatus", "adjustmentAmount",
    "priorOriginalAmount", "recalculatedOriginalAmount", "previouslyAppliedAmount",
  ];
  const result: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  if (scope) {
    // During the permission-granularity rollout, scopes created before the new
    // flag existed retain the prior taxes-based gross visibility. New scopes
    // carry the independent gross permission explicitly.
    const canSeeCheckGross = "canSeeCheckGross" in scope
      ? scope.canSeeCheckGross === true
      : scope.canSeeTaxes;
    if (!scope.canSeeCheckNet) {
      delete result.checkNet;
      delete result.employeeKeeps;
      delete result.directPercent;
    }
    if (!scope.canSeeTaxes) {
      delete result.taxWithheldDisplayOnly;
      delete result.totalDeductionsDisplayOnly;
    }
    if (!canSeeCheckGross) {
      delete result.checkGross;
    }
    if (!scope.canSeeBilledAmounts) delete result.billedAmount;
    if (!scope.canSeeEmployeeAmounts) {
      delete result.baseAmount;
      delete result.employeePayable;
      delete result.agencyCut;
      delete result.agencyCutPercent;
      delete result.monthlyAmount;
      delete result.yearlyGross;
      delete result.actualInternal;
    }
    if (!scope.canSeeAgencySpread) {
      delete result.agencySpread;
      delete result.agencyKeepsTotal;
    }
    if (!scope.canSeeHours) {
      delete result.plannedHours;
      delete result.actualHours;
      delete result.utilizationPercent;
      delete result.paceStatus;
    }
    if (!scope.canSeeBudgets) {
      delete result.monthlyAmount;
      delete result.yearlyGross;
      delete result.plannedHours;
      delete result.actualHours;
      delete result.actualInternal;
      delete result.utilizationPercent;
      delete result.timeElapsedPercent;
      delete result.paceStatus;
    }
  }
  return result;
}

function canViewSettlementPerson(scope: AccessScope, type: "employee" | "individual", id: string): boolean {
  if (scope.full) return true;
  return type === "employee"
    ? scope.allEmployees || scope.grantedEmployeeIds.includes(id)
    : scope.allIndividuals || scope.grantedIndividualIds.includes(id);
}

/**
 * Restrict settlement history to explicit person grants before ordering and
 * limiting the query. Connected navigation ids intentionally do not participate.
 */
export function settlementHistoryScopeWhere(
  scope: AccessScope | undefined,
  params: unknown[],
): string {
  if (!scope || scope.full) return "";

  const permitted: string[] = [];
  if (scope.allEmployees) {
    permitted.push("se.employee_id IS NOT NULL");
  } else if (scope.grantedEmployeeIds.length > 0) {
    params.push(scope.grantedEmployeeIds);
    permitted.push(`se.employee_id = ANY($${params.length}::uuid[])`);
  }

  if (scope.allIndividuals) {
    permitted.push("se.individual_id IS NOT NULL");
  } else if (scope.grantedIndividualIds.length > 0) {
    params.push(scope.grantedIndividualIds);
    permitted.push(`se.individual_id = ANY($${params.length}::uuid[])`);
  }

  return permitted.length > 0 ? `WHERE (${permitted.join(" OR ")})` : "WHERE FALSE";
}

type SettlementSummaryInput = Pick<
  SettlementRow,
  "state" | "direction" | "balance" | "originalAmount" | "appliedAmount"
>;

export function summarizeSettlementRows(rows: readonly SettlementSummaryInput[]): SettlementSummary {
  const active = rows.filter((row) => row.state !== "void");
  const positive = (direction: SettlementDirection) => active
    .filter((row) => row.direction === direction && dec(row.balance).greaterThan(0))
    .reduce((sum, row) => sum.plus(row.balance), dec(0));
  return {
    openCount: rows.filter((row) => row.state === "open").length,
    partialCount: rows.filter((row) => row.state === "partial").length,
    settledCount: rows.filter((row) => row.state === "settled").length,
    creditCount: rows.filter((row) => row.state === "credit").length,
    voidCount: rows.filter((row) => row.state === "void").length,
    agencyOwes: toMoney(positive("payable")),
    employeesOwe: toMoney(positive("receivable")),
    reservesToSetAside: toMoney(positive("reserve")),
    credits: toMoney(active
      .filter((row) => dec(row.balance).isNegative())
      .reduce((sum, row) => sum.plus(dec(row.balance).abs()), dec(0))),
    originalTotal: toMoney(active.reduce((sum, row) => sum.plus(row.originalAmount), dec(0))),
    appliedTotal: toMoney(active.reduce((sum, row) => sum.plus(row.appliedAmount), dec(0))),
  };
}

/** Lightweight current balance summary for the owner overview. */
export async function getSettlementSummary(pool: Queryable): Promise<SettlementSummary> {
  const { rows } = await pool.query<{
    direction: SettlementDirection;
    original_amount: string;
    applied_amount: string;
    status: "active" | "void";
  }>(
    `SELECT o.direction,
            o.original_amount::text,
            COALESCE(sum(e.amount), 0)::text AS applied_amount,
            o.status
       FROM settlement_obligations o
       LEFT JOIN settlement_events e ON e.settlement_obligation_id = o.id
      GROUP BY o.id, o.direction, o.original_amount, o.status`,
  );

  return summarizeSettlementRows(rows.map((row) => ({
    direction: row.direction,
    originalAmount: toMoney(row.original_amount),
    appliedAmount: toMoney(row.applied_amount),
    balance: settlementBalance(
      row.original_amount,
      row.applied_amount,
      row.status === "void",
    ),
    state: settlementState(
      row.original_amount,
      row.applied_amount,
      row.status === "void",
    ),
  })));
}

export async function getSettlementDashboard(pool: Queryable, scope?: AccessScope): Promise<SettlementDashboardData> {
  const eventParams: unknown[] = [];
  const eventScopeWhere = settlementHistoryScopeWhere(scope, eventParams);
  const [obligations, eventResult, missingResult, checkIssueResult, freshness] = await Promise.all([
    pool.query<ObligationRow>(
      `SELECT o.id, o.kind, o.direction, o.employee_id, o.individual_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              COALESCE(i.display_name, i.normalized_name) AS individual_name,
              o.original_amount::text,
              COALESCE(ev.applied_amount, 0)::text AS applied_amount,
              o.check_number, to_char(o.check_date, 'YYYY-MM-DD') AS check_date,
              to_char(o.period_begin, 'YYYY-MM-DD') AS period_begin,
              to_char(o.period_end, 'YYYY-MM-DD') AS period_end,
              o.calculation_metadata, o.status, o.void_reason,
              COALESCE(tx.transaction_count, 0)::text AS transaction_count,
              COALESCE(ev.event_count, 0)::text AS event_count,
              ev.last_action_at::text, o.created_at::text
         FROM settlement_obligations o
         LEFT JOIN employees e ON e.id = o.employee_id
         LEFT JOIN individuals i ON i.id = o.individual_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS transaction_count
             FROM settlement_obligation_transactions ot
            WHERE ot.settlement_obligation_id = o.id
         ) tx ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(se.amount), 0) AS applied_amount,
                  count(*) AS event_count, max(se.created_at) AS last_action_at
             FROM settlement_events se
            WHERE se.settlement_obligation_id = o.id
         ) ev ON true
        ORDER BY
          CASE WHEN o.status = 'active' AND o.original_amount > COALESCE(ev.applied_amount, 0) THEN 0 ELSE 1 END,
          COALESCE(o.check_date, o.period_end, o.period_begin) DESC NULLS LAST,
          COALESCE(e.display_name, e.normalized_name, i.display_name, i.normalized_name),
          o.created_at DESC`,
    ),
    pool.query<{
      id: string;
      settlement_obligation_id: string | null;
      obligation_kind: string | null;
      check_number: string | null;
      check_date: string | null;
      period_begin: string | null;
      period_end: string | null;
      batch_action: string | null;
      paired_obligation_id: string | null;
      paired_obligation_kind: string | null;
      paired_check_number: string | null;
      paired_check_date: string | null;
      paired_period_begin: string | null;
      paired_period_end: string | null;
      employee_id: string | null;
      individual_id: string | null;
      employee_name: string | null;
      individual_name: string | null;
      event_type: string;
      amount: string;
      occurred_on: string;
      reference: string | null;
      note: string | null;
      actor_name: string | null;
      reversal_of_event_id: string | null;
      reversed_by_event_id: string | null;
      created_at: string;
    }>(
      `SELECT se.id, se.settlement_obligation_id, so.kind AS obligation_kind,
              so.check_number,
              to_char(so.check_date, 'YYYY-MM-DD') AS check_date,
              to_char(so.period_begin, 'YYYY-MM-DD') AS period_begin,
              to_char(so.period_end, 'YYYY-MM-DD') AS period_end,
              sb.action AS batch_action,
              pair.settlement_obligation_id AS paired_obligation_id,
              pair.kind AS paired_obligation_kind,
              pair.check_number AS paired_check_number,
              to_char(pair.check_date, 'YYYY-MM-DD') AS paired_check_date,
              to_char(pair.period_begin, 'YYYY-MM-DD') AS paired_period_begin,
              to_char(pair.period_end, 'YYYY-MM-DD') AS paired_period_end,
              se.employee_id, se.individual_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              COALESCE(i.display_name, i.normalized_name) AS individual_name,
              se.event_type, se.amount::text,
              to_char(se.occurred_on, 'YYYY-MM-DD') AS occurred_on,
              se.reference, se.note, u.email AS actor_name,
              se.reversal_of_event_id,
              reversal.id AS reversed_by_event_id,
              se.created_at::text
         FROM settlement_events se
         LEFT JOIN employees e ON e.id = se.employee_id
         LEFT JOIN individuals i ON i.id = se.individual_id
         LEFT JOIN settlement_obligations so ON so.id = se.settlement_obligation_id
         LEFT JOIN settlement_batches sb ON sb.id = se.settlement_batch_id
         LEFT JOIN users u ON u.id = se.created_by_user_id
         LEFT JOIN settlement_events reversal ON reversal.reversal_of_event_id = se.id
         LEFT JOIN LATERAL (
           SELECT peer.settlement_obligation_id, peer_obligation.kind,
                  peer_obligation.check_number, peer_obligation.check_date,
                  peer_obligation.period_begin, peer_obligation.period_end
             FROM settlement_events peer
             JOIN settlement_obligations peer_obligation
               ON peer_obligation.id = peer.settlement_obligation_id
            WHERE sb.action = 'apply_credit'
              AND peer.settlement_batch_id = se.settlement_batch_id
              AND peer.id <> se.id
              AND peer.event_type = 'credit'
            ORDER BY peer.id
            LIMIT 1
         ) pair ON true
        ${eventScopeWhere}
        ORDER BY se.created_at DESC`,
      eventParams,
    ),
    pool.query<{
      employee_id: string;
      employee_name: string;
      transaction_count: string;
      first_transaction_date: string | null;
      last_transaction_date: string | null;
    }>(
      `SELECT t.employee_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              count(*)::text AS transaction_count,
              to_char(min(canonical_service_date(
                t.period_begin, t.check_date, t.period_end
              )), 'YYYY-MM-DD') AS first_transaction_date,
              to_char(max(canonical_service_date(
                t.period_begin, t.check_date, t.period_end
              )), 'YYYY-MM-DD') AS last_transaction_date
         FROM payroll_transactions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN programs p ON p.id = t.program_id
        WHERE t.employee_id IS NOT NULL
          AND effective_payment_recipient(
            t.payment_recipient,
            p.payment_recipient
          ) IN ('employee', 'excellent_staffing')
          AND NOT EXISTS (
            SELECT 1 FROM employee_deals d
             WHERE d.employee_id = t.employee_id AND d.status = 'active'
               AND d.effective_from <= canonical_service_date(
                 t.period_begin, t.check_date, t.period_end
               )
               AND (d.effective_to IS NULL OR d.effective_to >= canonical_service_date(
                 t.period_begin, t.check_date, t.period_end
               ))
          )
        GROUP BY t.employee_id, COALESCE(e.display_name, e.normalized_name)
        ORDER BY employee_name`,
    ),
    pool.query<{
      source_id: string;
      transaction_ids: string[];
      employee_id: string;
      employee_name: string;
      check_number: string | null;
      check_date: string | null;
      period_begin: string | null;
      period_end: string | null;
      transaction_count: string;
      issue: DirectCheckIssue["issue"];
    }>(
      `WITH direct_facts AS (
         SELECT t.id, t.employee_id,
                COALESCE(e.display_name, e.normalized_name) AS employee_name,
                pc.id AS verified_payroll_check_id,
                CASE WHEN pc.id IS NOT NULL
                  THEN NULLIF(btrim(pc.check_number), '')
                  ELSE NULLIF(btrim(t.check_number), '')
                END AS check_number,
                CASE WHEN pc.id IS NOT NULL THEN pc.check_date ELSE t.check_date END AS check_date,
                CASE WHEN pc.id IS NOT NULL THEN pc.period_begin ELSE t.period_begin END AS period_begin,
                CASE WHEN pc.id IS NOT NULL THEN pc.period_end ELSE t.period_end END AS period_end,
                CASE WHEN pc.id IS NOT NULL THEN pc.actual_net ELSE t.total_net_pay END AS total_net_pay
           FROM payroll_transactions t
           JOIN employees e ON e.id = t.employee_id
           LEFT JOIN programs p ON p.id = t.program_id
           LEFT JOIN employee_payroll_checks pc
             ON pc.id = t.payroll_check_id
            AND pc.employee_id = t.employee_id
            AND pc.verification_status = 'verified'
          WHERE t.employee_id IS NOT NULL
            AND effective_payment_recipient(
              t.payment_recipient,
              p.payment_recipient
            ) = 'employee'
            AND (
              pc.id IS NOT NULL
              OR (t.check_number IS NOT NULL AND btrim(t.check_number) <> '')
              OR t.check_date IS NOT NULL OR t.period_begin IS NOT NULL OR t.period_end IS NOT NULL
            )
       ), direct_sources AS (
         SELECT direct_facts.*,
                CASE
                  WHEN verified_payroll_check_id IS NOT NULL
                    THEN concat(employee_id::text, ':payroll-check:', verified_payroll_check_id::text)
                  WHEN check_number IS NOT NULL
                    THEN concat(
                      employee_id::text, ':check:', check_number,
                      ':date:', COALESCE(check_date::text, ''),
                      ':period:', COALESCE(period_begin::text, ''), ':', COALESCE(period_end::text, '')
                    )
                  ELSE concat(
                    employee_id::text,
                    ':date:', COALESCE(check_date::text, ''),
                    ':period:', COALESCE(period_begin::text, ''), ':', COALESCE(period_end::text, '')
                  )
                END AS source_id
           FROM direct_facts
       ), direct_checks AS (
         SELECT source_id, array_agg(id::text ORDER BY id) AS transaction_ids,
                employee_id, employee_name,
                NULLIF(btrim(check_number), '') AS check_number,
                to_char(min(check_date), 'YYYY-MM-DD') AS check_date,
                to_char(min(period_begin), 'YYYY-MM-DD') AS period_begin,
                to_char(max(period_end), 'YYYY-MM-DD') AS period_end,
                count(*)::text AS transaction_count,
                count(*) AS row_count,
                count(verified_payroll_check_id) AS verified_check_count,
                count(total_net_pay) AS net_count,
                count(DISTINCT total_net_pay) AS net_value_count,
                count(DISTINCT check_date) AS check_date_count
           FROM direct_sources
          GROUP BY source_id, employee_id, employee_name, NULLIF(btrim(check_number), '')
       ), ambiguous_numbered_checks AS (
         SELECT concat(employee_id::text, ':ambiguous-check:', NULLIF(btrim(check_number), '')) AS source_id,
                array_agg(id::text ORDER BY id) AS transaction_ids,
                employee_id, employee_name, NULLIF(btrim(check_number), '') AS check_number,
                to_char(min(check_date), 'YYYY-MM-DD') AS check_date,
                to_char(min(period_begin), 'YYYY-MM-DD') AS period_begin,
                to_char(max(period_end), 'YYYY-MM-DD') AS period_end,
                count(*)::text AS transaction_count
           FROM direct_sources
          WHERE verified_payroll_check_id IS NULL
            AND check_number IS NOT NULL AND btrim(check_number) <> ''
          GROUP BY employee_id, employee_name, NULLIF(btrim(check_number), '')
         HAVING count(DISTINCT check_date) > 1
            AND count(*) FILTER (WHERE check_date IS NULL) > 0
       )
       SELECT source_id, transaction_ids, employee_id, employee_name, check_number, check_date,
              period_begin, period_end, transaction_count,
              CASE
                WHEN net_value_count > 1 THEN 'conflicting_net'
                WHEN check_date_count > 1 THEN 'conflicting_check_date'
                WHEN verified_check_count < row_count OR net_count = 0 THEN 'missing_net'
                ELSE 'conflicting_check_date'
              END AS issue
         FROM direct_checks
        WHERE verified_check_count < row_count
           OR net_count = 0 OR net_value_count > 1 OR check_date_count > 1
       UNION ALL
       SELECT source_id, transaction_ids, employee_id, employee_name, check_number, check_date,
              period_begin, period_end, transaction_count,
              'conflicting_check_date'::text AS issue
         FROM ambiguous_numbered_checks
       UNION ALL
       SELECT t.id::text AS source_id, ARRAY[t.id::text] AS transaction_ids, t.employee_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              NULL::text AS check_number,
              to_char(t.check_date, 'YYYY-MM-DD') AS check_date,
              to_char(t.period_begin, 'YYYY-MM-DD') AS period_begin,
              to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
              '1'::text AS transaction_count,
              'missing_check_identity'::text AS issue
         FROM payroll_transactions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN programs p ON p.id = t.program_id
         LEFT JOIN employee_payroll_checks pc
           ON pc.id = t.payroll_check_id
          AND pc.employee_id = t.employee_id
          AND pc.verification_status = 'verified'
        WHERE t.employee_id IS NOT NULL
          AND effective_payment_recipient(
            t.payment_recipient,
            p.payment_recipient
          ) = 'employee'
          AND pc.id IS NULL
          AND (t.check_number IS NULL OR btrim(t.check_number) = '')
          AND t.check_date IS NULL AND t.period_begin IS NULL AND t.period_end IS NULL
       UNION ALL
       SELECT t.id::text AS source_id, ARRAY[t.id::text] AS transaction_ids, t.employee_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              t.check_number,
              to_char(t.check_date, 'YYYY-MM-DD') AS check_date,
              to_char(t.period_begin, 'YYYY-MM-DD') AS period_begin,
              to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
              '1'::text AS transaction_count,
              'missing_base'::text AS issue
         FROM payroll_transactions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN programs p ON p.id = t.program_id
        WHERE t.employee_id IS NOT NULL
          AND effective_payment_recipient(
            t.payment_recipient,
            p.payment_recipient
          ) = 'excellent_staffing'
          AND COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
                       t.internal_rate_applied * t.imported_hours) IS NULL
       UNION ALL
       SELECT t.id::text AS source_id, ARRAY[t.id::text] AS transaction_ids, t.employee_id,
              COALESCE(e.display_name, e.normalized_name) AS employee_name,
              t.check_number,
              to_char(t.check_date, 'YYYY-MM-DD') AS check_date,
              to_char(t.period_begin, 'YYYY-MM-DD') AS period_begin,
              to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
              '1'::text AS transaction_count,
              'unknown_recipient'::text AS issue
         FROM payroll_transactions t
         JOIN employees e ON e.id = t.employee_id
         LEFT JOIN programs p ON p.id = t.program_id
        WHERE t.employee_id IS NOT NULL
          AND effective_payment_recipient(
            t.payment_recipient,
            p.payment_recipient
          ) = 'unknown'
       ORDER BY employee_name, check_date DESC NULLS LAST`,
    ),
    getSettlementLedgerFreshness(pool),
  ]);

  const allRows: SettlementRow[] = obligations.rows.map((row) => {
    const personType = row.employee_id ? "employee" as const : "individual" as const;
    return {
      id: row.id,
      kind: row.kind,
      label: kindLabel(row.kind),
      direction: row.direction,
      directionLabel: directionLabel(row.direction),
      personType,
      personId: row.employee_id ?? row.individual_id!,
      personName: row.employee_name ?? row.individual_name ?? "Unknown person",
      originalAmount: toMoney(row.original_amount),
      appliedAmount: toMoney(row.applied_amount),
      balance: settlementBalance(row.original_amount, row.applied_amount, row.status === "void"),
      state: settlementState(row.original_amount, row.applied_amount, row.status === "void"),
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      transactionCount: Number(row.transaction_count),
      eventCount: Number(row.event_count),
      lastActionAt: row.last_action_at,
      calculation: calculationForClient(
        row.calculation_metadata,
        row.period_begin,
        row.period_end,
        scope,
      ),
      voidReason: row.void_reason,
      createdAt: row.created_at,
    };
  });

  const rows = scope
    ? allRows.filter((row) => canViewSettlementPerson(scope, row.personType, row.personId))
    : allRows;

  const summary = summarizeSettlementRows(rows);

  const allEvents: SettlementEventRow[] = eventResult.rows.map((row) => ({
    id: row.id,
    obligationId: row.settlement_obligation_id,
    obligationLabel: row.obligation_kind ? kindLabel(row.obligation_kind) : null,
    checkNumber: row.check_number,
    checkDate: row.check_date,
    periodBegin: row.period_begin,
    periodEnd: row.period_end,
    batchAction: row.batch_action,
    pairedObligationId: row.paired_obligation_id,
    pairedObligationLabel: row.paired_obligation_kind ? kindLabel(row.paired_obligation_kind) : null,
    pairedCheckNumber: row.paired_check_number,
    pairedCheckDate: row.paired_check_date,
    pairedPeriodBegin: row.paired_period_begin,
    pairedPeriodEnd: row.paired_period_end,
    personType: row.employee_id ? "employee" : "individual",
    personId: row.employee_id ?? row.individual_id!,
    personName: row.employee_name ?? row.individual_name ?? "Unknown person",
    eventType: row.event_type,
    amount: toMoney(row.amount),
    occurredOn: row.occurred_on,
    reference: row.reference,
    note: row.note,
    actorName: row.actor_name,
    reversalOfEventId: row.reversal_of_event_id,
    reversedByEventId: row.reversed_by_event_id,
    createdAt: row.created_at,
  }));

  const events = scope
    ? allEvents.filter((event) => canViewSettlementPerson(scope, event.personType, event.personId))
    : allEvents;
  const missingDeals = missingResult.rows
    .filter((row) => !scope || (scope.canSeeEmployeeDeals && canViewSettlementPerson(scope, "employee", row.employee_id)))
    .map((row) => ({
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      transactionCount: Number(row.transaction_count),
      firstTransactionDate: row.first_transaction_date,
      lastTransactionDate: row.last_transaction_date,
    }));
  const checkIssues = checkIssueResult.rows
    .filter((row) => !scope || canViewSettlementPerson(scope, "employee", row.employee_id))
    .map((row) => ({
      sourceId: row.source_id,
      transactionIds: row.transaction_ids,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      transactionCount: Number(row.transaction_count),
      issue: row.issue,
    }));

  return {
    rows,
    events,
    summary,
    missingDeals,
    checkIssues,
    freshness,
  };
}

export async function getPersonSettlementBalance(
  pool: PgLikePool,
  person: { employeeId?: string; individualId?: string },
): Promise<{ payable: string; receivable: string; reserve: string; credit: string; openItems: number }> {
  const id = person.employeeId ?? person.individualId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return { payable: toMoney(0), receivable: toMoney(0), reserve: toMoney(0), credit: toMoney(0), openItems: 0 };
  }
  const column = person.employeeId ? "employee_id" : "individual_id";
  const { rows } = await pool.query<{ current_direction: SettlementDirection; signed_balance: string }>(
    `WITH entries AS (
       SELECT COALESCE(o.calculation_metadata->>'adjustmentForObligationId', o.id::text) AS root_key,
              o.direction,
              o.original_amount - COALESCE(sum(e.amount), 0) AS balance
         FROM settlement_obligations o
         LEFT JOIN settlement_events e ON e.settlement_obligation_id = o.id
        WHERE o.${column} = $1 AND o.status = 'active'
        GROUP BY o.id
     ), roots AS (
       SELECT root.id::text AS root_key,
              CASE
                WHEN latest.calculation_metadata->>'recalculatedDirection' IN ('payable', 'receivable', 'reserve')
                  THEN latest.calculation_metadata->>'recalculatedDirection'
                ELSE root.direction
              END AS current_direction
         FROM settlement_obligations root
         LEFT JOIN LATERAL (
           SELECT correction.calculation_metadata
             FROM settlement_obligations correction
            WHERE correction.status = 'active'
              AND correction.calculation_metadata->>'adjustmentForObligationId' = root.id::text
            ORDER BY correction.created_at DESC, correction.id DESC
            LIMIT 1
         ) latest ON true
        WHERE root.${column} = $1
          AND root.status = 'active'
          AND NOT (root.calculation_metadata ? 'adjustmentForObligationId')
     )
     SELECT roots.current_direction,
            sum(CASE WHEN entries.direction = 'receivable' THEN -entries.balance ELSE entries.balance END)::text AS signed_balance
       FROM roots
       JOIN entries ON entries.root_key = roots.root_key
      GROUP BY roots.root_key, roots.current_direction`,
    [id],
  );
  let payable = dec(0);
  let receivable = dec(0);
  let reserve = dec(0);
  let credit = dec(0);
  let openItems = 0;
  for (const row of rows) {
    const signed = dec(row.signed_balance);
    const outstanding = row.current_direction === "receivable" ? signed.negated() : signed;
    if (outstanding.greaterThan(0)) {
      if (row.current_direction === "payable") payable = payable.plus(outstanding);
      else if (row.current_direction === "reserve") reserve = reserve.plus(outstanding);
      else receivable = receivable.plus(outstanding);
      openItems++;
    } else if (outstanding.isNegative()) {
      credit = credit.plus(outstanding.abs());
    }
  }
  return {
    payable: toMoney(payable),
    receivable: toMoney(receivable),
    reserve: toMoney(reserve),
    credit: toMoney(credit),
    openItems,
  };
}
