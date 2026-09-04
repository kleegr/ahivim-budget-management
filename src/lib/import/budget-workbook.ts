import { agencyDate } from "@/lib/business/agency-time";
import {
  matchPerson,
  type AliasRecord,
  type CanonicalRecord,
  type MatchOutcome,
} from "@/lib/business/name-matching";
import type {
  BudgetWorkbookParseResult,
  ParsedBudgetAuthorization,
  ParsedBudgetRow,
} from "@/lib/excel/parse-budget-workbook";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec } from "@/lib/money";
import {
  createAuthorizationInTransaction,
  createBudgetPeriod,
} from "@/lib/manage/authorizations";

const SOURCE_KIND = "budget_workbook";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type BudgetReconciliationState =
  | "exact"
  | "missing"
  | "different"
  | "ambiguous_identity"
  | "duplicate_source_label_or_key"
  | "needs_owner_review";

export type BudgetClassification =
  | BudgetReconciliationState
  | "historical"
  | "billing_without_budget";

const CLASSIFICATION_ORDER: BudgetClassification[] = [
  "exact",
  "missing",
  "different",
  "ambiguous_identity",
  "duplicate_source_label_or_key",
  "historical",
  "billing_without_budget",
  "needs_owner_review",
];

export interface BudgetIndividualContext {
  id: string;
  normalizedName: string;
  displayName: string;
  status: string;
  archivedAt: string | null;
  mergedIntoId: string | null;
}

export interface BudgetProgramContext {
  id: string;
  code: string;
  name: string;
  requiredAuthType: string;
  isActive: boolean;
  archivedAt: string | null;
}

export interface BudgetRateContext {
  programId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  internalRate: string;
  agencyRate: string | null;
  archivedAt: string | null;
}

export interface BudgetPeriodContext {
  id: string;
  individualId: string;
  label: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  periodType: string;
  status: string;
  source: string | null;
  archivedAt: string | null;
}

export interface BudgetAuthorizationContext {
  id: string;
  budgetPeriodId: string;
  individualId: string;
  programId: string;
  authorizedHours: string;
  status: string;
  source: string | null;
  sourceRowRef: string | null;
  archivedAt: string | null;
}

export interface BudgetReconciliationContext {
  individuals: BudgetIndividualContext[];
  individualAliases: AliasRecord[];
  programs: BudgetProgramContext[];
  rates: BudgetRateContext[];
  periods: BudgetPeriodContext[];
  authorizations: BudgetAuthorizationContext[];
}

export interface BudgetIdentityAssessment {
  outcome: MatchOutcome;
  matchedId: string | null;
  matchedDisplayName: string | null;
  matchedStatus: string | null;
  reason: string;
  suggestions: Array<{ id: string; displayName: string; similarity: number }>;
}

export interface ExistingBudgetPeriodSummary {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  status: string;
  source: string | null;
}

export interface ExistingBudgetAuthorizationSummary {
  id: string;
  budgetPeriodId: string;
  authorizedHours: string;
  status: string;
  source: string | null;
  sourceRowRef: string | null;
}

export interface BudgetPeriodAssessment {
  state: BudgetReconciliationState;
  classifications: BudgetClassification[];
  startDate: string | null;
  endDate: string | null;
  renewalDate: string | null;
  existingPeriodId: string | null;
  existing: ExistingBudgetPeriodSummary[];
  canApply: boolean;
  reasons: string[];
}

export interface BudgetAuthorizationAssessment {
  programCode: string;
  programName: string;
  sourceCell: string;
  billedComparisonCell: string;
  sourceAuthorizedHours: string | null;
  comparisonBilledHours: string | null;
  state: BudgetReconciliationState;
  classifications: BudgetClassification[];
  resolvedProgramId: string | null;
  existing: ExistingBudgetAuthorizationSummary[];
  canApply: boolean;
  reasons: string[];
}

export interface BudgetRowAssessment {
  sourceRowNumber: number;
  sourceRowHidden: boolean;
  sourceIndividualLabel: string;
  normalizedIndividualLabel: string;
  sourceKey: string;
  identity: BudgetIdentityAssessment;
  period: BudgetPeriodAssessment;
  authorizations: BudgetAuthorizationAssessment[];
  classifications: BudgetClassification[];
}

