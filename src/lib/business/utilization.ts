import { dec, toMoney, toHours, type MoneyInput, Decimal } from "@/lib/money";

/**
 * BUDGET PERIODS AND UTILIZATION
 * ==============================
 *
 * A budget period is an explicit start and end date. Twelve months is the
 * common case, not an assumption. Short initial periods, partial years and
 * custom ranges are all first class.
 *
 * The workbook contains a row that divides a yearly amount by 7 because
 * services started mid-period. That is one account's actual period length, not
 * a universal rule, and nothing here divides by 7 or by 12 by default.
 *
 * Pace is deliberately simple and transparent for this milestone:
 *   timeElapsedPercent = elapsed days / total days in period
 *   usagePercent       = used hours / authorized hours
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface BudgetPeriodShape {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface PeriodElapsed {
  totalDays: number;
  elapsedDays: number;
  remainingDays: number;
  timeElapsedPercent: string; // decimal fraction
  hasStarted: boolean;
  hasEnded: boolean;
}

function parseDate(value: string): Date {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${value}`);
  return d;
}

export function calculatePeriodElapsed(
  period: BudgetPeriodShape,
  asOf: Date = new Date(),
): PeriodElapsed {
  const start = parseDate(period.startDate);
  const end = parseDate(period.endDate);
  if (end.getTime() < start.getTime()) {
    throw new RangeError("Budget period end date precedes its start date");
  }

  // Inclusive of both endpoints: a 1 Jan - 31 Dec period is 365 days.
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  const asOfUtc = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());

  const rawElapsed = Math.round((asOfUtc - start.getTime()) / MS_PER_DAY) + 1;
  const elapsedDays = Math.min(Math.max(rawElapsed, 0), totalDays);

  return {
    totalDays,
    elapsedDays,
    remainingDays: totalDays - elapsedDays,
    timeElapsedPercent: dec(elapsedDays).dividedBy(totalDays).toFixed(6),
    hasStarted: asOfUtc >= start.getTime(),
    hasEnded: asOfUtc > end.getTime(),
  };
}

/** Actual months in the period, for monthly planning. Never assumed to be 12. */
export function calculatePlanningMonths(period: BudgetPeriodShape): string {
  const { totalDays } = calculatePeriodElapsed(period, parseDate(period.startDate));
  // 365.25/12 keeps leap years from skewing multi-year comparisons.
  return dec(totalDays).dividedBy("30.4375").toDecimalPlaces(3).toFixed(3);
}

export type UtilizationStatus =
  | "not_started"
  | "behind_pace"
  | "on_pace"
  | "ahead_of_pace"
  | "near_exhaustion"
  | "fully_used"
  | "over_authorization";

export interface ProgramUtilizationInput {
  authorizedHours: MoneyInput;
  usedHours: MoneyInput;
  internalRate: MoneyInput;
  /** Agency gross actually recorded against this program, for context. */
  agencyGross?: MoneyInput;
}

export interface ProgramUtilizationResult {
  authorizedHours: string;
  usedHours: string;
  remainingHours: string;
  usagePercent: string;
  internalRate: string;
  authorizedValue: string;
  usedValue: string;
  remainingValue: string;
  agencyGross: string;
  status: UtilizationStatus;
}

export interface PaceThresholds {
  /** Fraction of pace above/below which usage counts as ahead/behind. */
  paceTolerance?: MoneyInput;
  /** Usage fraction at which the budget is "near exhaustion". */
  nearExhaustion?: MoneyInput;
}

export function calculateProgramUtilization(
  input: ProgramUtilizationInput,
  elapsed: PeriodElapsed,
  thresholds: PaceThresholds = {},
): ProgramUtilizationResult {
  const authorized = dec(input.authorizedHours);
  const used = dec(input.usedHours);
  const rate = dec(input.internalRate);
  const remaining = authorized.minus(used);

  const usagePercent = authorized.isZero()
    ? new Decimal(0)
    : used.dividedBy(authorized);

  return {
    authorizedHours: toHours(authorized),
    usedHours: toHours(used),
    remainingHours: toHours(remaining),
    usagePercent: usagePercent.toFixed(6),
    internalRate: toMoney(rate),
    authorizedValue: toMoney(authorized.times(rate)),
    usedValue: toMoney(used.times(rate)),
    remainingValue: toMoney(remaining.times(rate)),
    agencyGross: toMoney(input.agencyGross ?? 0),
    status: classifyUtilization(usagePercent, elapsed, thresholds),
  };
}

export function classifyUtilization(
  usagePercent: Decimal | string,
  elapsed: PeriodElapsed,
  thresholds: PaceThresholds = {},
): UtilizationStatus {
  const usage = dec(usagePercent);
  const timeElapsed = dec(elapsed.timeElapsedPercent);
  const tolerance = dec(thresholds.paceTolerance ?? "0.10");
  const nearExhaustion = dec(thresholds.nearExhaustion ?? "0.90");

  if (usage.gt(1)) return "over_authorization";
  if (usage.eq(1)) return "fully_used";
  if (usage.isZero()) return elapsed.hasStarted ? "behind_pace" : "not_started";
  if (usage.gte(nearExhaustion)) return "near_exhaustion";

  const difference = usage.minus(timeElapsed);
  if (difference.abs().lte(tolerance)) return "on_pace";
  return difference.isPositive() ? "ahead_of_pace" : "behind_pace";
}

export const STATUS_LABELS: Record<UtilizationStatus, string> = {
  not_started: "Not started",
  behind_pace: "Behind pace",
  on_pace: "On pace",
  ahead_of_pace: "Ahead of pace",
  near_exhaustion: "Near exhaustion",
  fully_used: "Fully used",
  over_authorization: "Over authorization",
};
