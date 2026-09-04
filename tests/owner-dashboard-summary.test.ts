import { describe, expect, it } from "vitest";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { IndividualBudgetBoardRow } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import type { StrategyGridRow } from "@/lib/manage/calculation-strategies";
import {
  buildOwnerActivityFilterOptions,
  buildOwnerAttentionItems,
  buildOwnerDashboardSummary,
  normalizeOwnerActivitySelection,
} from "@/lib/dashboard/owner-summary";

const ids = {
  latest1: "00000000-0000-4000-8000-000000000001",
  latest2: "00000000-0000-4000-8000-000000000002",
  older: "00000000-0000-4000-8000-000000000003",
};
const AS_OF = new Date("2026-09-04T12:00:00Z");

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
    groupDetectionStatus: "single",
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
    scheduledHours: "0",
    remainingAfterScheduledHours: "300",
    undatedUsageCount: 0,
    hasUndatedUsage: false,
    revision: 1,
    isExplicit: true,
    source: "explicit_authorization",
    sourceCandidateCount: 1,
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
      asOf: AS_OF,
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
      overLimit: 0,
      atLimit: 0,
      behindPace: 1,
      scheduledOverLimit: 0,
      renewalDueSoon: 0,
      renewalMissing: 0,
      renewalExpired: 0,
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

  it("keeps check and money follow-up in separate exact queues", () => {
    const summary = buildOwnerDashboardSummary({
      asOf: AS_OF,
      transactions: [
        transaction({
          id: ids.latest2,
          checkDate: "2026-08-23",
          checkNumber: "901",
          paymentRecipient: "unknown",
          payTo: "Routing unclear",
        }),
        transaction({
          id: ids.latest1,
          totalNetPay: null,
        }),
      ],
      programBudgets: [programBudget({})],
      budgetBoard: [
        boardRow({ hasBilling: true }),
        boardRow({
          id: "20000000-0000-4000-8000-000000000009",
          name: "No Budget",
          hasBilling: true,
        }),
      ],
      strategies: [
        strategy({}),
        strategy({
          id: "60000000-0000-4000-8000-000000000002",
          afterAll: null,
        }),
      ],
    });

    const items = buildOwnerAttentionItems(summary, {
      agencyOwes: "75.0000",
      employeesOwe: "80.0000",
      reservesToSetAside: "40.0000",
      credits: "12.5000",
      creditCount: 1,
    }, 2);

    expect(items.map((item) => item.key)).toEqual([
      "check-verification",
      "agency-payments",
      "employee-collections",
      "individual-put-away",
      "billing-without-budget",
      "budget-behind-pace",
      "money-credits",
      "financial-approvals",
    ]);
    expect(items[0]).toMatchObject({
      detail: "2 check groups have missing or conflicting routing, net pay, identity, duplicate, or group-review data.",
      href: "/settlements?focus=check-issues",
    });
    expect(items[1]).toMatchObject({
      title: "$75.00 needs to be paid",
      href: "/settlements?queue=payable",
    });
    expect(items[2]).toMatchObject({
      title: "$80.00 needs to be collected",
      href: "/settlements?queue=receivable",
    });
    expect(items[3]).toMatchObject({
      title: "$40.00 needs to be put away",
      href: "/settlements?queue=reserve",
    });
    expect(items[7]).toMatchObject({
      detail: "1 financial plan needs an approved final amount.",
      href: "/calculations",
    });
  });

  it("prioritizes eight concise owner actions with filtered source sets", () => {
    const personId = (suffix: string) => `20000000-0000-4000-8000-0000000000${suffix}`;
    const authorization = (
      suffix: string,
      overrides: Partial<ProgramBudgetRecord>,
    ) => programBudget({
      authorizationId: `40000000-0000-4000-8000-0000000000${suffix}`,
      individualId: personId(suffix),
      individualName: `Person ${suffix}`,
      ...overrides,
    });
    const programBudgets = [
      authorization("01", { consumedHours: "510", remainingHours: "-10", remainingAfterScheduledHours: "-10" }),
      authorization("02", { consumedHours: "475", remainingHours: "25", remainingAfterScheduledHours: "25" }),
      authorization("03", { consumedHours: "100", remainingHours: "400", remainingAfterScheduledHours: "400" }),
      authorization("04", {
        endDate: "2026-10-01",
        renewalDate: "2026-10-02",
        consumedHours: "100",
        remainingHours: "400",
        scheduledHours: "450",
        remainingAfterScheduledHours: "-50",
      }),
      authorization("05", {
        startDate: "2025-09-01",
        endDate: "2026-08-31",
        renewalDate: "2026-09-01",
        consumedHours: "100",
        remainingHours: "400",
        remainingAfterScheduledHours: "400",
      }),
    ];
    const summary = buildOwnerDashboardSummary({
      asOf: AS_OF,
      transactions: [transaction({ matchStatus: "possible" })],
      programBudgets,
      budgetBoard: programBudgets.map((row) => boardRow({ id: row.individualId, name: row.individualName })),
      strategies: [strategy({
        individualId: personId("06"),
        renewalDate: null,
        effectiveRenewal: null,
        periodStart: null,
        periodEnd: null,
        afterAll: null,
      })],
    });

    expect(summary.budgets).toMatchObject({
      overLimit: 1,
      atLimit: 1,
      behindPace: 3,
      scheduledOverLimit: 1,
      renewalDueSoon: 1,
      renewalMissing: 1,
      renewalExpired: 1,
    });

    const items = buildOwnerAttentionItems(summary, {
      agencyOwes: "25",
      employeesOwe: "0",
      reservesToSetAside: "0",
      credits: "0",
      creditCount: 0,
    }, 1);
    expect(items).toHaveLength(8);
    expect(items.map((item) => item.key)).toEqual([
      "check-verification",
      "budget-over-limit",
      "scheduled-over-limit",
      "agency-payments",
      "budget-at-limit",
      "renewal-repair",
      "budget-behind-pace",
      "financial-approvals",
    ]);
    expect(items.map((item) => item.href)).toEqual([
      "/settlements?focus=check-issues",
      "/individuals?view=over",
      "/schedule?view=coverage",
      "/settlements?queue=payable",
      "/individuals?view=at_limit",
      "/individuals?view=attention",
      "/individuals?view=behind",
      "/calculations",
    ]);
  });

  it("opens the exact next visit for schedule conflicts and staffing gaps", () => {
    const summary = buildOwnerDashboardSummary({
      asOf: AS_OF,
      transactions: [],
      programBudgets: [],
      budgetBoard: [],
      strategies: [],
    });
    const conflictId = "70000000-0000-4000-8000-000000000001";
    const unassignedId = "70000000-0000-4000-8000-000000000002";
    const items = buildOwnerAttentionItems(summary, undefined, 0, {
      from: "2026-09-04",
      through: "2026-10-04",
      conflictCount: 2,
      unassignedCount: 1,
      nextConflict: {
        id: conflictId,
        sessionDate: "2026-09-05",
        startTime: "09:30",
        employeeName: "Eli Worker",
        individualNames: ["Ari Person"],
        programName: "Com Hab",
        href: `/schedule?view=calendar&date=2026-09-05&calendarView=day&sessionId=${conflictId}`,
      },
      nextUnassigned: {
        id: unassignedId,
        sessionDate: "2026-09-06",
        startTime: null,
        employeeName: null,
        individualNames: ["Bea Person"],
        programName: "Respite",
        href: `/schedule?view=calendar&date=2026-09-06&calendarView=day&sessionId=${unassignedId}`,
      },
    });

    expect(items.map((item) => item.key)).toEqual(["schedule-conflicts", "staffing-gaps"]);
    expect(items[0]).toMatchObject({
      href: `/schedule?view=calendar&date=2026-09-05&calendarView=day&sessionId=${conflictId}`,
      action: "Open first conflict",
    });
    expect(items[0]?.detail).toContain("2026-09-05 at 09:30 · Ari Person · Com Hab.");
    expect(items[0]?.detail).toContain("1 more visit needs review.");
    expect(items[1]).toMatchObject({
      href: `/schedule?view=calendar&date=2026-09-06&calendarView=day&sessionId=${unassignedId}`,
      action: "Assign first visit",
    });
  });

  it("omits cleared attention categories", () => {
    const summary = buildOwnerDashboardSummary({
      asOf: AS_OF,
      transactions: [transaction({})],
      programBudgets: [programBudget({ consumedHours: "340", remainingHours: "160" })],
      budgetBoard: [boardRow({ hasBilling: true })],
      strategies: [strategy({})],
    });

    expect(buildOwnerAttentionItems(summary, {
      agencyOwes: "0",
      employeesOwe: "0",
      reservesToSetAside: "0",
      credits: "0",
      creditCount: 0,
    })).toEqual([]);
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
            missingRenewal: false,
            renewalCount: 1,
            usedHours: 200,
            hoursLeft: 300,
            scheduledHours: 0,
            hoursAfterScheduled: 300,
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
            missingRenewal: false,
            renewalCount: 1,
            usedHours: 25,
            hoursLeft: 75,
            scheduledHours: 0,
            hoursAfterScheduled: 75,
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

  it("totals several selected people and preserves the cohort in transaction drilldowns", () => {
    const alexId = "20000000-0000-4000-8000-000000000001";
    const blairId = "20000000-0000-4000-8000-000000000002";
    const summary = buildOwnerDashboardSummary({
      transactions: [
        transaction({ id: ids.older, individualId: alexId, individual: "Alex One", gross: "300" }),
        transaction({ id: ids.latest1, individualId: blairId, individual: "Blair Two", gross: "500" }),
        transaction({
          id: ids.latest2,
          individualId: "20000000-0000-4000-8000-000000000003",
          individual: "Casey Three",
          gross: "900",
        }),
      ],
      programBudgets: [],
      budgetBoard: [],
      strategies: [],
      activitySelection: { individualIds: [alexId, blairId] },
    });

    expect(summary.transactions.contextTotals.transactions).toBe(2);
    expect(summary.transactions.contextTotals.gross).toBe("800.00");
    expect(summary.transactions.contextHref).toContain(`individualId=${alexId}`);
    expect(summary.transactions.contextHref).toContain(`individualId=${blairId}`);
    expect(summary.transactions.recentChecks.every((check) => (
      check.href.includes(`individualId=${alexId}`)
        && check.href.includes(`individualId=${blairId}`)
    ))).toBe(true);
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
