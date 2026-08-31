import { describe, expect, it } from "vitest";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { IndividualBudgetBoardRow } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import type { StrategyGridRow } from "@/lib/manage/calculation-strategies";
import {
  buildOwnerActivityFilterOptions,
  buildOwnerDashboardSummary,
  normalizeOwnerActivitySelection,
} from "@/lib/dashboard/owner-summary";

const ids = {
  latest1: "00000000-0000-4000-8000-000000000001",
  latest2: "00000000-0000-4000-8000-000000000002",
  older: "00000000-0000-4000-8000-000000000003",
};

function transaction(overrides: Partial<GridTransaction>): GridTransaction {
  return {
    id: ids.latest1,
    payTo: "Payroll account",
    checkDate: "2026-08-22",
    checkNumber: "900",
    hours: "10",
    rate: "100",
    gross: "1000",
    totalNetPay: "800",
    periodBegin: "2026-08-01",
    periodEnd: "2026-08-14",
    program: "Com Hab",
    programCode: "COM_HAB",
    programId: "10000000-0000-4000-8000-000000000001",
    individual: "Alex One",
    individualId: "20000000-0000-4000-8000-000000000001",
    employee: "Employee One",
    employeeId: "30000000-0000-4000-8000-000000000001",
    internalAmount: "800",
    agencyAdditional: "200",
    paymentRecipient: "employee",
    importBatchId: null,
    importRowId: null,
    sourceFileId: null,
    matchStatus: "new",
    isGroup: false,
    serviceSessionId: null,
    isPaid: false,
    paidAt: null,
    paidNote: null,
    ...overrides,
  };
}

function programBudget(overrides: Partial<ProgramBudgetRecord>): ProgramBudgetRecord {
  return {
    authorizationId: "40000000-0000-4000-8000-000000000001",
    budgetPeriodId: "50000000-0000-4000-8000-000000000001",
    individualId: "20000000-0000-4000-8000-000000000001",
    individualName: "Alex One",
    programId: "10000000-0000-4000-8000-000000000001",
    programCode: "COM_HAB",
    programName: "Com Hab",
    periodLabel: "2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    renewalDate: "2026-12-31",
    periodType: "annual",
    periodStatus: "active",
    requiredAuthType: "hours",
    serviceCategory: "direct_service",
    paymentRecipient: "agency",
    consumptionSource: "payroll",
    rateScope: "per_individual",
    renewalPolicy: "individual",
    allowIndividualRateOverride: true,
    authorizedHours: "500",
    authorizedDollars: null,
    internalRate: "21",
    agencyRate: "25",
    individualRateOverride: null,
    notes: null,
    consumedHours: "200",
    consumedDollars: "5000",
    remainingHours: "300",
    remainingDollars: null,
    undatedUsageCount: 0,
    hasUndatedUsage: false,
    revision: 1,
    ...overrides,
  };
}

function boardRow(overrides: Partial<IndividualBudgetBoardRow>): IndividualBudgetBoardRow {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Alex One",
    preferredName: null,
    status: "active",
    archived: false,
    programs: [],
    budget: null,
    hasBilling: false,
    lastBilledOn: null,
    ...overrides,
  };
}

function strategy(overrides: Partial<StrategyGridRow>): StrategyGridRow {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    individualId: "20000000-0000-4000-8000-000000000001",
    individualName: "Alex One",
    label: "1",
    renewalDate: "2026-12-31",
    effectiveRenewal: "2026-12-31",
    active: true,
    periodStart: "2025-12-31",
    periodEnd: "2026-12-31",
    monthDivisor: "12",
    cut1Percent: "0.1",
    cut2Percent: "0.1",
    clockAdjustment: "0",
    otherAdjustment: "0",
    afterAll: "650",
    account: null,
    status: "active",
    sortOrder: 0,
    hours: {},
    yearlyGross: "12000",
    monthlyGross: "1000",
    grossNet: "810",
    net: "700",
    revisionCount: 0,
    ...overrides,
  };
}

