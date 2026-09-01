import { describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  FIRST_RELIABLE_SET_ASIDE_MONTH,
  getAgencyFinancialReport,
  listAgencyFinancialOptions,
  normalizeActualAgencyFinancialMonth,
} from "@/lib/data/agency-financial-report";

describe("agency financial report read model", () => {
  it("clamps direct future-month requests because this report contains actuals only", () => {
    expect(normalizeActualAgencyFinancialMonth("2026-09", "2026-08")).toBe("2026-08");
    expect(normalizeActualAgencyFinancialMonth("2026-08", "2026-08")).toBe("2026-08");
    expect(normalizeActualAgencyFinancialMonth("2026-07", "2026-08")).toBe("2026-07");
    expect(normalizeActualAgencyFinancialMonth("0000-01", "2026-08")).toBe("2026-08");
  });

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
            history_available: true, state_source: "current", effective_at: "2026-01-01T12:00:00+00",
            revision_id: null, revision_number: null, revision_reason: null, revision_created_at: null,
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
      transactions: "2000.0000", classes: "0.0000", manual: "50.0000", total: "2050.0000",
    });
    expect(report.totals.expenses).toEqual({
      approvedSetAsides: "1500.0000",
      taxes: "200.0000",
      directEmployeeKeeps: "640.0000",
      agencyRoutedEmployeeShare: "600.0000",
      classIndividualShare: "0.0000",
      manualIndividualShare: "10.0000",
      total: "2950.0000",
    });
    expect(report.totals.agencyResult).toBe("-900.0000");
    expect(Object.values(report.coverage).reduce((sum, value) => sum + value, 0)).toBe(0);

    const sql = statements.join("\n");
    expect(sql).toContain("canonical_service_date(t.period_begin, t.check_date, t.period_end)");
    expect(sql).toContain("t.imported_amount::text AS gross_amount");
    expect(sql).toContain("employee_individual_compensation_terms");
    expect(sql).toContain("FROM employee_payroll_checks check_fact");
    expect(sql).toContain("invoice.status = 'issued'");
  });

  it("keeps a legacy class invoice split unknown until its missing program link is repaired", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")
          || statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")
          || statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [] };
        }
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-unlinked",
            class_budget_period_id: "class-budget-unlinked",
            invoice_number: "CLASS-UNLINKED",
            invoice_date: "2026-08-10",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: null,
            program_name: null,
            total_amount: "100",
            agency_share_percent: null,
            custom_split_required: false,
            count_separately_reason: null,
            count_separately_source_type: null,
            count_separately_source_id: null,
            count_separately_source_ref: null,
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.classInvoices[0]).toMatchObject({
      id: "invoice-unlinked",
      classBudgetPeriodId: "class-budget-unlinked",
      programId: null,
      splitSource: "missing",
      agencySharePercent: null,
      agencyAmount: null,
      individualExpense: null,
      countedInIncome: false,
      countedSplitExpense: false,
    });
    expect(report.totals.income.classes).toBe("0.0000");
    expect(report.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(report.coverage.classInvoicesMissingProgram).toBe(1);
    expect(report.coverage.classInvoicesMissingSplit).toBe(1);
  });

  it("starts trustworthy status history in August 2026 and preserves saved revision provenance", async () => {
    const setAsideParams: unknown[][] = [];
    const statements: string[] = [];
    const pool = {
      query: async (statement: string, params?: unknown[]) => {
        statements.push(statement);
        if (statement.includes("FROM payroll_transactions t")
          || statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("FROM class_invoices invoice")
          || statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [] };
        }
        if (statement.includes("WITH strategy_state_candidates")) {
          setAsideParams.push(params ?? []);
          const cutoff = params?.[0];
          if (cutoff === "2026-08-01") {
            return { rows: [{
              strategy_id: "strategy-1",
              individual_id: "person-1",
              individual_name: "Person One",
              setup_name: "Main",
              cut1_percent: null,
              cut2_percent: null,
              approved_final: null,
              history_available: false,
              state_source: null,
              effective_at: null,
              revision_id: null,
              revision_number: null,
              revision_reason: null,
              revision_created_at: null,
            }] };
          }
          const saved = cutoff === "2026-09-01";
          return { rows: [{
            strategy_id: "strategy-1",
            individual_id: "person-1",
            individual_name: "Person One",
            setup_name: "Main",
            cut1_percent: saved ? "0.10" : "0.24",
            cut2_percent: saved ? "0" : "0.30",
            approved_final: saved ? "900" : "1500",
            history_available: true,
            state_source: saved ? "saved_revision" : "current",
            effective_at: saved ? "2026-08-01T12:00:00+00" : "2026-09-15T12:00:00+00",
            revision_id: saved ? "revision-7" : null,
            revision_number: saved ? 7 : null,
            revision_reason: saved ? "Replaced with the September amount" : null,
            revision_created_at: saved ? "2026-09-15T12:00:00+00" : null,
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const july = await getAgencyFinancialReport(pool, "2026-07");
    const august = await getAgencyFinancialReport(pool, "2026-08");
    const september = await getAgencyFinancialReport(pool, "2026-09");

    expect(FIRST_RELIABLE_SET_ASIDE_MONTH).toBe("2026-08");
    expect(july.setAsides[0]).toMatchObject({
      approvedMonthlyFinal: null,
      historyAvailable: false,
      stateSource: null,
      revisionId: null,
    });
    expect(july.totals.expenses.approvedSetAsides).toBe("0.0000");
    expect(july.coverage.setAsideHistoriesUnavailable).toBe(1);
    expect(august.setAsides[0]).toMatchObject({
      firstCutPercent: "0.10",
      secondCutPercent: "0",
      approvedMonthlyFinal: "900.0000",
      historyAvailable: true,
      stateSource: "saved_revision",
      effectiveAt: "2026-08-01T12:00:00+00",
      revisionId: "revision-7",
      revisionNumber: 7,
      revisionReason: "Replaced with the September amount",
      revisionCreatedAt: "2026-09-15T12:00:00+00",
    });
    expect(august.totals.expenses.approvedSetAsides).toBe("900.0000");
    expect(september.setAsides[0]).toMatchObject({
      firstCutPercent: "0.24",
      secondCutPercent: "0.30",
      approvedMonthlyFinal: "1500.0000",
      historyAvailable: true,
      stateSource: "current",
      effectiveAt: "2026-09-15T12:00:00+00",
      revisionId: null,
      revisionNumber: null,
      revisionReason: null,
      revisionCreatedAt: null,
    });
    expect(september.totals.expenses.approvedSetAsides).toBe("1500.0000");
    expect(setAsideParams).toEqual([
      ["2026-08-01", "2026-09-01"],
      ["2026-09-01", "2026-09-01"],
      ["2026-10-01", "2026-09-01"],
    ]);

    const sql = statements.join("\n");
    expect(sql).toContain("JOIN calculation_strategy_revisions revision");
    expect(sql).toContain("WHERE $1::date >= $2::date");
    expect(sql).toContain("candidate.effective_from < ($1::date AT TIME ZONE 'America/New_York')");
    expect(sql).toContain("strategy.after_all::text AS approved_final");
    expect(sql).toContain("LEFT JOIN effective_strategy_states strategy ON strategy.strategy_id = base.id");
    expect(sql).toContain("base.created_at < ($1::date AT TIME ZONE 'America/New_York')");
    expect(sql).toContain("(strategy.strategy_id IS NOT NULL) AS history_available");
    expect(sql).toContain("strategy.effective_from::text AS effective_at");
    expect(sql).toContain("strategy.source_revision_id AS revision_id");
    expect(sql).toContain("strategy.source_revision_created_at::text AS revision_created_at");
  });

  it("keeps setup histories that cannot be reconstructed visible and out of totals", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")
          || statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("FROM class_invoices invoice")
          || statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [] };
        }
        if (statement.includes("WITH strategy_state_candidates")) {
          return { rows: [{
            strategy_id: "strategy-1",
            individual_id: "person-1",
            individual_name: "Person One",
            setup_name: "Imported setup",
            cut1_percent: null,
            cut2_percent: null,
            approved_final: null,
            history_available: false,
            state_source: null,
            effective_at: null,
            revision_id: null,
            revision_number: null,
            revision_reason: null,
            revision_created_at: null,
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2025-01");

    expect(report.setAsides).toEqual([{
      strategyId: "strategy-1",
      individualId: "person-1",
      individualName: "Person One",
      setupName: "Imported setup",
      firstCutPercent: null,
      secondCutPercent: null,
      approvedMonthlyFinal: null,
      historyAvailable: false,
      stateSource: null,
      effectiveAt: null,
      revisionId: null,
      revisionNumber: null,
      revisionReason: null,
      revisionCreatedAt: null,
    }]);
    expect(report.totals.expenses.approvedSetAsides).toBe("0.0000");
    expect(report.coverage.setupsMissingApprovedFinal).toBe(0);
    expect(report.coverage.setAsideHistoriesUnavailable).toBe(1);
  });

  it("uses Sheet gross once while a matching class receipt contributes its split", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")) {
          return { rows: [{
            id: "tx-late",
            service_date: "2026-08-15",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: "program-1",
            employee_id: "employee-1",
            employee_name: "Employee One",
            program_name: "Com Hab",
            payment_recipient: "employee",
            gross_amount: "50",
            base_amount: "40",
            person_share_percent: null,
            employee_deal_id: null,
            agency_cut_percent: null,
          }] };
        }
        if (statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")
          || statement.includes("FROM class_invoices invoice")) {
          return { rows: [] };
        }
        if (statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [{
            id: "income-before-sync",
            service_date: "2026-08-15",
            source_type: "class",
            individual_id: null,
            individual_name: null,
            program_id: null,
            program_code: null,
            program_name: null,
            gross_amount: "50",
            agency_share_percent: "0.8",
            agency_amount: "40",
            individual_amount: "10",
            source_ref: null,
            notes: null,
            automatic_source_override_reason: null,
            status: "active",
            void_reason: null,
            program_budget_event_id: null,
            created_at: "2026-08-01T12:00:00Z",
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.manualIncome[0]).toMatchObject({
      id: "income-before-sync",
      automaticSourceDuplicate: true,
      countedInIncome: false,
      countedSplitExpense: true,
      matchedIncomeSource: {
        sourceType: "google_sheet_transaction",
        sourceId: "tx-late",
        sourceRef: "tx-late",
      },
      automaticSourceOverrideReason: null,
    });
    expect(report.totals.income).toEqual({
      transactions: "50.0000",
      classes: "0.0000",
      manual: "0.0000",
      total: "50.0000",
    });
    expect(report.totals.expenses.manualIndividualShare).toBe("10.0000");
    expect(report.coverage.manualIncomeDuplicatesExcluded).toBe(0);
  });

  it("ignores legacy invoice matching decisions and counts recorded receipts as actual income", async () => {
    const statements: string[] = [];
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM payroll_transactions t")
          || statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")) {
          return { rows: [] };
        }
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-late",
            invoice_number: "CLASS-LATE",
            invoice_date: "2026-08-20",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: "program-class",
            program_name: "Classes",
            total_amount: "75",
            agency_share_percent: "1",
            custom_split_required: true,
          }] };
        }
        if (statement.includes("FROM agency_manual_income_entries entry")) {
          const base = {
            service_date: "2026-08-20",
            source_type: "class",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: "program-class",
            program_code: "CLASS",
            program_name: "Classes",
            gross_amount: "75",
            agency_share_percent: "0.8",
            agency_amount: "60",
            individual_amount: "15",
            source_ref: null,
            notes: null,
            status: "active",
            void_reason: null,
            program_budget_event_id: null,
            created_at: "2026-08-01T12:00:00Z",
          };
          return { rows: [
            { ...base, id: "income-late-duplicate", automatic_source_override_reason: null },
            {
              ...base,
              id: "income-audited-separate",
              automatic_source_override_reason: "Separate class payment for another service",
              automatic_source_override_source_type: "issued_class_invoice",
              automatic_source_override_source_id: "invoice-late",
              automatic_source_override_source_ref: "CLASS-LATE",
            },
          ] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.manualIncome).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "income-late-duplicate",
        automaticSourceDuplicate: false,
        countedInIncome: true,
        countedSplitExpense: true,
      }),
      expect.objectContaining({
        id: "income-audited-separate",
        automaticSourceDuplicate: false,
        countedInIncome: true,
        countedSplitExpense: true,
        matchedIncomeSource: null,
        automaticSourceOverrideReason: "Separate class payment for another service",
      }),
    ]));
    expect(report.totals.income).toEqual({
      transactions: "0.0000",
      classes: "0.0000",
      manual: "150.0000",
      total: "150.0000",
    });
    expect(report.totals.expenses.manualIndividualShare).toBe("30.0000");
    expect(report.coverage.manualIncomeDuplicatesExcluded).toBe(0);
    expect(statements.join("\n")).toContain("{next,automaticSourceOverride,reason}");
  });

  it("keeps an issued class invoice reference-only beside a Sheet actual", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")) {
          return { rows: [{
            id: "sheet-class-income",
            service_date: "2026-08-10",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: "program-class",
            employee_id: "employee-1",
            employee_name: "Employee One",
            program_name: "Classes",
            payment_recipient: "employee",
            gross_amount: "100",
            base_amount: "80",
            person_share_percent: null,
            employee_deal_id: null,
            agency_cut_percent: null,
          }] };
        }
        if (statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")
          || statement.includes("FROM agency_manual_income_entries entry")) {
          return { rows: [] };
        }
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-before-sync",
            invoice_number: "CLASS-1",
            invoice_date: "2026-08-10",
            individual_id: "person-1",
            individual_name: "Person One",
            program_id: "program-class",
            program_name: "Classes",
            total_amount: "100",
            agency_share_percent: "0.6",
            custom_split_required: true,
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.classInvoices[0]).toMatchObject({
      id: "invoice-before-sync",
      countedInIncome: false,
      countedSplitExpense: false,
      matchedIncomeSource: null,
    });
    expect(report.totals.income).toEqual({
      transactions: "100.0000",
      classes: "0.0000",
      manual: "0.0000",
      total: "100.0000",
    });
    expect(report.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(report.coverage.classInvoiceDuplicatesExcluded).toBe(0);
  });

  it("keeps every issued invoice out of actual totals regardless of matching Sheet rows", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")) {
          return { rows: [{
            id: "sheet-once", source_ref: "CHECK-ONCE", service_date: "2026-08-10",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            employee_id: null, employee_name: null, program_name: "Classes",
            payment_recipient: "employee", gross_amount: "100", base_amount: null,
            person_share_percent: null, employee_deal_id: null, agency_cut_percent: null,
          }] };
        }
        if (statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")
          || statement.includes("FROM agency_manual_income_entries entry")) return { rows: [] };
        if (statement.includes("FROM class_invoices invoice")) {
          const base = {
            invoice_number: "CLASS", invoice_date: "2026-08-10",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            program_name: "Classes", total_amount: "100", agency_share_percent: "0.6",
            custom_split_required: true,
          };
          return { rows: [
            { ...base, id: "invoice-b", invoice_number: "CLASS-B" },
            { ...base, id: "invoice-a", invoice_number: "CLASS-A" },
          ] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.classInvoices.find((row) => row.id === "invoice-a")).toMatchObject({
      countedInIncome: false,
      countedSplitExpense: false,
      matchedIncomeSource: null,
    });
    expect(report.classInvoices.find((row) => row.id === "invoice-b")).toMatchObject({
      countedInIncome: false,
      countedSplitExpense: false,
      matchedIncomeSource: null,
    });
    expect(report.totals.income).toMatchObject({
      transactions: "100.0000",
      classes: "0.0000",
      total: "100.0000",
    });
    expect(report.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(report.coverage.classInvoiceDuplicatesExcluded).toBe(0);
  });

  it("does not let a legacy class decision turn a receivable into actual income", async () => {
    const statements: string[] = [];
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM payroll_transactions t")) {
          return { rows: [{
            id: "sheet-separate", source_ref: "CHECK-SEPARATE", service_date: "2026-08-10",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            employee_id: null, employee_name: null, program_name: "Classes",
            payment_recipient: "employee", gross_amount: "100", base_amount: null,
            person_share_percent: null, employee_deal_id: null, agency_cut_percent: null,
          }] };
        }
        if (statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")
          || statement.includes("FROM agency_manual_income_entries entry")) return { rows: [] };
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-separate", invoice_number: "CLASS-SEPARATE", invoice_date: "2026-08-10",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            program_name: "Classes", total_amount: "100", agency_share_percent: "0.6",
            custom_split_required: true,
            count_separately_reason: "Different class payment received on the same date",
            count_separately_source_type: "google_sheet_transaction",
            count_separately_source_id: "sheet-separate",
            count_separately_source_ref: "CHECK-SEPARATE",
          }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.classInvoices[0]).toMatchObject({
      countedInIncome: false,
      countedSplitExpense: false,
      countSeparatelyReason: null,
      matchedIncomeSource: null,
    });
    expect(report.totals.income.total).toBe("100.0000");
    expect(report.coverage.classInvoiceDuplicatesExcluded).toBe(0);
    const sql = statements.join("\n");
    expect(sql).not.toContain("class_invoice_income.counted_separately");
    expect(sql).not.toContain("class_invoice_income.treated_as_same_payment");
  });

  it("deduplicates uneven Sheet and manual actuals while invoices stay reference-only", async () => {
    async function scenario(input: {
      sheetCount: number;
      invoiceCount: number;
      manualCount: number;
      separateFirstInvoice?: boolean;
    }) {
      const pool = {
        query: async (statement: string) => {
          if (statement.includes("FROM payroll_transactions t")) {
            return { rows: Array.from({ length: input.sheetCount }, (_, index) => ({
              id: `sheet-${index + 1}`,
              source_ref: `SHEET-${index + 1}`,
              service_date: "2026-08-10",
              individual_id: "person-1",
              individual_name: "Person One",
              program_id: "program-class",
              employee_id: null,
              employee_name: null,
              program_name: "Classes",
              payment_recipient: "employee",
              gross_amount: "100",
              base_amount: null,
              person_share_percent: null,
              employee_deal_id: null,
              agency_cut_percent: null,
            })) };
          }
          if (statement.includes("FROM employee_payroll_checks check_fact")
            || statement.includes("WITH strategy_state_candidates")) {
            return { rows: [] };
          }
          if (statement.includes("FROM class_invoices invoice")) {
            return { rows: Array.from({ length: input.invoiceCount }, (_, index) => ({
              id: `invoice-${index + 1}`,
              class_budget_period_id: `class-budget-${index + 1}`,
              invoice_number: `CLASS-${index + 1}`,
              invoice_date: "2026-08-10",
              individual_id: "person-1",
              individual_name: "Person One",
              program_id: "program-class",
              program_name: "Classes",
              total_amount: "100",
              agency_share_percent: "0.6",
              custom_split_required: true,
              count_separately_reason: input.separateFirstInvoice && index === 0
                ? "This invoice is a separate payment"
                : null,
              count_separately_source_type: input.separateFirstInvoice && index === 0
                ? "google_sheet_transaction"
                : null,
              count_separately_source_id: input.separateFirstInvoice && index === 0
                ? "sheet-1"
                : null,
              count_separately_source_ref: input.separateFirstInvoice && index === 0
                ? "SHEET-1"
                : null,
            })) };
          }
          if (statement.includes("FROM agency_manual_income_entries entry")) {
            return { rows: Array.from({ length: input.manualCount }, (_, index) => ({
              id: `manual-${index + 1}`,
              service_date: "2026-08-10",
              source_type: "class",
              individual_id: "person-1",
              individual_name: "Person One",
              program_id: "program-class",
              program_code: "CLASSES",
              program_name: "Classes",
              gross_amount: "100",
              agency_share_percent: "0.8",
              agency_amount: "80",
              individual_amount: "20",
              source_ref: null,
              notes: null,
              automatic_source_override_reason: null,
              status: "active",
              void_reason: null,
              program_budget_event_id: null,
              created_at: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
            })) };
          }
          throw new Error(`Unexpected query: ${statement}`);
        },
      } as unknown as PgLikePool;
      return getAgencyFinancialReport(pool, "2026-08");
    }

    const sheetHeavy = await scenario({ sheetCount: 2, invoiceCount: 1, manualCount: 2 });
    expect(sheetHeavy.totals.income).toMatchObject({
      transactions: "200.0000",
      classes: "0.0000",
      manual: "0.0000",
      total: "200.0000",
    });
    expect(sheetHeavy.manualIncome.every((entry) => !entry.countedInIncome)).toBe(true);
    expect(sheetHeavy.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(sheetHeavy.totals.expenses.manualIndividualShare).toBe("40.0000");

    const invoiceHeavy = await scenario({ sheetCount: 1, invoiceCount: 2, manualCount: 2 });
    expect(invoiceHeavy.totals.income).toMatchObject({
      transactions: "100.0000",
      classes: "0.0000",
      manual: "100.0000",
      total: "200.0000",
    });
    expect(invoiceHeavy.manualIncome.filter((entry) => entry.countedInIncome)).toHaveLength(1);
    expect(invoiceHeavy.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(invoiceHeavy.totals.expenses.manualIndividualShare).toBe("40.0000");

    const auditedSeparate = await scenario({
      sheetCount: 1,
      invoiceCount: 1,
      manualCount: 2,
      separateFirstInvoice: true,
    });
    expect(auditedSeparate.totals.income).toMatchObject({
      transactions: "100.0000",
      classes: "0.0000",
      manual: "100.0000",
      total: "200.0000",
    });
    expect(auditedSeparate.manualIncome.filter((entry) => entry.countedInIncome)).toHaveLength(1);
    expect(auditedSeparate.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(auditedSeparate.totals.expenses.manualIndividualShare).toBe("40.0000");
  });

  it("does not let an issued invoice suppress recorded cash receipts or their splits", async () => {
    const pool = {
      query: async (statement: string) => {
        if (statement.includes("FROM payroll_transactions t")
          || statement.includes("FROM employee_payroll_checks check_fact")
          || statement.includes("WITH strategy_state_candidates")) return { rows: [] };
        if (statement.includes("FROM class_invoices invoice")) {
          return { rows: [{
            id: "invoice-one", invoice_number: "CLASS-ONE", invoice_date: "2026-08-22",
            individual_id: "person-1", individual_name: "Person One", program_id: "program-class",
            program_name: "Classes", total_amount: "100", agency_share_percent: "0.6",
            custom_split_required: true,
          }] };
        }
        if (statement.includes("FROM agency_manual_income_entries entry")) {
          const base = {
            service_date: "2026-08-22", source_type: "class", individual_id: "person-1",
            individual_name: "Person One", program_id: "program-class", program_code: "CLASS",
            program_name: "Classes", gross_amount: "100", agency_share_percent: "0.8",
            agency_amount: "80", individual_amount: "20", source_ref: null, notes: null,
            automatic_source_override_reason: null, status: "active", void_reason: null,
            program_budget_event_id: null, created_at: "2026-08-01T12:00:00Z",
          };
          return { rows: [
            { ...base, id: "manual-b" },
            { ...base, id: "manual-a" },
          ] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
    } as unknown as PgLikePool;

    const report = await getAgencyFinancialReport(pool, "2026-08");

    expect(report.manualIncome.find((row) => row.id === "manual-a")).toMatchObject({
      countedInIncome: true,
      countedSplitExpense: true,
      matchedIncomeSource: null,
      matchedSplitSource: null,
    });
    expect(report.manualIncome.find((row) => row.id === "manual-b")).toMatchObject({
      countedInIncome: true,
      countedSplitExpense: true,
      matchedIncomeSource: null,
      matchedSplitSource: null,
    });
    expect(report.totals.income).toMatchObject({
      classes: "0.0000",
      manual: "200.0000",
      total: "200.0000",
    });
    expect(report.totals.expenses.classIndividualShare).toBe("0.0000");
    expect(report.totals.expenses.manualIndividualShare).toBe("40.0000");
    expect(report.coverage.manualIncomeDuplicatesExcluded).toBe(0);
  });
});
