import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import { groupChecks, amountCompletenessLabel } from "@/components/transactions/check-grouping";
import { buildCheckExport } from "@/components/transactions/check-export";
import { buildCsv, buildXlsx } from "@/lib/export/tabular";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";
import { buildInitialFilters, filterTransactionsBySelection } from "@/lib/transactions/initial-filters";
import { buildOwnerDashboardSummary } from "@/lib/dashboard/owner-summary";
import { applyFilters } from "@/components/data-grid/engine";
import { computeGridTotals, formatKnownMoneyTotal } from "@/lib/business/transaction-totals";

function row(overrides: Partial<GridTransaction> = {}): GridTransaction {
  return { id: "a", checkDate: "2026-08-28", checkNumber: "SAME", periodBegin: "2026-08-01", periodEnd: "2026-08-15", individualId: "person-a", individual: "Same Name", employeeId: "employee-a", employee: "Employee A", programId: "program-a", program: "Program A", payTo: "Agency", paymentRecipient: "excellent_staffing", hours: "2", gross: "100", internalAmount: null, agencyAdditional: null, ...overrides } as GridTransaction;
}

describe("transaction selection and amount completeness", () => {
  it("keeps row, selected-row, Home and check totals on the same known values when another field is missing", () => {
    const missing = row({ gross: "100", internalAmount: null, agencyAdditional: null });
    const zero = row({ id: "zero", gross: "0", internalAmount: "0", agencyAdditional: "0" });
    const rows = [missing, zero];
    const amounts = computeGridTotals(rows).amounts;
    expect(amounts.gross).toEqual({ amount: "100.00", known: 2, missing: 0 });
    expect(amounts.internal).toEqual({ amount: "0.00", known: 1, missing: 1 });
    expect(amounts.agencyAdditional).toEqual({ amount: "0.00", known: 1, missing: 1 });
    expect(formatKnownMoneyTotal(amounts.internal)).toContain("incomplete subtotal");
    const selected = computeGridTotals([missing]).amounts;
    expect(selected.internal.amount).toBeNull();
    expect(formatKnownMoneyTotal(selected.internal)).toBe("Unavailable");
    expect(groupChecks(rows)[0]!.funderBilled).toBe(amounts.gross.amount);
    const summary = buildOwnerDashboardSummary({ transactions: rows, programBudgets: [], budgetBoard: [], strategies: [], asOf: new Date("2026-09-01") });
    expect(summary.transactions.contextTotals.amounts.gross.amount).toBe(amounts.gross.amount);
    expect(formatKnownMoneyTotal(selected.verifiedCheckNet)).toBe("Unavailable");
  });

  it("keeps unknown, mixed, and verified zero distinct in grouping and actual CSV/Excel cells", async () => {
    const checks = groupChecks([
      row(), row({ id: "mixed-unknown", checkNumber: "MIXED" }), row({ id: "mixed-known", checkNumber: "MIXED", internalAmount: "20.12", agencyAdditional: "79.88" }),
      row({ id: "zero", checkNumber: "ZERO", internalAmount: "0", agencyAdditional: "0" }),
    ]);
    const unknown = checks.find((check) => check.checkNumber === "SAME")!;
    const mixed = checks.find((check) => check.checkNumber === "MIXED")!;
    const zero = checks.find((check) => check.checkNumber === "ZERO")!;
    expect(unknown.employeeBase).toBeNull(); expect(unknown.agencySpread).toBeNull();
    expect(mixed.employeeBase).toBe("20.12"); expect(mixed.completeness.employeeBase).toEqual({ known: 1, missing: 1 });
    expect(amountCompletenessLabel(mixed.completeness.employeeBase)).toContain("Incomplete subtotal");
    expect(zero.employeeBase).toBe("0.00"); expect(zero.completeness.employeeBase).toEqual({ known: 1, missing: 0 });
    const exported = buildCheckExport([unknown, mixed, zero], transactionFieldVisibility());
    const csv = buildCsv([exported]);
    expect(csv).toContain("Unavailable"); expect(csv).toContain("Incomplete subtotal (1 known, 1 missing)");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await buildXlsx("Checks", [exported])) as never);
    const sheet = workbook.worksheets[0]!;
    const moneyColumn = exported.columns.findIndex((column) => column.key === "employeeBase") + 1;
    const completeColumn = exported.columns.findIndex((column) => column.key === "employeeBaseCompleteness") + 1;
    expect(sheet.getCell(2, moneyColumn).value).toBeNull();
    expect(sheet.getCell(3, moneyColumn).value).toBe(20.12);
    expect(sheet.getCell(4, moneyColumn).value).toBe(0);
    expect(sheet.getCell(2, completeColumn).value).toBe("Unavailable");
    expect(sheet.getCell(3, completeColumn).value).toContain("Incomplete subtotal");
  });

  it("keeps Home card rows and totals exact across shared numbers, payees, people, and periods", () => {
    const rows = [row({ id: "wanted", internalAmount: "80", agencyAdditional: "20" }), row({ id: "other-employee", employeeId: "employee-b", employee: "Employee B", gross: "999" }), row({ id: "other-period", periodEnd: "2026-08-16", gross: "888" })];
    const summary = buildOwnerDashboardSummary({ transactions: rows, programBudgets: [], budgetBoard: [], strategies: [], asOf: new Date("2026-09-01") });
    const card = summary.transactions.recentChecks.find((check) => check.employee === "Employee A" && check.funderBilled === "100.00")!;
    const params = Object.fromEntries(new URL(card.href, "http://localhost").searchParams);
    expect(filterTransactionsBySelection(rows, params).map((item) => item.id)).toEqual(["wanted"]);
    expect(groupChecks(filterTransactionsBySelection(rows, params))[0]?.funderBilled).toBe(card.funderBilled);
  });

  it("keeps absent people empty and same-name stable identities through saved filters", () => {
    const rows = [row(), row({ id: "other", individualId: "person-b" })];
    expect(filterTransactionsBySelection(rows, { individualId: "no-transactions" })).toEqual([]);
    expect(filterTransactionsBySelection(rows, { individualId: "" })).toEqual([]);
    const filters = JSON.parse(JSON.stringify(buildInitialFilters(rows, { individualId: "person-a" }).filters));
    const actual = applyFilters(rows, [
      { key: "individualId", label: "Person identity", kind: "text", accessor: (item: GridTransaction) => item.individualId },
      { key: "individual", label: "Person", kind: "text", accessor: (item: GridTransaction) => item.individual },
    ], filters, "", []);
    expect(actual.map((item) => item.id)).toEqual(["a"]);
  });

  it("isolates undated program use and rejects invalid or contradictory constraints", () => {
    const rows = [row(), row({ id: "undated", periodBegin: null, checkDate: null, periodEnd: null }), row({ id: "other-program", programId: "program-b", periodBegin: null, checkDate: null, periodEnd: null })];
    expect(filterTransactionsBySelection(rows, { individualId: "person-a", programId: "program-a", undated: "1" }).map((item) => item.id)).toEqual(["undated"]);
    expect(filterTransactionsBySelection(rows, { serviceFrom: "2026-02-31" })).toEqual([]);
    expect(filterTransactionsBySelection(rows, { individualId: "person-a", individual: "Contradiction" })).toEqual([]);
    expect(filterTransactionsBySelection(rows, { undated: "invalid" })).toEqual([]);
  });

  it("intersects legacy check periods with explicit constraints and fails closed on malformed periods", () => {
    const rows = [row(), row({ id: "earlier", checkDate: "2026-08-10" }), row({ id: "later", checkDate: "2026-09-10" })];
    expect(filterTransactionsBySelection(rows, { period: "2026-08-01..2026-08-31", checkDateFrom: "2026-08-20", checkDateTo: "2026-09-20" }).map((entry) => entry.id)).toEqual(["a"]);
    expect(filterTransactionsBySelection(rows, { period: "malformed", checkDateFrom: "2026-08-01", checkDateTo: "2026-09-30" })).toEqual([]);
    expect(filterTransactionsBySelection(rows, { period: "2026-08-01..2026-08-31", checkDateFrom: "2026-09-01" })).toEqual([]);
    expect(buildInitialFilters(rows, { period: "2026-08-01..2026-08-31", checkDateFrom: "2026-08-20" }).filters.checkDate).toEqual({ from: "2026-08-20", to: "2026-08-31" });
  });
});
