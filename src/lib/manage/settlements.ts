import { createHash } from "node:crypto";
import {
  calculateAgencyRoutedTransaction,
  calculateDirectEmployeeCheck,
  type DirectEmployeeDeal,
} from "@/lib/business/deal-engine";
import {
  individualSettlementTargets,
  settlementBalance,
  settlementTargetDelta,
  type SettlementDirection,
} from "@/lib/business/settlement-ledger";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { recordChange } from "@/lib/manage/audit";
import { fail, ok, type Result } from "@/lib/manage/errors";
import {
  lockSettlementSources,
  markSettlementRefreshBlocked,
  markSettlementRefreshComplete,
  recordSettlementRefreshFailure,
  settlementApplicationDate,
} from "@/lib/manage/settlement-freshness";
import { redactError } from "@/lib/http";
import { dec, toMoney } from "@/lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_PG_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;

type SettlementRefreshPhase =
  | "begin"
  | "lock-refresh"
  | "lock-sources"
  | "read-employee-sources"
  | "read-individual-plans"
  | "build-candidates"
  | "match-existing-sources"
  | "write-obligations"
  | "read-reconciliation-roots"
  | "reconcile-obligations"
  | "write-audit"
  | "certify-ledger"
  | "commit";

export interface SettlementRefreshDiagnostic {
  phase: SettlementRefreshPhase;
  message: string;
  code?: string;
  table?: string;
  constraint?: string;
}

function safeErrorProperty(error: unknown, key: "code" | "table" | "constraint"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  if (key === "code") return /^[0-9A-Z]{5}$/i.test(value) ? value : undefined;
  return SAFE_PG_IDENTIFIER.test(value) ? value : undefined;
}

function safeSettlementRefreshMessage(error: unknown): string {
  const message = redactError(error, "Database operation failed.")
    .split(/\r?\n/, 1)[0]
    .trim();
  const groupBy = message.match(
    /^column "([A-Za-z0-9_.-]{1,128})" must appear in the GROUP BY clause or be used in an aggregate function$/i,
  );
  if (groupBy) return `Column "${groupBy[1]}" must be grouped or aggregated.`;
  if (/canceling statement due to statement timeout/i.test(message)) return "Database statement timed out.";
  if (/deadlock detected/i.test(message)) return "Database deadlock detected.";
  if (/could not serialize access/i.test(message)) return "Database serialization conflict.";
  if (/connection (?:terminated|closed)|server closed the connection/i.test(message)) {
    return "Database connection ended unexpectedly.";
  }
  if (/duplicate key|unique constraint/i.test(message)) return "Database uniqueness constraint was violated.";
  if (/violates (?:check|foreign key|not-null) constraint/i.test(message)) {
    return "Database constraint was violated.";
  }
  if (/invalid input syntax/i.test(message)) return "Database input had an invalid type or format.";
  return "Database operation failed; inspect the phase and PostgreSQL metadata.";
}

export function settlementRefreshDiagnostic(
  error: unknown,
  phase: SettlementRefreshPhase,
): SettlementRefreshDiagnostic {
  const diagnostic: SettlementRefreshDiagnostic = {
    phase,
    message: safeSettlementRefreshMessage(error),
  };
  const code = safeErrorProperty(error, "code");
  const table = safeErrorProperty(error, "table");
  const constraint = safeErrorProperty(error, "constraint");
  if (code) diagnostic.code = code;
  if (table) diagnostic.table = table;
  if (constraint) diagnostic.constraint = constraint;
  return diagnostic;
}

interface EmployeeTransactionRow {
  id: string;
  employee_id: string;
  employee_name: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  effective_date: string;
  payment_recipient: "employee" | "excellent_staffing";
  billed_amount: string;
  base_amount: string | null;
  total_net_pay: string | null;
  deal_id: string | null;
  deal_revision: number | null;
  direct_rule: "keep_all" | "giveback_percent" | "giveback_all" | null;
  direct_percent: string | null;
  agency_cut_percent: string | null;
}

interface ObligationCandidate {
  sourceKey: string;
  kind: string;
  direction: SettlementDirection;
  employeeId?: string | null;
  individualId?: string | null;
  employeeDealId?: string | null;
  calculationStrategyId?: string | null;
  amount: string;
  checkNumber?: string | null;
  checkDate?: string | null;
  periodBegin?: string | null;
  periodEnd?: string | null;
  metadata: Record<string, unknown>;
  transactionIds?: string[];
  allocations?: Record<string, string>;
}

interface ExistingObligation {
  id: string;
  original_amount: string;
  direction: SettlementDirection;
  event_count: string;
  applied_amount: string;
  status: "active" | "void";
}

interface ReconciliationRoot {
  source_key: string;
  kind: string;
  direction: SettlementDirection;
  employee_id: string | null;
  individual_id: string | null;
  employee_deal_id: string | null;
  calculation_strategy_id: string | null;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  calculation_metadata: Record<string, unknown> | string | null;
  transaction_ids: string[];
}

interface EmployeeSourceRoot {
  source_key: string;
  employee_id: string;
  flow: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  transaction_ids: string[];
}

export interface RefreshSettlementsInput {
  employeeId?: string | null;
  individualId?: string | null;
}

export interface RefreshSettlementsOptions {
  allowGlobalWhenDirty?: boolean;
}

export interface RefreshSettlementsResult {
  created: number;
  updated: number;
  adjusted: number;
  voided: number;
  unchanged: number;
  skippedNoDeal: number;
  skippedMissingCheckIdentity: number;
  skippedMissingNet: number;
  skippedInconsistentNet: number;
  skippedInconsistentCheck: number;
  skippedMissingBase: number;
  skippedUnknownRecipient: number;
  employeeChecks: number;
  individualPlans: number;
  preservedHistorical: number;
}

export function settlementRefreshBlockingIssueMessage(
  result: Pick<
    RefreshSettlementsResult,
    | "skippedMissingCheckIdentity"
    | "skippedMissingNet"
    | "skippedInconsistentNet"
    | "skippedInconsistentCheck"
    | "skippedMissingBase"
    | "skippedUnknownRecipient"
  >,
): string | null {
  const issues = [
    [result.skippedMissingCheckIdentity, "missing check or pay-period identity"],
    [result.skippedMissingNet, "missing whole-check net pay"],
    [result.skippedInconsistentNet, "conflicting whole-check net pay"],
    [result.skippedInconsistentCheck, "conflicting check dates or pay periods"],
    [result.skippedMissingBase, "missing agency-routed base amount"],
    [result.skippedUnknownRecipient, "unknown payment recipient"],
  ] as const;
  const details = issues
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (!details.length) return null;
  return `Settlement refresh is blocked by source issues: ${details.join("; ")}. Correct them and refresh again.`;
}

export interface SettlementEventResult {
  batchId: string;
  eventIds: string[];
}

