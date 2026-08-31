import {
  hasPortalIndividualCapability,
  type PortalAccessContext,
} from "@/lib/auth/portal-access";
import type { PgLikePool, PgLikeResult } from "@/lib/import/commit";
import { toMoney } from "@/lib/money";
import { normalizePortalMonth } from "@/lib/data/portal-read-model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PORTAL_INDIVIDUAL_TREND_MONTHS = 12;

export interface PortalIndividualTrendMonth {
  month: string;
  billed: string | null;
  setAside: string | null;
  direct: string | null;
  agencyPaid: string | null;
}

export interface PortalIndividualStatement {
  individualId: string;
  individualName: string;
  throughMonth: string;
  visibility: {
    billed: boolean;
    setAside: boolean;
    direct: boolean;
    agencyPaid: boolean;
  };
  months: PortalIndividualTrendMonth[];
}

interface TrendRow {
  month: string;
  amount: string;
}

function empty<T>(): Promise<PgLikeResult<T>> {
  return Promise.resolve({ rows: [] });
}

function monthWindow(throughMonth: string, count: number): {
  months: string[];
  startDate: string;
  endDate: string;
} {
  const [year, month] = throughMonth.split("-").map(Number);
  const end = new Date(Date.UTC(year, month, 1));
  const start = new Date(Date.UTC(year, month - count, 1));
  const months = Array.from({ length: count }, (_, index) => {
    const value = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  return {
    months,
    startDate: `${months[0]}-01`,
    endDate: `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-01`,
  };
}

function amountByMonth(rows: TrendRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.month, toMoney(row.amount)]));
}

/**
 * Privacy-safe monthly statement for one directly linked individual. Each
 * category is queried only when that exact relationship capability is active.
 */
export async function getPortalIndividualStatement(
  pool: PgLikePool,
  context: PortalAccessContext,
  individualId: string,
  requestedMonth?: string | null,
  requestedCount = PORTAL_INDIVIDUAL_TREND_MONTHS,
): Promise<PortalIndividualStatement | null> {
  if (!UUID.test(individualId)) return null;
  if (!hasPortalIndividualCapability(context, individualId, "people.self.read")) return null;

  const throughMonth = normalizePortalMonth(requestedMonth);
  const finiteCount = Number.isFinite(requestedCount)
    ? requestedCount
    : PORTAL_INDIVIDUAL_TREND_MONTHS;
  const count = Math.min(24, Math.max(1, Math.trunc(finiteCount)));
  const window = monthWindow(throughMonth, count);
  const visibility = {
    billed: hasPortalIndividualCapability(context, individualId, "financials.self.billed_totals.read"),
    setAside: hasPortalIndividualCapability(context, individualId, "financials.self.cuts_set_asides.read"),
    direct: hasPortalIndividualCapability(context, individualId, "financials.self.direct_checks.read"),
    agencyPaid: hasPortalIndividualCapability(context, individualId, "financials.self.agency_paid.read"),
  };

  const [personResult, billedResult, setAsideResult, directResult, agencyPaidResult] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT id, display_name AS name
         FROM individuals
        WHERE id = $1 AND status <> 'archived'`,
      [individualId],
    ),
    visibility.billed
      ? pool.query<TrendRow>(
          `SELECT to_char(date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )), 'YYYY-MM') AS month,
                  COALESCE(sum(transaction.imported_amount), 0)::text AS amount
             FROM payroll_transactions transaction
            WHERE transaction.individual_id = $1
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) >= $2::date
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) < $3::date
            GROUP BY 1
            ORDER BY 1`,
          [individualId, window.startDate, window.endDate],
        )
      : empty<TrendRow>(),
    visibility.setAside
      ? pool.query<TrendRow>(
          `SELECT to_char(date_trunc('month', event.occurred_on), 'YYYY-MM') AS month,
                  COALESCE(sum(event.amount), 0)::text AS amount
             FROM settlement_events event
             JOIN settlement_obligations obligation
               ON obligation.id = event.settlement_obligation_id
            WHERE event.individual_id = $1
              AND obligation.direction = 'reserve'
              AND event.occurred_on >= $2::date
              AND event.occurred_on < $3::date
            GROUP BY 1
            ORDER BY 1`,
          [individualId, window.startDate, window.endDate],
        )
      : empty<TrendRow>(),
    visibility.direct
      ? pool.query<TrendRow>(
          `SELECT to_char(date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )), 'YYYY-MM') AS month,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = $1
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) >= $2::date
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) < $3::date
            GROUP BY 1
            ORDER BY 1`,
          [individualId, window.startDate, window.endDate],
        )
      : empty<TrendRow>(),
    visibility.agencyPaid
      ? pool.query<TrendRow>(
          `SELECT to_char(date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )), 'YYYY-MM') AS month,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = $1
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'excellent_staffing'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) >= $2::date
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) < $3::date
            GROUP BY 1
            ORDER BY 1`,
          [individualId, window.startDate, window.endDate],
        )
      : empty<TrendRow>(),
  ]);

  const person = personResult.rows[0];
  if (!person) return null;
  const billed = amountByMonth(billedResult.rows);
  const setAside = amountByMonth(setAsideResult.rows);
  const direct = amountByMonth(directResult.rows);
  const agencyPaid = amountByMonth(agencyPaidResult.rows);

  return {
    individualId: person.id,
    individualName: person.name,
    throughMonth,
    visibility,
    months: window.months.map((month) => ({
      month,
      billed: visibility.billed ? billed.get(month) ?? toMoney(0) : null,
      setAside: visibility.setAside ? setAside.get(month) ?? toMoney(0) : null,
      direct: visibility.direct ? direct.get(month) ?? toMoney(0) : null,
      agencyPaid: visibility.agencyPaid ? agencyPaid.get(month) ?? toMoney(0) : null,
    })),
  };
}
