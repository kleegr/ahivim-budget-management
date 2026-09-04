import { describe, expect, it } from "vitest";
import {
  transactionFingerprint,
  transactionNaturalKey,
  type TransactionIdentity,
} from "@/lib/business/fingerprint";
import { normalizePersonName } from "@/lib/business/name-matching";
import type {
  ParsedAhivimRow,
  WorkbookParseResult,
} from "@/lib/excel/parse-workbook";
import {
  classifyTransactionWorkbook,
  stagingForTransactionRecovery,
  type TransactionLedgerRow,
} from "@/lib/import/transaction-workbook";
import type { StagedRow, StagingResult } from "@/lib/import/stage";

const INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "20000000-0000-4000-8000-000000000002";

function parsedRow(
  sourceRowNumber: number,
  overrides: Partial<NonNullable<ParsedAhivimRow["parsed"]>> = {},
): ParsedAhivimRow {
  const parsed = {
    payTo: "Example Staffing",
    checkDate: "2026-08-07",
    checkNumber: `CHECK-${sourceRowNumber}`,
    code: "RG",
    hours: "10",
    rate: "19",
    amount: "190",
    totalNetPay: "190",
    periodBegin: "2026-07-16",
    periodEnd: "2026-07-31",
    programDescription: "Day Hab",
    individual: "Person, One",
    employee: "Employee, One",
    nonContractHeader: "",
    calculatedInternalAmount: "170",
    dedupNetPayFormula: "",
    paid: "",
    ...overrides,
  };
  return {
    sourceRowNumber,
    raw: { ...parsed },
    formulas: {},
    parsed,
    errors: [],
  };
}

function invalidRow(sourceRowNumber: number): ParsedAhivimRow {
  const row = parsedRow(sourceRowNumber);
  return {
    ...row,
    raw: { ...row.raw, amount: "$ (not money)" },
    parsed: null,
    errors: [{ field: "amount", message: "Not a usable number" }],
  };
}

function identity(row: ParsedAhivimRow): TransactionIdentity {
  const parsed = row.parsed!;
  return {
    checkNumber: parsed.checkNumber,
    checkDate: parsed.checkDate,
    employeeKey: normalizePersonName(parsed.employee),
    individualKey: normalizePersonName(parsed.individual),
    programKey: "DAY_HAB",
    periodBegin: parsed.periodBegin,
    periodEnd: parsed.periodEnd,
    hours: parsed.hours,
    rate: parsed.rate,
    amount: parsed.amount,
  };
}

function stagedRow(
  row: ParsedAhivimRow,
  overrides: Partial<StagedRow> = {},
): StagedRow {
  if (!row.parsed) {
    return {
      sourceRowNumber: row.sourceRowNumber,
      status: "invalid",
      programCode: null,
      individualId: null,
      employeeId: null,
      fingerprint: null,
      naturalKey: null,
      duplicateStatus: "new",
      importedAmount: "0.0000",
      spreadsheetInternalAmount: null,
      calculatedInternalAmount: null,
      internalRateApplied: null,
      agencyRateApplied: null,
      rateResolvedForDate: null,
      internalAmountMismatch: false,
      errors: row.errors,
      ...overrides,
    };
  }
  const tx = identity(row);
  return {
    sourceRowNumber: row.sourceRowNumber,
    status: "valid",
    programCode: "DAY_HAB",
    individualId: INDIVIDUAL_ID,
    employeeId: EMPLOYEE_ID,
    fingerprint: transactionFingerprint(tx),
    naturalKey: transactionNaturalKey(tx),
    duplicateStatus: "new",
    importedAmount: row.parsed.amount,
    spreadsheetInternalAmount: row.parsed.calculatedInternalAmount,
    calculatedInternalAmount: row.parsed.calculatedInternalAmount,
    internalRateApplied: "17.0000",
    agencyRateApplied: "19.0000",
    rateResolvedForDate: row.parsed.periodBegin,
    internalAmountMismatch: false,
    errors: [],
    ...overrides,
  };
}