function stableKey(parts: unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `v1:${digest}`;
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function inTransaction<T>(pool: PgLikePool, run: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function directDeal(row: EmployeeTransactionRow): DirectEmployeeDeal {
  if (row.direct_rule === "giveback_all") return { mode: "giveback_all" };
  if (row.direct_rule === "giveback_percent") {
    return { mode: "giveback_percent", givebackFraction: row.direct_percent ?? "0" };
  }
  return { mode: "keep_all" };
}

export function directSettlementCheckIdentity(input: {
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
}): string | null {
  const checkNumber = input.checkNumber?.trim() || null;
  const numberedIdentity = input.checkDate
    ? `date:${input.checkDate}`
    : input.periodBegin || input.periodEnd
      ? `period:${input.periodBegin ?? ""}:${input.periodEnd ?? ""}`
      : null;
  if (checkNumber) return `check:${checkNumber}:${numberedIdentity ?? "undated"}`;
  if (input.periodBegin || input.periodEnd) {
    return `period:${input.periodBegin ?? ""}:${input.periodEnd ?? ""}`;
  }
  return input.checkDate ? `date:${input.checkDate}` : null;
}

async function loadEmployeeTransactions(
  pool: Pick<PgLikePool, "query">,
  employeeId?: string | null,
): Promise<EmployeeTransactionRow[]> {
  const params: unknown[] = [];
  const employeeClause = employeeId ? `AND t.employee_id = $${params.push(employeeId)}` : "";
  const { rows } = await pool.query<EmployeeTransactionRow>(
    `SELECT t.id, t.employee_id,
            COALESCE(e.display_name, e.normalized_name) AS employee_name,
            t.check_number,
            to_char(t.check_date, 'YYYY-MM-DD') AS check_date,
            to_char(t.period_begin, 'YYYY-MM-DD') AS period_begin,
            to_char(t.period_end, 'YYYY-MM-DD') AS period_end,
            to_char(COALESCE(t.check_date, t.period_end, t.period_begin, t.created_at::date), 'YYYY-MM-DD') AS effective_date,
            t.payment_recipient,
            COALESCE(t.imported_amount, 0)::text AS billed_amount,
            COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
                     t.internal_rate_applied * t.imported_hours)::text AS base_amount,
            t.total_net_pay::text,
            d.id AS deal_id, d.revision AS deal_revision, d.direct_rule,
            d.direct_percent::text, d.agency_cut_percent::text
       FROM payroll_transactions t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN LATERAL (
         SELECT ed.id, ed.revision, ed.direct_rule, ed.direct_percent, ed.agency_cut_percent
           FROM employee_deals ed
          WHERE ed.employee_id = t.employee_id AND ed.status = 'active'
            AND ed.effective_from <= COALESCE(t.check_date, t.period_end, t.period_begin, t.created_at::date)
            AND (ed.effective_to IS NULL OR ed.effective_to >= COALESCE(t.check_date, t.period_end, t.period_begin, t.created_at::date))
          ORDER BY ed.effective_from DESC
          LIMIT 1
       ) d ON true
      WHERE t.employee_id IS NOT NULL
        AND t.payment_recipient IN ('employee', 'excellent_staffing')
        ${employeeClause}
      ORDER BY t.employee_id, t.check_date NULLS LAST, t.check_number NULLS LAST, t.id`,
    params,
  );
  return rows;
}

async function loadUnknownRecipientTransactionIds(
  client: Pick<PgLikePool, "query">,
  employeeId?: string | null,
): Promise<string[]> {
  const params: unknown[] = [];
  const employeeClause = employeeId ? `AND employee_id = $${params.push(employeeId)}` : "";
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM payroll_transactions
      WHERE employee_id IS NOT NULL
        AND payment_recipient IS DISTINCT FROM 'employee'
        AND payment_recipient IS DISTINCT FROM 'excellent_staffing'
        ${employeeClause}`,
    params,
  );
  return rows.map((row) => row.id);
}

export function resolveNumberedDirectCheckDates(rows: readonly Pick<
  EmployeeTransactionRow,
  "id" | "employee_id" | "check_number" | "check_date" | "payment_recipient" | "deal_id"
>[]): {
  inferredCheckDates: Map<string, string>;
  ambiguousTransactionIds: Set<string>;
  ambiguousCheckCount: number;
} {
  const inferredCheckDates = new Map<string, string>();
  const ambiguousTransactionIds = new Set<string>();
  const numberedChecks = new Map<string, typeof rows[number][]>();

  for (const row of rows) {
    const checkNumber = row.check_number?.trim();
    if (!row.deal_id || row.payment_recipient !== "employee" || !checkNumber) continue;
    const key = `${row.employee_id}:${checkNumber}`;
    const checkRows = numberedChecks.get(key) ?? [];
    checkRows.push(row);
    numberedChecks.set(key, checkRows);
  }

  let ambiguousCheckCount = 0;
  for (const checkRows of numberedChecks.values()) {
    const dates = [...new Set(
      checkRows.map((row) => row.check_date).filter((value): value is string => value !== null),
    )];
    const undated = checkRows.filter((row) => row.check_date === null);
    if (dates.length === 1) {
      for (const row of undated) inferredCheckDates.set(row.id, dates[0]);
    } else if (dates.length > 1 && undated.length > 0) {
      ambiguousCheckCount++;
      for (const row of checkRows) ambiguousTransactionIds.add(row.id);
    }
  }

  return { inferredCheckDates, ambiguousTransactionIds, ambiguousCheckCount };
}

function employeeCandidates(rows: EmployeeTransactionRow[]): {
  candidates: ObligationCandidate[];
  skippedNoDeal: number;
  skippedMissingCheckIdentity: number;
  skippedMissingNet: number;
  skippedInconsistentNet: number;
  skippedInconsistentCheck: number;
  skippedMissingBase: number;
  employeeChecks: number;
  protectedSourceKeys: Set<string>;
  protectedTransactionIds: Set<string>;
} {
  const candidates: ObligationCandidate[] = [];
  let skippedNoDeal = 0;
  let skippedMissingCheckIdentity = 0;
  let skippedMissingNet = 0;
  let skippedInconsistentNet = 0;
  let skippedInconsistentCheck = 0;
  let skippedMissingBase = 0;
  const protectedSourceKeys = new Set<string>();
  const protectedTransactionIds = new Set<string>();
  const groups = new Map<string, EmployeeTransactionRow[]>();
  const {
    inferredCheckDates,
    ambiguousTransactionIds,
    ambiguousCheckCount,
  } = resolveNumberedDirectCheckDates(rows);
  skippedInconsistentCheck += ambiguousCheckCount;
  for (const transactionId of ambiguousTransactionIds) protectedTransactionIds.add(transactionId);

  for (const row of rows) {
    if (!row.deal_id) {
      skippedNoDeal++;
      continue;
    }
    if (ambiguousTransactionIds.has(row.id)) continue;
    const flow = row.payment_recipient === "employee" ? "direct" : "agency";
    const resolvedCheckDate = row.check_date ?? inferredCheckDates.get(row.id) ?? null;
    const directIdentity = flow === "direct"
      ? directSettlementCheckIdentity({
          checkNumber: row.check_number,
          checkDate: resolvedCheckDate,
          periodBegin: row.period_begin,
          periodEnd: row.period_end,
        })
      : null;
    if (flow === "direct" && !directIdentity) {
      skippedMissingCheckIdentity++;
      protectedTransactionIds.add(row.id);
      continue;
    }
    const checkIdentity = flow === "direct"
      ? directIdentity!
      : `transaction:${row.id}`;
    // The check/transaction is the durable accounting identity. A corrected or
    // backdated deal must recalculate this same obligation, not leave a second
    // obligation behind merely because the effective deal row changed.
    const key = `${row.employee_id}:${flow}:${checkIdentity}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const [groupKey, group] of groups) {
    const first = group[0];
    const transactionIds = group.map((row) => row.id).sort();
    const sourceKey = stableKey(["employee", groupKey]);
    const common = {
      sourceKey,
      employeeId: first.employee_id,
      employeeDealId: first.deal_id,
      checkNumber: first.check_number,
      checkDate: first.check_date ?? inferredCheckDates.get(first.id) ?? null,
      periodBegin: group.map((row) => row.period_begin).filter(Boolean).sort()[0] ?? null,
      periodEnd: group.map((row) => row.period_end).filter(Boolean).sort().at(-1) ?? null,
      transactionIds,
    };

    if (first.payment_recipient === "employee") {
      const checkDates = [...new Set(
        group
          .map((row) => row.check_date ?? inferredCheckDates.get(row.id) ?? null)
          .filter((value): value is string => value !== null),
      )];
      const dealIds = [...new Set(group.map((row) => row.deal_id).filter((value): value is string => value !== null))];
      if (checkDates.length > 1 || dealIds.length > 1) {
        skippedInconsistentCheck++;
        protectedSourceKeys.add(sourceKey);
        for (const transactionId of transactionIds) protectedTransactionIds.add(transactionId);
        continue;
      }
      const netValues = [...new Set(
        group
          .map((row) => row.total_net_pay)
          .filter((value): value is string => value != null)
          .map((value) => toMoney(value)),
      )];
      if (netValues.length === 0) {
        skippedMissingNet++;
        protectedSourceKeys.add(sourceKey);
        for (const transactionId of transactionIds) protectedTransactionIds.add(transactionId);
        continue;
      }
      if (netValues.length > 1) {
        skippedInconsistentNet++;
        protectedSourceKeys.add(sourceKey);
        for (const transactionId of transactionIds) protectedTransactionIds.add(transactionId);
        continue;
      }
      const checkNet = dec(netValues[0]);
      const checkGross = group.reduce((total, row) => total.plus(row.billed_amount), dec(0));
      const calculation = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: groupKey,
        checkNet: toMoney(checkNet),
        checkGross: toMoney(checkGross),
        deal: directDeal(first),
      });
      const signed = dec(calculation.employeeOwesAgency);
      candidates.push({
        ...common,
        kind: signed.isNegative() ? "employee_giveback_refund" : "employee_giveback",
        direction: signed.isNegative() ? "payable" : "receivable",
        amount: toMoney(signed.abs()),
        metadata: {
          flow: "direct_employee",
          employeeName: first.employee_name,
          dealRevision: first.deal_revision,
          directRule: first.direct_rule,
          directPercent: first.direct_percent,
          checkNet: calculation.checkNet,
          checkGross: calculation.checkGross,
          withholdingDisplayOnly: calculation.withholding,
          employeeKeeps: calculation.employeeKeeps,
          employeeOwesAgency: calculation.employeeOwesAgency,
          netValueCount: netValues.length,
          transactionCount: group.length,
          sourceTransactionIds: transactionIds,
          reconciles: calculation.reconciliations.every((check) => check.reconciles),
          reconciliations: calculation.reconciliations,
        },
      });
      continue;
    }

    if (group.some((row) => row.base_amount === null)) {
      skippedMissingBase++;
      protectedSourceKeys.add(stableKey(["employee", groupKey, "payable"]));
      protectedSourceKeys.add(stableKey(["employee", groupKey, "receivable"]));
      for (const transactionId of transactionIds) protectedTransactionIds.add(transactionId);
      continue;
    }
    const results = group.map((row) =>
      calculateAgencyRoutedTransaction({
        flow: "agency_routed",
        transactionId: row.id,
        billedAmount: row.billed_amount,
        baseAmount: row.base_amount!,
        deal: { agencyCutFraction: row.agency_cut_percent ?? "0" },
      }),
    );
    const directional = [
      { direction: "payable" as const, rows: results.filter((row) => dec(row.employeePayable).isPositive()) },
      { direction: "receivable" as const, rows: results.filter((row) => dec(row.employeePayable).isNegative()) },
    ];
    for (const section of directional) {
      const billed = section.rows.reduce((total, row) => total.plus(row.billedAmount), dec(0));
      const base = section.rows.reduce((total, row) => total.plus(row.baseAmount), dec(0));
      const spread = section.rows.reduce((total, row) => total.plus(row.agencySpread), dec(0));
      const cut = section.rows.reduce((total, row) => total.plus(row.agencyCut), dec(0));
      const payable = section.rows.reduce((total, row) => total.plus(row.employeePayable), dec(0));
      const sectionTransactionIds = section.rows.map((row) => row.transactionId).sort();
      candidates.push({
        ...common,
        sourceKey: stableKey(["employee", groupKey, section.direction]),
        kind: section.direction === "receivable" ? "employee_payout_adjustment" : "employee_payout",
        direction: section.direction,
        amount: toMoney(payable.abs()),
        transactionIds: sectionTransactionIds,
        allocations: Object.fromEntries(section.rows.map((row) => [row.transactionId, toMoney(dec(row.employeePayable).abs())])),
        metadata: {
          flow: "agency_routed",
          employeeName: first.employee_name,
          dealRevision: first.deal_revision,
          agencyCutPercent: first.agency_cut_percent,
          billedAmount: toMoney(billed),
          baseAmount: toMoney(base),
          agencySpread: toMoney(spread),
          agencyCut: toMoney(cut),
          employeePayable: toMoney(payable),
          agencyKeepsTotal: toMoney(spread.plus(cut)),
          transactionCount: section.rows.length,
          sourceTransactionIds: sectionTransactionIds,
          reconciles: section.rows.every((row) => row.reconciliations.every((check) => check.reconciles)),
        },
      });
    }
  }

  return {
    candidates,
    skippedNoDeal,
    skippedMissingCheckIdentity,
    skippedMissingNet,
    skippedInconsistentNet,
    skippedInconsistentCheck,
    skippedMissingBase,
    employeeChecks: groups.size,
    protectedSourceKeys,
    protectedTransactionIds,
  };
}

