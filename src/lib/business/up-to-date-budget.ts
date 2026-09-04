import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import { dec, toHours } from "@/lib/money";

export type UpToDatePeriodKind = "current" | "historical" | "upcoming";

export interface UpToDateProgramColumn {
  id: string;
  code: string;
  name: string;
}

export interface UpToDateProgramBalance {
  authorizationId: string;
  billedHours: string;
  originalHours: string;
  whatsLeftHours: string;
  scheduledHours: string;
  afterScheduledHours: string;
  hasUndatedUsage: boolean;
  sourceCandidateCount: number;
}

export interface UpToDatePeriodRow {
  id: string;
  individualId: string;
  individualName: string;
  budgetPeriodId: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  periodStatus: string;
  kind: UpToDatePeriodKind;
  programs: Record<string, UpToDateProgramBalance>;
  billedHours: string;
  originalHours: string;
  whatsLeftHours: string;
  scheduledHours: string;
  afterScheduledHours: string;
  hasUndatedUsage: boolean;
  hasDuplicateSource: boolean;
}

export interface UpToDateBudgetPortfolio {
  programs: UpToDateProgramColumn[];
  current: UpToDatePeriodRow[];
  historical: UpToDatePeriodRow[];
  upcoming: UpToDatePeriodRow[];
}

export interface UpToDateBudgetTotals {
  periods: number;
  people: number;
  billedHours: string;
  originalHours: string;
  whatsLeftHours: string;
  scheduledHours: string;
  afterScheduledHours: string;
}

function isHoursAuthorization(row: ProgramBudgetRecord): boolean {
  return row.requiredAuthType === "hours" || row.requiredAuthType === "both";
}

function periodKey(row: Pick<ProgramBudgetRecord, "individualId" | "budgetPeriodId">): string {
  return `${row.individualId}:${row.budgetPeriodId}`;
}

function lineKey(row: Pick<ProgramBudgetRecord, "individualId" | "budgetPeriodId" | "programId">): string {
  return `${periodKey(row)}:${row.programId}`;
}

function periodKind(
  row: ProgramBudgetRecord,
  currentPeriodIds: ReadonlySet<string>,
  asOf: string,
): UpToDatePeriodKind {
  if (currentPeriodIds.has(periodKey(row))) return "current";
  if (row.endDate < asOf || row.periodStatus !== "active") return "historical";
  if (row.startDate > asOf) return "upcoming";

  // A date-overlapping authorization that was not selected by the canonical
  // current resolver belongs outside the operational sheet (for example, an
  // inactive person's retained record or a non-primary duplicate source).
  return "historical";
}

function sortCurrent(left: UpToDatePeriodRow, right: UpToDatePeriodRow): number {
  return left.endDate.localeCompare(right.endDate)
    || left.individualName.localeCompare(right.individualName)
    || left.periodLabel.localeCompare(right.periodLabel);
}

function sortHistorical(left: UpToDatePeriodRow, right: UpToDatePeriodRow): number {
  return right.endDate.localeCompare(left.endDate)
    || left.individualName.localeCompare(right.individualName)
    || left.periodLabel.localeCompare(right.periodLabel);
}

/**
 * Build the workbook-shaped authorization portfolio from canonical balances.
 *
 * `current` comes from the effective authorization selector. `explicit` adds
 * prior/upcoming periods. A current row always wins the same period/program
 * key, which keeps repeated reads idempotent and prevents duplicate revisions
 * from inflating the visible totals.
 */