describe("buildOwnerDashboardSummary", () => {
  it("keeps the latest check-date actuals, authorization budgets, and financial plans separate", () => {
    const summary = buildOwnerDashboardSummary({
      transactions: [
        transaction({ id: ids.older, checkDate: "2026-08-08", checkNumber: "899", gross: "300", internalAmount: "200", agencyAdditional: "100" }),
        transaction({ id: ids.latest1 }),
        transaction({
          id: ids.latest2,
          hours: "5",
          gross: "500",
          internalAmount: "350",
          agencyAdditional: "150",
          individual: "Blair Two",
          individualId: "20000000-0000-4000-8000-000000000002",
        }),
      ],
      programBudgets: [
        programBudget({}),
        programBudget({
          authorizationId: "40000000-0000-4000-8000-000000000002",
          programId: "10000000-0000-4000-8000-000000000002",
          requiredAuthType: "both",
          authorizedHours: "100",
          consumedHours: "40",
          remainingHours: "60",
        }),
        programBudget({
          authorizationId: "40000000-0000-4000-8000-000000000003",
          individualId: "20000000-0000-4000-8000-000000000002",
          requiredAuthType: "dollars",
          authorizedHours: "999",
          consumedHours: "999",
          remainingHours: "0",
        }),
      ],
      budgetBoard: [
        boardRow({ hasBilling: true }),
        boardRow({ id: "20000000-0000-4000-8000-000000000003", hasBilling: true }),
        boardRow({ id: "20000000-0000-4000-8000-000000000004", hasBilling: true, archived: true }),
      ],
      strategies: [
        strategy({}),
        strategy({
          id: "60000000-0000-4000-8000-000000000002",
          yearlyGross: "6000",
          monthlyGross: "500",
          net: "350",
          afterAll: null,
        }),
      ],
    });

    expect(summary.transactions.latestCheckDate).toBe("2026-08-22");
    expect(summary.transactions.mode).toBe("latest");
    expect(summary.transactions.contextTotals).toMatchObject({
      gross: "1500.00",
      internal: "1150.00",
      agencyAdditional: "350.00",
      hours: "15.00",
      transactions: 2,
      checks: 1,
      individuals: 2,
      employees: 1,
    });
    expect(summary.transactions.contextHref).toBe(
      "/transactions?view=rows&checkDateFrom=2026-08-22&checkDateTo=2026-08-22",
    );
    expect(summary.transactions.contextHref).not.toContain("transactionId");
    expect(summary.transactions.recentChecks[0]).toMatchObject({ rows: 2 });
    expect(summary.transactions.recentChecks[0]?.href).toContain("checkNumber=900");
    expect(summary.transactions.recentChecks[0]?.href).toContain("checkDateFrom=2026-08-22");
    expect(summary.transactions.recentChecks[0]?.href).not.toContain("transactionId");
    expect(summary.transactions.recentChecks[0]?.netPay).toBe("800");

    expect(summary.budgets).toEqual({
      people: 1,
      authorizations: 2,
      authorizedHours: "600.00",
      usedHours: "240.00",
      remainingHours: "360.00",
      billingWithoutBudget: 1,
      source: "program_authorizations",
    });

    expect(summary.financial).toEqual({
      strategies: 2,
      yearlyGross: "18000.00",
      monthlyGross: "1500.00",
      calculatedNet: "1050.00",
      approvedFinal: "650.00",
      approvedStrategies: 1,
    });
  });

  it("never substitutes a legacy budget-board calculation for canonical authorizations", () => {
    const summary = buildOwnerDashboardSummary({
      transactions: [],
      programBudgets: [],
      budgetBoard: [
        boardRow({
          hasBilling: true,
          budget: {
            status: "on_pace",
            plainStatus: "on_track",
            usedPct: 40,
            elapsedPct: 35,
            renews: "2026-12-31",
            renewalCount: 1,
            usedHours: 200,
            hoursLeft: 300,
            plans: 2,
            daysToRenewal: 120,
            expired: false,
            mustUseMonthly: 75,
            mustUseWeekly: 18,
            transactionCount: 4,
            billedAmount: "5000",
          },
        }),
      ],
      strategies: [],
    });

    expect(summary.budgets).toMatchObject({
      people: 0,
      authorizations: 0,
      authorizedHours: "0.00",
      usedHours: "0.00",
      remainingHours: "0.00",
      billingWithoutBudget: 1,
      source: "program_authorizations",
    });
    expect(summary.transactions.latestCheckDate).toBeNull();
    expect(summary.transactions.contextHref).toBe("/transactions");
  });

  it("keeps uncovered legacy board rows out of totals and flags their billing", () => {
    const summary = buildOwnerDashboardSummary({
      transactions: [],
      programBudgets: [programBudget({})],
      budgetBoard: [
        boardRow({}),
        boardRow({
          id: "20000000-0000-4000-8000-000000000009",
          hasBilling: true,
          budget: {
            status: "on_pace",
            plainStatus: "on_track",
            usedPct: 25,
            elapsedPct: 25,
            renews: "2027-01-01",
            renewalCount: 1,
            usedHours: 25,
            hoursLeft: 75,
            plans: 1,
            daysToRenewal: 120,
            expired: false,
            mustUseMonthly: 10,
            mustUseWeekly: 2,
            transactionCount: 1,
            billedAmount: "525",
          },
        }),
      ],
      strategies: [],
    });

    expect(summary.budgets).toMatchObject({
      people: 1,
      authorizations: 1,
      authorizedHours: "500.00",
      usedHours: "200.00",
      remainingHours: "300.00",
      billingWithoutBudget: 1,
      source: "program_authorizations",
    });
  });

  it("totals the full selected activity set and builds the same stable ledger filters", () => {
    const alexId = "20000000-0000-4000-8000-000000000001";
    const summary = buildOwnerDashboardSummary({
      transactions: [
        transaction({
          id: ids.older,
          checkDate: "2026-08-08",
          checkNumber: "899",
          gross: "300",
          internalAmount: "200",
          agencyAdditional: "100",
        }),
        transaction({ id: ids.latest1 }),
        transaction({
          id: ids.latest2,
          individualId: "20000000-0000-4000-8000-000000000002",
          individual: "Blair Two",
          gross: "500",
          internalAmount: "350",
          agencyAdditional: "150",
        }),
      ],
      programBudgets: [],
      budgetBoard: [],
      strategies: [],
      activitySelection: {
        checkDateFrom: "2026-08-01",
        checkDateTo: "2026-08-31",
        individualId: alexId,
        payrollPeriod: "2026-08-01",
      },
    });

    expect(summary.transactions.mode).toBe("selection");
    expect(summary.transactions.contextTotals).toMatchObject({
      gross: "1300.00",
      internal: "1000.00",
      agencyAdditional: "300.00",
      transactions: 2,
      checks: 2,
    });
    expect(summary.transactions.contextHref).toBe(
      `/transactions?view=rows&checkDateFrom=2026-08-01&checkDateTo=2026-08-31&individualId=${alexId}&pbFrom=2026-08-01&pbTo=2026-08-01`,
    );
    expect(summary.transactions.contextHref).not.toContain("transactionId");
    expect(summary.transactions.recentChecks[0]?.href).toContain(`individualId=${alexId}`);
    expect(summary.transactions.recentChecks[0]?.href).toContain("pbFrom=2026-08-01");
  });

  it("builds sorted owner filter options and normalizes a reversed date range", () => {
    const rows = [
      transaction({
        id: ids.latest1,
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-14",
      }),
      transaction({
        id: ids.latest2,
        individualId: "20000000-0000-4000-8000-000000000002",
        individual: "Blair Two",
        employeeId: "30000000-0000-4000-8000-000000000002",
        employee: "Employee Two",
        periodBegin: "2026-08-15",
        periodEnd: "2026-08-31",
      }),
    ];

    expect(buildOwnerActivityFilterOptions(rows)).toEqual({
      individuals: [
        { value: "20000000-0000-4000-8000-000000000001", label: "Alex One" },
        { value: "20000000-0000-4000-8000-000000000002", label: "Blair Two" },
      ],
      employees: [
        { value: "30000000-0000-4000-8000-000000000001", label: "Employee One" },
        { value: "30000000-0000-4000-8000-000000000002", label: "Employee Two" },
      ],
      payrollPeriods: [
        { value: "2026-08-15", label: "2026-08-15 to 2026-08-31" },
        { value: "2026-08-01", label: "2026-08-01 to 2026-08-14" },
      ],
    });
    expect(normalizeOwnerActivitySelection({
      checkDateFrom: "2026-08-31",
      checkDateTo: "2026-08-01",
      payrollPeriod: "not-a-date",
    })).toMatchObject({
      checkDateFrom: "2026-08-01",
      checkDateTo: "2026-08-31",
      payrollPeriod: null,
    });
  });
});