async function individualCandidates(
  pool: PgLikePool,
  individualId?: string | null,
  asOf?: string,
): Promise<{ candidates: ObligationCandidate[]; individualPlans: number }> {
  const { rows } = await listStrategies(pool, {
    individualId: individualId ?? undefined,
    includeArchived: false,
    withAnalytics: true,
    asOf,
  });
  const candidates: ObligationCandidate[] = [];
  let individualPlans = 0;
  for (const row of rows) {
    if (!row.periodStart || !row.periodEnd) continue;
    individualPlans++;
    const targets = individualSettlementTargets(
      {
        lines: [{ programLabel: "Annual plan", hours: "1", internalRate: row.yearlyGross }],
        monthDivisor: row.monthDivisor,
        cut1Percent: row.cut1Percent,
        cut2Percent: row.cut2Percent,
        clockAdjustment: row.clockAdjustment,
        otherAdjustment: row.otherAdjustment,
        afterAll: row.afterAll,
      },
      { includeZero: true },
    );
    for (const target of targets) {
      candidates.push({
        sourceKey: stableKey(["individual", row.id, row.periodStart, row.periodEnd, target.kind]),
        kind: target.kind,
        direction: target.direction,
        individualId: row.individualId,
        calculationStrategyId: row.id,
        amount: target.amount,
        periodBegin: row.periodStart,
        periodEnd: row.periodEnd,
        metadata: {
          flow: "individual_plan",
          individualName: row.individualName,
          strategyLabel: row.label,
          strategyRevisionCount: row.revisionCount,
          account: row.account,
          targetLabel: target.label,
          formula: target.formula,
          monthlyAmount: target.monthlyAmount,
          yearlyGross: row.yearlyGross,
          plannedHours: row.analytics?.plannedHours ?? null,
          actualHours: row.analytics?.actualHours ?? null,
          actualInternal: row.analytics?.actualInternal ?? null,
          utilizationPercent: row.analytics?.utilizationPercent ?? null,
          timeElapsedPercent: row.analytics?.timeElapsedPercent ?? null,
          paceStatus: row.analytics?.status ?? null,
        },
      });
    }
  }
  return { candidates, individualPlans };
}

