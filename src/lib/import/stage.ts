import { dec, toMoney, closeEnough, type MoneyInput } from "@/lib/money";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { resolveProgram } from "@/lib/business/program-normalization";
import { matchPerson, type CanonicalRecord, type AliasRecord } from "@/lib/business/name-matching";
import {
  calculateInternalAmount,
  compareInternalAmounts,
} from "@/lib/business/internal-rate";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import {
  detectGroups,
  type GroupCandidateRow,
  type GroupDetectionResult,
} from "@/lib/business/group-allocation";
import {
  transactionFingerprint,
  transactionNaturalKey,
  type TransactionIdentity,
} from "@/lib/business/fingerprint";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";
import { canonicalServiceDate } from "@/lib/business/service-date";
import { agencyDate } from "@/lib/business/agency-time";

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

export interface EffectiveRateConfig extends RateConfig {
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function rateConfigAtDate(
  schedule: readonly EffectiveRateConfig[],
  asOf: string,
): RateConfig | undefined {
  const resolved = resolveEffectiveRate(schedule, asOf);
  if (!resolved) return undefined;
  return {
    agencyRate: resolved.agencyRate === null ? null : toMoney(resolved.agencyRate),
    internalRate: toMoney(resolved.internalRate),
  };
}

export interface StagingContext {
  /** Current rates retained for lightweight callers and older test fixtures. */
  ratesByProgram: Record<string, RateConfig>;
  /** Full production catalog, resolved separately for each row's service date. */
  rateSchedulesByProgram?: Readonly<Record<string, readonly EffectiveRateConfig[]>>;
  /** Rate-only fallback for source rows with no service-date facts. */
  rateFallbackDate?: string;
  /** Approved database aliases. Seed aliases remain the fallback for pure callers. */
  programAliases?: Readonly<Record<string, string>>;
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
  programCode: string | null;
  individualId: string | null;
  /** Canonical person id when known, otherwise the normalized source person. Used only for group safety. */
  groupIndividualKey?: string | null;
  employeeId: string | null;
  fingerprint: string | null;
  /** Fingerprint minus money/hours; stable per source identity. Exposed for the sheet-sync tracking layer. */
  naturalKey: string | null;
  duplicateStatus: "new" | "possible" | "confirmed";
  importedAmount: string;
  spreadsheetInternalAmount: string | null;
  calculatedInternalAmount: string | null;
  /** The effective-dated program rate used to calculate this source row. */
  internalRateApplied?: string | null;
  agencyRateApplied?: string | null;
  rateResolvedForDate?: string | null;
  internalAmountMismatch: boolean;
  errors: { field: string; message: string }[];
}

/**
 * Read the rate pinned by staging. An explicit null means the effective catalog
 * had no rate on that row's date and must not fall through to today's rate.
 * Undefined is reserved for older direct fixtures that predate the pinned fields.
 */
export function rateConfigForStagedRow(
  row: Pick<StagedRow, "internalRateApplied" | "agencyRateApplied">,
  legacyFallback?: RateConfig,
): RateConfig | undefined {
  if (row.internalRateApplied === undefined) return legacyFallback;
  if (row.internalRateApplied === null) return undefined;
  return {
    internalRate: row.internalRateApplied,
    agencyRate: row.agencyRateApplied ?? null,
  };
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
  /** Durable evidence that otherwise-valid group members were held as one atomic unit. */
  atomicGroupHolds?: AtomicGroupHold[];
}

export interface AtomicGroupHold {
  signature: string;
  sourceRowRefs: number[];
  heldSourceRowRefs: number[];
}

export function stagingGroupHasMultipleIndividuals(
  group: GroupDetectionResult,
  rows: readonly StagedRow[],
): boolean {
  const stagedByRow = new Map(rows.map((row) => [row.sourceRowNumber, row]));
  const individualKeys = group.sourceRowRefs.flatMap((sourceRowNumber) => {
    const row = stagedByRow.get(sourceRowNumber);
    if (!row) return [];
    // Prefer the canonical id so two approved aliases for one person remain a
    // singleton. The normalized source identity is retained for new people and
    // malformed rows that have not acquired a canonical id yet.
    if (row.groupIndividualKey) return [`person:${row.groupIndividualKey}`];
    if (row.individualId) return [`id:${row.individualId}`];
    return row.naturalKey ? [`natural:${row.naturalKey}`] : [];
  });
  return new Set(individualKeys).size > 1;
}

function recomputeReconciliationAfterAtomicHolds(
  staging: StagingResult,
  holds: readonly AtomicGroupHold[],
): void {
  if (holds.length === 0) return;

  const importedAgencyGross = staging.rows
    .filter((row) => row.status === "valid")
    .reduce((sum, row) => sum.plus(dec(row.importedAmount)), dec(0));
  const importedInternalAmount = staging.rows
    .filter((row) => row.status === "valid" && row.calculatedInternalAmount !== null)
    .reduce((sum, row) => sum.plus(dec(row.calculatedInternalAmount!)), dec(0));
  const workbookAgencyGross = staging.reconciliation.workbookAgencyGross;
  const workbookInternalAmount = staging.reconciliation.workbookInternalAmount;
  const agencyGrossMatches = workbookAgencyGross === null
    ? null
    : closeEnough(importedAgencyGross, workbookAgencyGross, "0.05");
  const internalAmountMatches = workbookInternalAmount === null
    ? null
    : closeEnough(importedInternalAmount, workbookInternalAmount, "0.05");
  const checked = [agencyGrossMatches, internalAmountMatches].filter(
    (matches): matches is boolean => matches !== null,
  );
  const heldSourceRows = [...new Set(holds.flatMap((hold) => hold.heldSourceRowRefs))]
    .sort((a, b) => a - b);

  staging.reconciliation.importedAgencyGross = toMoney(importedAgencyGross);
  staging.reconciliation.importedInternalAmount = toMoney(importedInternalAmount);
  staging.reconciliation.agencyGrossMatches = agencyGrossMatches;
  staging.reconciliation.internalAmountMatches = internalAmountMatches;
  staging.reconciliation.reconciled = checked.length > 0 && checked.every(Boolean);
  staging.reconciliation.note =
    `${heldSourceRows.length} otherwise-valid source row${heldSourceRows.length === 1 ? " was" : "s were"} ` +
    `held with an incomplete multi-person group (source row${heldSourceRows.length === 1 ? "" : "s"} ` +
    `${heldSourceRows.join(", ")}). The imported totals now include only rows that remain eligible ` +
    "to become transactions in this commit; held, invalid, and duplicate rows are excluded.";
}

/**
 * A multi-person service is one atomic unit. If only some members are eligible
 * to become transactions, hold the eligible members too; committing a subset
 * would create a session whose stated group size and allocations disagree with
 * the canonical ledger. Exact repeated rows for one individual are deliberately
 * excluded because they are source-occurrence evidence, not a multi-person group.
 */
export function holdPartialMultiPersonGroups(staging: StagingResult): AtomicGroupHold[] {
  const stagedByRow = new Map(staging.rows.map((row) => [row.sourceRowNumber, row]));
  const holds: AtomicGroupHold[] = [...(staging.atomicGroupHolds ?? [])];

  for (const group of staging.groups) {
    if (group.groupSize <= 1 || !stagingGroupHasMultipleIndividuals(group, staging.rows)) continue;
    const members = group.sourceRowRefs
      .map((sourceRowNumber) => stagedByRow.get(sourceRowNumber))
      .filter((row): row is StagedRow => row !== undefined);
    const eligible = members.filter((row) => row.status === "valid");
    if (eligible.length === 0 || eligible.length === members.length) continue;

    for (const row of eligible) row.status = "needs_review";
    const hold: AtomicGroupHold = {
      signature: group.signature,
      sourceRowRefs: [...group.sourceRowRefs].sort((a, b) => a - b),
      heldSourceRowRefs: eligible.map((row) => row.sourceRowNumber).sort((a, b) => a - b),
    };
    const existingHold = holds.find((candidate) => candidate.signature === hold.signature);
    if (existingHold) {
      existingHold.sourceRowRefs = [...new Set([
        ...existingHold.sourceRowRefs,
        ...hold.sourceRowRefs,
      ])].sort((a, b) => a - b);
      existingHold.heldSourceRowRefs = [...new Set([
        ...existingHold.heldSourceRowRefs,
        ...hold.heldSourceRowRefs,
      ])].sort((a, b) => a - b);
    } else {
      holds.push(hold);
    }
    const persistedHold = existingHold ?? hold;
    const existingWarning = staging.warnings.find((warning) =>
      warning.category === "group_needs_review"
      && warning.details?.reason === "partial_group_atomicity"
      && warning.details?.groupSignature === hold.signature
    );
    if (existingWarning) {
      existingWarning.sourceRowNumber = persistedHold.heldSourceRowRefs[0]
        ?? persistedHold.sourceRowRefs[0]
        ?? null;
      existingWarning.details = {
        ...existingWarning.details,
        sourceRows: persistedHold.sourceRowRefs,
        heldSourceRows: persistedHold.heldSourceRowRefs,
      };
    } else {
      staging.warnings.push({
        category: "group_needs_review",
        severity: "warning",
        sourceRowNumber: persistedHold.heldSourceRowRefs[0] ?? persistedHold.sourceRowRefs[0] ?? null,
        message:
          "This multi-person service includes both already-held or existing members and new importable members. " +
          "Every new member was held so the group cannot be partially committed.",
        details: {
          reason: "partial_group_atomicity",
          groupSignature: persistedHold.signature,
          sourceRows: persistedHold.sourceRowRefs,
          heldSourceRows: persistedHold.heldSourceRowRefs,
        },
      });
    }
  }

  staging.atomicGroupHolds = holds;
  if (holds.length > 0) {
    staging.counts.valid = staging.rows.filter((row) => row.status === "valid").length;
    staging.counts.needsReview = staging.rows.filter((row) => row.status === "needs_review").length;
    staging.counts.warningRows = new Set(
      staging.warnings
        .filter((warning) => warning.sourceRowNumber !== null)
        .map((warning) => warning.sourceRowNumber),
    ).size;
    const heldGroupSignatures = new Set(holds.map((hold) => hold.signature));
    staging.counts.groupsDetected = staging.groups.filter((group) =>
      group.status === "detected" && !heldGroupSignatures.has(group.signature),
    ).length;
    staging.counts.groupsNeedingReview = staging.groups.filter((group) =>
      group.status === "needs_review" || heldGroupSignatures.has(group.signature),
    ).length;
    recomputeReconciliationAfterAtomicHolds(staging, holds);
  }
  return holds;
}

function normalizedGroupNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const accounting = /^\((.*)\)$/.exec(trimmed);
  const normalized = (accounting ? `-${accounting[1]}` : trimmed)
    .replace(/[$,\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(normalized)) return null;
  try {
    return dec(normalized).toFixed(4);
  } catch {
    return null;
  }
}

function normalizedGroupDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed);
  if (match) {
    const [, month, day, rawYear] = match;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function provisionalInvalidGroupCandidate(
  row: ParsedAhivimRow,
  ctx: StagingContext,
): {
  candidate: GroupCandidateRow;
  individualId: string | null;
  employeeId: string | null;
  groupIndividualKey: string;
} | null {
  const hours = normalizedGroupNumber(row.raw.hours);
  const rate = normalizedGroupNumber(row.raw.rate);
  // Hours and rate are part of the structural group signature. If either is
  // unreadable, there is no defensible automatic relationship to another row.
  if (hours === null || rate === null) return null;

  const individual = matchPerson(row.raw.individual, ctx.individuals, ctx.individualAliases);
  const employee = row.raw.employee
    ? matchPerson(row.raw.employee, ctx.employees, ctx.employeeAliases)
    : null;
  const program = resolveProgram(row.raw.programDescription, ctx.programAliases);
  const groupIndividualKey = individual.matchedId
    ?? individual.normalizedName
    ?? `unresolved-row-${row.sourceRowNumber}`;

  return {
    candidate: {
      importRowId: `row-${row.sourceRowNumber}`,
      sourceRowNumber: row.sourceRowNumber,
      // A blank/otherwise unusable individual is still a distinct unresolved
      // member for safety; it must not disappear and let a sibling commit alone.
      individualKey: groupIndividualKey || `unresolved-row-${row.sourceRowNumber}`,
      employeeKey: employee?.matchedId ?? employee?.normalizedName ?? "",
      programKey: program.code ?? program.normalizedLabel,
      checkNumber: row.raw.checkNumber.trim() || null,
      checkDate: normalizedGroupDate(row.raw.checkDate),
      periodBegin: normalizedGroupDate(row.raw.periodBegin),
      periodEnd: normalizedGroupDate(row.raw.periodEnd),
      hours,
      rate,
      // Source amount is deliberately absent from the group signature and its
      // arithmetic. A placeholder lets an amount-only parse failure contribute
      // structural membership without treating the value as financial truth.
      amount: "0",
    },
    individualId: individual.matchedId,
    employeeId: employee?.matchedId ?? null,
    groupIndividualKey: groupIndividualKey || `unresolved-row-${row.sourceRowNumber}`,
  };
}

export interface StageRowsOptions {
  /**
   * A recurring Sheet is one durable source, so an exact fingerprint repeated
   * later in the same snapshot is evidence, not a second canonical transaction.
   * Ordinary workbook imports keep their preserve-and-warn behavior by default.
   */
  canonicalizeSourceDuplicates?: boolean;
}

export function stageRows(
  rows: ParsedAhivimRow[],
  ctx: StagingContext,
  options: StageRowsOptions = {},
): StagingResult {
  const warnings: StagedWarning[] = [];
  const staged: StagedRow[] = [];
  const groupCandidates: GroupCandidateRow[] = [];

  const unknownProgramLabels = new Set<string>();
  const unmatchedIndividualNames = new Set<string>();
  const unmatchedEmployeeNames = new Set<string>();

  // Fingerprints/keys seen EARLIER IN THIS FILE (starts empty). Kept separate from
  // ctx.knownFingerprints (already in the ledger from a PRIOR import): a row that
  // matches a prior commit is a re-import and is skipped, but a row identical to
  // an earlier line in the SAME file is a distinct source line the workbook counts
  // — it is imported and counted, only flagged.
  const fileFingerprints = new Set<string>();
  const firstSourceRowByFingerprint = new Map<string, number>();
  const fileNaturalKeys = new Set<string>();

  let agencyGross = dec(0);
  let internalTotal = dec(0);
  // Money on rows that are confirmed duplicates of already-committed
  // transactions. Kept separate so reconciliation can tell a benign re-import
  // (the workbook is already in the ledger) apart from a genuine shortfall
  // (rows held for review, or missing).
  let duplicateAgencyGross = dec(0);
  let duplicateInternalTotal = dec(0);
  let rateExceptionCount = 0;
  let ambiguousCount = 0;
  let sourceDuplicateCount = 0;

  for (const row of rows) {
    const rowWarnings: StagedWarning[] = [];

    if (!row.parsed) {
      const provisionalGroup = provisionalInvalidGroupCandidate(row, ctx);
      if (provisionalGroup) groupCandidates.push(provisionalGroup.candidate);
      staged.push({
        sourceRowNumber: row.sourceRowNumber,
        status: "invalid",
        programCode: null,
        individualId: provisionalGroup?.individualId ?? null,
        employeeId: provisionalGroup?.employeeId ?? null,
        groupIndividualKey: provisionalGroup?.groupIndividualKey ?? null,
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
      });
      continue;
    }

    const p = row.parsed;

    // --- program -----------------------------------------------------------
    const program = resolveProgram(p.programDescription, ctx.programAliases);
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
        // Not actionable at the row level — the row commits either way. The
        // Matches screen reconciles a possible duplicate at the person level.
        severity: "info",
        sourceRowNumber: row.sourceRowNumber,
        message: looksLikeSomeoneElse
          ? `Committed to a new record; possibly the same person as ${individual.suggestions[0]?.displayName ?? "an existing record"} — the Matches screen offers a one-click merge.`
          : `New individual; created on commit. ${individual.reason}`,
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
        // Employees never hold a row; a possible duplicate is an audit note only.
        severity: "info",
        sourceRowNumber: row.sourceRowNumber,
        message: looksLikeSomeoneElse
          ? `Committed to a new record; possibly the same worker as ${employee.suggestions[0]?.displayName ?? "an existing record"}.`
          : `New employee; created on commit. ${employee.reason}`,
        details: {
          suggestionCount: employee.suggestions.length,
          suggestions: employee.suggestions.map((s) => s.displayName),
        },
      });
    }

    // --- rates and internal amount ----------------------------------------
    const rateDate = canonicalServiceDate(p) ?? ctx.rateFallbackDate ?? agencyDate();
    const rateConfig = program.code
      ? ctx.rateSchedulesByProgram !== undefined
        ? rateConfigAtDate(ctx.rateSchedulesByProgram[program.code] ?? [], rateDate)
        : ctx.ratesByProgram[program.code]
      : undefined;

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
    // At this point a row has not been classified as single or group yet. Only
    // an exact configured per-person rate is accepted here. Confirmed and
    // suspected group rows are removed from this queue after group detection,
    // so a genuine single-person row at 3x the normal rate is not hidden.
    if (rateConfig && p.rate) {
      const onInternalRate = closeEnough(p.rate, rateConfig.internalRate, "0.005");
      const onAgencyRate =
        rateConfig.agencyRate !== null && closeEnough(p.rate, rateConfig.agencyRate, "0.005");

      const exception = evaluateRateException({
        importedRate: p.rate,
        expectedRate: rateConfig.internalRate,
        tolerance: onInternalRate || onAgencyRate ? "999999" : undefined,
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
    const fingerprint = transactionFingerprint(identity);
    const naturalKey = transactionNaturalKey(identity);
    const repeatedInSource = fileFingerprints.has(fingerprint);
    const sourceDuplicateHeld =
      options.canonicalizeSourceDuplicates === true && repeatedInSource;
    let dupStatus: "new" | "possible" | "confirmed";
    let dupReason: string;
    if (sourceDuplicateHeld) {
      sourceDuplicateCount++;
      dupStatus = "confirmed";
      dupReason =
        `Exact repeat of source row ${firstSourceRowByFingerprint.get(fingerprint) ?? "earlier"}. ` +
        "The source row is preserved as evidence but is not inserted as another canonical transaction.";
    } else if (ctx.knownFingerprints.has(fingerprint)) {
      // Already in the ledger from a prior import — a genuine re-import; skip it.
      dupStatus = "confirmed";
      dupReason = "An identical transaction is already in the ledger from a prior import.";
    } else if (repeatedInSource) {
      // Exact repeat of an earlier line in THIS file. The workbook lists it as its
      // own line and its own control totals count it, so it is a distinct, real
      // transaction: imported and counted, flagged only so an accidental double
      // entry can be caught — never silently dropped.
      dupStatus = "possible";
      dupReason =
        "Identical to an earlier row in the same file. Both are imported and counted — " +
        "confirm it is not an accidental double entry.";
    } else if (ctx.knownNaturalKeys.has(naturalKey) || fileNaturalKeys.has(naturalKey)) {
      // Same check, employee, individual, program and pay period as another row but
      // a different hours/rate/amount — usually a correction. Imported and flagged.
      dupStatus = "possible";
      dupReason =
        "Same check, employee, individual, program and pay period as another row, but a " +
        "different hours, rate or amount — likely a correction. Both are imported.";
    } else {
      dupStatus = "new";
      dupReason = "Not previously imported.";
    }
    if (dupStatus === "possible" || sourceDuplicateHeld) {
      rowWarnings.push({
        category: "possible_duplicate",
        severity: sourceDuplicateHeld ? "warning" : "info",
        sourceRowNumber: row.sourceRowNumber,
        message: dupReason,
        details: sourceDuplicateHeld
          ? {
              sourceDuplicate: true,
              fingerprint,
              firstSourceRowNumber: firstSourceRowByFingerprint.get(fingerprint) ?? null,
            }
          : undefined,
      });
    }
    fileFingerprints.add(fingerprint);
    if (!firstSourceRowByFingerprint.has(fingerprint)) {
      firstSourceRowByFingerprint.set(fingerprint, row.sourceRowNumber);
    }
    fileNaturalKeys.add(naturalKey);
    const duplicate = { status: dupStatus, fingerprint, naturalKey, reason: dupReason };

    // --- group candidate ---------------------------------------------------
    if (!sourceDuplicateHeld && (individual.matchedId || individual.normalizedName)) {
      groupCandidates.push({
        importRowId: `row-${row.sourceRowNumber}`,
        sourceRowNumber: row.sourceRowNumber,
        individualKey: individual.matchedId ?? individual.normalizedName,
        employeeKey: employee?.matchedId ?? employee?.normalizedName ?? "",
        programKey: program.code ?? program.normalizedLabel,
        checkNumber: p.checkNumber || null,
        checkDate: p.checkDate || null,
        periodBegin: p.periodBegin || null,
        periodEnd: p.periodEnd || null,
        hours: p.hours,
        rate: p.rate,
        amount: p.amount,
        expectedBaseRates: rateConfig
          ? [rateConfig.internalRate, ...(rateConfig.agencyRate ? [rateConfig.agencyRate] : [])]
          : [],
      });
    }

    // --- totals ------------------------------------------------------------
    const isCountable = duplicate.status !== "confirmed";
    if (isCountable) {
      agencyGross = agencyGross.plus(dec(p.amount));
      if (internal.internalAmount) internalTotal = internalTotal.plus(dec(internal.internalAmount));
    } else {
      duplicateAgencyGross = duplicateAgencyGross.plus(dec(p.amount));
      if (internal.internalAmount) {
        duplicateInternalTotal = duplicateInternalTotal.plus(dec(internal.internalAmount));
      }
    }

    // --- status ------------------------------------------------------------
    //
    // An unresolved NAME is not the same thing as an unknown name. On a first
    // import nobody is canonical yet, so requiring an exact match here would
    // send every single row to review and the database could never accept its
    // first workbook. What genuinely needs a person's decision is a name that
    // is ambiguous, blank, or close enough to an existing record to be a
    // misspelling of it — because merging or not merging changes the figures.
    // A row is HELD only when it genuinely cannot be attributed: an ambiguous
    // name (two canonical people share it — recorded as an error-severity warning
    // above), a blank individual, or an unknown program. A NEAR-MISS — a name
    // that merely resembles an existing record — is a real, countable
    // transaction. It is committed to its own record and the possible duplicate
    // is reconciled afterwards by the Matches scanner (every near-name pair
    // queues for an explicit human decision). Excluding these
    // understated every budget and total; the source sheet counts every row.
    const individualUnattributable = individual.normalizedName === "";

    let status: StagedRowStatus;
    if (duplicate.status === "confirmed") status = "duplicate";
    else if (rowWarnings.some((w) => w.severity === "error")) status = "needs_review";
    else if (!program.matched || individualUnattributable) status = "needs_review";
    else status = "valid";

    staged.push({
      sourceRowNumber: row.sourceRowNumber,
      status,
      programCode: program.code,
      individualId: individual.matchedId,
      employeeId: employee?.matchedId ?? null,
      groupIndividualKey: individual.matchedId ?? individual.normalizedName,
      fingerprint: duplicate.fingerprint,
      naturalKey: duplicate.naturalKey,
      duplicateStatus: duplicate.status,
      importedAmount: toMoney(p.amount),
      spreadsheetInternalAmount: comparison.spreadsheetValue,
      calculatedInternalAmount: internal.internalAmount,
      internalRateApplied: rateConfig?.internalRate ?? null,
      agencyRateApplied: rateConfig?.agencyRate ?? null,
      rateResolvedForDate: rateDate,
      internalAmountMismatch: !comparison.matches && Boolean(comparison.spreadsheetValue),
      errors: [],
    });

    warnings.push(...rowWarnings);
  }

  // --- groups --------------------------------------------------------------
  //
  // Each candidate carries only its own program's rate ladders. A rate from an
  // unrelated program must never make this group look valid.
  const groups = detectGroups(groupCandidates);
  const groupMemberRows = new Set(
    groups.filter((group) => group.groupSize > 1).flatMap((group) => group.sourceRowRefs),
  );
  const duplicateRows = new Set(
    staged
      .filter((row) => row.duplicateStatus === "confirmed")
      .map((row) => row.sourceRowNumber),
  );
  const retainedWarnings = warnings.filter((warning) =>
    warning.category !== "rate_exception"
    || warning.sourceRowNumber === null
    || (!groupMemberRows.has(warning.sourceRowNumber) && !duplicateRows.has(warning.sourceRowNumber)),
  );
  warnings.length = 0;
  warnings.push(...retainedWarnings);
  rateExceptionCount = warnings.filter((warning) => warning.category === "rate_exception").length;

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

  const checkedControls = [agencyGrossMatches, internalAmountMatches].filter(
    (matches): matches is boolean => matches !== null,
  );
  const noControlsChecked = checkedControls.length === 0;
  // Both workbook controls are optional. Reconciliation succeeds when at least
  // one was supplied and every supplied control agrees; an absent independent
  // control must not turn a valid comparison into a false failure.
  const reconciled = !noControlsChecked && checkedControls.every(Boolean);

  // A re-import (whole or partial) is not a reconciliation failure. When the
  // rows imported now, PLUS the rows skipped because they already exist in the
  // ledger, together match the workbook, the workbook is fully accounted for —
  // even though this batch may have written nothing. Only a shortfall that
  // duplicates do NOT explain (rows held for review, invalid, or genuinely
  // missing) is worth an "investigate".
  const confirmedDuplicateRows = staged.filter((r) => r.duplicateStatus === "confirmed").length;
  const ledgerAgency = agencyGross.plus(duplicateAgencyGross);
  const ledgerInternal = internalTotal.plus(duplicateInternalTotal);
  const agencyAccountedFor =
    wbGross === undefined || wbGross === null ? true : closeEnough(ledgerAgency, wbGross, "0.05");
  const internalAccountedFor =
    wbInternal === undefined || wbInternal === null
      ? true
      : closeEnough(ledgerInternal, wbInternal, "0.05");
  const explainedByDuplicates =
    !reconciled &&
    !noControlsChecked &&
    confirmedDuplicateRows > 0 &&
    agencyAccountedFor &&
    internalAccountedFor;

  const priorLedgerDuplicateRows = confirmedDuplicateRows - sourceDuplicateCount;
  const accountedForParts = [
    priorLedgerDuplicateRows > 0
      ? `${priorLedgerDuplicateRows} row${priorLedgerDuplicateRows === 1 ? "" : "s"} already represented in the ledger`
      : null,
    sourceDuplicateCount > 0
      ? `${sourceDuplicateCount} exact repeated source occurrence${sourceDuplicateCount === 1 ? "" : "s"} preserved as evidence`
      : null,
  ].filter((part): part is string => part !== null);

  const baseNote = noControlsChecked
    ? "No workbook control totals were supplied, so no reconciliation was performed. " +
      "Totals below are the application's own sums only."
    : reconciled
      ? checkedControls.length === 1
        ? "Application totals agree with the supplied workbook control total; the other control was not available."
        : "Application totals agree with the workbook control totals."
      : explainedByDuplicates
        ? `The workbook's control totals are fully accounted for: rows imported now plus ${accountedForParts.join(" and ")} ` +
          "together match the workbook. No duplicate transactions were inserted."
        : "Application totals DO NOT agree with the workbook control totals. Investigate before relying on this import.";
  const sourceDuplicateNote = sourceDuplicateCount > 0
    ? ` ${sourceDuplicateCount} exact repeated source occurrence${sourceDuplicateCount === 1 ? " was" : "s were"} ` +
      "preserved in the import evidence and excluded from the canonical transaction ledger."
    : "";
  const note = baseNote + sourceDuplicateNote;

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

  const result: StagingResult = {
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
  holdPartialMultiPersonGroups(result);
  return result;
}
