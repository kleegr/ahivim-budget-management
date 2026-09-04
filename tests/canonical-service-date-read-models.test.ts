import { describe, expect, it, vi } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { getFinancialDashboard } from "@/lib/data/financial-dashboard";
import { listEmployeeDirectory } from "@/lib/data/employee-directory";
import {
  getEmployeeMonthlyPayments,
  getEmployeePaymentSummary,
} from "@/lib/data/employee-queries";
import {
  agencyEarningsReport,
  budgetUtilizationReport,
  dashboardReportMetrics,
  employeePayableReport,
  expiringAuthorizationsReport,
  groupActivityReport,
  utilizationOutliersReport,
} from "@/lib/data/report-queries";
import { individualProgramForecast, listSessionWarningFlags } from "@/lib/data/schedule-queries";
import type { PgLikePool } from "@/lib/import/commit";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000002";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000003";

describe("canonical service-date read models", () => {
  it("uses the shared service date in report windows and shared routing in payables", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        if (query.includes("AS transaction_rows")) {
          return { rows: [{
            agency_additional: "0",
            agency_additional_rows: "0",
            employee_payable: "0",
            employee_payable_rows: "0",
            transaction_rows: "0",
            unbilled_schedules: "0",
            unscheduled_billing: "0",
          }] };
        }
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await budgetUtilizationReport(pool);
    await agencyEarningsReport(pool, { from: "2026-01-01", to: "2026-01-31" });
    await employeePayableReport(pool, { from: "2026-01-01", to: "2026-01-31" });
    await groupActivityReport(pool, { from: "2026-01-01", to: "2026-01-31" });
    await utilizationOutliersReport(pool);
    await expiringAuthorizationsReport(pool);
    await dashboardReportMetrics(pool);

    const utilization = sql.find((query) => query.includes("AS scheduled_hours"));
    expect(utilization).toContain("effective_budget_authorizations_at($1::date)");
    expect(utilization).toContain("LEFT JOIN program_budget_balances explicit_balance");
    expect(utilization).toContain(
      "scheduled_session.session_date BETWEEN effective.start_date AND effective.end_date",
    );
    expect(utilization).not.toContain("FROM service_allocations");

    const currentBudgetReads = sql.filter((query) =>
      query.includes("effective_budget_authorizations_at($1::date)"),
    );
    expect(currentBudgetReads.length).toBeGreaterThanOrEqual(4);
    expect(sql.join("\n")).not.toContain("FROM program_budget_balances balance");

    const metrics = sql.find((query) => query.includes("AS transaction_rows"));
    expect(metrics).not.toContain("FROM service_allocations");

    const earnings = sql.find((query) => query.includes("AS agency_gross"));
    expect(earnings).toContain(
      "canonical_service_date(\n              t.period_begin, t.check_date, t.period_end",
    );
    expect(earnings).not.toContain("OR t.period_begin >=");

    const payable = sql.find((query) => query.includes("AS paid_to_employee"));
    expect(payable).toContain("LEFT JOIN programs p ON p.id = t.program_id");
    expect(payable).toContain(
      "effective_payment_recipient(\n                t.payment_recipient, p.payment_recipient",
    );
    expect(payable).toContain(
      "canonical_service_date(\n              t.period_begin, t.check_date, t.period_end",
    );

    const groups = sql.find((query) => query.includes("ss.group_size > 1"));
    expect(groups).toContain("canonical_service_date(ss.period_begin, NULL, ss.period_end)");
  });

  it("groups employee history by canonical month and resolves program routing", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await getEmployeePaymentSummary(pool, EMPLOYEE_ID);
    await getEmployeeMonthlyPayments(pool, EMPLOYEE_ID);

    for (const query of sql) {
      expect(query).toContain("LEFT JOIN programs p ON p.id = t.program_id");
      expect(query).toContain("effective_payment_recipient(");
    }
    expect(sql[0]).toContain(") <> 'unknown'");
    expect(sql[1]).toContain(
      "date_trunc('month', canonical_service_date(\n              t.period_begin, t.check_date, t.period_end",
    );
    expect(sql[1]).not.toContain("COALESCE(t.period_begin, t.check_date)");
  });

  it("never uses import time to select an employee deal", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        if (query.includes("FROM employees e")) {
          return {
            rows: [{
              id: EMPLOYEE_ID,
              display_name: "Employee",
              external_ref: null,
              status: "active",
              archived_at: null,
            }],
          };
        }
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await listEmployeeDirectory(pool, fullAccess("admin", "admin"));

    const activity = sql.find((query) => query.includes("AS last_activity_date"));
    expect(activity).toContain(
      "max(canonical_service_date(\n              t.period_begin, t.check_date, t.period_end",
    );
    const readiness = sql.find((query) => query.includes("AS missing_deal_transactions"));
    expect(readiness).toContain("LEFT JOIN programs p ON p.id = t.program_id");
    expect(readiness).toContain("effective_payment_recipient(");
    expect(readiness).toContain("canonical_service_date(");
    expect(readiness).not.toContain("t.created_at::date");
  });

  it("uses canonical usage for both explicit and fallback planner authorizations", async () => {
    for (const isExplicit of [true, false]) {
      const sql: string[] = [];
      const pool = {
        query: vi.fn(async (query: string) => {
          sql.push(query);
          if (query.includes("effective_budget_authorizations_at")) {
            return {
              rows: [{
                authorization_id: "00000000-0000-4000-8000-000000000004",
                period_id: "00000000-0000-4000-8000-000000000005",
                period_label: "2026",
                program_id: PROGRAM_ID,
                program_code: "COMHAB",
                program_name: "Community Habilitation",
                start_date: "2026-01-01",
                end_date: "2026-12-31",
                authorized_hours: "100",
                internal_rate: "21",
                is_explicit: isExplicit,
                source_candidate_count: 1,
              }],
            };
          }
          return { rows: [{ h: "0", amt: "0" }] };
        }),
      } as unknown as PgLikePool;

      await individualProgramForecast(
        pool,
        INDIVIDUAL_ID,
        PROGRAM_ID,
        null,
        "2026-08-01",
      );

      const actual = sql.find((query) => query.includes("effective_billed_hours"));
      expect(actual).toContain(
        "canonical_service_date(t.period_begin, t.check_date, t.period_end)",
      );
      expect(actual).not.toContain("FROM service_allocations");
      expect(actual).not.toContain("AND t.period_begin BETWEEN");
    }
  });

  it("uses canonical budget usage for live calendar risk flags", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await listSessionWarningFlags(pool, { from: "2026-08-01", to: "2026-08-31" });

    expect(sql[0]).toContain("effective_billed_hours(");
    expect(sql[0]).not.toContain("FROM service_allocations actual_a");
    expect(sql[0]).not.toContain("WHEN EXISTS (\n                              SELECT 1 FROM budget_authorizations");
  });

  it("keeps one primary plan total while exposing duplicate authorization sources", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        if (query.includes("effective_budget_authorizations_at")) {
          return { rows: [{
            authorization_id: "00000000-0000-4000-8000-000000000004",
            period_id: "00000000-0000-4000-8000-000000000005",
            period_label: "Primary",
            program_id: PROGRAM_ID,
            program_code: "COMHAB",
            program_name: "Community Habilitation",
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            authorized_hours: "40",
            internal_rate: "21",
            is_explicit: false,
            source_candidate_count: 2,
          }] };
        }
        return { rows: [{ h: "0", amt: "0" }] };
      }),
    } as unknown as PgLikePool;

    const forecast = await individualProgramForecast(
      pool,
      INDIVIDUAL_ID,
      PROGRAM_ID,
      null,
      "2026-08-01",
    );

    expect(forecast).toMatchObject({
      authorizedHours: "40.0000",
      authorizationCount: 1,
      authorizationAmbiguous: false,
      sourceCandidateCount: 2,
      sourceAmbiguous: true,
    });
    expect(queries[0]).toContain("ea.source_candidate_count");
  });

  it("uses the canonical date and routing in the financial budget window", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        if (query.includes("FROM calculation_strategies s")) {
          return { rows: [{
            id: "00000000-0000-4000-8000-000000000006",
            individual_id: INDIVIDUAL_ID,
            individual_name: "Individual",
            individual_status: "active",
            label: "Plan",
            renewal_date: "2027-01-01",
            month_divisor: "12",
            cut1_percent: "0",
            cut2_percent: "0",
            clock_adjustment: "0",
            other_adjustment: "0",
            after_all: null,
            account: null,
            status: "active",
            sort_order: 0,
            revision_count: "0",
          }] };
        }
        if (query.includes("FROM calculation_strategy_lines")) {
          return { rows: [{
            strategy_id: "00000000-0000-4000-8000-000000000006",
            program_id: PROGRAM_ID,
            authorized_hours: "100",
            rate_override: null,
            rate_override_effective_from: null,
          }] };
        }
        if (query.includes("FROM program_rate_schedules")) {
          return { rows: [{
            program_id: PROGRAM_ID,
            internal_rate: "21",
            effective_from: "2020-01-01",
            effective_to: null,
          }] };
        }
        if (query.includes("FROM programs p")) {
          return { rows: [{
            id: PROGRAM_ID,
            code: "COMHAB",
            name: "Community Habilitation",
            as_of: "2026-12-31",
          }] };
        }
        if (query.includes("WHERE i.id = ANY")) {
          return { rows: [{
            id: INDIVIDUAL_ID,
            name: "Individual",
            status: "active",
            phone: null,
            category: null,
            notes: null,
          }] };
        }
        if (query.includes("NOT (i.id = ANY")) return { rows: [] };
        if (query.includes("WITH win AS")) {
          return { rows: [{
            individual_id: INDIVIDUAL_ID,
            gross_all: "0",
            internal_all: "0",
            agency_all: "0",
            hours_all: "0",
            tx_all: "0",
            wh_all: "0",
            gross_period: "0",
            internal_period: "0",
            agency_period: "0",
            hours_period: "0",
            tx_period: "0",
            wh_period: "0",
          }] };
        }
        throw new Error(`Unexpected query: ${query}`);
      }),
    } as unknown as PgLikePool;

    await getFinancialDashboard(pool);

    const actuals = sql.find((query) => query.includes("WITH win AS"));
    expect(actuals).toContain(
      "canonical_service_date(\n       t.period_begin, t.check_date, t.period_end",
    );
    expect(actuals).toContain("LEFT JOIN programs p ON p.id = t.program_id");
    expect(actuals).toContain("effective_payment_recipient(");
    expect(actuals).toContain("LEFT JOIN employee_payroll_checks verified_check");
    expect(actuals).toContain("verified_check.employee_id = check_row.employee_id");
    expect(actuals).toContain("'source:', check_row.employee_id::text");
    expect(actuals).toContain("COALESCE(NULLIF(btrim(check_row.check_number), ''), 'no-number')");
    expect(actuals).toContain("COALESCE(check_row.check_date::text, 'no-date')");
    expect(actuals).toContain("COALESCE(check_row.period_begin::text, 'no-period-begin')");
    expect(actuals).toContain("COALESCE(check_row.period_end::text, 'no-period-end')");
    expect(actuals).toContain("LEFT JOIN check_tot ct ON ct.check_key = cf.check_key");
    expect(actuals).not.toContain("GROUP BY check_row.check_number");
    expect(actuals).not.toContain("t.period_begin >= w.start_date");
  });
});
