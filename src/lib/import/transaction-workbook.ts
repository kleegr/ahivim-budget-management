import { canonicalServiceDate } from "@/lib/business/service-date";
import {
  transactionNaturalKey,
  type TransactionIdentity,
} from "@/lib/business/fingerprint";
import { normalizePersonName } from "@/lib/business/name-matching";
import { normalizeProgramLabel } from "@/lib/business/program-normalization";
import { currentRatesByProgram } from "@/lib/data/queries";
import type {
  ParsedAhivimRow,
  WorkbookParseResult,
} from "@/lib/excel/parse-workbook";
import {
  commitStagedImport,
  type CommitResult,
  type PgLikePool,
} from "@/lib/import/commit";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import type {
  StagedRow,
  StagedWarning,
  StagingResult,
} from "@/lib/import/stage";
import { closeEnough, dec, toMoney } from "@/lib/money";

/**
 * Conservative recovery for an Ahivim transaction workbook.
 *
 * The ordinary importer is intentionally generous on a first-ever import: a
 * previously unseen person can be created automatically and a repeated source
 * row is imported with a warning. Recovery runs against an established ledger,
 * so its safety posture is stricter:
 *
 * - exact ledger matches are no-ops;
 * - a same-natural-key change is held for review and never overwrites history;
 * - a repeated source occurrence is preserved as evidence but never inserted
 *   automatically;
 * - a genuinely missing transaction is eligible only when its program,
 *   individual and employee already resolve unambiguously; and
 * - ledger-only rows are reported as historical and are never deleted.
 */

export type TransactionSourceClassification =
  | "exact"
  | "missing_new"
  | "different_natural_key"
  | "ambiguous_review"
  | "duplicate_source_occurrence";

export interface TransactionLedgerRow {
  id: string;
  fingerprint: string;
  naturalKey: string;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  individual: string;
  employee: string | null;
  program: string;
  hours: string;
  rate: string;
  amount: string;
  sourceFileId: string | null;
  sourceRowNumber: number | null;
  syncReviewReason: string | null;
}

export interface TransactionSourceIdentity {
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  serviceDate: string | null;
  individual: string;
  employee: string | null;
  program: string;
  hours: string;
  rate: string;
  amount: string;
  rawAmount: string;
}

export interface TransactionSourceAssessment {
  sourceRowNumber: number;
  classification: TransactionSourceClassification;
  fingerprint: string | null;
  naturalKey: string | null;
  occurrence: number | null;
  occurrenceCount: number | null;
  identity: TransactionSourceIdentity | null;
  existingTransactionIds: string[];
  canApply: boolean;
  reasons: string[];
}

export interface TransactionHistoricalAssessment {
  classification: "historical";
  transactionId: string;
  fingerprint: string;
  naturalKey: string;
  identity: Omit<TransactionSourceIdentity, "serviceDate" | "rawAmount">;
  sourceFileId: string | null;
  sourceRowNumber: number | null;
  syncReviewReason: string | null;
  reason: string;
}

export interface TransactionDuplicateSourceGroup {
  fingerprint: string;
  occurrenceCount: number;
  /** Evidence only. The fingerprint, not a mutable row number, is the identity. */
  sourceRows: number[];
}

export interface TransactionReconciliationSummary {
  sourceRows: number;
  parsedRows: number;
  uniqueSourceFingerprints: number;
  ledgerRows: number;
  exact: number;
  missingNew: number;
  differentNaturalKey: number;
  ambiguousReview: number;
  duplicateSourceOccurrences: number;
  duplicateSourceGroups: number;
  historical: number;
  applicable: number;
}

interface ClassifiedTransactionWorkbook {
  assessments: TransactionSourceAssessment[];
  historical: TransactionHistoricalAssessment[];
  duplicateSourceGroups: TransactionDuplicateSourceGroup[];
  summary: TransactionReconciliationSummary;
}

export interface TransactionWorkbookSource {
  fileName: string;
  byteSize: number;
  checksumSha256: string;
}