export interface BudgetClassificationCounts {
  exact: number;
  missing: number;
  different: number;
  ambiguous_identity: number;
  duplicate_source_label_or_key: number;
  historical: number;
  billing_without_budget: number;
  needs_owner_review: number;
}

export interface BudgetReconciliationSummary {
  sourceRows: number;
  sourceAuthorizations: number;
  periodClassifications: BudgetClassificationCounts;
  authorizationClassifications: BudgetClassificationCounts;
  applicablePeriods: number;
  applicableAuthorizations: number;
}

export interface AppliedBudgetReference {
  sourceRowNumber: number;
  sourceCell?: string;
  databaseId: string;
}

export interface BudgetApplySummary {
  insertedPeriods: number;
  insertedAuthorizations: number;
  concurrentExactNoops: number;
  periodReferences: AppliedBudgetReference[];
  authorizationReferences: AppliedBudgetReference[];
}

export interface BudgetReconciliationReport {
  reportVersion: "budget_workbook_reconciliation_v1";
  mode: "dry-run" | "apply";
  generatedAt: string;
  asOfDate: string;
  source: {
    fileName: string;
    sheetName: string;
    range: string;
    checksumSha256: string;
    layoutValid: boolean;
    warnings: string[];
  };
  summary: BudgetReconciliationSummary;
  preApplySummary: BudgetReconciliationSummary | null;
  applySummary: BudgetApplySummary | null;
  rows: BudgetRowAssessment[];
}

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

function clientPool(client: PgLikeClient): PgLikePool {
  return {
    query: client.query.bind(client),
    connect: async () => client,
  };
}

function tags(
  state: BudgetReconciliationState,
  flags: BudgetClassification[] = [],
): BudgetClassification[] {
  const values = new Set<BudgetClassification>([state, ...flags]);
  if (
    state === "different"
    || state === "ambiguous_identity"
    || state === "duplicate_source_label_or_key"
  ) {
    values.add("needs_owner_review");
  }
  return CLASSIFICATION_ORDER.filter((classification) => values.has(classification));
}

function summaryPeriod(period: BudgetPeriodContext): ExistingBudgetPeriodSummary {
  return {
    id: period.id,
    label: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
    renewalDate: period.renewalDate,
    status: period.status,
    source: period.source,
  };
}

function summaryAuthorization(
  authorization: BudgetAuthorizationContext,
): ExistingBudgetAuthorizationSummary {
  return {
    id: authorization.id,
    budgetPeriodId: authorization.budgetPeriodId,
    authorizedHours: authorization.authorizedHours,
    status: authorization.status,
    source: authorization.source,
    sourceRowRef: authorization.sourceRowRef,
  };
}

function activePeriod(period: BudgetPeriodContext): boolean {
  return period.status === "active" && period.archivedAt === null;
}

function activeAuthorization(authorization: BudgetAuthorizationContext): boolean {
  return authorization.status === "active" && authorization.archivedAt === null;
}

function rangesOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function historical(row: ParsedBudgetRow, asOfDate: string): boolean {
  return row.periodEndDate !== null && row.periodEndDate < asOfDate;
}

function validAsOfDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function findEffectiveRate(
  rates: BudgetRateContext[],
  programId: string,
  asOfDate: string,
): BudgetRateContext | null {
  return rates
    .filter((rate) => rate.programId === programId
      && rate.archivedAt === null
      && rate.effectiveFrom <= asOfDate
      && (rate.effectiveTo === null || rate.effectiveTo >= asOfDate))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null;
}

function assessIdentity(
  row: ParsedBudgetRow,
  context: BudgetReconciliationContext,
): { assessment: BudgetIdentityAssessment; person: BudgetIndividualContext | null } {
  const canonical: CanonicalRecord[] = context.individuals.map((individual) => ({
    id: individual.id,
    normalizedName: individual.normalizedName,
    displayName: individual.displayName,
  }));
  const match = matchPerson(row.sourceIndividualLabel, canonical, context.individualAliases);
  const person = match.matchedId
    ? context.individuals.find((individual) => individual.id === match.matchedId) ?? null
    : null;
  return {
    assessment: {
      outcome: person ? match.outcome : match.matchedId ? "ambiguous" : match.outcome,
      matchedId: person?.id ?? null,
      matchedDisplayName: person?.displayName ?? null,
      matchedStatus: person?.status ?? null,
      reason: person || !match.matchedId
        ? match.reason
        : "The matched alias points to a canonical individual that no longer exists.",
      suggestions: match.suggestions,
    },
    person,
  };
}

