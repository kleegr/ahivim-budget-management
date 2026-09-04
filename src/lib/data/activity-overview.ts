import type { PgLikePool } from "@/lib/import/commit";
import { exceptionCounts, type ExceptionCounts } from "@/lib/data/queries";
import {
  getOpenSyncConflictCounts,
  type OpenSyncConflictCounts,
} from "@/lib/sheets/queries";

export interface ActivityReviewSummary {
  decisions: {
    unmatchedNames: number;
    unknownPrograms: number;
    pendingAliases: number;
    duplicatePeople: number;
    changedSourceRecords: number;
    missingSourceRecords: number;
    totalDifferences: number;
  };
  monitoring: {
    unexpectedRates: number;
    groupServices: number;
    possibleDuplicateServices: number;
    overAuthorization: number;
  };
  decisionTotal: number;
  monitoringTotal: number;
}

export function buildActivityReviewSummary(
  exceptions: ExceptionCounts,
  conflicts: OpenSyncConflictCounts,
): ActivityReviewSummary {
  const decisions = {
    unmatchedNames: exceptions.unmatchedNames,
    unknownPrograms: exceptions.unknownPrograms,
    pendingAliases: exceptions.pendingAliases,
    duplicatePeople: exceptions.duplicateIndividuals,
    changedSourceRecords: conflicts.changed,
    missingSourceRecords: conflicts.missing,
    totalDifferences: exceptions.reconciliationDifferences,
  };
  const monitoring = {
    unexpectedRates: exceptions.rateExceptions,
    groupServices: exceptions.groupReviewIssues,
    possibleDuplicateServices: exceptions.duplicateCandidates,
    overAuthorization: exceptions.overAuthorization,
  };

  return {
    decisions,
    monitoring,
    decisionTotal: Object.values(decisions).reduce((sum, count) => sum + count, 0),
    monitoringTotal: Object.values(monitoring).reduce((sum, count) => sum + count, 0),
  };
}

/** One shared definition of the decisions waiting across Activity and Review. */
export async function getActivityReviewSummary(
  pool: PgLikePool,
  options: { includeBudgetMonitoring?: boolean } = {},
): Promise<ActivityReviewSummary> {
  const [exceptions, conflicts] = await Promise.all([
    exceptionCounts(pool, {
      includeOverAuthorization: options.includeBudgetMonitoring !== false,
    }),
    getOpenSyncConflictCounts(pool),
  ]);
  return buildActivityReviewSummary(exceptions, conflicts);
}