export interface TransactionApplySummary {
  alreadyCommitted: boolean;
  importedFileId: string;
  importBatchId: string;
  sourceRowsPreserved: number;
  transactionsInserted: number;
  /** Source value already present in the ledger or inserted by this recovery. */
  accountedAgencyGross: string;
  /** Source employee/internal value already present or inserted by this recovery. */
  accountedInternalAmount: string;
  reviewRowsPreserved: number;
  duplicateRowsPreserved: number;
  note: string;
}

export interface TransactionWorkbookReconciliationReport {
  reportVersion: "transaction_workbook_reconciliation_v1";
  mode: "dry-run" | "apply";
  generatedAt: string;
  source: TransactionWorkbookSource & {
    templateDetected: string;
    mappingStrategy: string;
    parseWarnings: string[];
  };
  summary: TransactionReconciliationSummary;
  preApplySummary: TransactionReconciliationSummary | null;
  applySummary: TransactionApplySummary | null;
  /** Exact rows are summarized above; only rows needing attention are expanded. */
  exceptions: TransactionSourceAssessment[];
  duplicateSourceGroups: TransactionDuplicateSourceGroup[];
  historical: TransactionHistoricalAssessment[];
  safeguards: {
    dryRunByDefault: true;
    deletesRows: false;
    overwritesChangedRows: false;
    createsUnresolvedPeople: false;
    sourceRowNumbersAreIdentity: false;
  };
}

export interface ReconcileTransactionWorkbookOptions {
  apply?: boolean;
  actorId?: string | null;
}

const OPERATIONAL_EMPLOYEE_LABELS = new Set(["denied billing"]);

