import { describe, expect, it } from "vitest";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";

function authorization(overrides: Partial<ProgramBudgetRecord>): ProgramBudgetRecord {
  return {
    authorizationId: "auth-1",
    budgetPeriodId: "period-1",
    individualId: "person-1",
    individualName: "Test Person",
    programId: "program-1",
    programCode: "COM_HAB",
    programName: "Com Hab",
    periodLabel: "Com Hab year",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    renewalDate: "2026-12-31",
    periodType: "rolling",
    periodStatus: "active",
    requiredAuthType: "hours",
    serviceCategory: "support",
    paymentRecipient: "agency",
    consumptionSource: "payroll",
    rateScope: "per_person",
    renewalPolicy: "manual",
    allowIndividualRateOverride: true,
    authorizedHours: "100",
    authorizedDollars: null,
    internalRate: "21",
    agencyRate: "25",
    individualRateOverride: null,
    notes: null,
    consumedHours: "40",
    consumedDollars: "1000",
    remainingHours: "60",
    remainingDollars: null,
    scheduledHours: "0",
    remainingAfterScheduledHours: "60",
    undatedUsageCount: 0,
    hasUndatedUsage: false,
    revision: 1,
    isExplicit: true,
    source: "explicit_authorization",
    sourceCandidateCount: 1,
    ...overrides,
  };
}

describe("authorization portfolio summary", () => {
  it("keeps separate program renewal clocks while giving the roster one next date", () => {
    const summaries = summarizeAuthorizationPortfolio([
      authorization({}),
      authorization({
        authorizationId: "auth-2",
        budgetPeriodId: "period-2",
        programId: "program-2",
        programCode: "RESPITE",
        programName: "Respite",
        startDate: "2026-04-01",
        endDate: "2027-03-31",
        renewalDate: "2027-03-31",
        authorizedHours: "50",
        consumedHours: "10",
        consumedDollars: "190",
      }),
    ], new Date("2026-08-30T12:00:00.000Z"));

    const summary = summaries.get("person-1");
    expect(summary?.programs).toEqual(["Com Hab", "Respite"]);
    expect(summary?.budget).toMatchObject({
      renews: "2026-12-31",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      periodCount: 2,
      renewalCount: 2,
      plans: 2,
      usedHours: 50,
      hoursLeft: 100,
      scheduledHours: 0,
      hoursAfterScheduled: 100,
      usedPct: 100 / 3,
      billedAmount: "1190.00",
      elapsedPct: null,
    });
  });

  it("excludes dollar-only programs from the hours portfolio", () => {
    const summaries = summarizeAuthorizationPortfolio([
      authorization({ requiredAuthType: "dollars", programCode: "CLASSES", programName: "Classes" }),
    ], new Date("2026-08-30T12:00:00.000Z"));

    expect(summaries.size).toBe(0);
  });

  it("does not let one overused program erase another program's remaining pace", () => {
    const summaries = summarizeAuthorizationPortfolio([
      authorization({ authorizedHours: "100", consumedHours: "150", remainingHours: "-50" }),
      authorization({
        authorizationId: "auth-2",
        budgetPeriodId: "period-2",
        programId: "program-2",
        programCode: "RESPITE",
        programName: "Respite",
        authorizedHours: "50",
        consumedHours: "0",
        remainingHours: "50",
      }),
    ], new Date("2026-08-30T12:00:00.000Z"));

    const budget = summaries.get("person-1")?.budget;
    expect(budget?.hoursLeft).toBe(0);
    expect(budget?.mustUseMonthly).not.toBeNull();
    expect(budget!.mustUseMonthly!).toBeGreaterThan(0);
  });

  it("subtracts pending schedule from the pace still needing to be planned", () => {
    const withoutSchedule = summarizeAuthorizationPortfolio([
      authorization({ scheduledHours: "0", remainingAfterScheduledHours: "60" }),
    ], new Date("2026-08-30T12:00:00.000Z")).get("person-1")!.budget;
    const withSchedule = summarizeAuthorizationPortfolio([
      authorization({ scheduledHours: "20", remainingAfterScheduledHours: "40" }),
    ], new Date("2026-08-30T12:00:00.000Z")).get("person-1")!.budget;

    expect(withSchedule).toMatchObject({
      scheduledHours: 20,
      hoursLeft: 60,
      hoursAfterScheduled: 40,
    });
    expect(withSchedule.mustUseMonthly!).toBeLessThan(withoutSchedule.mustUseMonthly!);
  });

  it("keeps the latest expired authorization visible and flags a missing renewal", () => {
    const summary = summarizeAuthorizationPortfolio([
      authorization({
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        renewalDate: null,
      }),
    ], new Date("2026-08-30T12:00:00.000Z")).get("person-1")!.budget;

    expect(summary).toMatchObject({
      renews: null,
      missingRenewal: true,
      expired: true,
    });
  });
});
