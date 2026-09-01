import { describe, expect, it } from "vitest";
import { getAgencyFinancialReport } from "@/lib/data/agency-financial-report";
import type { PgLikePool } from "@/lib/import/commit";

type TransactionFixture = {
  id: string;
  source_ref: string;
  service_session_id: string | null;
  gross_amount: string;
  base_amount: string | null;
  person_share_percent: string | null;
  employee_deal_id: string | null;
  agency_cut_percent: string | null;
};

function reportPool(rows: TransactionFixture[], statements: string[] = []): PgLikePool {
  return {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes("FROM payroll_transactions t")) {
        return {
          rows: rows.map((row, index) => ({
            ...row,
            service_date: "2026-08-12",
            individual_id: `person-${index + 1}`,
            individual_name: `Person ${index + 1}`,
            program_id: "program-group",
            employee_id: "employee-1",
            employee_name: "Employee One",
            program_name: "Group service",
            payment_recipient: "excellent_staffing",
          })),
        };
      }
      if (statement.includes("FROM employee_payroll_checks check_fact")
        || statement.includes("WITH strategy_state_candidates")
        || statement.includes("FROM class_invoices invoice")
        || statement.includes("FROM agency_manual_income_entries entry")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  } as unknown as PgLikePool;
}

describe("agency financial group-service allocation truth", () => {
  it("keeps linked member money row-level while only physical session hours are shared", async () => {
    const statements: string[] = [];
    const report = await getAgencyFinancialReport(reportPool([
      {
        id: "group-member-a",
        source_ref: "GROUP-A",
        service_session_id: "session-1",
        gross_amount: "600",
        base_amount: "300",
        person_share_percent: "0.5",
        employee_deal_id: "deal-1",
        agency_cut_percent: "0.25",
      },
      {
        id: "group-member-b",
        source_ref: "GROUP-B",
        service_session_id: "session-1",
        gross_amount: "400",
        base_amount: "250",
        person_share_percent: "0.8",
        employee_deal_id: "deal-1",
        agency_cut_percent: "0.25",
      },
      {
        id: "ordinary-row",
        source_ref: "ORDINARY-1",
        service_session_id: null,
        gross_amount: "100",
        base_amount: "80",
        person_share_percent: null,
        employee_deal_id: "deal-1",
        agency_cut_percent: "0.25",
      },
    ], statements), "2026-08");

    expect(report.transactions).toHaveLength(3);
    expect(report.transactions.map((row) => ({
      id: row.id,
      sourceRef: row.sourceRef,
      grossAmount: row.grossAmount,
      baseAmount: row.baseAmount,
      employeeExpense: row.employeeExpense,
    }))).toEqual([
      {
        id: "group-member-a",
        sourceRef: "GROUP-A",
        grossAmount: "600.0000",
        baseAmount: "300.0000",
        employeeExpense: "150.0000",
      },
      {
        id: "group-member-b",
        sourceRef: "GROUP-B",
        grossAmount: "400.0000",
        baseAmount: "250.0000",
        employeeExpense: "200.0000",
      },
      {
        id: "ordinary-row",
        sourceRef: "ORDINARY-1",
        grossAmount: "100.0000",
        baseAmount: "80.0000",
        employeeExpense: "60.0000",
      },
    ]);
    expect(report.totals.income.transactions).toBe("1100.0000");
    expect(report.transactions.reduce(
      (total, row) => total + Number(row.baseAmount ?? 0),
      0,
    )).toBe(630);
    expect(report.totals.expenses.agencyRoutedEmployeeShare).toBe("410.0000");

    const transactionSql = statements.find((statement) => statement.includes("FROM payroll_transactions t"));
    expect(transactionSql).toBeDefined();
    expect(transactionSql).not.toMatch(/\bGROUP BY\b/i);
    expect(transactionSql).not.toMatch(/\bDISTINCT\s+ON\b/i);
  });

  it("does not infer or collapse legacy rows when an allocation base is missing", async () => {
    const report = await getAgencyFinancialReport(reportPool([
      {
        id: "linked-known",
        source_ref: "LEGACY-1",
        service_session_id: "session-legacy",
        gross_amount: "300",
        base_amount: "210",
        person_share_percent: "1",
        employee_deal_id: null,
        agency_cut_percent: null,
      },
      {
        id: "linked-missing-base",
        source_ref: "LEGACY-2",
        service_session_id: "session-legacy",
        gross_amount: "300",
        base_amount: null,
        person_share_percent: "1",
        employee_deal_id: null,
        agency_cut_percent: null,
      },
      {
        id: "unlinked-similar-row",
        source_ref: "LEGACY-3",
        service_session_id: null,
        gross_amount: "300",
        base_amount: "180",
        person_share_percent: "1",
        employee_deal_id: null,
        agency_cut_percent: null,
      },
    ]), "2026-08");

    expect(report.transactions.map((row) => row.id)).toEqual([
      "linked-known",
      "linked-missing-base",
      "unlinked-similar-row",
    ]);
    expect(report.totals.income.transactions).toBe("900.0000");
    expect(report.totals.expenses.agencyRoutedEmployeeShare).toBe("390.0000");
    expect(report.coverage.agencyTransactionsMissingBase).toBe(1);
    expect(report.transactions.find((row) => row.id === "linked-missing-base")).toMatchObject({
      sourceRef: "LEGACY-2",
      baseAmount: null,
      employeeExpense: null,
      payRuleSource: "person_rule",
    });
  });
});
