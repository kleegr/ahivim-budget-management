import { calculatePeriodElapsed } from "@/lib/business/utilization";
import { dec, toHours } from "@/lib/money";

export type PlanningCoverageStatus =
  | "over_committed"
  | "plan_gap"
  | "covered"
  | "on_pace";

export interface PlanningCoverageInput {
  authorizedHours: string;
  actualHours: string;
  scheduledHours: string;
  startDate: string;
  endDate: string;
  asOf: Date;
}

export interface PlanningCoverageMetrics {
  unplannedHours: string;
  requiredWeeklyHours: string | null;
  targetToDateHours: string;
  paceGapHours: string;
  usagePercent: string;
  committedPercent: string;
  timeElapsedPercent: string;
  status: PlanningCoverageStatus;
}

/** Transparent pace math shared by the Planning read model and its tests. */
export function calculatePlanningCoverage(input: PlanningCoverageInput): PlanningCoverageMetrics {
  const authorized = dec(input.authorizedHours);
  const actual = dec(input.actualHours);
  const scheduled = dec(input.scheduledHours);
  const committed = actual.plus(scheduled);
  const unplanned = authorized.minus(committed);
  const elapsed = calculatePeriodElapsed(
    { startDate: input.startDate, endDate: input.endDate },
    input.asOf,
  );

  const targetToDate = authorized.times(elapsed.timeElapsedPercent);
  const paceGap = targetToDate.minus(actual);
  const usagePercent = authorized.isZero() ? dec(0) : actual.dividedBy(authorized);
  const committedPercent = authorized.isZero() ? dec(0) : committed.dividedBy(authorized);

  // Include today while the period is active. On the final day, a positive gap
  // therefore becomes a one-day weekly run rate instead of disappearing.
  const planningDays = elapsed.hasEnded
    ? 0
    : elapsed.remainingDays + (elapsed.hasStarted ? 1 : 0);
  const requiredWeekly = unplanned.gt(0) && planningDays > 0
    ? unplanned.dividedBy(planningDays).times(7)
    : null;

  let status: PlanningCoverageStatus;
  if (committed.gt(authorized)) status = "over_committed";
  else if (committed.lt(targetToDate)) status = "plan_gap";
  else if (actual.lt(targetToDate)) status = "covered";
  else status = "on_pace";

  return {
    unplannedHours: toHours(unplanned),
    requiredWeeklyHours: requiredWeekly ? toHours(requiredWeekly) : null,
    targetToDateHours: toHours(targetToDate),
    paceGapHours: toHours(paceGap),
    usagePercent: usagePercent.toFixed(6),
    committedPercent: committedPercent.toFixed(6),
    timeElapsedPercent: elapsed.timeElapsedPercent,
    status,
  };
}
