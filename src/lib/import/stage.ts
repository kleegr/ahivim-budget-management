import { dec, toMoney, closeEnough, type MoneyInput } from "@/lib/money";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { resolveProgram, type ProgramCode } from "@/lib/business/program-normalization";
import { matchPerson, type CanonicalRecord, type AliasRecord } from "@/lib/business/name-matching";
import {
  calculateInternalAmount,
  compareInternalAmounts,
  isIntegerMultiple,
} from "@/lib/business/internal-rate";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import {
  detectGroups,
  type GroupCandidateRow,
  type GroupDetectionResult,
} from "@/lib/business/group-allocation";
import { classifyDuplicate, type TransactionIdentity } from "@/lib/business/fingerprint";

/**
 * STAGING
 * =======
 *
 * Everything below is read-only analysis. Nothing here writes to the database.
 * The user reviews the result and only then confirms a commit, which runs in a
 * single database transaction.
 *
 * No row is ever discarded. A row that cannot be resolved is staged with a
 * status that keeps it visible for review.
 */

export interface RateConfig {
  agencyRate: string | null;
  internalRate: string;
}

export interface StagingContext {
  ratesByProgram: Record<string, RateConfig>;
  individuals: readonly CanonicalRecord[];
  individualAliases: readonly AliasRecord[];
  employees: readonly CanonicalRecord[];
  employeeAliases: readonly AliasRecord[];
  knownFingerprints: ReadonlySet<string>;
  knownNaturalKeys: ReadonlySet<string>;
  /** Totals read from the workbook itself, for reconciliation. */
  workbookTotals?: { agencyGross?: MoneyInput; internalAmount?: MoneyInput };
}

export type StagedRowStatus = "valid" | "invalid" | "needs_review" | "duplicate";

export interface StagedWarning {
  category:
    | "unknown_program"
    | "unmatched_individual"
    | "unmatched_employee"
    | "ambiguous_name"
    | "rate_exception"
    | "internal_amount_mismatch"
    | "possible_duplicate"
    | "group_needs_review"
    | "unresolved_column";
  severity: "info" | "warning" | "error";
  sourceRowNumber: number | null;
  message: string;
  details?: Record<string, unknown>;
}

export interface StagedRow {
  sourceRowNumber: number;
  status: StagedRowStatus;
  programCode: ProgramCode | null;
  individualId: string | null;
  employeeId: string | null;
  fingerprint: string | null;
  duplicateStatus: "new" | "possible" | "confirmed";
  importedAmount: string;
  spreadsheetInternalAmount: string | null;
  calculatedInternalAmount: string | null;
  internalAmountMismatch: boolean;
  errors: { field: string; message: string }[];
}

export interface StagingResult {
  totalSourceRows: number;
  rows: StagedRow[];
  warnings: StagedWarning[];
  groups: GroupDetectionResult[];
  counts: {
    valid: number;
    invalid: number;
    needsReview: number;
    duplicates: number;
    confirmedDuplicates: number;
    possibleDuplicates: number;
    warningRows: number;
    unknownPrograms: number;
    unmatchedIndividuals: number;
    unmatchedEmployees: number;
    ambiguousNames: number;
    rateExceptions: number;
    groupsDetected: number;
    groupsNeedingReview: number;
  };
  reconciliation: {
    importedAgencyGross: string;
    importedInternalAmount: string;
    workbookAgencyGross: string | null;
    workbookInternalAmount: string | null;
    agencyGrossMatches: boolean | null;
    internalAmountMatches: boolean | null;
    /** True only when totals were actually compared and actually agreed. */
    reconciled: boolean;
    note: string;
  };
  unknownProgramLabels: string[];
  unmatchedIndividualNames: string[];
  unmatchedEmployeeNames: string[];
}

