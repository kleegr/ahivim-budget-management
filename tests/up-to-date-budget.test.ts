import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildUpToDateBudgetPortfolio,
  matchesUpToDatePeriod,
  sumUpToDatePeriods,
} from "@/lib/business/up-to-date-budget";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import {
  budgetStatusViewHref,
  resolveBudgetStatusView,
} from "@/components/individuals/budget-status-view";

const sheetSource = readFileSync("src/components/individuals/up-to-date-budget-sheet.tsx", "utf8");
const workspaceSource = readFileSync("src/components/individuals/budget-status-workspace.tsx", "utf8");

function authorization(overrides: Partial<ProgramBudgetRecord> = {}): ProgramBudgetRecord {
  return {
    authorizationId: "auth-1",
    budgetPeriodId: "period-1",
    individualId: "person-1",
    individualName: "Ada Person",
    programId: "program-1",
    programCode: "COM_HAB",
    programName: "Community Habilitation",
    periodLabel: "Annual authorization",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    renewalDate: "2027-01-01",
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
    internalRate: "20",
    agencyRate: "25",
    individualRateOverride: null,
    notes: null,
    consumedHours: "40",
    consumedDollars: "1000",
    remainingHours: "60",
    remainingDollars: null,
    scheduledHours: "10",
    remainingAfterScheduledHours: "50",
    undatedUsageCount: 0,
    hasUndatedUsage: false,
    revision: 1,
    isExplicit: true,
    source: "explicit_authorization",
    sourceCandidateCount: 1,
    ...overrides,
  };
}

describe("Up To Date budget portfolio", () => {
  it("keeps program balances separate while deriving one authorization-period row", () => {
    const comHab = authorization({
      authorizedHours: "100",
      consumedHours: "150",
      remainingHours: "-50",
      remainingAfterScheduledHours: "-60",
    });
    const customProgram = authorization({
      authorizationId: "auth-2",
      programId: "program-custom",
      programCode: "CUSTOM_SUPPORT",
      programName: "Custom Support",
      authorizedHours: "50",
      consumedHours: "0",
      remainingHours: "50",
      scheduledHours: "0",
      remainingAfterScheduledHours: "50",
    });

    const portfolio = buildUpToDateBudgetPortfolio({
      current: [comHab, customProgram],
      // Re-reading the same explicit rows must not inflate the sheet.
      explicit: [comHab, customProgram],
      asOf: "2026-09-04",
    });

    expect(portfolio.programs.map((program) => program.code)).toEqual(["COM_HAB", "CUSTOM_SUPPORT"]);
    expect(portfolio.current).toHaveLength(1);
    expect(portfolio.current[0]).toMatchObject({
      individualId: "person-1",
      budgetPeriodId: "period-1",
      billedHours: "150.0000",
      originalHours: "150.0000",
      whatsLeftHours: "0.0000",
    });
    expect(portfolio.current[0]?.programs["program-1"]?.whatsLeftHours).toBe("-50");
    expect(portfolio.current[0]?.programs["program-custom"]?.whatsLeftHours).toBe("50");
  });

  it("does not collapse distinct renewal periods for the same individual", () => {
    const portfolio = buildUpToDateBudgetPortfolio({
      current: [
        authorization(),
        authorization({
          authorizationId: "auth-2",
          budgetPeriodId: "period-2",
          programId: "program-2",
          programCode: "RESPITE",
          programName: "Respite",
          periodLabel: "Respite year",
          startDate: "2026-04-01",
          endDate: "2027-03-31",
          renewalDate: "2027-04-01",
        }),
      ],
      explicit: [],
      asOf: "2026-09-04",
    });

    expect(portfolio.current).toHaveLength(2);
    expect(portfolio.current.map((row) => row.budgetPeriodId)).toEqual(["period-1", "period-2"]);
  });

  it("separates historical and upcoming periods and excludes dollar-only allowances", () => {
    const historical = authorization({
      authorizationId: "auth-history",
      budgetPeriodId: "period-history",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      renewalDate: "2026-01-01",
      periodStatus: "closed",
    });
    const upcoming = authorization({
      authorizationId: "auth-upcoming",
      budgetPeriodId: "period-upcoming",
      startDate: "2027-01-01",
      endDate: "2027-12-31",
      renewalDate: "2028-01-01",
    });
    const dollars = authorization({
      authorizationId: "auth-classes",
      budgetPeriodId: "period-classes",
      programId: "program-classes",
      programCode: "CLASSES",
      requiredAuthType: "dollars",
    });

    const portfolio = buildUpToDateBudgetPortfolio({
      current: [],
      explicit: [historical, upcoming, dollars],
      asOf: "2026-09-04",
    });

    expect(portfolio.historical.map((row) => row.budgetPeriodId)).toEqual(["period-history"]);
    expect(portfolio.upcoming.map((row) => row.budgetPeriodId)).toEqual(["period-upcoming"]);
    expect(portfolio.programs.some((program) => program.code === "CLASSES")).toBe(false);
  });

  it("filters exact programs, searches identity, and totals decimal values safely", () => {
    const portfolio = buildUpToDateBudgetPortfolio({
      current: [
        authorization({ consumedHours: "0.1", authorizedHours: "0.3", remainingHours: "0.2" }),
        authorization({
          authorizationId: "auth-2",
          individualId: "person-2",
          individualName: "Ben Person",
          budgetPeriodId: "period-2",
          consumedHours: "0.2",
          authorizedHours: "0.3",
          remainingHours: "0.1",
        }),
      ],
      explicit: [],
      asOf: "2026-09-04",
    });

    expect(matchesUpToDatePeriod(portfolio.current[0]!, "Ada", "program-1")).toBe(true);
    expect(matchesUpToDatePeriod(portfolio.current[0]!, "Ada", "program-other")).toBe(false);
    expect(sumUpToDatePeriods(portfolio.current)).toMatchObject({
      periods: 2,
      people: 2,
      billedHours: "0.3000",
      originalHours: "0.6000",
      whatsLeftHours: "0.3000",
    });
  });

  it("uses a stable sheet URL without discarding existing deep-link filters", () => {
    expect(resolveBudgetStatusView(undefined)).toBe("portfolio");
    expect(resolveBudgetStatusView("up_to_date")).toBe("up_to_date");
    expect(budgetStatusViewHref(
      "/individuals?view=billing_without_budget&budget=with#review",
      "up_to_date",
    )).toBe("/individuals?view=billing_without_budget&budget=with&sheet=up_to_date#review");
    expect(budgetStatusViewHref(
      "/individuals?view=billing_without_budget&sheet=up_to_date",
      "portfolio",
    )).toBe("/individuals?view=billing_without_budget");
  });

  it("renders the workbook-shaped columns, identity drill-through, and accessible history", () => {
    for (const label of ["Billed", "Original", "What&apos;s Left", "Historical authorization periods"]) {
      expect(sheetSource).toContain(label);
    }
    expect(sheetSource).toContain("individualBudgetHref(row.individualId)");
    expect(sheetSource).toContain('caption="Historical authorization balances by individual and program"');
    expect(sheetSource).toContain('className="sticky top-0 z-10"');
    expect(sheetSource).toContain('className="scroll-thin max-h-[70vh] overflow-auto"');
    expect(workspaceSource).toContain('aria-controls="budget-status-panel-up-to-date"');
    expect(workspaceSource).toContain('tabIndex={view === "up_to_date" ? 0 : -1}');
    expect(workspaceSource).toContain('selectView("up_to_date")');
  });
});