function classifyPeriod(args: {
  parsed: BudgetWorkbookParseResult;
  row: ParsedBudgetRow;
  person: BudgetIndividualContext | null;
  identity: BudgetIdentityAssessment;
  duplicate: boolean;
  context: BudgetReconciliationContext;
  asOfDate: string;
}): BudgetPeriodAssessment {
  const { parsed, row, person, identity, duplicate, context, asOfDate } = args;
  const rowIsHistorical = historical(row, asOfDate);
  const flags: BudgetClassification[] = rowIsHistorical ? ["historical"] : [];
  const reasons: string[] = [];
  let state: BudgetReconciliationState;
  let existing: BudgetPeriodContext[] = [];
  let existingPeriodId: string | null = null;

  if (row.sourceRowHidden) {
    reasons.push("The hidden source row was included; hiding a worksheet row does not remove its data.");
  }

  if (!parsed.layoutValid) {
    state = "needs_owner_review";
    reasons.push("The workbook headers or reviewed source range changed; fixed-column parsing cannot be applied safely.");
  } else if (row.issues.length > 0 || !row.periodStartDate || !row.periodEndDate || !row.renewalDate) {
    state = "needs_owner_review";
    reasons.push(...row.issues.map((issue) => issue.message));
  } else if (!person || identity.outcome === "unmatched" || identity.outcome === "ambiguous") {
    state = "ambiguous_identity";
    reasons.push(identity.reason);
  } else if (duplicate) {
    state = "duplicate_source_label_or_key";
    reasons.push("More than one source row resolves to this individual and renewal period.");
  } else if (person.mergedIntoId !== null) {
    state = "needs_owner_review";
    reasons.push("The matched individual was merged into another record; its identity must be resolved by an owner.");
  } else if ((person.status !== "active" || person.archivedAt !== null) && !rowIsHistorical) {
    state = "needs_owner_review";
    reasons.push("The matched individual is inactive, archived, or discharged for a current or future source period.");
  } else {
    const individualPeriods = context.periods.filter((period) => period.individualId === person.id);
    const exactActive = individualPeriods.filter((period) => activePeriod(period)
      && period.startDate === row.periodStartDate
      && period.endDate === row.periodEndDate
      && period.renewalDate === row.renewalDate);
    // Periods may legitimately overlap when they carry different programs.
    // Only the same source dates/renewal make a period-level conflict; the
    // per-program overlap guard is applied below when each authorization is
    // classified.
    const activeConflicts = individualPeriods.filter((period) => activePeriod(period)
      && (
        (period.startDate === row.periodStartDate && period.endDate === row.periodEndDate)
        || period.renewalDate === row.renewalDate
      ));
    const inactiveExact = individualPeriods.filter((period) => !activePeriod(period)
      && period.startDate === row.periodStartDate
      && period.endDate === row.periodEndDate
      && period.renewalDate === row.renewalDate);
    const sameRenewal = individualPeriods.filter((period) => period.renewalDate === row.renewalDate);

    if (
      exactActive.length === 1
      && activeConflicts.every((period) => period.id === exactActive[0]!.id)
    ) {
      state = "exact";
      existingPeriodId = exactActive[0]!.id;
      existing = [exactActive[0]!, ...inactiveExact];
    } else {
      const candidates = new Map<string, BudgetPeriodContext>();
      for (const period of [...exactActive, ...activeConflicts, ...inactiveExact, ...sameRenewal]) {
        candidates.set(period.id, period);
      }
      existing = [...candidates.values()];
      if (existing.length > 0) {
        state = "different";
        reasons.push("An existing period has the same dates, renewal, or an overlapping active range but does not exactly match this source period.");
      } else {
        state = "missing";
        reasons.push("No matching budget period exists.");
      }
    }
  }

  return {
    state,
    classifications: tags(state, flags),
    startDate: row.periodStartDate,
    endDate: row.periodEndDate,
    renewalDate: row.renewalDate,
    existingPeriodId,
    existing: existing.map(summaryPeriod),
    canApply: false,
    reasons,
  };
}