function staging(rows: StagedRow[], groups: StagingResult["groups"] = []): StagingResult {
  return {
    totalSourceRows: rows.length,
    rows,
    warnings: [],
    groups,
    counts: {
      valid: rows.filter((row) => row.status === "valid").length,
      invalid: rows.filter((row) => row.status === "invalid").length,
      needsReview: rows.filter((row) => row.status === "needs_review").length,
      duplicates: rows.filter((row) => row.duplicateStatus !== "new").length,
      confirmedDuplicates: rows.filter((row) => row.duplicateStatus === "confirmed").length,
      possibleDuplicates: rows.filter((row) => row.duplicateStatus === "possible").length,
      warningRows: 0,
      unknownPrograms: 0,
      unmatchedIndividuals: 0,
      unmatchedEmployees: 0,
      ambiguousNames: 0,
      rateExceptions: 0,
      groupsDetected: groups.filter((group) => group.status === "detected").length,
      groupsNeedingReview: groups.filter((group) => group.status === "needs_review").length,
    },
    reconciliation: {
      importedAgencyGross: "0.0000",
      importedInternalAmount: "0.0000",
      workbookAgencyGross: null,
      workbookInternalAmount: null,
      agencyGrossMatches: null,
      internalAmountMatches: null,
      reconciled: false,
      note: "fixture",
    },
    unknownProgramLabels: [],
    unmatchedIndividualNames: [],
    unmatchedEmployeeNames: [],
  };
}

function ledgerRow(
  row: ParsedAhivimRow,
  overrides: Partial<TransactionLedgerRow> = {},
): TransactionLedgerRow {
  const tx = identity(row);
  return {
    id: `ledger-${row.sourceRowNumber}`,
    fingerprint: transactionFingerprint(tx),
    naturalKey: transactionNaturalKey(tx),
    checkNumber: tx.checkNumber,
    checkDate: tx.checkDate,
    periodBegin: tx.periodBegin,
    periodEnd: tx.periodEnd,
    individual: row.parsed!.individual,
    employee: row.parsed!.employee,
    program: "DAY_HAB",
    hours: String(tx.hours),
    rate: String(tx.rate),
    amount: String(tx.amount),
    sourceFileId: "source-file",
    sourceRowNumber: row.sourceRowNumber,
    syncReviewReason: null,
    ...overrides,
  };
}

function workbook(rows: ParsedAhivimRow[]): WorkbookParseResult {
  return {
    sheets: [],
    templateDetected: "ahivim_v1",
    mappingStrategy: "header",
    columnMap: {} as WorkbookParseResult["columnMap"],
    ahivimRows: rows,
    controlTotals: {
      internalAmount: null,
      agencyGross: null,
      agencyRetention: null,
      deduplicatedNetPay: null,
    },
    calculationsRaw: [],
    warnings: [],
  };
}