async function attachTransactions(
  client: PgLikeClient,
  obligationId: string,
  candidate: ObligationCandidate,
  actorId: string | null,
  updateExisting = false,
) {
  const transactionIds = candidate.transactionIds ?? [];
  if (updateExisting) {
    await client.query(
      `DELETE FROM settlement_obligation_transactions
        WHERE settlement_obligation_id = $1
          AND NOT (payroll_transaction_id = ANY($2::uuid[]))`,
      [obligationId, transactionIds],
    );
  }
  if (transactionIds.length === 0) return;
  await client.query(
    `INSERT INTO settlement_obligation_transactions
       (settlement_obligation_id, payroll_transaction_id, allocated_amount, created_by_user_id)
     SELECT $1::uuid, source.payroll_transaction_id, source.allocated_amount, $4::uuid
       FROM unnest($2::uuid[], $3::numeric[]) AS source(payroll_transaction_id, allocated_amount)
     ON CONFLICT (settlement_obligation_id, payroll_transaction_id)
     ${updateExisting ? "DO UPDATE SET allocated_amount = EXCLUDED.allocated_amount" : "DO NOTHING"}`,
    [
      obligationId,
      transactionIds,
      transactionIds.map((transactionId) => candidate.allocations?.[transactionId] ?? null),
      actorId,
    ],
  );
}