function programResolution(
  authorization: ParsedBudgetAuthorization,
  context: BudgetReconciliationContext,
): { program: BudgetProgramContext | null; reason: string | null } {
  const candidates = context.programs.filter((program) => program.code === authorization.programCode);
  if (candidates.length !== 1) {
    return {
      program: null,
      reason: candidates.length === 0
        ? `Program ${authorization.programCode} is missing from the canonical catalog.`
        : `Program ${authorization.programCode} is duplicated in the canonical catalog.`,
    };
  }
  const program = candidates[0]!;
  if (!program.isActive || program.archivedAt !== null) {
    return { program, reason: `Program ${authorization.programCode} is inactive or archived.` };
  }
  if (program.requiredAuthType !== "hours") {
    return {
      program,
      reason: `Program ${authorization.programCode} does not accept an hours-only authorization.`,
    };
  }
  return { program, reason: null };
}

function classifyAuthorization(args: {
  row: ParsedBudgetRow;
  authorization: ParsedBudgetAuthorization;
  person: BudgetIndividualContext | null;
  period: BudgetPeriodAssessment;
  context: BudgetReconciliationContext;
  asOfDate: string;
}): BudgetAuthorizationAssessment | null {
  const { row, authorization, person, period, context, asOfDate } = args;
  const resolvedProgram = programResolution(authorization, context);
  const program = resolvedProgram.program;
  const hasSourceAuthorization = authorization.authorizedHours !== null;
  // A non-blank Original must not create overlapping same-program truth. A
  // blank Original, however, asserts absence only on this exact source period;
  // the same program may legitimately be authorized in another renewal period.
  const relevantPeriods = person && row.periodStartDate && row.periodEndDate
    ? context.periods.filter((candidate) => candidate.individualId === person.id
      && (
        candidate.id === period.existingPeriodId
        || (hasSourceAuthorization
          ? activePeriod(candidate)
            && rangesOverlap(
              candidate.startDate,
              candidate.endDate,
              row.periodStartDate!,
              row.periodEndDate!,
            )
          : candidate.startDate === row.periodStartDate
            && candidate.endDate === row.periodEndDate
            && candidate.renewalDate === row.renewalDate)
      ))
    : period.existing
      .map((candidate) => context.periods.find((value) => value.id === candidate.id))
      .filter((candidate): candidate is BudgetPeriodContext => candidate !== undefined);
  const candidatePeriodIds = new Set(relevantPeriods.map((candidate) => candidate.id));
  const existing = person && program
    ? context.authorizations.filter((candidate) => candidate.individualId === person.id
      && candidate.programId === program.id
      && candidatePeriodIds.has(candidate.budgetPeriodId))
    : [];
  if (
    !hasSourceAuthorization
    && !authorization.billingWithoutBudget
    && authorization.issues.length === 0
    && existing.length === 0
  ) return null;

  const flags: BudgetClassification[] = [];
  if (historical(row, asOfDate)) flags.push("historical");
  if (authorization.billingWithoutBudget) flags.push("billing_without_budget");
  const reasons: string[] = [];
  let state: BudgetReconciliationState;
  let canApply = false;

  if (
    period.state === "ambiguous_identity"
    || period.state === "duplicate_source_label_or_key"
    || period.state === "needs_owner_review"
  ) {
    state = period.state;
    reasons.push(...period.reasons);
  } else if (period.state === "different") {
    state = "different";
    reasons.push("The source period does not exactly match the existing period, so its authorization cannot be applied safely.");
  } else if (authorization.issues.length > 0) {
    state = "needs_owner_review";
    reasons.push(...authorization.issues.map((issue) => issue.message));
  } else if (resolvedProgram.reason) {
    state = "needs_owner_review";
    reasons.push(resolvedProgram.reason);
  } else if (!hasSourceAuthorization) {
    if (existing.length > 0) {
      state = "different";
      reasons.push("The database contains an authorization where the workbook Original cell is blank.");
    } else {
      state = authorization.billingWithoutBudget ? "needs_owner_review" : "exact";
      reasons.push(
        authorization.billingWithoutBudget
          ? "Billed hours exist while the workbook Original authorization is blank. No authorization was inferred."
          : "Neither the source nor database contains an authorization for this program and period.",
      );
    }
  } else if (!program || !row.periodStartDate) {
    state = "needs_owner_review";
    reasons.push("The program or source period could not be resolved.");
  } else {
    const active = existing.filter(activeAuthorization);
    const activeOnExactPeriod = period.existingPeriodId
      ? active.filter((candidate) => candidate.budgetPeriodId === period.existingPeriodId)
      : [];
    const activeOnOtherPeriod = active.filter(
      (candidate) => candidate.budgetPeriodId !== period.existingPeriodId,
    );
    const inactive = existing.filter((candidate) => !activeAuthorization(candidate));
    if (
      period.state === "exact"
      && activeOnExactPeriod.length === 1
      && activeOnOtherPeriod.length === 0
      && dec(activeOnExactPeriod[0]!.authorizedHours).eq(authorization.authorizedHours!)
    ) {
      state = "exact";
      reasons.push("The active database authorization matches the workbook Original hours.");
    } else if (active.length > 0 || inactive.length > 0) {
      state = "different";
      reasons.push(
        active.length > 1
          ? "More than one active database authorization matched this source key."
          : inactive.length > 0 && active.length === 0
            ? "A prior database authorization exists but is no longer active; it was not reactivated automatically."
            : "The active database authorization hours differ from the workbook Original hours.",
      );
    } else {
      const rate = findEffectiveRate(context.rates, program.id, row.periodStartDate);
      if (!rate || dec(rate.internalRate).isNegative()) {
        state = "needs_owner_review";
        reasons.push("No valid employee/internal rate is effective on the source period start date.");
      } else {
        state = "missing";
        canApply = period.state === "missing" || period.state === "exact";
        reasons.push("No authorization exists for the exact individual, period, and program key.");
      }
    }
  }

  return {
    programCode: authorization.programCode,
    programName: authorization.programLabel,
    sourceCell: authorization.sourceCell,
    billedComparisonCell: authorization.billedComparisonCell,
    sourceAuthorizedHours: authorization.authorizedHours,
    comparisonBilledHours: authorization.billedComparisonHours,
    state,
    classifications: tags(state, flags),
    resolvedProgramId: program?.id ?? null,
    existing: existing.map(summaryAuthorization),
    canApply,
    reasons,
  };
}

