import { describe, expect, it } from "vitest";
import { detectGroup, type GroupCandidateRow } from "@/lib/business/group-allocation";
import {
  holdPartialMultiPersonGroups,
  stageRows,
  stagingGroupHasMultipleIndividuals,
  type StagingContext,
  type StagedRow,
  type StagingResult,
} from "@/lib/import/stage";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";

function candidate(individualKey: string, sourceRowNumber: number): GroupCandidateRow {
  return {
    importRowId: `row-${sourceRowNumber}`,
    sourceRowNumber,
    individualKey,
    employeeKey: "employee",
    programKey: "program",
    checkNumber: "100",
    checkDate: "2026-09-01",
    periodBegin: "2026-09-01",
    periodEnd: "2026-09-15",
    hours: "10",
    rate: "42",
    amount: "420",
  };
}

function staged(
  sourceRowNumber: number,
  naturalKey: string,
  status: StagedRow["status"],
): StagedRow {
  return {
    sourceRowNumber,
    status,
    programCode: "PROGRAM",
    individualId: null,
    employeeId: null,
    fingerprint: `fingerprint-${sourceRowNumber}`,
    naturalKey,
    duplicateStatus: status === "duplicate" ? "confirmed" : "new",
    importedAmount: "420.0000",
    spreadsheetInternalAmount: null,
    calculatedInternalAmount: "420.0000",
    internalRateApplied: "21.0000",
    agencyRateApplied: "42.0000",
    rateResolvedForDate: "2026-09-01",
    internalAmountMismatch: false,
    errors: [],
  };
}

function staging(rows: StagedRow[], candidates: GroupCandidateRow[]): StagingResult {
  return {
    totalSourceRows: rows.length,
    rows,
    warnings: [],
    groups: [detectGroup(candidates)],
    counts: {
      valid: rows.filter((row) => row.status === "valid").length,
      invalid: 0,
      needsReview: 0,
      duplicates: rows.filter((row) => row.status === "duplicate").length,
      confirmedDuplicates: rows.filter((row) => row.status === "duplicate").length,
      possibleDuplicates: 0,
      warningRows: 0,
      unknownPrograms: 0,
      unmatchedIndividuals: 0,
      unmatchedEmployees: 0,
      ambiguousNames: 0,
      rateExceptions: 0,
      groupsDetected: 0,
      groupsNeedingReview: 1,
    },
    reconciliation: {
      importedAgencyGross: "0.0000",
      importedInternalAmount: "0.0000",
      workbookAgencyGross: null,
      workbookInternalAmount: null,
      agencyGrossMatches: null,
      internalAmountMatches: null,
      reconciled: false,
      note: "test",
    },
    unknownProgramLabels: [],
    unmatchedIndividualNames: [],
    unmatchedEmployeeNames: [],
  };
}

const stagingContext: StagingContext = {
  ratesByProgram: { COM_HAB: { agencyRate: "25", internalRate: "21" } },
  individuals: [],
  individualAliases: [],
  employees: [],
  employeeAliases: [],
  knownFingerprints: new Set(),
  knownNaturalKeys: new Set(),
};

function parsedSource(
  sourceRowNumber: number,
  individual: string,
  amount: string,
  valid: boolean,
): ParsedAhivimRow {
  const raw = {
    payTo: "Excellent Staffing",
    checkDate: "09/01/2026",
    checkNumber: "GROUP-INVALID",
    code: "RG",
    hours: "10",
    rate: "42",
    amount,
    totalNetPay: "",
    periodBegin: "09/01/2026",
    periodEnd: "09/15/2026",
    programDescription: "Com Hab",
    individual,
    employee: "Group Worker",
    nonContractHeader: "",
    calculatedInternalAmount: "",
    dedupNetPayFormula: "",
    paid: "",
  };
  return {
    sourceRowNumber,
    raw,
    formulas: {},
    parsed: valid ? {
      ...raw,
      checkDate: "2026-09-01",
      periodBegin: "2026-09-01",
      periodEnd: "2026-09-15",
    } : null,
    errors: valid ? [] : [{ field: "amount", message: "Not a usable number" }],
  };
}

