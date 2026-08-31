import { describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  getAgencyFinancialReport,
  listAgencyFinancialOptions,
} from "@/lib/data/agency-financial-report";

describe("agency financial report read model", () => {
  it("uses only columns that exist on the production employee table", async () => {
    const statements: string[] = [];
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      },
    } as unknown as PgLikePool;

    await listAgencyFinancialOptions(pool);

    const employeeQuery = statements.find((statement) => statement.includes("FROM employees"));
    expect(employeeQuery).toBeDefined();
    expect(employeeQuery).not.toContain("merged_into_id");
  });

  it("keeps actual income and each expense category separate without double counting", async () => {
    const statements: string[] = [];
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM payroll_transactions t")) {
          return { rows: [
            {
              id: "tx-agency", service_date: "2026-08-05", individual_id: "person-1", individual_name: "Person One",
              employee_id: "employee-1", employee_name: "Employee One", program_name: "Com Hab",
              payment_recipient: "excellent_staffing", gross_amount: "1000", base_amount: "800",
              person_share_percent: "0.75", employee_deal_id: "deal-1", agency_cut_percent: "0.2",
            },
            {
              id: "tx-direct", service_date: "2026-08-06", individual_id: "person-1", individual_name: "Person One",
              employee_id: "employee-1", employee_name: "Employee One", program_name: "Respite",
              payment_recipient: "employee", gross_amount: "1000", base_amount: "800",
              person_share_percent: null, employee_deal_id: "deal-1", agency_cut_percent: "0.2",
            },
          ] };
        }
        if (statement.includes("FROM employee_payroll_checks check_fact")) {
          return { rows: [{
            id: "check-1", service_date: "2026-08-06", employee_id: "employee-1", employee_name: "Employee One",
            check_number: "101", actual_gross: "1000", actual_net: "800",
            direct_rule: "giveback_percent", direct_percent: "0.2",
          }] };
        }
        if (statement.includes("FROM calculation_strategies strategy")) {
          return { rows: [{
            strategy_id: "strategy-1", individual_id: "person-1", individual_name: "Person One",
            setup_name: "Main", cut1_percent: "0.24", cut2_percent: "0.30", approved_final: "-1500",
          }] };
        }
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-1", invoice_number: "CLASS-1", invoice_date: "2026-08-10",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            program_name: "Classes", total_amount: "100", agency_share_percent: "0.6", custom_split_required: true,
          }] };
        }
        if (statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [{
            id: "income-1", service_date: "2026-08-15", source_type: "reimbursement",
            individual_id: "person-1", individual_name: "Person One", program_id: null,
            program_code: null, program_name: null, gross_amount: "50", agency_share_percent: "0.8",
            agency_amount: "40", individual_amount: "10", source_ref: "R-1", notes: null,
            status: "active", void_reason: null, program_budget_event_id: null, created_at: "2026-08-15T12:00:00Z",
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.totals.income).toEqual({
      transactions: "2000.0000", classes: "100.0000", manual: "50.0000", total: "2150.0000",
    });
    expect(report.totals.expenses).toEqual({
      approvedSetAsides: "1500.0000",
      taxes: "200.0000",
      directEmployeeKeeps: "640.0000",
      agencyRoutedEmployeeShare: "600.0000",
      classIndividualShare: "40.0000",
      manualIndividualShare: "10.0000",
      total: "2990.0000",
    });
    expect(report.totals.agencyResult).toBe("-840.0000");
    expect(Object.values(report.coverage).reduce((sum, value) => sum + value, 0)).toBe(0);

    const sql = statements.join("\n");
    expect(sql).toContain("canonical_service_date(t.period_begin, t.check_date, t.period_end)");
    expect(sql).toContain("t.imported_amount::text AS gross_amount");
    expect(sql).toContain("employee_individual_compensation_terms");
    expect(sql).toContain("FROM employee_payroll_checks check_fact");
    expect(sql).toContain("invoice.status = 'issued'");
  });
});