function emptyCounts(): BudgetClassificationCounts {
  return {
    exact: 0,
    missing: 0,
    different: 0,
    ambiguous_identity: 0,
    duplicate_source_label_or_key: 0,
    historical: 0,
    billing_without_budget: 0,
    needs_owner_review: 0,
  };
}

function countClassifications(
  records: Array<{ classifications: BudgetClassification[] }>,
): BudgetClassificationCounts {
  const counts = emptyCounts();
  for (const record of records) {
    for (const classification of record.classifications) counts[classification] += 1;
  }
  return counts;
}

/** Deterministic, side-effect-free comparison against a loaded database snapshot. */
export function classifyBudgetWorkbook(
  parsed: BudgetWorkbookParseResult,
  context: BudgetReconciliationContext,
  asOfDate: string = agencyDate(),
): { rows: BudgetRowAssessment[]; summary: BudgetReconciliationSummary } {
  if (!validAsOfDate(asOfDate)) throw new Error("The reconciliation as-of date must be a real YYYY-MM-DD date.");

  const matches = parsed.rows.map((row) => ({ row, ...assessIdentity(row, context) }));
  const rawKeyCounts = new Map<string, number>();
  const resolvedKeyCounts = new Map<string, number>();
  for (const match of matches) {
    rawKeyCounts.set(match.row.sourceKey, (rawKeyCounts.get(match.row.sourceKey) ?? 0) + 1);
    if (match.person && match.row.renewalDate) {
      const key = `${match.person.id}|${match.row.renewalDate}`;
      resolvedKeyCounts.set(key, (resolvedKeyCounts.get(key) ?? 0) + 1);
    }
  }

  const rows = matches.map(({ row, assessment: identity, person }): BudgetRowAssessment => {
    const resolvedKey = person && row.renewalDate ? `${person.id}|${row.renewalDate}` : null;
    const duplicate = (rawKeyCounts.get(row.sourceKey) ?? 0) > 1
      || (resolvedKey !== null && (resolvedKeyCounts.get(resolvedKey) ?? 0) > 1);
    const period = classifyPeriod({ parsed, row, person, identity, duplicate, context, asOfDate });
    const authorizations = row.authorizations
      .map((authorization) => classifyAuthorization({
        row,
        authorization,
        person,
        period,
        context,
        asOfDate,
      }))
      .filter((authorization): authorization is BudgetAuthorizationAssessment => authorization !== null);
    period.canApply = period.state === "missing"
      && authorizations.some((authorization) => authorization.canApply);
    const rowClassifications = new Set<BudgetClassification>(period.classifications);
    for (const authorization of authorizations) {
      for (const classification of authorization.classifications) rowClassifications.add(classification);
    }
    return {
      sourceRowNumber: row.sourceRowNumber,
      sourceRowHidden: row.sourceRowHidden,
      sourceIndividualLabel: row.sourceIndividualLabel,
      normalizedIndividualLabel: row.normalizedIndividualLabel,
      sourceKey: row.sourceKey,
      identity,
      period,
      authorizations,
      classifications: CLASSIFICATION_ORDER.filter((classification) => rowClassifications.has(classification)),
    };
  });

  const authorizations = rows.flatMap((row) => row.authorizations);
  return {
    rows,
    summary: {
      sourceRows: rows.length,
      sourceAuthorizations: parsed.summary.sourceAuthorizations,
      periodClassifications: countClassifications(rows.map((row) => row.period)),
      authorizationClassifications: countClassifications(authorizations),
      applicablePeriods: rows.filter((row) => row.period.canApply).length,
      applicableAuthorizations: authorizations.filter((authorization) => authorization.canApply).length,
    },
  };
}

