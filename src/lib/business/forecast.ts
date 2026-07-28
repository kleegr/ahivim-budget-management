import { dec, toHours, type MoneyInput, Decimal } from "@/lib/money";
import type { PeriodElapsed } from "./utilization";

/**
 * FORECASTING
 * ===========
 *
 * Every figure here is a transparent arithmetic statement about observed
 * history. Nothing is smoothed, weighted or fitted, because a support
 * coordinator has to be able to defend the number to a family.
 *
 *   averageWeeklyUsage  = used hours / weeks elapsed in the period
 *   requiredWeeklyUsage = remaining hours / weeks remaining in the period
 *   projectedRemaining  = authorized - (averageWeeklyUsage x total weeks)
 *   exhaustionDate      = period start + (authorized / averageWeeklyUsage) weeks
 *
 * A forecast is SUPPRESSED rather than guessed. Extrapolating from two days of
 * data produces a confident-looking exhaustion date that is simply wrong, and a
 * wrong date in this system means someone is told their budget is fine when it
 * is not. `available: false` carries a reason the UI shows instead of numbers.
 *
 * The suppression rules are deliberately conservative:
 *   - the period has not started                     -> nothing to observe
 *   - fewer than MIN_ELAPSED_DAYS of history         -> too short to trust
 *   - fewer than MIN_OBSERVATIONS transactions       -> too sparse to trust
 *   - no hours used at all                           -> no rate to project
 *   - authorized hours are zero                      -> nothing to exhaust
 */

export const DAYS_PER_WEEK = 7;

/** Minimum elapsed history before any projection is offered. */
export const MIN_ELAPSED_DAYS = 28;

/** Minimum number of distinct transactions before any projection is offered. */
export const MIN_OBSERVATIONS = 3;

export type ForecastSuppressionReason =
  | "period_not_started"
  | "insufficient_elapsed_time"
  | "insufficient_observations"
  | "no_usage_recorded"
  | "no_authorization";

export const SUPPRESSION_MESSAGES: Record<ForecastSuppressionReason, string> = {
  period_not_started: "The budget period has not started yet, so there is nothing to project from.",
  insufficient_elapsed_time: `Fewer than ${MIN_ELAPSED_DAYS} days of the period have elapsed. A projection from this little history would not be reliable.`,
  insufficient_observations: `Fewer than ${MIN_OBSERVATIONS} transactions have been recorded. A projection from this few observations would not be reliable.`,
  no_usage_recorded: "No hours have been used yet, so there is no usage rate to project.",
  no_authorization: "No hours are authorized for this program, so there is nothing to exhaust.",
};

export interface ForecastInput {
  authorizedHours: MoneyInput;
  usedHours: MoneyInput;
  /** Elapsed/remaining day counts for the budget period. */
  elapsed: PeriodElapsed;
  /** ISO date the period starts, used to date the exhaustion estimate. */
  periodStartDate: string;
  /** How many transactions the used-hours figure was built from. */
  observationCount: number;
}

export interface ForecastAvailable {
  available: true;
  timeElapsedPercent: string;
  usagePercent: string;
  weeksElapsed: string;
  weeksRemaining: string;
  averageWeeklyUsage: string;
  requiredWeeklyUsage: string;
  /** Null when the current pace never exhausts the budget inside the period. */
  estimatedExhaustionDate: string | null;
  /** Hours expected to be LEFT at period end at the current pace. Can be negative. */
  projectedRemainingHours: string;
  /** True when the projection runs out before the period ends. */
  projectedToExhaustEarly: boolean;
  observationCount: number;
}

export interface ForecastUnavailable {
  available: false;
  reason: ForecastSuppressionReason;
  message: string;
  timeElapsedPercent: string;
  usagePercent: string;
  observationCount: number;
}

export type ForecastResult = ForecastAvailable | ForecastUnavailable;

function usageFraction(authorized: Decimal, used: Decimal): Decimal {
  return authorized.isZero() ? new Decimal(0) : used.dividedBy(authorized);
}

/**
 * Project a single program's budget consumption.
 *
 * Callers should render `message` when `available` is false and never fall back
 * to a partial number: an absent forecast is a valid, informative answer.
 */
export function calculateForecast(input: ForecastInput): ForecastResult {
  const authorized = dec(input.authorizedHours);
  const used = dec(input.usedHours);
  const { elapsed } = input;

  const timeElapsedPercent = elapsed.timeElapsedPercent;
  const usagePercent = usageFraction(authorized, used).toFixed(6);

  const unavailable = (reason: ForecastSuppressionReason): ForecastUnavailable => ({
    available: false,
    reason,
    message: SUPPRESSION_MESSAGES[reason],
    timeElapsedPercent,
    usagePercent,
    observationCount: input.observationCount,
  });

  if (!elapsed.hasStarted) return unavailable("period_not_started");
  if (authorized.isZero()) return unavailable("no_authorization");
  if (elapsed.elapsedDays < MIN_ELAPSED_DAYS) return unavailable("insufficient_elapsed_time");
  if (input.observationCount < MIN_OBSERVATIONS) return unavailable("insufficient_observations");
  if (used.lte(0)) return unavailable("no_usage_recorded");

  const weeksElapsed = dec(elapsed.elapsedDays).dividedBy(DAYS_PER_WEEK);
  const weeksRemaining = dec(elapsed.remainingDays).dividedBy(DAYS_PER_WEEK);
  const weeksTotal = dec(elapsed.totalDays).dividedBy(DAYS_PER_WEEK);
  const remainingHours = authorized.minus(used);

  // Observed pace. weeksElapsed cannot be zero here: elapsedDays >= 28.
  const averageWeeklyUsage = used.dividedBy(weeksElapsed);

  // The pace needed to land exactly on the authorization at period end. When
  // the period is over there is no remaining time, so the requirement is zero.
  const requiredWeeklyUsage = weeksRemaining.isZero()
    ? new Decimal(0)
    : remainingHours.dividedBy(weeksRemaining);

  // Where the current pace lands at period end.
  const projectedUsage = averageWeeklyUsage.times(weeksTotal);
  const projectedRemainingHours = authorized.minus(projectedUsage);

  // Weeks from the period start until the authorization is fully consumed.
  const weeksToExhaustion = authorized.dividedBy(averageWeeklyUsage);
  const exhaustsInsidePeriod = weeksToExhaustion.lte(weeksTotal);

  return {
    available: true,
    timeElapsedPercent,
    usagePercent,
    weeksElapsed: weeksElapsed.toFixed(4),
    weeksRemaining: weeksRemaining.toFixed(4),
    averageWeeklyUsage: toHours(averageWeeklyUsage),
    requiredWeeklyUsage: toHours(requiredWeeklyUsage),
    estimatedExhaustionDate: exhaustsInsidePeriod
      ? addDays(input.periodStartDate, weeksToExhaustion.times(DAYS_PER_WEEK))
      : null,
    projectedRemainingHours: toHours(projectedRemainingHours),
    projectedToExhaustEarly: exhaustsInsidePeriod,
    observationCount: input.observationCount,
  };
}

/**
 * Add a fractional number of days to an ISO date, returning an ISO date.
 * Rounds up, because "the budget runs out part way through Tuesday" is
 * reported as Tuesday, not Monday.
 */
export function addDays(isoDate: string, days: Decimal | number | string): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) throw new RangeError(`Invalid date: ${isoDate}`);
  const whole = dec(days).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  const shifted = new Date(base.getTime() + whole * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