async function insertObligation(
  client: PgLikeClient,
  candidate: ObligationCandidate,
  actorId: string | null,
  sourceKey = candidate.sourceKey,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO settlement_obligations
       (source_key, kind, direction, employee_id, individual_id, employee_deal_id,
        calculation_strategy_id, original_amount, check_number, check_date,
        period_begin, period_end, calculation_metadata, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::date, $13::jsonb, $14)
     RETURNING id`,
    [
      sourceKey,
      candidate.kind,
      candidate.direction,
      candidate.employeeId ?? null,
      candidate.individualId ?? null,
      candidate.employeeDealId ?? null,
      candidate.calculationStrategyId ?? null,
      candidate.amount,
      candidate.checkNumber ?? null,
      candidate.checkDate ?? null,
      candidate.periodBegin ?? null,
      candidate.periodEnd ?? null,
      JSON.stringify(candidate.metadata),
      actorId,
    ],
  );
  const id = rows[0].id;
  await attachTransactions(client, id, candidate, actorId);
  return id;
}

async function ensureObligation(
  client: PgLikeClient,
  candidate: ObligationCandidate,
  actorId: string | null,
): Promise<"created" | "updated" | "adjusted" | "voided" | "unchanged"> {
  const existingResult = await client.query<ExistingObligation>(
    `SELECT o.id, o.original_amount::text, o.direction, o.status,
            '0'::text AS event_count, '0'::text AS applied_amount
       FROM settlement_obligations o
      WHERE o.source_key = $1
      FOR UPDATE`,
    [candidate.sourceKey],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    const activity = await client.query<{ event_count: string; applied_amount: string }>(
      `SELECT count(*)::text AS event_count, COALESCE(sum(amount), 0)::text AS applied_amount
         FROM settlement_events WHERE settlement_obligation_id = $1`,
      [existing.id],
    );
    existing.event_count = activity.rows[0]?.event_count ?? "0";
    existing.applied_amount = activity.rows[0]?.applied_amount ?? "0";
  }
  const amount = dec(candidate.amount);
  const lifecycleReason = typeof candidate.metadata.lifecycleReason === "string"
    ? candidate.metadata.lifecycleReason
    : "Recalculated to zero";

  if (!existing) {
    if (!amount.greaterThan(0)) return "unchanged";
    await insertObligation(client, candidate, actorId);
    return "created";
  }

  const eventCount = Number(existing.event_count);
  if (!amount.greaterThan(0) && eventCount === 0) {
    if (existing.status === "active") {
      await client.query(
        `UPDATE settlement_obligations
            SET status = 'void', voided_at = now(), voided_by_user_id = $2,
                void_reason = $3, calculation_metadata = calculation_metadata || $4::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [existing.id, actorId, lifecycleReason, JSON.stringify(candidate.metadata)],
      );
      return "voided";
    }
    return "unchanged";
  }

  if (eventCount === 0) {
    const changed = !dec(existing.original_amount).equals(amount)
      || existing.direction !== candidate.direction
      || existing.status !== "active";
    await client.query(
      `UPDATE settlement_obligations
          SET kind = $2, direction = $3, employee_id = $4, individual_id = $5,
              employee_deal_id = $6, calculation_strategy_id = $7,
              original_amount = $8, check_number = $9, check_date = $10::date,
              period_begin = $11::date, period_end = $12::date,
              calculation_metadata = $13::jsonb, status = 'active',
              voided_at = NULL, voided_by_user_id = NULL, void_reason = NULL,
              updated_at = now()
        WHERE id = $1`,
      [
        existing.id,
        candidate.kind,
        candidate.direction,
        candidate.employeeId ?? null,
        candidate.individualId ?? null,
        candidate.employeeDealId ?? null,
        candidate.calculationStrategyId ?? null,
        candidate.amount,
        candidate.checkNumber ?? null,
        candidate.checkDate ?? null,
        candidate.periodBegin ?? null,
        candidate.periodEnd ?? null,
        JSON.stringify(candidate.metadata),
      ],
    );
    await attachTransactions(client, existing.id, candidate, actorId, true);
    return changed ? "updated" : "unchanged";
  }

  const priorAdjustment = await client.query<{
    id: string;
    recalculated_amount: string | null;
    recalculated_direction: SettlementDirection | null;
  }>(
    `SELECT id,
            calculation_metadata->>'recalculatedOriginalAmount' AS recalculated_amount,
            calculation_metadata->>'recalculatedDirection' AS recalculated_direction
       FROM settlement_obligations
      WHERE calculation_metadata->>'adjustmentForObligationId' = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [existing.id],
  );
  const priorTarget = priorAdjustment.rows[0]?.recalculated_amount ?? existing.original_amount;
  const priorDirection = priorAdjustment.rows[0]?.recalculated_direction ?? existing.direction;
  const delta = settlementTargetDelta({
    previousAmount: priorTarget,
    previousDirection: priorDirection,
    nextAmount: candidate.amount,
    nextDirection: candidate.direction,
    positiveDirection: candidate.employeeId ? "payable" : "reserve",
  });
  if (!delta) {
    return "unchanged";
  }
  const adjustmentKey = stableKey([
    candidate.sourceKey,
    "adjustment",
    priorAdjustment.rows[0]?.id ?? existing.id,
    candidate.amount,
    candidate.direction,
    candidate.metadata,
  ]);
  const prior = await client.query<{ id: string }>(
    `SELECT id FROM settlement_obligations WHERE source_key = $1`,
    [adjustmentKey],
  );
  if (prior.rows[0]) return "unchanged";
  await insertObligation(
    client,
    {
      ...candidate,
      sourceKey: adjustmentKey,
      kind: `${candidate.kind}_correction`,
      direction: delta.direction,
      amount: delta.amount,
      metadata: {
        ...candidate.metadata,
        adjustmentForObligationId: existing.id,
        priorOriginalAmount: priorTarget,
        priorDirection,
        recalculatedOriginalAmount: candidate.amount,
        recalculatedDirection: candidate.direction,
        adjustmentAmount: delta.signedAmount,
        previouslyAppliedAmount: existing.applied_amount,
      },
    },
    actorId,
    adjustmentKey,
  );
  return "adjusted";
}

function metadataRecord(value: ReconciliationRoot["calculation_metadata"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function loadReconciliationRoots(
  client: PgLikeClient,
  input: RefreshSettlementsInput,
  includeEmployees: boolean,
  includeIndividuals: boolean,
): Promise<ReconciliationRoot[]> {
  const params: unknown[] = [];
  const scopes: string[] = [];
  if (includeEmployees) {
    const employee = input.employeeId
      ? ` AND o.employee_id = $${params.push(input.employeeId)}`
      : "";
    scopes.push(`(o.employee_id IS NOT NULL
      AND o.calculation_metadata->>'flow' IN ('direct_employee', 'agency_routed')${employee})`);
  }
  if (includeIndividuals) {
    const individual = input.individualId
      ? ` AND o.individual_id = $${params.push(input.individualId)}`
      : "";
    scopes.push(`(o.individual_id IS NOT NULL
      AND o.calculation_metadata->>'flow' = 'individual_plan'${individual})`);
  }
  if (scopes.length === 0) return [];

  const { rows } = await client.query<ReconciliationRoot>(
    `SELECT o.source_key, o.kind, o.direction, o.employee_id, o.individual_id,
            o.employee_deal_id, o.calculation_strategy_id, o.check_number,
            to_char(o.check_date, 'YYYY-MM-DD') AS check_date,
            to_char(o.period_begin, 'YYYY-MM-DD') AS period_begin,
            to_char(o.period_end, 'YYYY-MM-DD') AS period_end,
            o.calculation_metadata,
            ARRAY(
              SELECT ot.payroll_transaction_id::text
                FROM settlement_obligation_transactions ot
               WHERE ot.settlement_obligation_id = o.id
            ) AS transaction_ids
       FROM settlement_obligations o
      WHERE o.status = 'active'
        AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
        AND (${scopes.join(" OR ")})
      FOR UPDATE OF o`,
    params,
  );
  return rows;
}

function employeeSourceSignature(input: {
  employeeId: string;
  flow: unknown;
  transactionIds: readonly string[];
}): string | null {
  if (typeof input.flow !== "string" || input.transactionIds.length === 0) return null;
  return `${input.employeeId}:${input.flow}:${[...input.transactionIds].sort().join(",")}`;
}

function employeeStableSourceIdentity(input: {
  employeeId: string;
  flow: unknown;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
}): string | null {
  if (input.flow !== "direct_employee") return null;
  const checkIdentity = directSettlementCheckIdentity({
    checkNumber: input.checkNumber,
    checkDate: input.checkDate,
    periodBegin: input.periodBegin,
    periodEnd: input.periodEnd,
  });
  return checkIdentity ? `${input.employeeId}:direct_employee:${checkIdentity}` : null;
}

/** Preserve the original ledger root when an employee merge changes only the person id. */
async function adoptMergedEmployeeSourceKeys(
  client: PgLikeClient,
  candidates: ObligationCandidate[],
): Promise<void> {
  const employeeIds = [...new Set(
    candidates
      .map((candidate) => candidate.employeeId)
      .filter((employeeId): employeeId is string => Boolean(employeeId)),
  )];
  if (employeeIds.length === 0) return;

  const { rows } = await client.query<EmployeeSourceRoot>(
    `SELECT o.source_key, o.employee_id,
            o.calculation_metadata->>'flow' AS flow,
            o.check_number,
            to_char(o.check_date, 'YYYY-MM-DD') AS check_date,
            to_char(o.period_begin, 'YYYY-MM-DD') AS period_begin,
            to_char(o.period_end, 'YYYY-MM-DD') AS period_end,
            ARRAY(
              SELECT ot.payroll_transaction_id::text
                FROM settlement_obligation_transactions ot
               WHERE ot.settlement_obligation_id = o.id
               ORDER BY ot.payroll_transaction_id
            ) AS transaction_ids
       FROM settlement_obligations o
      WHERE o.status = 'active'
        AND o.employee_id = ANY($1::uuid[])
        AND o.calculation_metadata->>'flow' IN ('direct_employee', 'agency_routed')
        AND NOT (o.calculation_metadata ? 'adjustmentForObligationId')
      FOR UPDATE OF o`,
    [employeeIds],
  );

  const existingKeys = new Set(rows.map((row) => row.source_key));
  const rootsBySignature = new Map<string, EmployeeSourceRoot | null>();
  const rootsByStableIdentity = new Map<string, EmployeeSourceRoot | null>();
  for (const root of rows) {
    const signature = employeeSourceSignature({
      employeeId: root.employee_id,
      flow: root.flow,
      transactionIds: root.transaction_ids,
    });
    if (signature) rootsBySignature.set(signature, rootsBySignature.has(signature) ? null : root);
    const stableIdentity = employeeStableSourceIdentity({
      employeeId: root.employee_id,
      flow: root.flow,
      checkNumber: root.check_number,
      checkDate: root.check_date,
      periodBegin: root.period_begin,
      periodEnd: root.period_end,
    });
    if (stableIdentity) {
      rootsByStableIdentity.set(
        stableIdentity,
        rootsByStableIdentity.has(stableIdentity) ? null : root,
      );
    }
  }

  for (const candidate of candidates) {
    if (!candidate.employeeId || existingKeys.has(candidate.sourceKey)) continue;
    const signature = employeeSourceSignature({
      employeeId: candidate.employeeId,
      flow: candidate.metadata.flow,
      transactionIds: candidate.transactionIds ?? [],
    });
    const stableIdentity = employeeStableSourceIdentity({
      employeeId: candidate.employeeId,
      flow: candidate.metadata.flow,
      checkNumber: candidate.checkNumber ?? null,
      checkDate: candidate.checkDate ?? null,
      periodBegin: candidate.periodBegin ?? null,
      periodEnd: candidate.periodEnd ?? null,
    });
    const root = (signature ? rootsBySignature.get(signature) : null)
      ?? (stableIdentity ? rootsByStableIdentity.get(stableIdentity) : null);
    if (root) candidate.sourceKey = root.source_key;
  }
}

function zeroCandidate(root: ReconciliationRoot): ObligationCandidate {
  return {
    sourceKey: root.source_key,
    kind: root.kind,
    direction: root.direction,
    employeeId: root.employee_id,
    individualId: root.individual_id,
    employeeDealId: root.employee_deal_id,
    calculationStrategyId: root.calculation_strategy_id,
    amount: "0.0000",
    checkNumber: root.check_number,
    checkDate: root.check_date,
    periodBegin: root.period_begin,
    periodEnd: root.period_end,
    metadata: {
      ...metadataRecord(root.calculation_metadata),
      lifecycleReconciliation: true,
      lifecycleReason: "Source no longer produces this obligation",
    },
    transactionIds: root.transaction_ids,
  };
}

function readPoolFromClient(client: PgLikeClient): PgLikePool {
  return {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return client.query<T>(sql, params);
    },
    async connect() {
      throw new Error("Nested settlement source transactions are not supported.");
    },
  };
}

export function shouldPreserveEndedIndividualPeriod(
  periodEnd: string | null,
  today: string,
): boolean {
  return periodEnd !== null && periodEnd <= today;
}

export async function refreshSettlementObligations(
  pool: PgLikePool,
  input: RefreshSettlementsInput,
  actorId: string | null,
  options: RefreshSettlementsOptions = {},
): Promise<Result<RefreshSettlementsResult>> {
  if (input.employeeId && !UUID.test(input.employeeId)) return fail("validation", "Invalid employee.");
  if (input.individualId && !UUID.test(input.individualId)) return fail("validation", "Invalid individual.");
  const applicationDate = settlementApplicationDate();
  let phase: SettlementRefreshPhase = "begin";

  try {
    const result = await inTransaction(pool, async (client) => {
      phase = "lock-refresh";
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ahivim:settlement-refresh'))`);
      phase = "lock-sources";
      const freshness = await lockSettlementSources(client, applicationDate);
      if (freshness.dirty && options.allowGlobalWhenDirty === false) {
        phase = "commit";
        return null;
      }
      // A dirty global ledger can only be certified by a global pass. Targeted
      // refreshes remain available for clean, diagnostic recalculation.
      const refreshInput: RefreshSettlementsInput = freshness.dirty ? {} : input;
      const readPool = readPoolFromClient(client);
      phase = "read-employee-sources";
      const employeeRows = refreshInput.individualId && !refreshInput.employeeId
        ? []
        : await loadEmployeeTransactions(client, refreshInput.employeeId);
      const unknownRecipientTransactionIds = refreshInput.individualId && !refreshInput.employeeId
        ? []
        : await loadUnknownRecipientTransactionIds(client, refreshInput.employeeId);
      phase = "read-individual-plans";
      const individual = refreshInput.employeeId && !refreshInput.individualId
        ? { candidates: [], individualPlans: 0 }
        : await individualCandidates(readPool, refreshInput.individualId, applicationDate);
      phase = "build-candidates";
      const employee = employeeCandidates(employeeRows);
      const refreshResult: RefreshSettlementsResult = {
        created: 0,
        updated: 0,
        adjusted: 0,
        voided: 0,
        unchanged: 0,
        skippedNoDeal: employee.skippedNoDeal,
        skippedMissingCheckIdentity: employee.skippedMissingCheckIdentity,
        skippedMissingNet: employee.skippedMissingNet,
        skippedInconsistentNet: employee.skippedInconsistentNet,
        skippedInconsistentCheck: employee.skippedInconsistentCheck,
        skippedMissingBase: employee.skippedMissingBase,
        skippedUnknownRecipient: unknownRecipientTransactionIds.length,
        employeeChecks: employee.employeeChecks,
        individualPlans: individual.individualPlans,
        preservedHistorical: 0,
      };
      const fullRefresh = !refreshInput.employeeId && !refreshInput.individualId;
      // Existing zero-value roots are handled by the bulk reconciliation pass.
      // Keep ended individual periods on their historical path instead of
      // accidentally preserving a root that the prior behavior recalculated.
      const candidates = [...employee.candidates, ...individual.candidates].filter((candidate) => (
        dec(candidate.amount).greaterThan(0)
        || Boolean(
          candidate.individualId
          && shouldPreserveEndedIndividualPeriod(candidate.periodEnd ?? null, applicationDate),
        )
      ));
      phase = "match-existing-sources";
      await adoptMergedEmployeeSourceKeys(client, candidates);
      phase = "write-obligations";
      for (const candidate of candidates) {
        const outcome = await ensureObligation(client, candidate, actorId);
        refreshResult[outcome]++;
      }
      const candidateKeys = new Set(candidates.map((candidate) => candidate.sourceKey));
      for (const transactionId of unknownRecipientTransactionIds) {
        employee.protectedTransactionIds.add(transactionId);
      }
      const includeEmployees = !(refreshInput.individualId && !refreshInput.employeeId);
      const includeIndividuals = !(refreshInput.employeeId && !refreshInput.individualId);
      phase = "read-reconciliation-roots";
      const roots = await loadReconciliationRoots(client, refreshInput, includeEmployees, includeIndividuals);
      phase = "reconcile-obligations";
      for (const root of roots) {
        if (candidateKeys.has(root.source_key) || employee.protectedSourceKeys.has(root.source_key)) continue;
        if (root.transaction_ids.some((id) => employee.protectedTransactionIds.has(id))) continue;
        if (root.individual_id && shouldPreserveEndedIndividualPeriod(root.period_end, applicationDate)) {
          refreshResult.preservedHistorical++;
          continue;
        }
        const outcome = await ensureObligation(client, zeroCandidate(root), actorId);
        refreshResult[outcome]++;
      }
      phase = "write-audit";
      await recordChange(client, {
        actorId,
        action: "settlements.refreshed",
        entityType: "settlement_ledger",
        entityId: null,
        next: refreshResult,
        extra: {
          requestedEmployeeId: input.employeeId ?? null,
          requestedIndividualId: input.individualId ?? null,
          fullRefresh,
          applicationDate,
        },
      });
      if (fullRefresh) {
        phase = "certify-ledger";
        const blockingIssue = settlementRefreshBlockingIssueMessage(refreshResult);
        if (blockingIssue) {
          await markSettlementRefreshBlocked(client, blockingIssue);
        } else {
          await markSettlementRefreshComplete(client, true, applicationDate);
        }
      }
      phase = "commit";
      return refreshResult;
    });
    if (!result) {
      return fail(
        "conflict",
        "Settlement calculations require a full refresh by an operator with access to all employees and individuals.",
      );
    }
    return ok(result);
  } catch (error) {
    console.error("[settlement-refresh] failed", settlementRefreshDiagnostic(error, phase));
    await recordSettlementRefreshFailure(
      pool,
      "Settlement refresh did not complete. Retry from Settlements.",
    ).catch(() => undefined);
    return fail("conflict", "Settlement items could not be refreshed. The ledger remains blocked until refresh succeeds.");
  }
}