/** Load only the canonical identity, program, rate, period, and authorization facts needed here. */
export async function loadBudgetReconciliationContext(
  db: Queryable,
): Promise<BudgetReconciliationContext> {
  const individuals = await db.query<{
    id: string;
    normalized_name: string;
    display_name: string;
    status: string;
    archived_at: string | null;
    merged_into_id: string | null;
  }>(
    `SELECT id::text, normalized_name, display_name, status,
            archived_at::text AS archived_at, merged_into_id::text AS merged_into_id
       FROM individuals`,
  );
  const aliases = await db.query<{
    normalized_alias: string;
    individual_id: string;
    status: string;
  }>(
    `SELECT normalized_alias, individual_id::text, status
       FROM individual_aliases`,
  );
  const programs = await db.query<{
    id: string;
    code: string;
    name: string;
    required_auth_type: string;
    is_active: boolean;
    archived_at: string | null;
  }>(
    `SELECT id::text, code, name, required_auth_type, is_active,
            archived_at::text AS archived_at
       FROM programs`,
  );
  const rates = await db.query<{
    program_id: string;
    effective_from: string;
    effective_to: string | null;
    internal_rate: string;
    agency_rate: string | null;
    archived_at: string | null;
  }>(
    `SELECT program_id::text, effective_from::text, effective_to::text,
            internal_rate::text, agency_rate::text,
            archived_at::text AS archived_at
       FROM program_rate_schedules`,
  );
  const periods = await db.query<{
    id: string;
    individual_id: string;
    label: string;
    start_date: string;
    end_date: string;
    renewal_date: string | null;
    period_type: string;
    status: string;
    source: string | null;
    archived_at: string | null;
  }>(
    `SELECT id::text, individual_id::text, label, start_date::text, end_date::text,
            renewal_date::text, period_type, status, source,
            archived_at::text AS archived_at
       FROM budget_periods`,
  );
  const authorizations = await db.query<{
    id: string;
    budget_period_id: string;
    individual_id: string;
    program_id: string;
    authorized_hours: string;
    status: string;
    source: string | null;
    source_row_ref: string | null;
    archived_at: string | null;
  }>(
    `SELECT id::text, budget_period_id::text, individual_id::text, program_id::text,
            authorized_hours::text, status, source, source_row_ref,
            archived_at::text AS archived_at
       FROM budget_authorizations`,
  );

  return {
    individuals: individuals.rows.map((row) => ({
      id: row.id,
      normalizedName: row.normalized_name,
      displayName: row.display_name,
      status: row.status,
      archivedAt: row.archived_at,
      mergedIntoId: row.merged_into_id,
    })),
    individualAliases: aliases.rows.map((row) => ({
      normalizedAlias: row.normalized_alias,
      targetId: row.individual_id,
      status: row.status === "approved" ? "approved" : "pending",
    })),
    programs: programs.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      requiredAuthType: row.required_auth_type,
      isActive: row.is_active,
      archivedAt: row.archived_at,
    })),
    rates: rates.rows.map((row) => ({
      programId: row.program_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      internalRate: row.internal_rate,
      agencyRate: row.agency_rate,
      archivedAt: row.archived_at,
    })),
    periods: periods.rows.map((row) => ({
      id: row.id,
      individualId: row.individual_id,
      label: row.label,
      startDate: row.start_date,
      endDate: row.end_date,
      renewalDate: row.renewal_date,
      periodType: row.period_type,
      status: row.status,
      source: row.source,
      archivedAt: row.archived_at,
    })),
    authorizations: authorizations.rows.map((row) => ({
      id: row.id,
      budgetPeriodId: row.budget_period_id,
      individualId: row.individual_id,
      programId: row.program_id,
      authorizedHours: row.authorized_hours,
      status: row.status,
      source: row.source,
      sourceRowRef: row.source_row_ref,
      archivedAt: row.archived_at,
    })),
  };
}

