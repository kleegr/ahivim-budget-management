import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AgencyFinancialReport } from "@/lib/data/agency-financial-report";
import { agencyFinancialExportTables } from "@/lib/export/agency-financial-report";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  getAgencyFinancialReport: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/data/agency-financial-report", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/agency-financial-report")>(),
  getAgencyFinancialReport: mocks.getAgencyFinancialReport,
}));

import { GET } from "@/app/api/agency-financials/export/route";

const REPORT: AgencyFinancialReport = {
  month: "2026-07",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  transactions: [{
    id: "transaction-1",
    sourceRef: "TX-1",
    serviceDate: "2026-07-08",
    individualId: "individual-1",
    individualName: "Individual One",
    programId: "program-1",
    employeeId: "employee-1",
    employeeName: "Employee One",
    programName: "Community Habilitation",
    paymentRecipient: "excellent_staffing",
    grossAmount: "100.0000",
    baseAmount: "60.0000",
    employeeSharePercent: "50.0000",
    employeeExpense: "30.0000",
    payRuleSource: "person_rule",
  }],
  directChecks: [{
    id: "check-1",
    serviceDate: "2026-07-15",
    employeeId: "employee-2",
    employeeName: "Employee Two",
    checkNumber: "CHK-1",
    grossAmount: "50.0000",
    netAmount: "45.0000",
    taxes: "5.0000",
    employeeKeeps: "30.0000",
    employeeOwesAgency: "15.0000",
    dealLabel: "Employee keeps 66.67%",
  }],
  setAsides: [{
    strategyId: "strategy-1",
    individualId: "individual-1",
    individualName: "Individual One",
    setupName: "Monthly setup",
    firstCutPercent: "10.0000",
    secondCutPercent: "5.0000",
    approvedMonthlyFinal: "20.0000",
    historyAvailable: true,
    stateSource: "saved_revision",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    revisionId: "revision-1",
    revisionNumber: 2,
    revisionReason: "Monthly close",
    revisionCreatedAt: "2026-08-01T00:00:00.000Z",
  }],
  classInvoices: [{
    id: "invoice-1",
    classBudgetPeriodId: "budget-1",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-07-10",
    individualId: "individual-1",
    individualName: "Individual One",
    programId: "program-1",
    programName: "Community Habilitation",
    grossAmount: "80.0000",
    agencySharePercent: "25.0000",
    agencyAmount: "20.0000",
    individualExpense: "60.0000",
    splitSource: "configured",
    matchedIncomeSource: null,
    countSeparatelyReason: null,
    countedInIncome: false,
    countedSplitExpense: false,
  }],
  manualIncome: [{
    id: "income-1",
    serviceDate: "2026-07-20",
    sourceType: "other",
    individualId: null,
    individualName: null,
    programId: null,
    programCode: null,
    programName: null,
    grossAmount: "25.0000",
    agencySharePercent: "100.0000",
    agencyAmount: "25.0000",
    individualAmount: "0.0000",
    sourceRef: "OTHER-1",
    notes: null,
    automaticSourceOverrideReason: null,
    automaticSourceOverrideSourceType: null,
    automaticSourceOverrideSourceId: null,
    automaticSourceOverrideSourceRef: null,
    status: "active",
    voidReason: null,
    programBudgetEventId: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    automaticSourceDuplicate: false,
    matchedIncomeSource: null,
    matchedSplitSource: null,
    countSeparatelyReason: null,
    countedInIncome: true,
    countedSplitExpense: true,
  }],
  totals: {
    income: {
      transactions: "100.0000",
      classes: "0.0000",
      manual: "25.0000",
      total: "125.0000",
    },
    expenses: {
      approvedSetAsides: "20.0000",
      taxes: "5.0000",
      directEmployeeKeeps: "30.0000",
      agencyRoutedEmployeeShare: "30.0000",
      classIndividualShare: "0.0000",
      manualIndividualShare: "0.0000",
      total: "85.0000",
    },
    agencyResult: "40.0000",
  },
  coverage: {
    transactionsMissingAmount: 0,
    agencyTransactionsMissingBase: 0,
    agencyTransactionsMissingPayRule: 0,
    directChecksMissingGross: 0,
    directChecksGrossBelowNet: 0,
    directChecksMissingDeal: 0,
    classInvoicesMissingProgram: 0,
    classInvoicesMissingSplit: 0,
    classInvoiceDuplicatesExcluded: 0,
    setupsMissingApprovedFinal: 0,
    setAsideHistoriesUnavailable: 0,
    manualIncomeDuplicatesExcluded: 0,
    unknownPaymentRecipients: 0,
  },
};