function staleSettlementLedger() {
  return fail(
    "conflict",
    "Settlement calculations are out of date. Refresh Settlements before recording any payment, credit, or reversal.",
  );
}

interface LockedObligation {
  id: string;
  employee_id: string | null;
  individual_id: string | null;
  direction: SettlementDirection;
  original_amount: string;
  applied_amount: string;
  status: "active" | "void";
}

async function lockObligations(client: PgLikeClient, ids: string[]): Promise<LockedObligation[]> {
  const { rows } = await client.query<Omit<LockedObligation, "applied_amount">>(
    `SELECT o.id, o.employee_id, o.individual_id, o.direction,
            o.original_amount::text, o.status
       FROM settlement_obligations o
      WHERE o.id = ANY($1::uuid[])
      ORDER BY o.id
      FOR UPDATE`,
    [ids],
  );
  if (!rows.length) return [];
  const activity = await client.query<{ settlement_obligation_id: string; applied_amount: string }>(
    `SELECT settlement_obligation_id, COALESCE(sum(amount), 0)::text AS applied_amount
       FROM settlement_events
      WHERE settlement_obligation_id = ANY($1::uuid[])
      GROUP BY settlement_obligation_id`,
    [rows.map((row) => row.id)],
  );
  const applied = new Map(activity.rows.map((row) => [row.settlement_obligation_id, row.applied_amount]));
  return rows.map((row) => ({ ...row, applied_amount: applied.get(row.id) ?? "0" }));
}

interface BatchLookup {
  state: "missing" | "conflict" | "replay";
  result?: SettlementEventResult;
}

async function lookupBatch(
  client: PgLikeClient,
  operationKey: string,
  action: string,
  requestFingerprint: string,
  actorId: string | null,
): Promise<BatchLookup> {
  const existing = await client.query<{
    id: string;
    action: string;
    request_fingerprint: string | null;
    created_by_user_id: string | null;
  }>(
    `SELECT id, action, metadata->>'requestFingerprint' AS request_fingerprint,
            created_by_user_id
       FROM settlement_batches
      WHERE idempotency_key = $1`,
    [operationKey],
  );
  const batch = existing.rows[0];
  if (!batch) return { state: "missing" };
  if (
    batch.action !== action
    || batch.request_fingerprint !== requestFingerprint
    || batch.created_by_user_id !== actorId
  ) {
    return { state: "conflict" };
  }
  const events = await client.query<{ id: string }>(
    `SELECT id FROM settlement_events WHERE settlement_batch_id = $1 ORDER BY id`,
    [batch.id],
  );
  if (events.rows.length === 0) return { state: "conflict" };
  return {
    state: "replay",
    result: { batchId: batch.id, eventIds: events.rows.map((row) => row.id) },
  };
}

async function createBatch(
  client: PgLikeClient,
  operationKey: string,
  action: string,
  actorId: string | null,
  requestFingerprint: string,
  metadata: Record<string, unknown>,
): Promise<{ state: "created"; batchId: string } | BatchLookup> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO settlement_batches
       (idempotency_key, action, metadata, created_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [operationKey, action, JSON.stringify({ ...metadata, requestFingerprint }), actorId],
  );
  if (rows[0]) return { state: "created", batchId: rows[0].id };
  return lookupBatch(client, operationKey, action, requestFingerprint, actorId);
}