function sourceReference(
  parsed: BudgetWorkbookParseResult,
  row: BudgetRowAssessment,
  sourceCell?: string,
): string {
  return [
    parsed.sourceFileName,
    parsed.sourceSheetName,
    `row=${row.sourceRowNumber}`,
    ...(sourceCell ? [`cell=${sourceCell}`] : []),
    `sha256=${parsed.checksumSha256}`,
  ].join("::");
}

function report(args: {
  parsed: BudgetWorkbookParseResult;
  asOfDate: string;
  mode: "dry-run" | "apply";
  classified: ReturnType<typeof classifyBudgetWorkbook>;
  preApplySummary?: BudgetReconciliationSummary | null;
  applySummary?: BudgetApplySummary | null;
}): BudgetReconciliationReport {
  return {
    reportVersion: "budget_workbook_reconciliation_v1",
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    asOfDate: args.asOfDate,
    source: {
      fileName: args.parsed.sourceFileName,
      sheetName: args.parsed.sourceSheetName,
      range: args.parsed.sourceRange,
      checksumSha256: args.parsed.checksumSha256,
      layoutValid: args.parsed.layoutValid,
      warnings: args.parsed.warnings,
    },
    summary: args.classified.summary,
    preApplySummary: args.preApplySummary ?? null,
    applySummary: args.applySummary ?? null,
    rows: args.classified.rows,
  };
}

async function exactPeriodAfterLock(
  client: PgLikeClient,
  individualId: string,
  period: BudgetPeriodAssessment,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text
       FROM budget_periods
      WHERE individual_id = $1
        AND start_date = $2::date
        AND end_date = $3::date
        AND renewal_date IS NOT DISTINCT FROM $4::date
        AND status = 'active'
        AND archived_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [individualId, period.startDate, period.endDate, period.renewalDate],
  );
  if (rows.length > 1) throw new Error("Multiple active periods appeared for one exact source key; no writes were committed.");
  return rows[0]?.id ?? null;
}

async function exactAuthorizationAfterConflict(
  client: PgLikeClient,
  budgetPeriodId: string,
  programId: string,
  authorizedHours: string,
): Promise<boolean> {
  const { rows } = await client.query<{ authorized_hours: string }>(
    `SELECT authorized_hours::text
       FROM budget_authorizations
      WHERE budget_period_id = $1
        AND program_id = $2
        AND status = 'active'
        AND archived_at IS NULL`,
    [budgetPeriodId, programId],
  );
  return rows.length === 1 && dec(rows[0]!.authorized_hours).eq(authorizedHours);
}

export interface ReconcileBudgetWorkbookOptions {
  apply?: boolean;
  actorId?: string | null;
  asOfDate?: string;
}

/**
 * Dry-run by default. Apply writes only rows classified as unequivocally
 * missing, within one transaction, then reclassifies the committed result.
 */