export function buildUpToDateBudgetPortfolio({
  current,
  explicit,
  asOf,
}: {
  current: readonly ProgramBudgetRecord[];
  explicit: readonly ProgramBudgetRecord[];
  asOf: string;
}): UpToDateBudgetPortfolio {
  const currentHours = current.filter(isHoursAuthorization);
  const currentPeriodIds = new Set(currentHours.map(periodKey));
  const lines = new Map<string, ProgramBudgetRecord>();

  for (const row of explicit) {
    if (!isHoursAuthorization(row)) continue;
    const key = lineKey(row);
    const prior = lines.get(key);
    if (!prior || row.revision > prior.revision) lines.set(key, row);
  }
  for (const row of currentHours) lines.set(lineKey(row), row);

  const programColumns = new Map<string, UpToDateProgramColumn>();
  const grouped = new Map<string, { seed: ProgramBudgetRecord; lines: ProgramBudgetRecord[] }>();
  for (const row of lines.values()) {
    programColumns.set(row.programId, { id: row.programId, code: row.programCode, name: row.programName });
    const key = periodKey(row);
    const group = grouped.get(key);
    if (group) group.lines.push(row);
    else grouped.set(key, { seed: row, lines: [row] });
  }

  const rows: UpToDatePeriodRow[] = [];
  for (const [id, group] of grouped) {
    const programs: Record<string, UpToDateProgramBalance> = {};
    let billed = dec(0);
    let original = dec(0);
    let left = dec(0);
    let scheduled = dec(0);
    let afterScheduled = dec(0);
    let hasUndatedUsage = false;
    let hasDuplicateSource = false;

    for (const line of group.lines) {
      programs[line.programId] = {
        authorizationId: line.authorizationId,
        billedHours: line.consumedHours,
        originalHours: line.authorizedHours,
        whatsLeftHours: line.remainingHours,
        scheduledHours: line.scheduledHours,
        afterScheduledHours: line.remainingAfterScheduledHours,
        hasUndatedUsage: line.hasUndatedUsage,
        sourceCandidateCount: line.sourceCandidateCount,
      };
      billed = billed.plus(line.consumedHours);
      original = original.plus(line.authorizedHours);
      left = left.plus(line.remainingHours);
      scheduled = scheduled.plus(line.scheduledHours);
      afterScheduled = afterScheduled.plus(line.remainingAfterScheduledHours);
      hasUndatedUsage ||= line.hasUndatedUsage;
      hasDuplicateSource ||= line.sourceCandidateCount > 1;
    }

    rows.push({
      id,
      individualId: group.seed.individualId,
      individualName: group.seed.individualName,
      budgetPeriodId: group.seed.budgetPeriodId,
      periodLabel: group.seed.periodLabel,
      startDate: group.seed.startDate,
      endDate: group.seed.endDate,
      renewalDate: group.seed.renewalDate,
      periodStatus: group.seed.periodStatus,
      kind: periodKind(group.seed, currentPeriodIds, asOf),
      programs,
      billedHours: toHours(billed),
      originalHours: toHours(original),
      whatsLeftHours: toHours(left),
      scheduledHours: toHours(scheduled),
      afterScheduledHours: toHours(afterScheduled),
      hasUndatedUsage,
      hasDuplicateSource,
    });
  }

  return {
    programs: [...programColumns.values()].sort((leftColumn, rightColumn) => (
      leftColumn.name.localeCompare(rightColumn.name) || leftColumn.code.localeCompare(rightColumn.code)
    )),
    current: rows.filter((row) => row.kind === "current").sort(sortCurrent),
    historical: rows.filter((row) => row.kind === "historical").sort(sortHistorical),
    upcoming: rows.filter((row) => row.kind === "upcoming").sort(sortCurrent),
  };
}

export function matchesUpToDatePeriod(
  row: UpToDatePeriodRow,
  search: string,
  programId = "",
): boolean {
  if (programId && !row.programs[programId]) return false;
  const term = search.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    row.individualName,
    row.periodLabel,
    row.startDate,
    row.endDate,
    row.renewalDate ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(term));
}

export function sumUpToDatePeriods(rows: readonly UpToDatePeriodRow[]): UpToDateBudgetTotals {
  const people = new Set<string>();
  let billed = dec(0);
  let original = dec(0);
  let left = dec(0);
  let scheduled = dec(0);
  let afterScheduled = dec(0);
  for (const row of rows) {
    people.add(row.individualId);
    billed = billed.plus(row.billedHours);
    original = original.plus(row.originalHours);
    left = left.plus(row.whatsLeftHours);
    scheduled = scheduled.plus(row.scheduledHours);
    afterScheduled = afterScheduled.plus(row.afterScheduledHours);
  }
  return {
    periods: rows.length,
    people: people.size,
    billedHours: toHours(billed),
    originalHours: toHours(original),
    whatsLeftHours: toHours(left),
    scheduledHours: toHours(scheduled),
    afterScheduledHours: toHours(afterScheduled),
  };
}