describe("atomic multi-person group holds", () => {
  it("holds the new B member in an A, A, B group even though not every row is distinct", () => {
    const candidates = [candidate("a", 1), candidate("a", 2), candidate("b", 3)];
    const result = staging([
      staged(1, "natural-a", "duplicate"),
      staged(2, "natural-a", "duplicate"),
      staged(3, "natural-b", "valid"),
    ], candidates);

    expect(result.groups[0]!.validation.distinctIndividuals).toBe(false);
    expect(stagingGroupHasMultipleIndividuals(result.groups[0]!, result.rows)).toBe(true);
    expect(holdPartialMultiPersonGroups(result)).toEqual([{
      signature: result.groups[0]!.signature,
      sourceRowRefs: [1, 2, 3],
      heldSourceRowRefs: [3],
    }]);
    expect(result.rows[2]!.status).toBe("needs_review");
    expect(result.warnings[0]?.details?.reason).toBe("partial_group_atomicity");
  });

  it("does not mistake exact repeated evidence for a multi-person group", () => {
    const candidates = [candidate("a", 1), candidate("a", 2)];
    const result = staging([
      staged(1, "natural-a", "duplicate"),
      staged(2, "natural-a", "valid"),
    ], candidates);

    expect(stagingGroupHasMultipleIndividuals(result.groups[0]!, result.rows)).toBe(false);
    expect(holdPartialMultiPersonGroups(result)).toEqual([]);
    expect(result.rows[1]!.status).toBe("valid");
  });

  it("preserves one exact A repeat as evidence while detecting the canonical A,B group", () => {
    const firstA = parsedSource(3, "Person A", "420", true);
    const repeatedA = parsedSource(4, "Person A", "420", true);
    const personB = parsedSource(5, "Person B", "420", true);
    const result = stageRows(
      [firstA, repeatedA, personB],
      stagingContext,
      { canonicalizeSourceDuplicates: true },
    );

    expect(result.rows.map((row) => row.status)).toEqual(["valid", "duplicate", "valid"]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      status: "detected",
      groupSize: 2,
      sourceRowRefs: [3, 5],
    });
    expect(result.atomicGroupHolds).toEqual([]);
  });

  it("does not mistake two approved source aliases for one canonical person as multi-person", () => {
    const first = staged(1, "alias-natural-a", "duplicate");
    const second = staged(2, "alias-natural-b", "valid");
    first.individualId = "canonical-person";
    second.individualId = "canonical-person";
    const result = staging(
      [first, second],
      [candidate("canonical-person", 1), candidate("canonical-person", 2)],
    );

    expect(stagingGroupHasMultipleIndividuals(result.groups[0]!, result.rows)).toBe(false);
    expect(holdPartialMultiPersonGroups(result)).toEqual([]);
    expect(result.rows[1]!.status).toBe("valid");
  });

  it("holds a valid sibling when an amount-only parse failure still proves group membership", () => {
    const result = stageRows([
      parsedSource(3, "Person A", "420", true),
      parsedSource(4, "Person B", "not-a-number", false),
    ], stagingContext);

    expect(result.rows.map((row) => row.status)).toEqual(["needs_review", "invalid"]);
    expect(result.atomicGroupHolds).toEqual([{
      signature: result.groups[0]!.signature,
      sourceRowRefs: [3, 4],
      heldSourceRowRefs: [3],
    }]);
    expect(result.reconciliation.importedAgencyGross).toBe("0.0000");
    expect(result.reconciliation.importedInternalAmount).toBe("0.0000");
    expect(result.counts).toMatchObject({ valid: 0, needsReview: 1, invalid: 1 });
    expect(result.warnings.some((warning) =>
      warning.category === "group_needs_review"
      && warning.details?.reason === "partial_group_atomicity"
      && warning.sourceRowNumber === 3
    )).toBe(true);

    // Commit and sync both invoke the defense-in-depth helper. Re-running it
    // must retain the durable hold without duplicating its warning or totals.
    expect(holdPartialMultiPersonGroups(result)).toEqual(result.atomicGroupHolds);
    expect(result.warnings.filter((warning) =>
      warning.details?.reason === "partial_group_atomicity"
    )).toHaveLength(1);
    expect(result.reconciliation.importedAgencyGross).toBe("0.0000");
  });
});
