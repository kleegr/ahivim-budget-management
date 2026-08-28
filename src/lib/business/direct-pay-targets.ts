import { dec, toHours, type MoneyInput } from "@/lib/money";

export type DirectPayTargetInterval = "week" | "month" | "custom";
export type DirectPayTargetStatus = "met" | "covered" | "needs_hours";

export interface DirectPayTargetWindowInput {
  intervalUnit: DirectPayTargetInterval;
  intervalCount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface DirectPayTargetWindow {
  startDate: string;
  endDate: string;
}

const DAY_MS = 86_400_000;

function parseDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid ISO date: ${value}`);
  }
  return parsed;
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.valueOf() + days * DAY_MS);
}

function monthIndex(value: Date): number {
  return value.getUTCFullYear() * 12 + value.getUTCMonth();
}

function monthStart(index: number): Date {
  return new Date(Date.UTC(Math.floor(index / 12), index % 12, 1));
}

/** Resolve the recurring target interval that contains `asOf`. */
export function directPayTargetWindow(
  input: DirectPayTargetWindowInput,
  asOf: string,
): DirectPayTargetWindow | null {
  const effectiveFrom = parseDate(input.effectiveFrom);
  const effectiveTo = input.effectiveTo ? parseDate(input.effectiveTo) : null;
  const date = parseDate(asOf);
  if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1) {
    throw new RangeError("intervalCount must be a positive integer");
  }
  if (date < effectiveFrom || (effectiveTo && date > effectiveTo)) return null;

  let start: Date;
  let end: Date;
  if (input.intervalUnit === "custom") {
    if (!effectiveTo) throw new RangeError("A custom target requires an effective end date");
    start = effectiveFrom;
    end = effectiveTo;
  } else if (input.intervalUnit === "week") {
    const intervalDays = input.intervalCount * 7;
    const daysFromAnchor = Math.floor((date.valueOf() - effectiveFrom.valueOf()) / DAY_MS);
    start = addDays(effectiveFrom, Math.floor(daysFromAnchor / intervalDays) * intervalDays);
    end = addDays(start, intervalDays - 1);
  } else {
    const anchor = monthIndex(effectiveFrom);
    const current = monthIndex(date);
    const intervalStartMonth = anchor + Math.floor((current - anchor) / input.intervalCount) * input.intervalCount;
    start = monthStart(intervalStartMonth);
    end = addDays(monthStart(intervalStartMonth + input.intervalCount), -1);
  }

  if (start < effectiveFrom) start = effectiveFrom;
  if (effectiveTo && end > effectiveTo) end = effectiveTo;
  return { startDate: iso(start), endDate: iso(end) };
}

export function directPayTargetProgress(input: {
  targetHours: MoneyInput;
  recordedHours: MoneyInput;
  scheduledHours: MoneyInput;
}): {
  remainingHours: string;
  coverageHours: string;
  status: DirectPayTargetStatus;
} {
  const target = dec(input.targetHours);
  const recorded = dec(input.recordedHours);
  const coverage = recorded.plus(dec(input.scheduledHours));
  const remaining = target.minus(coverage);
  return {
    remainingHours: toHours(remaining.greaterThan(0) ? remaining : 0),
    coverageHours: toHours(coverage),
    status: recorded.greaterThanOrEqualTo(target)
      ? "met"
      : coverage.greaterThanOrEqualTo(target)
        ? "covered"
        : "needs_hours",
  };
}
