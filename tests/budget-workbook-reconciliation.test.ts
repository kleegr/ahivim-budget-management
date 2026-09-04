import { describe, expect, it } from "vitest";
import type {
  BudgetWorkbookParseResult,
  ParsedBudgetAuthorization,
  ParsedBudgetRow,
} from "@/lib/excel/parse-budget-workbook";
import {
  classifyBudgetWorkbook,
  type BudgetReconciliationContext,
} from "@/lib/import/budget-workbook";

const PERSON_ID = "10000000-0000-4000-8000-000000000001";
const COM_HAB_ID = "20000000-0000-4000-8000-000000000002";
const DAY_HAB_ID = "30000000-0000-4000-8000-000000000003";
const PERIOD_ID = "40000000-0000-4000-8000-000000000004";
const AUTH_ID = "50000000-0000-4000-8000-000000000005";

function sourceAuthorization(args: {
  programCode?: "COM_HAB" | "DAY_HAB" | "RESPITE";
  authorizedHours?: string | null;
  billedComparisonHours?: string | null;
  issues?: Array<{ code: string; message: string }>;
} = {}): ParsedBudgetAuthorization {
  const programCode = args.programCode ?? "COM_HAB";
  const cells = programCode === "COM_HAB"
    ? { source: "D3", billed: "C3", name: "Com Hab" }
    : programCode === "DAY_HAB"
      ? { source: "P3", billed: "O3", name: "Day Hab" }
      : { source: "G3", billed: "F3", name: "Respite" };
  const billed = args.billedComparisonHours ?? null;
  const authorized = args.authorizedHours === undefined ? "416.0000" : args.authorizedHours;
  return {
    programCode,
    programLabel: cells.name,
    sourceCell: cells.source,
    billedComparisonCell: cells.billed,
    authorizedHours: authorized,
    billedComparisonHours: billed,
    billingWithoutBudget: authorized === null && billed !== null && billed !== "0",
    originalWasFormula: false,
    issues: args.issues ?? [],
  };
}

function sourceRow(overrides: Partial<ParsedBudgetRow> = {}): ParsedBudgetRow {
  return {
    sourceRowNumber: 3,
    sourceRowHidden: false,
    sourceIndividualLabel: "Person, One",
    normalizedIndividualLabel: "one person",
    renewalDate: "2027-01-01",
    periodStartDate: "2026-01-01",
    periodEndDate: "2026-12-31",
    sourceKey: "one person|2027-01-01",
    authorizations: [sourceAuthorization()],
    issues: [],
    ...overrides,
  };
}

function parsed(rows: ParsedBudgetRow[], layoutValid = true): BudgetWorkbookParseResult {
  return {
    sourceFileName: "Budget source.xlsx",
    checksumSha256: "a".repeat(64),
    sourceSheetName: "UpToDate",
    sourceRange: "UpToDate!A3:S40",
    layoutValid,
    rows,
    warnings: layoutValid ? [] : ["layout changed"],
    summary: {
      sourceRows: rows.length,
      distinctNormalizedPeople: new Set(rows.map((row) => row.normalizedIndividualLabel)).size,
      distinctSourceKeys: new Set(rows.map((row) => row.sourceKey)).size,
      sourceAuthorizations: rows.flatMap((row) => row.authorizations)
        .filter((authorization) => authorization.authorizedHours !== null).length,
      billingWithoutBudget: rows.flatMap((row) => row.authorizations)
        .filter((authorization) => authorization.billingWithoutBudget).length,
      hiddenRows: rows.filter((row) => row.sourceRowHidden).map((row) => row.sourceRowNumber),
    },
  };
}

function context(overrides: Partial<BudgetReconciliationContext> = {}): BudgetReconciliationContext {
  return {
    individuals: [{
      id: PERSON_ID,
      normalizedName: "one person",
      displayName: "Person One",
      status: "active",
      archivedAt: null,
      mergedIntoId: null,
    }],
    individualAliases: [],
    programs: [
      {
        id: COM_HAB_ID,
        code: "COM_HAB",
        name: "Com Hab",
        requiredAuthType: "hours",
        isActive: true,
        archivedAt: null,
      },
      {
        id: DAY_HAB_ID,
        code: "DAY_HAB",
        name: "Day Hab",
        requiredAuthType: "hours",
        isActive: true,
        archivedAt: null,
      },
    ],
    rates: [
      {
        programId: COM_HAB_ID,
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
        internalRate: "21.0000",
        agencyRate: "25.0000",
        archivedAt: null,
      },
      {
        programId: DAY_HAB_ID,
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
        internalRate: "17.0000",
        agencyRate: "19.0000",
        archivedAt: null,
      },
    ],
    periods: [],
    authorizations: [],
    ...overrides,
  };
}

function exactPeriod() {
  return {
    id: PERIOD_ID,
    individualId: PERSON_ID,
    label: "2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    renewalDate: "2027-01-01",
    periodType: "rolling",
    status: "active",
    source: "manual",
    archivedAt: null,
  };
}

