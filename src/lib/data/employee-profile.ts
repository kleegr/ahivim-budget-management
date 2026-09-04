import type { PgLikePool } from "@/lib/import/commit";
import { settlementState, type SettlementDirection, type SettlementState } from "@/lib/business/settlement-ledger";
import { dec, toMoney } from "@/lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EmployeeProfileView = "overview" | "activity" | "staffing" | "money" | "more";

const VIEW_ALIASES: Record<string, EmployeeProfileView> = {
  overview: "overview",
  activity: "activity",
  people: "activity",
  staffing: "staffing",
  money: "money",
  checks: "money",
  deal: "money",
  more: "more",
  details: "more",
};

/** Keep old Employee profile deep links useful after the five-tab consolidation. */
export function normalizeEmployeeProfileView(value: string | undefined): EmployeeProfileView {
  return value ? VIEW_ALIASES[value] ?? "overview" : "overview";
}

export interface EmployeePortalPreviewAccount {
  userId: string;
  displayName: string;
  email: string;
  lastLoginAt: string | null;
}

/** Active, real Employee portal identities that an Owner may impersonate. */
export async function listEmployeeProfilePreviewAccounts(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeePortalPreviewAccount[]> {
  if (!UUID.test(employeeId)) return [];
  const { rows } = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    last_login_at: string | null;
  }>(
    `SELECT DISTINCT account.id AS user_id, account.display_name, account.email,
            account.last_login_at::text
       FROM user_employee_relationships relationship
       JOIN users account ON account.id = relationship.user_id
       JOIN user_portal_roles portal_role
         ON portal_role.user_id = relationship.user_id
        AND portal_role.portal_role = 'employee'
        AND portal_role.is_active = true
      WHERE relationship.employee_id = $1
        AND relationship.relationship_type = 'self'
        AND relationship.is_active = true
        AND account.is_active = true
      ORDER BY account.last_login_at DESC NULLS LAST, account.display_name, account.id`,
    [employeeId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    lastLoginAt: row.last_login_at,
  }));
}

export interface EmployeeProfileCheck {
  id: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  actualGross: string | null;
  actualNet: string | null;
  taxWithheld: string | null;
  verificationStatus: "unverified" | "verified" | "void";
  linkedTransactions: number;
  transactionIds: string[];
}

/** Canonical payroll-check facts for one Employee; never substitutes billed revenue for gross. */
export async function listEmployeeProfileChecks(
  pool: PgLikePool,
  employeeId: string,
  visibility: {
    gross: boolean;
    net: boolean;
    tax: boolean;
    transactions: boolean;
  },
  limit = 50,
): Promise<EmployeeProfileCheck[]> {
  if (!UUID.test(employeeId) || (!visibility.gross && !visibility.net && !visibility.tax)) return [];
  const { rows } = await pool.query<{
    id: string;
    check_number: string | null;
    check_date: string | null;
    period_begin: string | null;
    period_end: string | null;
    actual_gross: string | null;
    actual_net: string | null;
    tax_withheld: string | null;
    verification_status: EmployeeProfileCheck["verificationStatus"];
    linked_transactions: string;
    transaction_ids: string[] | null;
  }>(
    `SELECT checks.id, checks.check_number,
            to_char(checks.check_date, 'YYYY-MM-DD') AS check_date,
            to_char(checks.period_begin, 'YYYY-MM-DD') AS period_begin,
            to_char(checks.period_end, 'YYYY-MM-DD') AS period_end,
            checks.actual_gross::text, checks.actual_net::text,
            checks.tax_withheld::text, checks.verification_status,
            count(t.id)::text AS linked_transactions,
            COALESCE(
              array_agg(t.id::text ORDER BY t.id)
                FILTER (WHERE t.id IS NOT NULL),
              ARRAY[]::text[]
            ) AS transaction_ids
       FROM employee_payroll_checks checks
       LEFT JOIN payroll_transactions t ON t.payroll_check_id = checks.id
      WHERE checks.employee_id = $1
      GROUP BY checks.id
      ORDER BY CASE checks.verification_status
                 WHEN 'unverified' THEN 0 WHEN 'verified' THEN 1 ELSE 2
               END,
               canonical_service_date(checks.period_begin, checks.check_date, checks.period_end) DESC NULLS LAST,
               checks.updated_at DESC
      LIMIT $2`,
    [employeeId, Math.min(Math.max(1, limit), 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    checkNumber: row.check_number,
    checkDate: row.check_date,
    periodBegin: row.period_begin,
    periodEnd: row.period_end,
    actualGross: visibility.gross && row.actual_gross !== null ? toMoney(row.actual_gross) : null,
    actualNet: visibility.net && row.actual_net !== null ? toMoney(row.actual_net) : null,
    taxWithheld: visibility.tax && row.tax_withheld !== null ? toMoney(row.tax_withheld) : null,
    verificationStatus: row.verification_status,
    linkedTransactions: Number(row.linked_transactions),
    transactionIds: visibility.transactions ? row.transaction_ids ?? [] : [],
  }));
}

