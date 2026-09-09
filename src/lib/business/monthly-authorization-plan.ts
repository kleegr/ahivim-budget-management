import { dec } from "@/lib/money";

export interface MonthlyPlanInput {
  startDate: string; endDate: string; renewalDate: string | null; asOf: string;
  authorizedHours: string | null; actualHours: string | null;
  history: Array<{ month: string; usedHours: string; scheduledHours: string; payrollHours?: string; adjustmentHours?: string }>;
  unavailableUsage?: boolean;
  periodStatus?: string;
}
export interface MonthlyPlanRow {
  month: string; phase: "past" | "current" | "future";
  actualHours: string; scheduledHours: string;
  payrollHours: string | null; adjustmentHours: string | null;
  remainingDays: number; targetHours: string | null; gapHours: string | null;
  from: string; to: string;
}
export interface MonthlyAuthorizationPlan {
  method: "Even remaining-calendar-day pace";
  unavailableReason: string | null; remainingHours: string | null;
  remainingAfterSchedule: string | null; months: MonthlyPlanRow[];
}
const timestamp = (value: string) => Date.parse(`${value}T00:00:00Z`);
const dateText = (value: Date) => value.toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.max(0, Math.round((timestamp(to) - timestamp(from)) / 86_400_000) + 1);
const maxDate = (...values: string[]) => values.slice().sort().at(-1)!;
const minDate = (...values: string[]) => values.slice().sort()[0];

/** Per-authorization only: scheduled coverage is compared to targets once.
 * Round to hundredths, assigning the final remainder to the last eligible month. */
export function buildMonthlyAuthorizationPlan(input: MonthlyPlanInput): MonthlyAuthorizationPlan {
  const remaining = input.authorizedHours === null || input.actualHours === null ? null : dec(input.authorizedHours).minus(input.actualHours);
  const renewalEnd = input.renewalDate ? dateText(new Date(timestamp(input.renewalDate) - 86_400_000)) : input.endDate;
  const end = minDate(input.endDate, renewalEnd);
  const start = maxDate(input.startDate, input.asOf);
  const totalDays = days(start, end);
  const unavailableReason = input.periodStatus && input.periodStatus !== "active" ? "This authorization is not active. Future targets require an approved active period."
    : remaining === null ? "Authorization or actual usage is unavailable."
    : input.unavailableUsage ? "Undated usage needs review before a reliable target can be calculated."
    : !input.renewalDate ? "Add a renewal date to calculate the remaining pace."
    : totalDays === 0 ? "This authorization has ended. A new approved period is required for future planning." : null;
  const history = new Map(input.history.map((row) => [row.month, row]));
  const months: MonthlyPlanRow[] = [];
  const cursor = new Date(`${input.startDate.slice(0, 7)}-01T00:00:00Z`);
  const positiveRemaining = remaining && remaining.gt(0) ? remaining : dec(0);
  let distributed = dec(0);
  let scheduled = dec(0);
  // Authorization dates are validated at entry. Bound legacy malformed periods.
  for (let count = 0; dateText(cursor) <= input.endDate && count < 600; count += 1) {
    const month = dateText(cursor).slice(0, 7);
    const monthEnd = dateText(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)));
    const from = maxDate(dateText(cursor), input.startDate);
    const to = minDate(monthEnd, input.endDate);
    const eligibleFrom = maxDate(from, start);
    const eligibleTo = minDate(to, end);
    const remainingDays = days(eligibleFrom, eligibleTo);
    // Difference of rounded cumulative targets reconciles every hundredth
    // without a negative final month when many very small targets round up.
    const target = unavailableReason || remainingDays === 0 ? null
      : positiveRemaining.times(days(start, eligibleTo)).dividedBy(totalDays).toDecimalPlaces(2).minus(distributed);
    if (target) distributed = distributed.plus(target);
    const coverage = remainingDays > 0 ? dec(history.get(month)?.scheduledHours ?? 0) : dec(0);
    scheduled = scheduled.plus(coverage);
    months.push({ month, phase: month < input.asOf.slice(0, 7) ? "past" : month === input.asOf.slice(0, 7) ? "current" : "future",
      actualHours: history.get(month)?.usedHours ?? "0.00", scheduledHours: coverage.toFixed(2), remainingDays,
      payrollHours: history.get(month)?.payrollHours ?? null, adjustmentHours: history.get(month)?.adjustmentHours ?? null,
      targetHours: target?.toFixed(2) ?? null, gapHours: target ? (target.minus(coverage).gt(0) ? target.minus(coverage) : dec(0)).toFixed(2) : null, from, to });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { method: "Even remaining-calendar-day pace", unavailableReason, remainingHours: remaining?.toFixed(2) ?? null,
    remainingAfterSchedule: remaining?.minus(scheduled).toFixed(2) ?? null, months };
}