describe("Budget workbook reconciliation classifier", () => {
  it("classifies unequivocally absent periods and authorizations as applyable missing records", () => {
    const result = classifyBudgetWorkbook(parsed([sourceRow()]), context(), "2026-09-04");
    expect(result.rows[0]?.period).toMatchObject({ state: "missing", canApply: true });
    expect(result.rows[0]?.authorizations[0]).toMatchObject({
      state: "missing",
      sourceAuthorizedHours: "416.0000",
      canApply: true,
    });
    expect(result.summary).toMatchObject({ applicablePeriods: 1, applicableAuthorizations: 1 });
  });

  it("reports exact hours, refuses different values, and never overwrites", () => {
    const base = context({
      periods: [exactPeriod()],
      authorizations: [{
        id: AUTH_ID,
        budgetPeriodId: PERIOD_ID,
        individualId: PERSON_ID,
        programId: COM_HAB_ID,
        authorizedHours: "416.0000",
        status: "active",
        source: "manual",
        sourceRowRef: null,
        archivedAt: null,
      }],
    });
    const exact = classifyBudgetWorkbook(parsed([sourceRow()]), base, "2026-09-04");
    expect(exact.rows[0]?.period.state).toBe("exact");
    expect(exact.rows[0]?.authorizations[0]).toMatchObject({ state: "exact", canApply: false });

    const different = classifyBudgetWorkbook(
      parsed([sourceRow({ authorizations: [sourceAuthorization({ authorizedHours: "520.0000" })] })]),
      base,
      "2026-09-04",
    );
    expect(different.rows[0]?.authorizations[0]).toMatchObject({
      state: "different",
      canApply: false,
      classifications: ["different", "needs_owner_review"],
    });
  });

  it("keeps overlapping periods valid for different programs but blocks overlapping same-program truth", () => {
    const overlappingPeriod = {
      ...exactPeriod(),
      startDate: "2026-03-01",
      endDate: "2027-02-28",
      renewalDate: "2027-03-01",
    };
    const source = sourceRow({
      renewalDate: "2027-01-01",
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-12-31",
      authorizations: [sourceAuthorization({ programCode: "COM_HAB" })],
    });
    const differentProgram = classifyBudgetWorkbook(parsed([source]), context({
      periods: [overlappingPeriod],
      authorizations: [{
        id: AUTH_ID,
        budgetPeriodId: PERIOD_ID,
        individualId: PERSON_ID,
        programId: DAY_HAB_ID,
        authorizedHours: "1075.0000",
        status: "active",
        source: "manual",
        sourceRowRef: null,
        archivedAt: null,
      }],
    }), "2026-09-04");
    expect(differentProgram.rows[0]?.period.state).toBe("missing");
    expect(differentProgram.rows[0]?.authorizations[0]).toMatchObject({ state: "missing", canApply: true });

    const sameProgram = classifyBudgetWorkbook(parsed([source]), context({
      periods: [overlappingPeriod],
      authorizations: [{
        id: AUTH_ID,
        budgetPeriodId: PERIOD_ID,
        individualId: PERSON_ID,
        programId: COM_HAB_ID,
        authorizedHours: "416.0000",
        status: "active",
        source: "manual",
        sourceRowRef: null,
        archivedAt: null,
      }],
    }), "2026-09-04");
    expect(sameProgram.rows[0]?.period.state).toBe("missing");
    expect(sameProgram.rows[0]?.authorizations[0]).toMatchObject({ state: "different", canApply: false });
  });

  it("does not treat an authorization on another overlapping period as truth for a blank Original cell", () => {
    const overlappingPeriod = {
      ...exactPeriod(),
      id: "40000000-0000-4000-8000-000000000099",
      startDate: "2026-03-01",
      endDate: "2027-02-28",
      renewalDate: "2027-03-01",
    };
    const blankDayHab = sourceAuthorization({ programCode: "DAY_HAB", authorizedHours: null });
    const overlappingDayHab = {
      id: "50000000-0000-4000-8000-000000000099",
      budgetPeriodId: overlappingPeriod.id,
      individualId: PERSON_ID,
      programId: DAY_HAB_ID,
      authorizedHours: "1075.0000",
      status: "active",
      source: "budget_workbook",
      sourceRowRef: "Budget source.xlsx#UpToDate!P4",
      archivedAt: null,
    };

    const otherPeriodOnly = classifyBudgetWorkbook(
      parsed([sourceRow({ authorizations: [blankDayHab] })]),
      context({
        periods: [exactPeriod(), overlappingPeriod],
        authorizations: [overlappingDayHab],
      }),
      "2026-09-04",
    );
    expect(otherPeriodOnly.rows[0]?.period.state).toBe("exact");
    expect(otherPeriodOnly.rows[0]?.authorizations).toEqual([]);
    expect(otherPeriodOnly.summary.authorizationClassifications.different).toBe(0);

    const exactPeriodAuthorization = classifyBudgetWorkbook(
      parsed([sourceRow({ authorizations: [blankDayHab] })]),
      context({
        periods: [exactPeriod(), overlappingPeriod],
        authorizations: [{ ...overlappingDayHab, budgetPeriodId: PERIOD_ID }],
      }),
      "2026-09-04",
    );
    expect(exactPeriodAuthorization.rows[0]?.authorizations[0]).toMatchObject({
      state: "different",
      canApply: false,
    });
  });

  it("surfaces historical, hidden, duplicate, ambiguous, and billing-without-budget cases", () => {
    const billing = sourceAuthorization({
      programCode: "RESPITE",
      authorizedHours: null,
      billedComparisonHours: "35.91",
    });
    const first = sourceRow({
      renewalDate: "2026-09-01",
      periodStartDate: "2025-09-01",
      periodEndDate: "2026-08-31",
      sourceKey: "one person|2026-09-01",
      authorizations: [sourceAuthorization(), billing],
    });
    const duplicate = { ...first, sourceRowNumber: 4 };
    const duplicateResult = classifyBudgetWorkbook(parsed([first, duplicate]), context(), "2026-09-04");
    expect(duplicateResult.rows[0]?.period.classifications).toEqual([
      "duplicate_source_label_or_key",
      "historical",
      "needs_owner_review",
    ]);
    expect(duplicateResult.rows[0]?.authorizations.find((authorization) => authorization.programCode === "RESPITE")?.classifications)
      .toContain("billing_without_budget");

    const hiddenResult = classifyBudgetWorkbook(
      parsed([sourceRow({ sourceRowHidden: true })]),
      context(),
      "2026-09-04",
    );
    expect(hiddenResult.rows[0]?.period).toMatchObject({ state: "missing", canApply: true });
    expect(hiddenResult.rows[0]?.period.reasons).toContain(
      "The hidden source row was included; hiding a worksheet row does not remove its data.",
    );

    const ambiguousResult = classifyBudgetWorkbook(parsed([sourceRow()]), context({ individuals: [] }), "2026-09-04");
    expect(ambiguousResult.rows[0]?.period).toMatchObject({ state: "ambiguous_identity", canApply: false });
  });

  it("allows historical rows for inactive people but blocks merged and non-historical inactive identities", () => {
    const historical = sourceRow({
      sourceRowHidden: true,
      renewalDate: "2026-09-01",
      periodStartDate: "2025-09-01",
      periodEndDate: "2026-08-31",
      sourceKey: "one person|2026-09-01",
    });
    const archivedPerson = {
      ...context().individuals[0]!,
      status: "archived",
      archivedAt: "2026-09-01T00:00:00.000Z",
    };
    const historicalResult = classifyBudgetWorkbook(
      parsed([historical]),
      context({ individuals: [archivedPerson] }),
      "2026-09-04",
    );
    expect(historicalResult.rows[0]?.period).toMatchObject({
      state: "missing",
      canApply: true,
      classifications: ["missing", "historical"],
    });
    expect(historicalResult.rows[0]?.authorizations[0]).toMatchObject({ state: "missing", canApply: true });

    const inactiveHistoricalResult = classifyBudgetWorkbook(
      parsed([historical]),
      context({
        individuals: [{
          ...archivedPerson,
          status: "inactive",
          archivedAt: null,
        }],
      }),
      "2026-09-04",
    );
    expect(inactiveHistoricalResult.rows[0]?.period).toMatchObject({ state: "missing", canApply: true });
    expect(inactiveHistoricalResult.rows[0]?.authorizations[0]).toMatchObject({ state: "missing", canApply: true });

    const endingToday = sourceRow({
      renewalDate: "2026-09-05",
      periodStartDate: "2025-09-05",
      periodEndDate: "2026-09-04",
      sourceKey: "one person|2026-09-05",
    });
    for (const inactivePerson of [
      archivedPerson,
      { ...archivedPerson, status: "inactive", archivedAt: null },
      { ...archivedPerson, status: "discharged", archivedAt: null },
      { ...archivedPerson, status: "active", archivedAt: "2026-09-01T00:00:00.000Z" },
    ]) {
      for (const nonHistorical of [endingToday, sourceRow()]) {
        const result = classifyBudgetWorkbook(
          parsed([nonHistorical]),
          context({ individuals: [inactivePerson] }),
          "2026-09-04",
        );
        expect(result.rows[0]?.period).toMatchObject({ state: "needs_owner_review", canApply: false });
        expect(result.rows[0]?.authorizations[0]).toMatchObject({
          state: "needs_owner_review",
          canApply: false,
        });
        expect(result.summary.applicableAuthorizations).toBe(0);
      }
    }

    for (const source of [historical, endingToday, sourceRow()]) {
      const mergedResult = classifyBudgetWorkbook(
        parsed([source]),
        context({
          individuals: [{
            ...archivedPerson,
            mergedIntoId: "60000000-0000-4000-8000-000000000006",
          }],
        }),
        "2026-09-04",
      );
      expect(mergedResult.rows[0]?.period).toMatchObject({ state: "needs_owner_review", canApply: false });
      expect(mergedResult.rows[0]?.authorizations[0]).toMatchObject({
        state: "needs_owner_review",
        canApply: false,
      });
      expect(mergedResult.summary.applicableAuthorizations).toBe(0);
    }
  });
});