export type EmployeeMoneyFlow = "direct_employee" | "agency_routed";

export interface EmployeeMoneyRoot {
  id: string;
  flow: EmployeeMoneyFlow;
  direction: SettlementDirection;
  target: string;
  applied: string;
  balance: string;
  state: SettlementState;
  checkNumber: string | null;
  serviceDate: string | null;
}

export interface EmployeeMoneyFlowSummary {
  due: string;
  paid: string;
  credit: string;
  remaining: string;
  openItems: number;
}

export interface EmployeeMoneyEvent {
  id: string;
  flow: EmployeeMoneyFlow;
  eventType: string;
  amount: string;
  occurredOn: string;
  reference: string | null;
  note: string | null;
  reversed: boolean;
}

export interface EmployeeMoneyProfile {
  directPay: EmployeeMoneyFlowSummary;
  agencyRouted: EmployeeMoneyFlowSummary;
  roots: EmployeeMoneyRoot[];
  events: EmployeeMoneyEvent[];
}

const EMPTY_FLOW: EmployeeMoneyFlowSummary = {
  due: "0.00",
  paid: "0.00",
  credit: "0.00",
  remaining: "0.00",
  openItems: 0,
};

/**
 * Summarize already-calculated settlement roots. Direct Pay's normal direction
 * is receivable (Employee gives the Agency money); Agency Routed's normal
 * direction is payable (Agency pays the Employee). Opposite-direction balances
 * are shown as a credit/refund instead of being silently relabeled.
 */
export function summarizeEmployeeMoneyRoots(
  rows: readonly EmployeeMoneyRoot[],
  flow: EmployeeMoneyFlow,
): EmployeeMoneyFlowSummary {
  const normalDirection: SettlementDirection = flow === "direct_employee" ? "receivable" : "payable";
  let due = dec(0);
  let paid = dec(0);
  let credit = dec(0);
  let remaining = dec(0);
  let openItems = 0;
  for (const row of rows) {
    if (row.flow !== flow) continue;
    const target = dec(row.target);
    const applied = dec(row.applied);
    const balance = dec(row.balance);
    if (row.direction === normalDirection) {
      due = due.plus(target);
      if (applied.greaterThan(0)) paid = paid.plus(applied);
      if (balance.greaterThan(0)) {
        remaining = remaining.plus(balance);
        openItems += 1;
      } else if (balance.isNegative()) {
        credit = credit.plus(balance.abs());
      }
    } else if (balance.greaterThan(0)) {
      credit = credit.plus(balance);
      openItems += 1;
    }
  }
  return {
    due: toMoney(due),
    paid: toMoney(paid),
    credit: toMoney(credit),
    remaining: toMoney(remaining),
    openItems,
  };
}

function moneyFlow(value: string): EmployeeMoneyFlow {
  return value === "direct_employee" ? "direct_employee" : "agency_routed";
}

/**
 * Employee-specific projection of the canonical settlement ledger. The query
 * follows the same correction-root arithmetic as getPersonSettlementBalance;
 * it does not run the deal engine or create a second financial calculation.
 */