export function stageRows(rows: ParsedAhivimRow[], ctx: StagingContext): StagingResult {
  const warnings: StagedWarning[] = [];
  const staged: StagedRow[] = [];
  const groupCandidates: GroupCandidateRow[] = [];

  const unknownProgramLabels = new Set<string>();
  const unmatchedIndividualNames = new Set<string>();
  const unmatchedEmployeeNames = new Set<string>();

  // Fingerprints seen within THIS file, so a workbook that repeats a row
  // internally is caught too.
  const seenFingerprints = new Set<string>(ctx.knownFingerprints);
  const seenNaturalKeys = new Set<string>(ctx.knownNaturalKeys);

  let agencyGross = dec(0);
  let internalTotal = dec(0);
  let rateExceptionCount = 0;
  let ambiguousCount = 0;

  for (const row of rows) {
    const rowWarnings: StagedWarning[] = [];

    if (!row.parsed) {
      staged.push({
        sourceRowNumber: row.sourceRowNumber,
        status: "invalid",
        programCode: null,
        individualId: null,
        employeeId: null,
        fingerprint: null,
        duplicateStatus: "new",
        importedAmount: "0.0000",
        spreadsheetInternalAmount: null,
        calculatedInternalAmount: null,
        internalAmountMismatch: false,
        errors: row.errors,
      });
      continue;
    }

    const p = row.parsed;

    // --- program -----------------------------------------------------------
    const program = resolveProgram(p.programDescription);
    if (!program.matched) {
      unknownProgramLabels.add(p.programDescription);
      rowWarnings.push({
        category: "unknown_program",
        severity: "warning",
        sourceRowNumber: row.sourceRowNumber,
        message: `Unknown program description. ${program.reason}`,
        details: { normalizedLabel: program.normalizedLabel },
      });
    }

    // --- people ------------------------------------------------------------
    const individual = matchPerson(p.individual, ctx.individuals, ctx.individualAliases);
    if (individual.outcome === "ambiguous") {
      ambiguousCount++;
      rowWarnings.push({
        category: "ambiguous_name",
        severity: "error",
        sourceRowNumber: row.sourceRowNumber,
        message: `Individual name is ambiguous. ${individual.reason}`,
      });
    } else if (individual.outcome === "unmatched") {
      unmatchedIndividualNames.add(p.individual);
      // A name with NO similar existing record is simply someone new, and is
      // created on commit. A name that looks like an existing person might be
      // a misspelling of them, and merging or not merging changes the money —
      // so that, and only that, goes to a human.
      const looksLikeSomeoneElse = individual.suggestions.length > 0;
      rowWarnings.push({
        category: "unmatched_individual",
        severity: looksLikeSomeoneElse ? "warning" : "info",
        sourceRowNumber: row.sourceRowNumber,
        message: looksLikeSomeoneElse
          ? `Individual resembles an existing record and was not matched automatically. ${individual.reason}`
          : `New individual; will be created on commit. ${individual.reason}`,
        details: {
          suggestionCount: individual.suggestions.length,
          suggestions: individual.suggestions.map((s) => s.displayName),
        },
      });
    }

    const employee = p.employee
      ? matchPerson(p.employee, ctx.employees, ctx.employeeAliases)
      : null;
    if (employee && employee.outcome === "ambiguous") {
      ambiguousCount++;
      rowWarnings.push({
        category: "ambiguous_name",
        severity: "error",
        sourceRowNumber: row.sourceRowNumber,
        message: `Employee name is ambiguous. ${employee.reason}`,
      });
    } else if (employee && employee.outcome === "unmatched") {
      unmatchedEmployeeNames.add(p.employee);
      const looksLikeSomeoneElse = employee.suggestions.length > 0;
      rowWarnings.push({
        category: "unmatched_employee",
        severity: looksLikeSomeoneElse ? "warning" : "info",
        sourceRowNumber: row.sourceRowNumber,
        message: looksLikeSomeoneElse
          ? `Employee resembles an existing record and was not matched automatically. ${employee.reason}`
          : `New employee; will be created on commit. ${employee.reason}`,
        details: {
          suggestionCount: employee.suggestions.length,
          suggestions: employee.suggestions.map((s) => s.displayName),
        },
      });
    }

    // --- rates and internal amount ----------------------------------------
    const rateConfig = program.code ? ctx.ratesByProgram[program.code] : undefined;

    const internal = calculateInternalAmount({
      payTo: p.payTo,
      importedAmount: p.amount,
      agencyRate: rateConfig?.agencyRate ?? null,
      internalRate: rateConfig?.internalRate ?? null,
      hours: p.hours,
      rowRate: p.rate,
    });

    const comparison = compareInternalAmounts(
      p.calculatedInternalAmount || null,
      internal.internalAmount,
    );
    if (!comparison.matches && comparison.spreadsheetValue && comparison.applicationValue) {
      rowWarnings.push({
        category: "internal_amount_mismatch",
        severity: "warning",
        sourceRowNumber: row.sourceRowNumber,
        message:
          "The workbook's internal amount and the application's calculated internal amount " +
          "disagree. Both values were kept; neither was overwritten.",
        details: {
          spreadsheet: comparison.spreadsheetValue,
          application: comparison.applicationValue,
          difference: comparison.difference,
        },
      });
    }

    // --- rate exception ----------------------------------------------------
    //
    // A rate is legitimate when it is a whole-number multiple of either the
    // configured internal rate or the configured agency rate. The multiple is
    // the group size: Day Hab at $57 is three individuals at the $19 agency
    // rate, not an anomaly. Only rates that fit neither ladder are exceptions,
    // which is what isolates the genuine Self-Hire Respite variances.
    if (rateConfig && p.rate) {
      const onInternalLadder = isIntegerMultiple(p.rate, rateConfig.internalRate);
      const onAgencyLadder =
        rateConfig.agencyRate !== null && isIntegerMultiple(p.rate, rateConfig.agencyRate);

      const exception = evaluateRateException({
        importedRate: p.rate,
        expectedRate: rateConfig.internalRate,
        // Suppress the variance when the row sits on a recognised rate ladder.
        tolerance: onInternalLadder || onAgencyLadder ? "999999" : undefined,
      });
      if (exception.isException) {
        rateExceptionCount++;
        rowWarnings.push({
          category: "rate_exception",
          severity: "warning",
          sourceRowNumber: row.sourceRowNumber,
          message: exception.summary,
          details: {
            direction: exception.direction,
            varianceAmount: exception.varianceAmount,
            variancePercent: exception.variancePercent,
          },
        });
      }
    }

    // --- duplicates --------------------------------------------------------
    //
    // The identity keys on NORMALIZED NAMES, never on database ids. On a first
    // import nobody is canonical yet, so a matched id is null; on a second
    // import of the same workbook the same people now have ids. Keying on the
    // id would change the fingerprint between those two runs and let an
    // entire re-imported workbook through as new. The normalized name is
    // stable, so the fingerprint is too.
    const identity: TransactionIdentity = {
      checkNumber: p.checkNumber || null,
      checkDate: p.checkDate || null,
      employeeKey: employee?.normalizedName ?? null,
      individualKey: individual.normalizedName,
      programKey: program.code ?? program.normalizedLabel,
      periodBegin: p.periodBegin || null,
      periodEnd: p.periodEnd || null,
      hours: p.hours,
      rate: p.rate,
      amount: p.amount,
    };
    const duplicate = classifyDuplicate(identity, {
      fingerprints: seenFingerprints,
      naturalKeys: seenNaturalKeys,
    });
    if (duplicate.status === "possible") {
      rowWarnings.push({
        category: "possible_duplicate",
        severity: "warning",
        sourceRowNumber: row.sourceRowNumber,
        message: duplicate.reason,
      });
    }
    seenFingerprints.add(duplicate.fingerprint);
    seenNaturalKeys.add(duplicate.naturalKey);

    // --- group candidate ---------------------------------------------------
    if (individual.matchedId || individual.normalizedName) {
      groupCandidates.push({
        importRowId: `row-${row.sourceRowNumber}`,
        sourceRowNumber: row.sourceRowNumber,
        individualKey: individual.matchedId ?? individual.normalizedName,
        employeeKey: employee?.matchedId ?? employee?.normalizedName ?? "",
        programKey: program.code ?? program.normalizedLabel,
        checkNumber: p.checkNumber || null,
        periodBegin: p.periodBegin || null,
        periodEnd: p.periodEnd || null,
        hours: p.hours,
        rate: p.rate,
        amount: p.amount,
      });
    }

    // --- totals ------------------------------------------------------------
    const isCountable = duplicate.status !== "confirmed";
    if (isCountable) {
      agencyGross = agencyGross.plus(dec(p.amount));
      if (internal.internalAmount) internalTotal = internalTotal.plus(dec(internal.internalAmount));
    }

    // --- status ------------------------------------------------------------
    //
    // An unresolved NAME is not the same thing as an unknown name. On a first
    // import nobody is canonical yet, so requiring an exact match here would
    // send every single row to review and the database could never accept its
    // first workbook. What genuinely needs a person's decision is a name that
    // is ambiguous, blank, or close enough to an existing record to be a
    // misspelling of it — because merging or not merging changes the figures.
    const individualNeedsDecision =
      individual.outcome === "ambiguous" ||
      individual.normalizedName === "" ||
      (individual.outcome === "unmatched" && individual.suggestions.length > 0);
    const employeeNeedsDecision =
      employee !== null &&
      (employee.outcome === "ambiguous" ||
        (employee.outcome === "unmatched" && employee.suggestions.length > 0));

    let status: StagedRowStatus;
    if (duplicate.status === "confirmed") status = "duplicate";
    else if (rowWarnings.some((w) => w.severity === "error")) status = "needs_review";
    else if (!program.matched || individualNeedsDecision || employeeNeedsDecision)
      status = "needs_review";
    else status = "valid";

    staged.push({
      sourceRowNumber: row.sourceRowNumber,
      status,
      programCode: program.code,
      individualId: individual.matchedId,
      employeeId: employee?.matchedId ?? null,
      fingerprint: duplicate.fingerprint,
      duplicateStatus: duplicate.status,
      importedAmount: toMoney(p.amount),
      spreadsheetInternalAmount: comparison.spreadsheetValue,
      calculatedInternalAmount: internal.internalAmount,
      internalAmountMismatch: !comparison.matches && Boolean(comparison.spreadsheetValue),
      errors: [],
    });

    warnings.push(...rowWarnings);
  }

  // --- groups --------------------------------------------------------------
  //
  // Candidate rows are bucketed by composite signature. Both rate ladders are
  // offered as candidate bases because the workbook prices groups off the
  // internal rate on some rows and the agency rate on others.
  const allBases = new Set<string>();
  for (const cfg of Object.values(ctx.ratesByProgram)) {
    allBases.add(cfg.internalRate);
    if (cfg.agencyRate) allBases.add(cfg.agencyRate);
  }
  const groups = detectGroups(groupCandidates, { expectedBaseRates: [...allBases] });
  for (const g of groups) {
    if (g.status === "needs_review") {
      warnings.push({
        category: "group_needs_review",
        severity: "warning",
        sourceRowNumber: g.sourceRowRefs[0] ?? null,
        message: g.warningReason ?? "Group service could not be confirmed.",
        details: { groupSize: g.groupSize, sourceRows: g.sourceRowRefs, confidence: g.confidence },
      });
    }
  }

  // Calculations!S is preserved but carries no logic. Recorded once, as info.
  warnings.push({
    category: "unresolved_column",
    severity: "info",
    sourceRowNumber: null,
    message:
      "Calculations column S is preserved as raw text and intentionally carries no business " +
      "logic in this release. Documented as unresolved.",
  });

  // --- reconciliation ------------------------------------------------------
  const wbGross = ctx.workbookTotals?.agencyGross;
  const wbInternal = ctx.workbookTotals?.internalAmount;
  const agencyGrossMatches =
    wbGross === undefined || wbGross === null ? null : closeEnough(agencyGross, wbGross, "0.05");
  const internalAmountMatches =
    wbInternal === undefined || wbInternal === null
      ? null
      : closeEnough(internalTotal, wbInternal, "0.05");

  const reconciled = agencyGrossMatches === true && internalAmountMatches === true;
  const note =
    agencyGrossMatches === null && internalAmountMatches === null
      ? "No workbook control totals were supplied, so no reconciliation was performed. " +
        "Totals below are the application's own sums only."
      : reconciled
        ? "Application totals agree with the workbook control totals."
        : "Application totals DO NOT agree with the workbook control totals. Investigate before relying on this import.";

  const counts = {
    valid: staged.filter((r) => r.status === "valid").length,
    invalid: staged.filter((r) => r.status === "invalid").length,
    needsReview: staged.filter((r) => r.status === "needs_review").length,
    duplicates: staged.filter((r) => r.duplicateStatus !== "new").length,
    confirmedDuplicates: staged.filter((r) => r.duplicateStatus === "confirmed").length,
    possibleDuplicates: staged.filter((r) => r.duplicateStatus === "possible").length,
    warningRows: new Set(
      warnings.filter((w) => w.sourceRowNumber !== null).map((w) => w.sourceRowNumber),
    ).size,
    unknownPrograms: unknownProgramLabels.size,
    unmatchedIndividuals: unmatchedIndividualNames.size,
    unmatchedEmployees: unmatchedEmployeeNames.size,
    ambiguousNames: ambiguousCount,
    rateExceptions: rateExceptionCount,
    groupsDetected: groups.filter((g) => g.status === "detected").length,
    groupsNeedingReview: groups.filter((g) => g.status === "needs_review").length,
  };

  return {
    totalSourceRows: rows.length,
    rows: staged,
    warnings,
    groups,
    counts,
    reconciliation: {
      importedAgencyGross: toMoney(agencyGross),
      importedInternalAmount: toMoney(internalTotal),
      workbookAgencyGross: wbGross === undefined || wbGross === null ? null : toMoney(wbGross),
      workbookInternalAmount:
        wbInternal === undefined || wbInternal === null ? null : toMoney(wbInternal),
      agencyGrossMatches,
      internalAmountMatches,
      reconciled,
      note,
    },
    unknownProgramLabels: [...unknownProgramLabels],
    unmatchedIndividualNames: [...unmatchedIndividualNames],
    unmatchedEmployeeNames: [...unmatchedEmployeeNames],
  };
}