export async function reconcileBudgetWorkbook(
  pool: PgLikePool,
  parsed: BudgetWorkbookParseResult,
  options: ReconcileBudgetWorkbookOptions = {},
): Promise<BudgetReconciliationReport> {
  const asOfDate = options.asOfDate ?? agencyDate();
  if (!validAsOfDate(asOfDate)) throw new Error("The reconciliation as-of date must be a real YYYY-MM-DD date.");
  if (!options.apply) {
    const context = await loadBudgetReconciliationContext(pool);
    return report({
      parsed,
      asOfDate,
      mode: "dry-run",
      classified: classifyBudgetWorkbook(parsed, context, asOfDate),
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`budget_workbook:${parsed.checksumSha256}`],
    );
    const before = classifyBudgetWorkbook(
      parsed,
      await loadBudgetReconciliationContext(client),
      asOfDate,
    );
    const applySummary: BudgetApplySummary = {
      insertedPeriods: 0,
      insertedAuthorizations: 0,
      concurrentExactNoops: 0,
      periodReferences: [],
      authorizationReferences: [],
    };
    const txPool = clientPool(client);

    for (const row of before.rows) {
      const eligible = row.authorizations.filter((authorization) => authorization.canApply);
      if (eligible.length === 0 || !row.identity.matchedId) continue;
      if (!row.period.startDate || !row.period.endDate || !row.period.renewalDate) {
        throw new Error(`Source row ${row.sourceRowNumber} lost its derived period dates.`);
      }

      let periodId = row.period.existingPeriodId;
      if (!periodId) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`budget_period:${row.identity.matchedId}:${row.period.startDate}:${row.period.endDate}`],
        );
        periodId = await exactPeriodAfterLock(client, row.identity.matchedId, row.period);
      }
      if (!periodId) {
        const periodRef = sourceReference(parsed, row);
        const created = await createBudgetPeriod(
          txPool,
          {
            individualId: row.identity.matchedId,
            label: `Annual authorization through ${row.period.endDate}`,
            startDate: row.period.startDate,
            endDate: row.period.endDate,
            periodType: "rolling",
            renewalDate: row.period.renewalDate,
            source: SOURCE_KIND,
            notes: `Source ref: ${periodRef}. Only Original authorization hours are eligible for import; Billed and What's Left are excluded.`,
          },
          options.actorId ?? null,
          `Recover missing Budget workbook period from ${periodRef}`,
        );
        if (!created.ok) throw new Error(`Source row ${row.sourceRowNumber}: ${created.message}`);
        periodId = created.data.id;
        applySummary.insertedPeriods += 1;
        applySummary.periodReferences.push({
          sourceRowNumber: row.sourceRowNumber,
          databaseId: periodId,
        });
      }

      for (const authorization of eligible) {
        if (!authorization.resolvedProgramId || authorization.sourceAuthorizedHours === null) {
          throw new Error(`Source row ${row.sourceRowNumber} has an incomplete authorization plan.`);
        }
        const authorizationRef = sourceReference(parsed, row, authorization.sourceCell);
        const created = await createAuthorizationInTransaction(
          client,
          {
            budgetPeriodId: periodId,
            programId: authorization.resolvedProgramId,
            authorizedHours: authorization.sourceAuthorizedHours,
            rateBasis: "hours",
            source: SOURCE_KIND,
            sourceRowRef: authorizationRef,
            notes: `Recovered from workbook Original cell ${authorization.sourceCell}; Billed and What's Left were not imported.`,
          },
          options.actorId ?? null,
          `Recover missing Budget workbook authorization from ${authorizationRef}`,
        );
        if (!created.ok) {
          if (created.code === "conflict" && await exactAuthorizationAfterConflict(
            client,
            periodId,
            authorization.resolvedProgramId,
            authorization.sourceAuthorizedHours,
          )) {
            applySummary.concurrentExactNoops += 1;
            continue;
          }
          throw new Error(`Source row ${row.sourceRowNumber}, ${authorization.programCode}: ${created.message}`);
        }
        applySummary.insertedAuthorizations += 1;
        applySummary.authorizationReferences.push({
          sourceRowNumber: row.sourceRowNumber,
          sourceCell: authorization.sourceCell,
          databaseId: created.data.id,
        });
      }
    }

    const after = classifyBudgetWorkbook(
      parsed,
      await loadBudgetReconciliationContext(client),
      asOfDate,
    );
    await client.query("COMMIT");
    return report({
      parsed,
      asOfDate,
      mode: "apply",
      classified: after,
      preApplySummary: before.summary,
      applySummary,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