export async function settleObligations(
  pool: PgLikePool,
  input: {
    obligationIds: string[];
    occurredOn: string;
    operationKey: string;
    reference?: string | null;
    note?: string | null;
  },
  actorId: string | null,
): Promise<Result<SettlementEventResult>> {
  const ids = [...new Set(input.obligationIds)].filter((id) => UUID.test(id)).sort();
  if (!ids.length || ids.length !== new Set(input.obligationIds).size) {
    return fail("validation", "Select one or more valid settlement items.");
  }
  if (!validDate(input.occurredOn)) return fail("validation", "Enter a valid settlement date.");
  if (!UUID.test(input.operationKey)) return fail("validation", "This settlement request is missing its operation key.");
  const reference = input.reference?.trim() || null;
  const note = input.note?.trim() || null;
  const requestFingerprint = stableKey(["settle_selected", ids, input.occurredOn, reference, note, actorId]);

  return inTransaction(pool, async (client) => {
    const replay = await lookupBatch(client, input.operationKey, "settle_selected", requestFingerprint, actorId);
    if (replay.state === "replay") return ok(replay.result!);
    if (replay.state === "conflict") return fail("conflict", "That operation key was already used for a different settlement.");
    if ((await lockSettlementSources(client)).dirty) return staleSettlementLedger();
    const obligations = await lockObligations(client, ids);
    const replayAfterLock = await lookupBatch(client, input.operationKey, "settle_selected", requestFingerprint, actorId);
    if (replayAfterLock.state === "replay") return ok(replayAfterLock.result!);
    if (replayAfterLock.state === "conflict") return fail("conflict", "That operation key was already used for a different settlement.");
    if (obligations.length !== ids.length) return fail("not_found", "One of those settlement items no longer exists.");
    const actionable = obligations.filter(
      (row) => row.status === "active" && dec(row.original_amount).minus(row.applied_amount).greaterThan(0),
    );
    if (actionable.length !== obligations.length) {
      return fail("conflict", "One of those balances changed. Refresh Settlements and select the items again.");
    }
    const batch = await createBatch(
      client,
      input.operationKey,
      "settle_selected",
      actorId,
      requestFingerprint,
      { obligationIds: ids },
    );
    if (batch.state === "replay") return ok(batch.result!);
    if (batch.state !== "created") return fail("conflict", "That operation key was already used for a different settlement.");
    const batchId = batch.batchId;
    const eventIds: string[] = [];
    for (const row of actionable) {
      const amount = settlementBalance(row.original_amount, row.applied_amount);
      const eventType = row.direction === "reserve" ? "set_aside" : "payment";
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO settlement_events
           (settlement_obligation_id, settlement_batch_id, employee_id, individual_id,
            event_type, amount, occurred_on, reference, note, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)
         RETURNING id`,
        [
          row.id,
          batchId,
          row.employee_id,
          row.individual_id,
          eventType,
          amount,
          input.occurredOn,
          reference,
          note,
          actorId,
        ],
      );
      eventIds.push(inserted.rows[0].id);
    }
    eventIds.sort();
    await recordChange(client, {
      actorId,
      action: "settlements.settled",
      entityType: "settlement_batch",
      entityId: batchId,
      next: { eventIds, obligationIds: actionable.map((row) => row.id), occurredOn: input.occurredOn },
    });
    return ok({ batchId, eventIds });
  });
}

export async function recordObligationPayment(
  pool: PgLikePool,
  input: {
    obligationId: string;
    amount: string;
    occurredOn: string;
    operationKey: string;
    reference?: string | null;
    note?: string | null;
  },
  actorId: string | null,
): Promise<Result<SettlementEventResult>> {
  if (!UUID.test(input.obligationId)) return fail("validation", "Choose a settlement item.");
  if (!validDate(input.occurredOn)) return fail("validation", "Enter a valid payment date.");
  if (!UUID.test(input.operationKey)) return fail("validation", "This payment request is missing its operation key.");
  let amount: string;
  try {
    amount = toMoney(input.amount);
    if (!dec(amount).greaterThan(0)) return fail("validation", "The payment must be greater than zero.");
  } catch {
    return fail("validation", "Enter a valid payment amount.");
  }
  const reference = input.reference?.trim() || null;
  const note = input.note?.trim() || null;
  const requestFingerprint = stableKey([
    "record_payment",
    input.obligationId,
    amount,
    input.occurredOn,
    reference,
    note,
    actorId,
  ]);

  return inTransaction(pool, async (client) => {
    const replay = await lookupBatch(client, input.operationKey, "record_payment", requestFingerprint, actorId);
    if (replay.state === "replay") return ok(replay.result!);
    if (replay.state === "conflict") return fail("conflict", "That operation key was already used for a different payment.");
    if ((await lockSettlementSources(client)).dirty) return staleSettlementLedger();
    const obligations = await lockObligations(client, [input.obligationId]);
    const replayAfterLock = await lookupBatch(client, input.operationKey, "record_payment", requestFingerprint, actorId);
    if (replayAfterLock.state === "replay") return ok(replayAfterLock.result!);
    if (replayAfterLock.state === "conflict") return fail("conflict", "That operation key was already used for a different payment.");
    const row = obligations[0];
    if (!row) return fail("not_found", "That settlement item no longer exists.");
    if (row.status !== "active") return fail("conflict", "That settlement item is void.");
    const batch = await createBatch(
      client,
      input.operationKey,
      "record_payment",
      actorId,
      requestFingerprint,
      { obligationId: row.id, amount },
    );
    if (batch.state === "replay") return ok(batch.result!);
    if (batch.state !== "created") return fail("conflict", "That operation key was already used for a different payment.");
    const batchId = batch.batchId;
    const eventType = row.direction === "reserve" ? "set_aside" : "payment";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO settlement_events
         (settlement_obligation_id, settlement_batch_id, employee_id, individual_id,
          event_type, amount, occurred_on, reference, note, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)
       RETURNING id`,
      [
        row.id,
        batchId,
        row.employee_id,
        row.individual_id,
        eventType,
        amount,
        input.occurredOn,
        reference,
        note,
        actorId,
      ],
    );
    await recordChange(client, {
      actorId,
      action: "settlement.payment_recorded",
      entityType: "settlement_event",
      entityId: inserted.rows[0].id,
      next: { obligationId: row.id, amount, occurredOn: input.occurredOn },
    });
    return ok({ batchId, eventIds: [inserted.rows[0].id] });
  });
}