const client = {
  query: vi.fn(async () => ({ rows: [] })),
  release: vi.fn(),
};

describe("Agency Financial export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: "owner-1", role: "admin" });
    mocks.getPool.mockReturnValue({ connect: vi.fn(async () => client) });
    mocks.getAgencyFinancialReport.mockResolvedValue(REPORT);
  });

  it("exports the selected report month, totals, and every actual row collection", () => {
    const tables = agencyFinancialExportTables(REPORT);
    const table = (title: string) => tables.find((candidate) => candidate.title === title)!;

    expect(table("Report period").rows).toEqual([{
      month: REPORT.month,
      periodStart: REPORT.periodStart,
      periodEnd: REPORT.periodEnd,
    }]);
    expect(table("Summary totals").rows).toContainEqual({
      section: "Result",
      metric: "Agency result",
      records: null,
      amount: REPORT.totals.agencyResult,
    });
    expect(table("Transaction actuals").rows).toHaveLength(REPORT.transactions.length);
    expect(table("Verified direct-pay checks").rows).toHaveLength(REPORT.directChecks.length);
    expect(table("Approved monthly set-asides").rows).toHaveLength(REPORT.setAsides.length);
    expect(table("Class invoice receivables").rows).toHaveLength(REPORT.classInvoices.length);
    expect(table("Recorded other income").rows).toHaveLength(REPORT.manualIncome.length);
    expect(table("Transaction actuals").rows[0]).toMatchObject({
      serviceDate: REPORT.transactions[0]!.serviceDate,
      gross: REPORT.transactions[0]!.grossAmount,
      employeeExpense: REPORT.transactions[0]!.employeeExpense,
    });
  });

  it("downloads CSV and XLSX from the same repeatable-read report snapshot", async () => {
    const csvResponse = await GET(new NextRequest(
      "http://localhost/api/agency-financials/export?month=2026-07&format=csv",
    ));
    const csv = await csvResponse.text();

    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-disposition")).toContain("agency-financials-2026-07.csv");
    expect(csv).toContain("Report period");
    expect(csv).toContain("2026-07,2026-07-01,2026-07-31");
    expect(csv).toContain("Result,Agency result,,40.00");
    expect(mocks.apiUser).toHaveBeenCalledWith("admin");
    expect(mocks.getAgencyFinancialReport).toHaveBeenCalledWith(client, "2026-07");
    expect(client.query).toHaveBeenCalledWith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.query).toHaveBeenCalledWith("COMMIT");

    const xlsxResponse = await GET(new NextRequest(
      "http://localhost/api/agency-financials/export?month=2026-07&format=xlsx",
    ));
    const bytes = new Uint8Array(await xlsxResponse.arrayBuffer());
    expect(xlsxResponse.status).toBe(200);
    expect(xlsxResponse.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(xlsxResponse.headers.get("content-disposition")).toContain("agency-financials-2026-07.xlsx");
    expect(Array.from(bytes.slice(0, 2))).toEqual([80, 75]);
  }, 15_000);

  it("denies non-owners before opening a database snapshot", async () => {
    mocks.apiUser.mockResolvedValue(null);

    const response = await GET(new NextRequest(
      "http://localhost/api/agency-financials/export?month=2026-07&format=csv",
    ));

    expect(response.status).toBe(403);
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.getAgencyFinancialReport).not.toHaveBeenCalled();
  });

  it("shows both export actions for the report's selected month", () => {
    const workspace = readFileSync("src/components/reports/agency-financial-workspace.tsx", "utf8");
    expect(workspace).toContain("/api/agency-financials/export?format=csv&month=${report.month}");
    expect(workspace).toContain("/api/agency-financials/export?format=xlsx&month=${report.month}");
    expect(workspace.match(/<a className=\"btn btn-secondary\" download/g)).toHaveLength(2);
  });
});