function plainLabel(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceIdentity(row: ParsedAhivimRow): TransactionSourceIdentity | null {
  const parsed = row.parsed;
  if (!parsed) return null;
  return {
    checkNumber: parsed.checkNumber || null,
    checkDate: parsed.checkDate || null,
    periodBegin: parsed.periodBegin || null,
    periodEnd: parsed.periodEnd || null,
    serviceDate: canonicalServiceDate(parsed),
    individual: parsed.individual,
    employee: parsed.employee || null,
    program: parsed.programDescription,
    hours: parsed.hours,
    rate: parsed.rate,
    amount: parsed.amount,
    rawAmount: row.raw.amount,
  };
}

function occurrenceMaps(staging: StagingResult): {
  rowsByFingerprint: Map<string, number[]>;
  fingerprintsByNaturalKey: Map<string, Set<string>>;
} {
  const rowsByFingerprint = new Map<string, number[]>();
  const fingerprintsByNaturalKey = new Map<string, Set<string>>();
  for (const row of staging.rows) {
    if (!row.fingerprint || !row.naturalKey) continue;
    const occurrences = rowsByFingerprint.get(row.fingerprint) ?? [];
    occurrences.push(row.sourceRowNumber);
    rowsByFingerprint.set(row.fingerprint, occurrences);
    const fingerprints = fingerprintsByNaturalKey.get(row.naturalKey) ?? new Set<string>();
    fingerprints.add(row.fingerprint);
    fingerprintsByNaturalKey.set(row.naturalKey, fingerprints);
  }
  return { rowsByFingerprint, fingerprintsByNaturalKey };
}

function initialAssessment(args: {
  parsed: ParsedAhivimRow;
  staged: StagedRow | undefined;
  occurrence: number | null;
  occurrenceCount: number | null;
  sourceNaturalKeyFingerprints: ReadonlySet<string>;
  ledgerByFingerprint: ReadonlyMap<string, TransactionLedgerRow[]>;
  ledgerByNaturalKey: ReadonlyMap<string, TransactionLedgerRow[]>;
}): TransactionSourceAssessment {
  const { parsed, staged } = args;
  const base = {
    sourceRowNumber: parsed.sourceRowNumber,
    fingerprint: staged?.fingerprint ?? null,
    naturalKey: staged?.naturalKey ?? null,
    occurrence: args.occurrence,
    occurrenceCount: args.occurrenceCount,
    identity: sourceIdentity(parsed),
  };
  const exact = staged?.fingerprint
    ? (args.ledgerByFingerprint.get(staged.fingerprint) ?? [])
    : [];
  const sameNaturalKey = staged?.naturalKey
    ? (args.ledgerByNaturalKey.get(staged.naturalKey) ?? [])
    : [];

  if (!parsed.parsed || !staged || staged.status === "invalid" || !staged.fingerprint || !staged.naturalKey) {
    return {
      ...base,
      classification: "ambiguous_review",
      existingTransactionIds: [],
      canApply: false,
      reasons: parsed.errors.length
        ? parsed.errors.map((error) => `${error.field || "row"}: ${error.message}`)
        : ["The source row could not be parsed and must be reviewed."],
    };
  }

  if ((args.occurrence ?? 1) > 1) {
    return {
      ...base,
      classification: "duplicate_source_occurrence",
      existingTransactionIds: exact.map((row) => row.id),
      canApply: false,
      reasons: [
        "This exact fingerprint occurs more than once in the source workbook. The occurrence is preserved for review but is not inserted automatically.",
      ],
    };
  }

  if (exact.length === 1) {
    return {
      ...base,
      classification: "exact",
      existingTransactionIds: [exact[0]!.id],
      canApply: false,
      reasons: ["An identical transaction already exists in the ledger."],
    };
  }
  if (exact.length > 1) {
    return {
      ...base,
      classification: "ambiguous_review",
      existingTransactionIds: exact.map((row) => row.id),
      canApply: false,
      reasons: ["More than one ledger transaction has this exact fingerprint; no automatic choice is safe."],
    };
  }

  if (
    sameNaturalKey.length > 0
    || args.sourceNaturalKeyFingerprints.size > 1
    || staged.duplicateStatus === "possible"
  ) {
    return {
      ...base,
      classification: "different_natural_key",
      existingTransactionIds: sameNaturalKey.map((row) => row.id),
      canApply: false,
      reasons: [
        sameNaturalKey.length > 0
          ? "The ledger has the same check/person/program/period identity with different hours, rate, or amount. The existing row is not overwritten."
          : "Another source row has the same check/person/program/period identity with different hours, rate, or amount. Both require review.",
      ],
    };
  }

  const unresolved: string[] = [];
  if (staged.status === "needs_review") {
    unresolved.push("The shared staging pipeline marked this row for review.");
  }
  if (!staged.programCode) unresolved.push("The program does not resolve to an approved canonical program.");
  if (!staged.individualId) unresolved.push("The individual does not resolve to one existing canonical person.");
  if (!parsed.parsed.employee || !staged.employeeId) {
    unresolved.push("The employee does not resolve to one existing canonical employee.");
  }
  if (OPERATIONAL_EMPLOYEE_LABELS.has(plainLabel(parsed.parsed.employee))) {
    unresolved.push(
      `"${parsed.parsed.employee}" is an operational label, not a person; it cannot create or select an employee automatically.`,
    );
  }
  if (unresolved.length > 0) {
    return {
      ...base,
      classification: "ambiguous_review",
      existingTransactionIds: [],
      canApply: false,
      reasons: unresolved,
    };
  }

  return {
    ...base,
    classification: "missing_new",
    existingTransactionIds: [],
    canApply: true,
    reasons: [
      "No exact or same-natural-key ledger row exists, and every canonical identity resolves unambiguously.",
    ],
  };
}

function historicalAssessment(row: TransactionLedgerRow): TransactionHistoricalAssessment {
  return {
    classification: "historical",
    transactionId: row.id,
    fingerprint: row.fingerprint,
    naturalKey: row.naturalKey,
    identity: {
      checkNumber: row.checkNumber,
      checkDate: row.checkDate,
      periodBegin: row.periodBegin,
      periodEnd: row.periodEnd,
      individual: row.individual,
      employee: row.employee,
      program: row.program,
      hours: row.hours,
      rate: row.rate,
      amount: row.amount,
    },
    sourceFileId: row.sourceFileId,
    sourceRowNumber: row.sourceRowNumber,
    syncReviewReason: row.syncReviewReason,
    reason:
      "This ledger row has no fingerprint or natural-key counterpart in the current workbook. It is retained as historical data and is never deleted automatically.",
  };
}

/** Deterministic, side-effect-free classification against one ledger snapshot. */
export function classifyTransactionWorkbook(
  parsedRows: ParsedAhivimRow[],
  staging: StagingResult,
  ledger: TransactionLedgerRow[],
): ClassifiedTransactionWorkbook {
  const stagedByRow = new Map(staging.rows.map((row) => [row.sourceRowNumber, row]));
  const ledgerByFingerprint = new Map<string, TransactionLedgerRow[]>();
  const ledgerByNaturalKey = new Map<string, TransactionLedgerRow[]>();
  for (const row of ledger) {
    const exact = ledgerByFingerprint.get(row.fingerprint) ?? [];
    exact.push(row);
    ledgerByFingerprint.set(row.fingerprint, exact);
    const natural = ledgerByNaturalKey.get(row.naturalKey) ?? [];
    natural.push(row);
    ledgerByNaturalKey.set(row.naturalKey, natural);
  }

  const source = occurrenceMaps(staging);
  const occurrenceSeen = new Map<string, number>();
  const assessments = parsedRows.map((parsed) => {
    const staged = stagedByRow.get(parsed.sourceRowNumber);
    const fingerprint = staged?.fingerprint ?? null;
    const occurrenceCount = fingerprint
      ? (source.rowsByFingerprint.get(fingerprint)?.length ?? 1)
      : null;
    const occurrence = fingerprint
      ? (occurrenceSeen.get(fingerprint) ?? 0) + 1
      : null;
    if (fingerprint && occurrence !== null) occurrenceSeen.set(fingerprint, occurrence);
    const naturalFingerprints = staged?.naturalKey
      ? (source.fingerprintsByNaturalKey.get(staged.naturalKey) ?? new Set<string>())
      : new Set<string>();
    return initialAssessment({
      parsed,
      staged,
      occurrence,
      occurrenceCount,
      sourceNaturalKeyFingerprints: naturalFingerprints,
      ledgerByFingerprint,
      ledgerByNaturalKey,
    });
  });

  // A multi-person group must land as one coherent unit. If only some members
  // are eligible, hold those missing members as well; otherwise the commit path
  // would create a partial service session alongside historical members.
  const assessmentByRow = new Map(assessments.map((row) => [row.sourceRowNumber, row]));
  for (const group of staging.groups) {
    if (group.groupSize <= 1) continue;
    const members = group.sourceRowRefs
      .map((sourceRowNumber) => assessmentByRow.get(sourceRowNumber))
      .filter((row): row is TransactionSourceAssessment => row !== undefined);
    const applicable = members.filter((row) => row.canApply);
    if (applicable.length === 0 || applicable.length === members.length) continue;
    for (const row of applicable) {
      row.classification = "ambiguous_review";
      row.canApply = false;
      row.reasons.push(
        "Only part of this detected group service is missing. The partial group is held for owner review.",
      );
    }
  }

  const sourceFingerprints = new Set(
    staging.rows.flatMap((row) => (row.fingerprint ? [row.fingerprint] : [])),
  );
  const sourceNaturalKeys = new Set(
    staging.rows.flatMap((row) => (row.naturalKey ? [row.naturalKey] : [])),
  );
  const historical = ledger
    .filter((row) => !sourceFingerprints.has(row.fingerprint) && !sourceNaturalKeys.has(row.naturalKey))
    .map(historicalAssessment);
  const duplicateSourceGroups = [...source.rowsByFingerprint.entries()]
    .filter(([, sourceRows]) => sourceRows.length > 1)
    .map(([fingerprint, sourceRows]) => ({
      fingerprint,
      occurrenceCount: sourceRows.length,
      sourceRows: [...sourceRows],
    }));

  const count = (classification: TransactionSourceClassification) =>
    assessments.filter((row) => row.classification === classification).length;
  return {
    assessments,
    historical,
    duplicateSourceGroups,
    summary: {
      sourceRows: parsedRows.length,
      parsedRows: parsedRows.filter((row) => row.parsed !== null).length,
      uniqueSourceFingerprints: sourceFingerprints.size,
      ledgerRows: ledger.length,
      exact: count("exact"),
      missingNew: count("missing_new"),
      differentNaturalKey: count("different_natural_key"),
      ambiguousReview: count("ambiguous_review"),
      duplicateSourceOccurrences: count("duplicate_source_occurrence"),
      duplicateSourceGroups: duplicateSourceGroups.length,
      historical: historical.length,
      applicable: assessments.filter((row) => row.canApply).length,
    },
  };
}

interface LedgerQueryRow {
  id: string;
  transaction_fingerprint: string;
  check_number: string | null;
  check_date: string | null;
  period_begin: string | null;
  period_end: string | null;
  individual_normalized: string | null;
  individual_display: string | null;
  individual_raw: string;
  employee_normalized: string | null;
  employee_display: string | null;
  employee_raw: string | null;
  program_code: string | null;
  program_name: string | null;
  program_raw: string;
  imported_hours: string;
  imported_rate: string;
  imported_amount: string;
  source_file_id: string | null;
  source_row_number: number | null;
  sync_review_reason: string | null;
}

/** Load the immutable imported identity used for comparison, not presentation totals. */
export async function loadTransactionLedger(pool: PgLikePool): Promise<TransactionLedgerRow[]> {
  const result = await pool.query<LedgerQueryRow>(
    `SELECT t.id::text,
            t.transaction_fingerprint,
            t.check_number,
            t.check_date::text AS check_date,
            t.period_begin::text AS period_begin,
            t.period_end::text AS period_end,
            i.normalized_name AS individual_normalized,
            i.display_name AS individual_display,
            t.individual_raw,
            e.normalized_name AS employee_normalized,
            e.display_name AS employee_display,
            t.employee_raw,
            p.code AS program_code,
            p.name AS program_name,
            t.program_raw,
            t.imported_hours::text AS imported_hours,
            t.imported_rate::text AS imported_rate,
            t.imported_amount::text AS imported_amount,
            t.source_file_id::text AS source_file_id,
            t.source_row_number,
            t.sync_review_reason
       FROM payroll_transactions t
       LEFT JOIN individuals i ON i.id = t.individual_id
       LEFT JOIN employees e ON e.id = t.employee_id
       LEFT JOIN programs p ON p.id = t.program_id
      ORDER BY t.id`,
  );
  return result.rows.map((row) => {
    const identity: TransactionIdentity = {
      checkNumber: row.check_number,
      checkDate: row.check_date,
      employeeKey: row.employee_normalized ?? normalizePersonName(row.employee_raw),
      individualKey: row.individual_normalized ?? normalizePersonName(row.individual_raw),
      programKey: row.program_code ?? normalizeProgramLabel(row.program_raw),
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      hours: row.imported_hours,
      rate: row.imported_rate,
      amount: row.imported_amount,
    };
    return {
      id: row.id,
      fingerprint: row.transaction_fingerprint,
      naturalKey: transactionNaturalKey(identity),
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      individual: row.individual_display ?? row.individual_raw,
      employee: row.employee_display ?? row.employee_raw,
      program: row.program_code ?? row.program_name ?? row.program_raw,
      hours: row.imported_hours,
      rate: row.imported_rate,
      amount: row.imported_amount,
      sourceFileId: row.source_file_id,
      sourceRowNumber: row.source_row_number,
      syncReviewReason: row.sync_review_reason,
    };
  });
}

function reconciliationForRecovery(
  parsed: WorkbookParseResult,
  rows: StagedRow[],
  classified: ClassifiedTransactionWorkbook,
): StagingResult["reconciliation"] {
  const stagedByRow = new Map(rows.map((row) => [row.sourceRowNumber, row]));
  // Reconciliation is source-accounting, not an insert counter. An exact row
  // is already represented in the canonical ledger and must contribute once;
  // an unequivocally missing row contributes because this transaction will
  // insert it. Review/changed/repeated occurrences remain excluded.
  const accountedRows = new Set(
    classified.assessments
      .filter((row) => row.classification === "exact" || row.canApply)
      .map((row) => row.sourceRowNumber),
  );
  let agencyGross = dec(0);
  let internalAmount = dec(0);
  for (const parsedRow of parsed.ahivimRows) {
    const staged = stagedByRow.get(parsedRow.sourceRowNumber);
    if (!accountedRows.has(parsedRow.sourceRowNumber) || !staged || !parsedRow.parsed) continue;
    agencyGross = agencyGross.plus(parsedRow.parsed.amount);
    if (staged.calculatedInternalAmount !== null) {
      internalAmount = internalAmount.plus(staged.calculatedInternalAmount);
    }
  }
  const workbookAgency = parsed.controlTotals.agencyGross;
  const workbookInternal = parsed.controlTotals.internalAmount;
  const agencyMatches = workbookAgency === null
    ? null
    : closeEnough(agencyGross, workbookAgency, "0.05");
  const internalMatches = workbookInternal === null
    ? null
    : closeEnough(internalAmount, workbookInternal, "0.05");
  return {
    importedAgencyGross: toMoney(agencyGross),
    importedInternalAmount: toMoney(internalAmount),
    workbookAgencyGross: workbookAgency === null ? null : toMoney(workbookAgency),
    workbookInternalAmount: workbookInternal === null ? null : toMoney(workbookInternal),
    agencyGrossMatches: agencyMatches,
    internalAmountMatches: internalMatches,
    reconciled: agencyMatches === true && internalMatches === true,
    note:
      "Recovery accounting includes each exact ledger match once plus unequivocally missing rows inserted by this run. Source repeats, natural-key changes, and unresolved identities remain review evidence and are not inserted or overwritten.",
  };
}

function warningForAssessment(row: TransactionSourceAssessment): StagedWarning | null {
  if (row.classification === "duplicate_source_occurrence") {
    return {
      category: "possible_duplicate",
      severity: "warning",
      sourceRowNumber: row.sourceRowNumber,
      message: row.reasons.join(" "),
      details: {
        recoveryClassification: row.classification,
        fingerprint: row.fingerprint,
        occurrence: row.occurrence,
        occurrenceCount: row.occurrenceCount,
      },
    };
  }
  if (row.classification === "different_natural_key") {
    return {
      category: "possible_duplicate",
      severity: "warning",
      sourceRowNumber: row.sourceRowNumber,
      message: row.reasons.join(" "),
      details: {
        recoveryClassification: row.classification,
        fingerprint: row.fingerprint,
        naturalKey: row.naturalKey,
        existingTransactionIds: row.existingTransactionIds,
      },
    };
  }
  if (row.classification === "ambiguous_review" && row.identity?.employee) {
    return {
      category: "unmatched_employee",
      severity: "error",
      sourceRowNumber: row.sourceRowNumber,
      message: row.reasons.join(" "),
      details: { recoveryClassification: row.classification },
    };
  }
  return null;
}

/**
 * Narrow ordinary staging to the recovery policy. This never promotes a row
 * the shared pipeline rejected; it only demotes unsafe rows to review.
 */
export function stagingForTransactionRecovery(
  parsed: WorkbookParseResult,
  staging: StagingResult,
  classified: ClassifiedTransactionWorkbook,
): StagingResult {
  const assessmentByRow = new Map(
    classified.assessments.map((assessment) => [assessment.sourceRowNumber, assessment]),
  );
  const rows = staging.rows.map((row): StagedRow => {
    const assessment = assessmentByRow.get(row.sourceRowNumber);
    if (!assessment) return { ...row, status: "invalid" };
    if (assessment.classification === "exact") {
      return { ...row, status: "duplicate", duplicateStatus: "confirmed" };
    }
    if (assessment.canApply && row.status === "valid") return { ...row };
    if (row.status === "invalid") return { ...row };
    return {
      ...row,
      status: "needs_review",
      duplicateStatus:
        assessment.classification === "missing_new" ? row.duplicateStatus : "possible",
    };
  });
  const addedWarnings = classified.assessments
    .map(warningForAssessment)
    .filter((warning): warning is StagedWarning => warning !== null);
  const warnings = [...staging.warnings, ...addedWarnings];
  return {
    ...staging,
    rows,
    warnings,
    counts: {
      ...staging.counts,
      valid: rows.filter((row) => row.status === "valid").length,
      invalid: rows.filter((row) => row.status === "invalid").length,
      needsReview: rows.filter((row) => row.status === "needs_review").length,
      duplicates: rows.filter((row) => row.duplicateStatus !== "new").length,
      confirmedDuplicates: rows.filter((row) => row.duplicateStatus === "confirmed").length,
      possibleDuplicates: rows.filter((row) => row.duplicateStatus === "possible").length,
      warningRows: new Set(
        warnings
          .filter((warning) => warning.sourceRowNumber !== null)
          .map((warning) => warning.sourceRowNumber),
      ).size,
    },
    reconciliation: reconciliationForRecovery(parsed, rows, classified),
  };
}

function compactReport(args: {
  parsed: WorkbookParseResult;
  source: TransactionWorkbookSource;
  mode: "dry-run" | "apply";
  classified: ClassifiedTransactionWorkbook;
  preApplySummary?: TransactionReconciliationSummary | null;
  commit?: CommitResult | null;
}): TransactionWorkbookReconciliationReport {
  const commit = args.commit ?? null;
  return {
    reportVersion: "transaction_workbook_reconciliation_v1",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    source: {
      ...args.source,
      templateDetected: args.parsed.templateDetected,
      mappingStrategy: args.parsed.mappingStrategy,
      parseWarnings: args.parsed.warnings,
    },
    summary: args.classified.summary,
    preApplySummary: args.preApplySummary ?? null,
    applySummary: commit
      ? {
          alreadyCommitted: commit.alreadyCommitted,
          importedFileId: commit.importedFileId,
          importBatchId: commit.importBatchId,
          sourceRowsPreserved: commit.counts.importRows,
          transactionsInserted: commit.counts.transactions,
          accountedAgencyGross: commit.reconciliation.importedAgencyGross,
          accountedInternalAmount: commit.reconciliation.importedInternalAmount,
          reviewRowsPreserved: commit.counts.reviewRows,
          duplicateRowsPreserved: commit.counts.duplicateRows,
          note: commit.note,
        }
      : null,
    exceptions: args.classified.assessments.filter((row) => row.classification !== "exact"),
    duplicateSourceGroups: args.classified.duplicateSourceGroups,
    historical: args.classified.historical,
    safeguards: {
      dryRunByDefault: true,
      deletesRows: false,
      overwritesChangedRows: false,
      createsUnresolvedPeople: false,
      sourceRowNumbersAreIdentity: false,
    },
  };
}

/** Dry-run by default; apply delegates all writes to the transactional commit path. */
export async function reconcileTransactionWorkbook(
  pool: PgLikePool,
  parsed: WorkbookParseResult,
  source: TransactionWorkbookSource,
  options: ReconcileTransactionWorkbookOptions = {},
): Promise<TransactionWorkbookReconciliationReport> {
  if (parsed.ahivimRows.length === 0) {
    throw new Error("No transaction rows were found in the Ahivim workbook sheet.");
  }
  const staging = await stageAgainstDatabase(pool, parsed.ahivimRows, parsed.controlTotals);
  const ledger = await loadTransactionLedger(pool);
  const before = classifyTransactionWorkbook(parsed.ahivimRows, staging, ledger);
  if (!options.apply) {
    return compactReport({ parsed, source, mode: "dry-run", classified: before });
  }

  const recoveryStaging = stagingForTransactionRecovery(parsed, staging, before);
  const ratesByProgram = await currentRatesByProgram(pool);
  const commit = await commitStagedImport(pool, {
    checksumSha256: source.checksumSha256,
    originalFilename: source.fileName,
    byteSize: source.byteSize,
    templateDetected: parsed.templateDetected,
    sheetSummary: {
      kind: "transaction_workbook_recovery_v1",
      source: {
        fileName: source.fileName,
        byteSize: source.byteSize,
        checksumSha256: source.checksumSha256,
      },
      sheets: parsed.sheets,
      mappingStrategy: parsed.mappingStrategy,
      parseWarnings: parsed.warnings,
      controlTotals: parsed.controlTotals,
      classificationSummary: before.summary,
      safeguards: {
        repeatedSourceOccurrencesHeld: true,
        naturalKeyChangesHeld: true,
        unresolvedIdentitiesHeld: true,
        historicalRowsPreserved: true,
      },
    },
    parsedRows: parsed.ahivimRows,
    staging: recoveryStaging,
    ratesByProgram,
    committedByUserId: options.actorId ?? null,
  });

  const afterStaging = await stageAgainstDatabase(pool, parsed.ahivimRows, parsed.controlTotals);
  const after = classifyTransactionWorkbook(
    parsed.ahivimRows,
    afterStaging,
    await loadTransactionLedger(pool),
  );
  return compactReport({
    parsed,
    source,
    mode: "apply",
    classified: after,
    preApplySummary: before.summary,
    commit,
  });
}