export async function applySettlementCredit(
  pool: PgLikePool,
  input: {
    sourceObligationId: string;
    targetObligationId: string;
    amount: string;
    occurredOn: string;
    operationKey: string;
    reference?: string | null;
    note?: string | null;
  },
  actorId: string | null,
): Promise<Result<SettlementEventResult>> {
  if (!UUID.test(input.sourceObligationId) || !UUID.test(input.targetObligationId)) {
    return fail("validation", "Choose a valid credit and balance.");
  }
  if (input.sourceObligationId === input.targetObligationId) {
    return fail("validation", "Choose a different balance to receive the credit.");
  }
  if (!validDate(input.occurredOn)) return fail("validation", "Enter a valid credit date.");
  if (!UUID.test(input.operationKey)) return fail("validation", "This credit request is missing its operation key.");
  let amount: string;
  try {
    amount = toMoney(input.amount);
    if (!dec(amount).greaterThan(0)) return fail("validation", "The credit amount must be greater than zero.");
  } catch {
    return fail("validation", "Enter a valid credit amount.");
  }
  const reference = input.reference?.trim() || null;
  const note = input.note?.trim() || null;
  const requestFingerprint = stableKey([
    "apply_credit",
    input.sourceObligationId,
    input.targetObligationId,
    amount,
    input.occurredOn,
    reference,
    note,
    actorId,
  ]);

  return inTransaction(pool, async (client) => {
    const replay = await lookupBatch(client, input.operationKey, "apply_credit", requestFingerprint, actorId);
    if (replay.state === "replay") return ok(replay.result!);
    if (replay.state === "conflict") return fail("conflict", "That operation key was already used for a different credit.");
    if ((await lockSettlementSources(client)).dirty) return staleSettlementLedger();

    const obligations = await lockObligations(
      client,
      [input.sourceObligationId, input.targetObligationId].sort(),
    );
    const replayAfterLock = await lookupBatch(client, input.operationKey, "apply_credit", requestFingerprint, actorId);
    if (replayAfterLock.state === "replay") return ok(replayAfterLock.result!);
    if (replayAfterLock.state === "conflict") return fail("conflict", "That operation key was already used for a different credit.");

    const source = obligations.find((row) => row.id === input.sourceObligationId);
    const target = obligations.find((row) => row.id === input.targetObligationId);
    if (!source || !target) return fail("not_found", "That credit or balance no longer exists.");
    if (source.status !== "active" || target.status !== "active") {
      return fail("conflict", "That credit or balance is void. Refresh Settlements and try again.");
    }
    const samePerson = source.employee_id === target.employee_id
      && source.individual_id === target.individual_id;
    if (!samePerson || source.direction !== target.direction) {
      return fail("validation", "Credits can only be applied to the same person and settlement direction.");
    }
    const sourceBalance = dec(settlementBalance(source.original_amount, source.applied_amount));
    const targetBalance = dec(settlementBalance(target.original_amount, target.applied_amount));
    const creditAvailable = sourceBalance.negated();
    if (!creditAvailable.greaterThan(0)) return fail("conflict", "That item no longer has a credit balance.");
    if (!targetBalance.greaterThan(0)) return fail("conflict", "That target no longer has a balance to settle.");
    if (dec(amount).greaterThan(creditAvailable) || dec(amount).greaterThan(targetBalance)) {
      return fail("conflict", "The credit amount is greater than the available credit or remaining balance.");
    }

    const batch = await createBatch(
      client,
      input.operationKey,
      "apply_credit",
      actorId,
      requestFingerprint,
      {
        sourceObligationId: source.id,
        targetObligationId: target.id,
        amount,
      },
    );
    if (batch.state === "replay") return ok(batch.result!);
    if (batch.state !== "created") return fail("conflict", "That operation key was already used for a different credit.");

    const eventIds: string[] = [];
    for (const [row, signedAmount] of [[source, toMoney(dec(amount).negated())], [target, amount]] as const) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO settlement_events
           (settlement_obligation_id, settlement_batch_id, employee_id, individual_id,
            event_type, amount, occurred_on, reference, note, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'credit', $5, $6::date, $7, $8, $9)
         RETURNING id`,
        [
          row.id,
          batch.batchId,
          row.employee_id,
          row.individual_id,
          signedAmount,
          input.occurredOn,
          reference,
          note,
          actorId,
        ],
      );
      eventIds.push(inserted.rows[0].id);
    }
    eventIds.sort();
    await recordChange(client, {
      actorId,
      action: "settlement.credit_applied",
      entityType: "settlement_batch",
      entityId: batch.batchId,
      next: {
        sourceObligationId: source.id,
        targetObligationId: target.id,
        amount,
        occurredOn: input.occurredOn,
      },
    });
    return ok({ batchId: batch.batchId, eventIds });
  });
}

export async function reverseSettlementEvent(
  pool: PgLikePool,
  eventId: string,
  reason: string,
  actorId: string | null,
  operationKey: string,
): Promise<Result<SettlementEventResult>> {
  if (!UUID.test(eventId)) return fail("validation", "Choose a settlement event.");
  if (!UUID.test(operationKey)) return fail("validation", "This reversal request is missing its operation key.");
  const trimmedReason = reason.trim();
  if (!trimmedReason) return fail("validation", "Enter a reason for the reversal.");
  const requestFingerprint = stableKey(["reverse_event", eventId, trimmedReason, actorId]);
  return inTransaction(pool, async (client) => {
    const replay = await lookupBatch(client, operationKey, "reverse_event", requestFingerprint, actorId);
    if (replay.state === "replay") return ok(replay.result!);
    if (replay.state === "conflict") return fail("conflict", "That operation key was already used for a different reversal.");
    if ((await lockSettlementSources(client)).dirty) return staleSettlementLedger();
    const original = await client.query<{
      id: string;
      settlement_obligation_id: string | null;
      settlement_batch_id: string | null;
      batch_action: string | null;
      employee_id: string | null;
      individual_id: string | null;
      amount: string;
      occurred_on: string;
    }>(
      `SELECT e.id, e.settlement_obligation_id, e.settlement_batch_id,
              b.action AS batch_action, e.employee_id, e.individual_id,
              e.amount::text, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on
         FROM settlement_events e
         LEFT JOIN settlement_batches b ON b.id = e.settlement_batch_id
        WHERE e.id = $1 AND e.event_type <> 'reversal'
        FOR UPDATE OF e`,
      [eventId],
    );
    const row = original.rows[0];
    if (!row) return fail("not_found", "That settlement event no longer exists.");
    const sourceEvents = row.batch_action === "apply_credit" && row.settlement_batch_id
      ? await client.query<typeof row>(
        `SELECT e.id, e.settlement_obligation_id, e.settlement_batch_id,
                'apply_credit'::text AS batch_action, e.employee_id, e.individual_id,
                e.amount::text, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on
           FROM settlement_events e
          WHERE e.settlement_batch_id = $1 AND e.event_type = 'credit'
          ORDER BY e.id
          FOR UPDATE`,
        [row.settlement_batch_id],
      )
      : { rows: [row] };
    const sourceIds = sourceEvents.rows.map((event) => event.id);
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM settlement_events WHERE reversal_of_event_id = ANY($1::uuid[]) LIMIT 1`,
      [sourceIds],
    );
    if (duplicate.rows[0]) return fail("conflict", "That event has already been reversed.");
    const replayAfterLock = await lookupBatch(client, operationKey, "reverse_event", requestFingerprint, actorId);
    if (replayAfterLock.state === "replay") return ok(replayAfterLock.result!);
    if (replayAfterLock.state === "conflict") return fail("conflict", "That operation key was already used for a different reversal.");
    const batch = await createBatch(
      client,
      operationKey,
      "reverse_event",
      actorId,
      requestFingerprint,
      { eventId, sourceEventIds: sourceIds, reason: trimmedReason },
    );
    if (batch.state === "replay") return ok(batch.result!);
    if (batch.state !== "created") return fail("conflict", "That operation key was already used for a different reversal.");
    const reversalIds: string[] = [];
    for (const source of sourceEvents.rows) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO settlement_events
           (settlement_obligation_id, settlement_batch_id, employee_id, individual_id,
            event_type, amount, occurred_on, note, created_by_user_id, reversal_of_event_id)
         VALUES ($1, $2, $3, $4, 'reversal', $5, CURRENT_DATE, $6, $7, $8)
         RETURNING id`,
        [
          source.settlement_obligation_id,
          batch.batchId,
          source.employee_id,
          source.individual_id,
          toMoney(dec(source.amount).negated()),
          trimmedReason,
          actorId,
          source.id,
        ],
      );
      reversalIds.push(inserted.rows[0].id);
    }
    reversalIds.sort();
    await recordChange(client, {
      actorId,
      action: "settlement.event_reversed",
      entityType: "settlement_event",
      entityId: reversalIds[0],
      previous: { eventIds: sourceIds, amount: row.amount, occurredOn: row.occurred_on },
      next: { reversalEventIds: reversalIds },
      reason: trimmedReason,
    });
    return ok({ batchId: batch.batchId, eventIds: reversalIds });
  });
}
