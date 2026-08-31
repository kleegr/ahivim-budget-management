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
  const grouped = new Map<string, ProgramBudgetRecord[]>();

  for (const row of source) {
    if (row.periodStatus !== "active" || row.requiredAuthType === "dollars") continue;
    if (today < row.startDate || today > row.endDate) continue;
    const current = grouped.get(row.individualId);
    if (current) current.push(row);
    else grouped.set(row.individualId, [row]);
  }

  const summaries = new Map<string, AuthorizationPortfolioSummary>();
  for (const [individualId, rows] of grouped) {
    let authorized = dec(0);
    let used = dec(0);
    let billedAmount = dec(0);
    let monthlyPace = dec(0);
    let weeklyPace = dec(0);
    let worst: UtilizationStatus = "not_started";
    const renewals = new Set<string>();
    const periods = new Set<string>();
    let singleElapsedPercent: number | null = null;

    for (const row of rows) {
      const lineAuthorized = dec(row.authorizedHours || 0);
      const lineUsed = dec(row.consumedHours || 0);
      const lineRemaining = lineAuthorized.minus(lineUsed);
      const elapsed = calculatePeriodElapsed(
        { startDate: row.startDate, endDate: row.endDate },
        businessDate,
      );
      const usage = lineAuthorized.isZero() ? dec(0) : lineUsed.dividedBy(lineAuthorized);
      const status = classifyUtilization(usage, elapsed);

      authorized = authorized.plus(lineAuthorized);
      used = used.plus(lineUsed);
      billedAmount = billedAmount.plus(dec(row.consumedDollars || 0));
      renewals.add(row.endDate);
      periods.add(`${row.startDate}:${row.endDate}`);
      singleElapsedPercent = dec(elapsed.timeElapsedPercent).times(100).toNumber();
      if (STATUS_RANK[status] < STATUS_RANK[worst]) worst = status;

      if (lineRemaining.greaterThan(0) && elapsed.remainingDays > 0) {
        const lineMonthlyPace = lineRemaining.dividedBy(elapsed.remainingDays / 30.4375);
        const lineWeeklyPace = lineRemaining.dividedBy(elapsed.remainingDays / 7);
        monthlyPace = monthlyPace.plus(lineMonthlyPace.greaterThan(lineRemaining) ? lineRemaining : lineMonthlyPace);
        weeklyPace = weeklyPace.plus(lineWeeklyPace.greaterThan(lineRemaining) ? lineRemaining : lineWeeklyPace);
      }
    }

    const renewalDates = [...renewals].sort();
    const nextRenewal = renewalDates[0] ?? null;
    const daysToRenewal = nextRenewal
      ? Math.round(
          (Date.parse(`${nextRenewal}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`))
            / 86_400_000,
        )
      : null;
    const remaining = authorized.minus(used);
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
        renewalCount: renewalDates.length,
        usedHours: used.toNumber(),
        hoursLeft: remaining.toNumber(),
        plans: rows.length,
        daysToRenewal,
        expired: daysToRenewal !== null && daysToRenewal < 0,
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
