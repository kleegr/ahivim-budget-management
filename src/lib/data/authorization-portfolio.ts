import { budgetStatusFromHours } from "@/lib/business/budget-status";
import { agencyDate } from "@/lib/business/agency-time";
import {
  calculatePeriodElapsed,
  classifyUtilization,
  type UtilizationStatus,
} from "@/lib/business/utilization";
import type { IndividualBudgetSummary } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import { dec } from "@/lib/money";

const STATUS_RANK: Record<UtilizationStatus, number> = {
  over_authorization: 0,
  fully_used: 1,
  near_exhaustion: 2,
  behind_pace: 3,
  ahead_of_pace: 4,
  on_pace: 5,
  not_started: 6,
};

export interface AuthorizationPortfolioSummary {
  individualId: string;
  programs: string[];
  budget: IndividualBudgetSummary;
}

/**
 * Collapse program-level authorizations into one portfolio row without losing
 * their separate periods. The displayed renewal is the next program renewal;
 * renewalCount tells the UI when more dates exist behind that one row.
 */
export function summarizeAuthorizationPortfolio(
  source: ProgramBudgetRecord[],
  asOf: Date = new Date(),
): Map<string, AuthorizationPortfolioSummary> {
  const today = agencyDate(asOf);
  const businessDate = new Date(`${today}T12:00:00.000Z`);
  const byProgram = new Map<string, ProgramBudgetRecord[]>();
  const grouped = new Map<string, ProgramBudgetRecord[]>();

  for (const row of source) {
    if (row.periodStatus !== "active" || row.requiredAuthType === "dollars") continue;
    const key = `${row.individualId}:${row.programId}`;
    const candidates = byProgram.get(key);
    if (candidates) candidates.push(row);
    else byProgram.set(key, [row]);
  }

  // Keep one operational period per person/program. A current period wins;
  // otherwise retain the most recent expired period so a missed renewal does
  // not disappear from the portfolio. Future-only periods are shown last.
  for (const candidates of byProgram.values()) {
    const current = candidates
      .filter((row) => row.startDate <= today && row.endDate >= today)
      .sort((left, right) => left.endDate.localeCompare(right.endDate))[0];
    const expired = candidates
      .filter((row) => row.endDate < today)
      .sort((left, right) => right.endDate.localeCompare(left.endDate))[0];
    const upcoming = candidates
      .filter((row) => row.startDate > today)
      .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
    const selected = current ?? expired ?? upcoming;
    if (!selected) continue;
    const personRows = grouped.get(selected.individualId);
    if (personRows) personRows.push(selected);
    else grouped.set(selected.individualId, [selected]);
  }

  const summaries = new Map<string, AuthorizationPortfolioSummary>();
  for (const [individualId, rows] of grouped) {
    let authorized = dec(0);
    let used = dec(0);
    let scheduled = dec(0);
    let billedAmount = dec(0);
    let monthlyPace = dec(0);
    let weeklyPace = dec(0);
    let worst: UtilizationStatus = "not_started";
    const renewals = new Set<string>();
    const periods = new Set<string>();
    let singleElapsedPercent: number | null = null;
    let missingRenewal = false;
    let expired = false;

    for (const row of rows) {
      const lineAuthorized = dec(row.authorizedHours || 0);
      const lineUsed = dec(row.consumedHours || 0);
      const lineScheduled = dec(row.scheduledHours || 0);
      const lineRemaining = lineAuthorized.minus(lineUsed);
      const lineRemainingAfterScheduled = lineRemaining.minus(lineScheduled);
      const elapsed = calculatePeriodElapsed(
        { startDate: row.startDate, endDate: row.endDate },
        businessDate,
      );
      const usage = lineAuthorized.isZero() ? dec(0) : lineUsed.dividedBy(lineAuthorized);
      const status = classifyUtilization(usage, elapsed);

      authorized = authorized.plus(lineAuthorized);
      used = used.plus(lineUsed);
      scheduled = scheduled.plus(lineScheduled);
      billedAmount = billedAmount.plus(dec(row.consumedDollars || 0));
      if (row.renewalDate) renewals.add(row.renewalDate);
      else missingRenewal = true;
      if (row.endDate < today) expired = true;
      periods.add(`${row.startDate}:${row.endDate}`);
      singleElapsedPercent = dec(elapsed.timeElapsedPercent).times(100).toNumber();
      if (STATUS_RANK[status] < STATUS_RANK[worst]) worst = status;

      if (lineRemainingAfterScheduled.greaterThan(0) && elapsed.remainingDays > 0) {
        const lineMonthlyPace = lineRemainingAfterScheduled.dividedBy(elapsed.remainingDays / 30.4375);
        const lineWeeklyPace = lineRemainingAfterScheduled.dividedBy(elapsed.remainingDays / 7);
        monthlyPace = monthlyPace.plus(lineMonthlyPace.greaterThan(lineRemainingAfterScheduled) ? lineRemainingAfterScheduled : lineMonthlyPace);
        weeklyPace = weeklyPace.plus(lineWeeklyPace.greaterThan(lineRemainingAfterScheduled) ? lineRemainingAfterScheduled : lineWeeklyPace);
      }
    }

    const renewalDates = [...renewals].sort();
    const nextRenewal = renewalDates[0] ?? null;
    const periodCandidates = nextRenewal
      ? rows.filter((row) => row.renewalDate === nextRenewal)
      : rows;
    const primaryPeriod = periodCandidates
      .slice()
      .sort((left, right) => {
        return left.endDate.localeCompare(right.endDate)
          || left.startDate.localeCompare(right.startDate);
      })[0] ?? null;
    const daysToRenewal = nextRenewal
      ? Math.round(
          (Date.parse(`${nextRenewal}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`))
            / 86_400_000,
        )
      : null;
    const remaining = authorized.minus(used);
    const remainingAfterScheduled = remaining.minus(scheduled);
    summaries.set(individualId, {
      individualId,
      programs: [...new Set(rows.map((row) => row.programName))].sort(),
      budget: {
        status: worst,
        plainStatus: budgetStatusFromHours(authorized.toNumber(), used.toNumber()),
        usedPct: authorized.isZero() ? null : used.dividedBy(authorized).times(100).toNumber(),
        // One marker cannot honestly represent several independent period clocks.
        elapsedPct: periods.size === 1 ? singleElapsedPercent : null,
        renews: nextRenewal,
        periodStart: primaryPeriod?.startDate ?? null,
        periodEnd: primaryPeriod?.endDate ?? null,
        periodCount: periods.size,
        missingRenewal,
        renewalCount: renewalDates.length,
        usedHours: used.toNumber(),
        hoursLeft: remaining.toNumber(),
        scheduledHours: scheduled.toNumber(),
        hoursAfterScheduled: remainingAfterScheduled.toNumber(),
        plans: rows.length,
        daysToRenewal,
        expired,
        mustUseMonthly: monthlyPace.greaterThan(0)
          ? monthlyPace.toNumber()
          : null,
        mustUseWeekly: weeklyPace.greaterThan(0)
          ? weeklyPace.toNumber()
          : null,
        transactionCount: 0,
        billedAmount: billedAmount.toFixed(2),
      },
    });
  }

  return summaries;
}