export async function getEmployeeMoneyProfile(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeeMoneyProfile> {
  if (!UUID.test(employeeId)) {
    return { directPay: EMPTY_FLOW, agencyRouted: EMPTY_FLOW, roots: [], events: [] };
  }
  const [rootResult, eventResult] = await Promise.all([
    pool.query<{
      id: string;
      flow: string;
      current_direction: SettlementDirection;
      current_target: string;
      signed_balance: string;
      check_number: string | null;
      service_date: string | null;
    }>(
      `WITH entries AS (
         SELECT COALESCE(
                  obligation.calculation_metadata->>'adjustmentForObligationId',
                  obligation.id::text
                ) AS root_key,
                obligation.direction,
                obligation.original_amount - COALESCE(sum(event.amount), 0) AS balance
           FROM settlement_obligations obligation
           LEFT JOIN settlement_events event ON event.settlement_obligation_id = obligation.id
          WHERE obligation.employee_id = $1 AND obligation.status = 'active'
          GROUP BY obligation.id
       ), roots AS (
         SELECT root.id,
                CASE
                  WHEN root.calculation_metadata->>'flow' = 'direct_employee' THEN 'direct_employee'
                  ELSE 'agency_routed'
                END AS flow,
                CASE
                  WHEN latest.calculation_metadata->>'recalculatedDirection' IN ('payable', 'receivable', 'reserve')
                    THEN latest.calculation_metadata->>'recalculatedDirection'
                  ELSE root.direction
                END AS current_direction,
                COALESCE(
                  NULLIF(latest.calculation_metadata->>'recalculatedOriginalAmount', '')::numeric,
                  root.original_amount
                ) AS current_target,
                root.check_number,
                canonical_service_date(root.period_begin, root.check_date, root.period_end) AS service_date
           FROM settlement_obligations root
           LEFT JOIN LATERAL (
             SELECT correction.calculation_metadata
               FROM settlement_obligations correction
              WHERE correction.status = 'active'
                AND correction.calculation_metadata->>'adjustmentForObligationId' = root.id::text
              ORDER BY correction.created_at DESC, correction.id DESC
              LIMIT 1
           ) latest ON true
          WHERE root.employee_id = $1
            AND root.status = 'active'
            AND NOT (root.calculation_metadata ? 'adjustmentForObligationId')
            AND COALESCE(root.calculation_metadata->>'flow', '') IN ('direct_employee', 'agency_routed')
       )
       SELECT roots.id, roots.flow, roots.current_direction,
              roots.current_target::text,
              sum(CASE WHEN entries.direction = 'receivable'
                       THEN -entries.balance ELSE entries.balance END)::text AS signed_balance,
              roots.check_number,
              to_char(roots.service_date, 'YYYY-MM-DD') AS service_date
         FROM roots
         JOIN entries ON entries.root_key = roots.id::text
        GROUP BY roots.id, roots.flow, roots.current_direction, roots.current_target,
                 roots.check_number, roots.service_date
        ORDER BY roots.service_date DESC NULLS LAST, roots.id`,
      [employeeId],
    ),
    pool.query<{
      id: string;
      flow: string;
      event_type: string;
      amount: string;
      occurred_on: string;
      reference: string | null;
      note: string | null;
      reversed: boolean;
    }>(
      `SELECT event.id,
              CASE
                WHEN obligation.calculation_metadata->>'flow' = 'direct_employee' THEN 'direct_employee'
                ELSE 'agency_routed'
              END AS flow,
              event.event_type, event.amount::text,
              to_char(event.occurred_on, 'YYYY-MM-DD') AS occurred_on,
              event.reference, event.note,
              EXISTS (
                SELECT 1 FROM settlement_events reversal
                 WHERE reversal.reversal_of_event_id = event.id
              ) AS reversed
         FROM settlement_events event
         JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
        WHERE event.employee_id = $1
          AND COALESCE(obligation.calculation_metadata->>'flow', '') IN ('direct_employee', 'agency_routed')
        ORDER BY event.occurred_on DESC, event.created_at DESC
        LIMIT 30`,
      [employeeId],
    ),
  ]);

  const roots = rootResult.rows.map((row): EmployeeMoneyRoot => {
    const signed = dec(row.signed_balance);
    const balance = row.current_direction === "receivable" ? signed.negated() : signed;
    const target = dec(row.current_target);
    const applied = target.minus(balance);
    return {
      id: row.id,
      flow: moneyFlow(row.flow),
      direction: row.current_direction,
      target: toMoney(target),
      applied: toMoney(applied.greaterThan(0) ? applied : 0),
      balance: toMoney(balance),
      state: settlementState(target, applied),
      checkNumber: row.check_number,
      serviceDate: row.service_date,
    };
  });
  const events = eventResult.rows.map((row): EmployeeMoneyEvent => ({
    id: row.id,
    flow: moneyFlow(row.flow),
    eventType: row.event_type,
    amount: toMoney(row.amount),
    occurredOn: row.occurred_on,
    reference: row.reference,
    note: row.note,
    reversed: row.reversed,
  }));
  return {
    directPay: summarizeEmployeeMoneyRoots(roots, "direct_employee"),
    agencyRouted: summarizeEmployeeMoneyRoots(roots, "agency_routed"),
    roots,
    events,
  };
}