describe("transaction workbook reconciliation", () => {
  it("separates exact, missing, changed, invalid, and historical rows without mutating history", () => {
    const exact = parsedRow(3);
    const missing = parsedRow(4);
    const changed = parsedRow(5, { checkNumber: "CHANGED", amount: "200" });
    const invalid = invalidRow(6);
    const oldVersion = parsedRow(50, { checkNumber: "CHANGED", amount: "190" });
    const historical = parsedRow(99, { checkNumber: "HISTORICAL" });
    const staged = staging([
      stagedRow(exact, { duplicateStatus: "confirmed", status: "duplicate" }),
      stagedRow(missing),
      stagedRow(changed, { duplicateStatus: "possible" }),
      stagedRow(invalid),
    ]);

    const result = classifyTransactionWorkbook(
      [exact, missing, changed, invalid],
      staged,
      [ledgerRow(exact), ledgerRow(oldVersion), ledgerRow(historical)],
    );

    expect(result.summary).toMatchObject({
      exact: 1,
      missingNew: 1,
      differentNaturalKey: 1,
      ambiguousReview: 1,
      duplicateSourceOccurrences: 0,
      historical: 1,
      applicable: 1,
    });
    expect(result.assessments.map((row) => row.classification)).toEqual([
      "exact",
      "missing_new",
      "different_natural_key",
      "ambiguous_review",
    ]);
    expect(result.historical).toHaveLength(1);
    expect(result.historical[0]!.transactionId).toBe("ledger-99");
    expect(result.historical[0]!.reason).toMatch(/never deleted/i);
  });

  it("groups exact source repeats by fingerprint and holds every extra occurrence", () => {
    const first = parsedRow(3, { checkNumber: "REPEAT" });
    const repeated = parsedRow(42, { checkNumber: "REPEAT" });
    const firstStaged = stagedRow(first);
    const source = staging([
      firstStaged,
      stagedRow(repeated, {
        fingerprint: firstStaged.fingerprint,
        naturalKey: firstStaged.naturalKey,
        duplicateStatus: "possible",
      }),
    ]);

    const result = classifyTransactionWorkbook([first, repeated], source, []);

    expect(result.assessments.map((row) => row.classification)).toEqual([
      "missing_new",
      "duplicate_source_occurrence",
    ]);
    expect(result.assessments.map((row) => row.canApply)).toEqual([true, false]);
    expect(result.duplicateSourceGroups).toEqual([{
      fingerprint: firstStaged.fingerprint,
      occurrenceCount: 2,
      sourceRows: [3, 42],
    }]);
    expect(result.summary.duplicateSourceOccurrences).toBe(1);
    expect(result.summary.uniqueSourceFingerprints).toBe(1);
  });

  it("holds the operational Denied Billing label and preserves its accounting-negative raw value", () => {
    const denied = parsedRow(1555, {
      employee: "Denied Billing",
      hours: "-31.25",
      amount: "-625.00",
      calculatedInternalAmount: "-531.25",
    });
    denied.raw.amount = "$ (625.00)";
    const deniedStaged = stagedRow(denied, { employeeId: null });
    const base = staging([deniedStaged]);
    const classified = classifyTransactionWorkbook([denied], base, []);

    expect(classified.assessments[0]).toMatchObject({
      classification: "ambiguous_review",
      canApply: false,
      identity: { amount: "-625.00", rawAmount: "$ (625.00)", employee: "Denied Billing" },
    });
    expect(classified.assessments[0]!.reasons.join(" ")).toMatch(/operational label/i);

    const safe = stagingForTransactionRecovery(workbook([denied]), base, classified);
    expect(safe.rows[0]!.status).toBe("needs_review");
    expect(safe.counts.valid).toBe(0);
    expect(safe.counts.needsReview).toBe(1);
    expect(safe.warnings.some((warning) => warning.severity === "error")).toBe(true);
  });

  it("holds a partial group instead of creating a second, incomplete service session", () => {
    const existing = parsedRow(3, { checkNumber: "GROUP", individual: "Person, One" });
    const missing = parsedRow(4, { checkNumber: "GROUP", individual: "Person, Two" });
    const existingStaged = stagedRow(existing, { status: "duplicate", duplicateStatus: "confirmed" });
    const missingStaged = stagedRow(missing);
    const group: StagingResult["groups"][number] = {
      signature: "group-signature",
      status: "detected",
      detectionRule: "fixture",
      groupSize: 2,
      physicalHours: "10.0000",
      combinedRate: "19.0000",
      combinedAmount: "190.0000",
      baseIndividualRate: "9.5000",
      confidence: "1.0000",
      validation: {
        distinctIndividuals: true,
        hoursMatch: true,
        employeeMatches: true,
        programMatches: true,
        combinedRateReconciles: true,
        amountDividesEqually: true,
      },
      warningReason: null,
      allocations: [],
      sourceRowRefs: [3, 4],
    };
    const result = classifyTransactionWorkbook(
      [existing, missing],
      staging([existingStaged, missingStaged], [group]),
      [ledgerRow(existing)],
    );

    expect(result.assessments[0]!.classification).toBe("exact");
    expect(result.assessments[1]!.classification).toBe("ambiguous_review");
    expect(result.assessments[1]!.canApply).toBe(false);
    expect(result.assessments[1]!.reasons.join(" ")).toMatch(/partial group/i);
  });

  it("counts exact ledger matches as accounted without making them insertable", () => {
    const exact = parsedRow(3);
    const missing = parsedRow(4);
    const changed = parsedRow(5, { checkNumber: "CHANGED", amount: "200" });
    const prior = parsedRow(50, { checkNumber: "CHANGED", amount: "190" });
    const base = staging([
      stagedRow(exact, { status: "duplicate", duplicateStatus: "confirmed" }),
      stagedRow(missing),
      stagedRow(changed, { duplicateStatus: "possible" }),
    ]);
    const parsed = workbook([exact, missing, changed]);
    parsed.controlTotals.agencyGross = "380";
    parsed.controlTotals.internalAmount = "340";
    const classified = classifyTransactionWorkbook(
      parsed.ahivimRows,
      base,
      [ledgerRow(exact), ledgerRow(prior)],
    );

    const recovery = stagingForTransactionRecovery(parsed, base, classified);

    expect(recovery.rows.map((row) => row.status)).toEqual([
      "duplicate",
      "valid",
      "needs_review",
    ]);
    expect(recovery.reconciliation).toMatchObject({
      importedAgencyGross: "380.0000",
      importedInternalAmount: "340.0000",
      agencyGrossMatches: true,
      internalAmountMatches: true,
      reconciled: true,
    });
    expect(classified.summary).toMatchObject({ exact: 1, missingNew: 1, applicable: 1 });
  });
});
